// =====================================================================
// 문서 글자 추출 (PDF · DOCX · PPTX) — 순수 함수. 네트워크·DB 없음 (handler.ts가 부름)
//
//   PDF : 쪽마다 글자층(text layer)을 읽음. 스캔본(그림만 있는 쪽)은 글자가 없음 → 사진 OCR(/ocr) 안내
//         Edge Function CPU 한도(요청당 2초) 때문에 한 번에 최대 50쪽, 시간 예산을 넘으면 거기서 멈추고
//         next_from_page를 돌려줌 → 앱이 이어서 부름
//   DOCX: word/document.xml 본문. Word 파일엔 고정된 쪽이 없어서, 저장 당시 Word가 남긴 쪽 나눔 표시
//         (lastRenderedPageBreak)나 직접 넣은 쪽 나눔이 있을 때만 "약 N쪽"으로 나눔
//         머리글·바닥글·각주·변경 추적으로 지운 글자·필드 코드는 뺌. 표는 칸을 " | "로 이음
//   PPTX: presentation.xml에 적힌 표시 순서대로 슬라이드마다 글자 + (선택) 발표자 메모
//
//   결과 쪽 번호는 1부터. 글자는 앱에서 사용자가 확인·수정하는 초안 (원본 파일은 그대로)
// =====================================================================
import { unzipSync } from "npm:fflate@0.8";
import { getDocumentProxy } from "npm:unpdf@1";

export type DocKind = "PDF" | "DOCX" | "PPTX";
/** 쪽 나눔 근거: PDF 실제 쪽 / PPTX 슬라이드 / DOCX 저장 당시 쪽 표시(대략) / DOCX 직접 넣은 쪽 나눔 / 나눔 정보 없음 */
export type PageBasis = "PDF_PAGE" | "SLIDE" | "DOCX_RENDERED" | "DOCX_EXPLICIT" | "NONE";

export interface ExtractedPage {
  number: number;          // 1부터
  text: string;
  hidden?: boolean;        // PPTX 숨긴 슬라이드
  notes?: string;          // PPTX 발표자 메모
}

export interface ExtractResult {
  kind: DocKind;
  pageBasis: PageBasis;
  totalPages: number;
  fromPage: number;
  pages: ExtractedPage[];
  /** PDF: 이어서 부를 쪽 (끝까지 읽었으면 null) */
  nextFromPage: number | null;
  /** 글자 수 한도로 잘렸는지 (DOCX·PPTX) */
  truncated: boolean;
  /** 이번에 읽은 쪽이 전부 글자가 없음 (스캔본 의심) */
  noText: boolean;
}

export const EXTRACT_LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,          // 받는 파일 크기
  maxInlineBytes: 10 * 1024 * 1024,        // 본문에 base64로 실어 보내는 경우
  pdfPagesPerCall: 50,
  pdfBudgetMs: 1200,                       // 한 번 부를 때 PDF 해석 시간 예산 (CPU 2초 한도 안)
  maxCharsPerCall: 200_000,
  maxZipEntryBytes: 40 * 1024 * 1024,      // 압축 해제 후 XML 하나 크기 (zip 폭탄 방지)
  maxZipTotalBytes: 80 * 1024 * 1024,
  maxSlides: 500,
} as const;

export class ExtractError extends Error {
  constructor(public code: string, message: string, public status = 422) {
    super(message);
  }
}

const MIME = {
  PDF: "application/pdf",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;
export const EXTRACT_MIME = MIME;

/** 파일 앞부분·형식·이름으로 종류 판단. PDF는 %PDF-, DOCX/PPTX는 zip(PK..)이고 형식·확장자로 구분 */
export function detectKind(bytes: Uint8Array, mime?: string | null, name?: string | null): DocKind | null {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  const ext = (name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const isPdf = bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (isPdf) return "PDF";
  if (!isZip) return null;
  if (m === MIME.DOCX || ext === "docx") return "DOCX";
  if (m === MIME.PPTX || ext === "pptx") return "PPTX";
  // 형식·이름이 없으면 zip 안 구조로 판단
  try {
    const names = Object.keys(unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" || f.name === "ppt/presentation.xml" }));
    if (names.includes("word/document.xml")) return "DOCX";
    if (names.includes("ppt/presentation.xml")) return "PPTX";
  } catch { /* 깨진 zip */ }
  return null;
}

// ---------------------------------------------------------------------
// 공통: 글자 정리
// ---------------------------------------------------------------------
const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return ENTITY[e];
  });
}

/** 제어 문자 제거, 줄 끝 공백 제거, 빈 줄 3개 이상 → 2개 */
export function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n").map((l) => l.replace(/[ \t\xa0]+$/g, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeUnzip(bytes: Uint8Array, want: (name: string) => boolean): Record<string, Uint8Array> {
  let total = 0;
  let tooBig = false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!want(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > EXTRACT_LIMITS.maxZipEntryBytes || total > EXTRACT_LIMITS.maxZipTotalBytes) tooBig = true;
        return !tooBig;
      },
    });
  } catch {
    throw new ExtractError("FILE_DAMAGED", "파일을 열 수 없어요 (손상됐거나 암호가 걸린 파일)");
  }
  if (tooBig) throw new ExtractError("TOO_LARGE", "파일 안 내용이 너무 커요", 413);
  return files;
}

const utf8 = new TextDecoder("utf-8");

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------
type PdfItem = { str: string; hasEOL?: boolean; transform?: number[]; width?: number };

// 사용자 영역 글자(U+E000~F8FF): 유니코드 대응이 없는 글리프(대체 모양 숫자 사이 ':' 등)를 PDF가 이렇게 적음
// → 화면에 네모로 보이므로 뺌 (원래 글자는 복원할 수 없음)
const PRIVATE_USE = new RegExp(`[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}]`, "g");

/** pdf.js 글자 조각 → 줄. 같은 줄에서 조각 사이가 떨어져 있으면 띄어 씀 */
export function joinPdfItems(items: PdfItem[]): string {
  let out = "";
  let prevEnd: number | null = null;
  let prevY: number | null = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const t = it.transform ?? [];
    const x = t[4], y = t[5], size = Math.abs(t[0] || t[3] || 10);
    if (it.str.length > 0) {
      if (prevY !== null && y !== undefined && Math.abs(y - prevY) > size * 0.5 && !out.endsWith("\n")) {
        out += "\n";                                   // 줄이 바뀌었는데 EOL 표시가 없던 경우
      } else if (prevEnd !== null && x !== undefined && x - prevEnd > size * 0.2 && !/\s$/.test(out) && !/^\s/.test(it.str)) {
        out += " ";
      }
      out += it.str;
      prevEnd = x !== undefined ? x + (it.width ?? 0) : null;
      prevY = y ?? prevY;
    }
    if (it.hasEOL) {
      out += "\n";
      prevEnd = null;
    }
  }
  return out.replace(PRIVATE_USE, "");
}

export async function extractPdf(bytes: Uint8Array, opts: {
  fromPage?: number; maxPages?: number; budgetMs?: number; maxChars?: number; now?: () => number;
} = {}): Promise<ExtractResult> {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // 글꼴 파일·외부 요청 없이 글자만 (데이터 복사: pdf.js가 버퍼를 넘겨받음)
    pdf = await getDocumentProxy(new Uint8Array(bytes), { disableFontFace: true, useSystemFonts: false });
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name === "PasswordException") throw new ExtractError("FILE_ENCRYPTED", "암호가 걸린 PDF는 읽을 수 없어요");
    throw new ExtractError("FILE_DAMAGED", "PDF를 열 수 없어요 (손상된 파일)");
  }
  try {
    const total = pdf.numPages;
    const from = Math.max(1, Math.floor(opts.fromPage ?? 1));
    if (from > total) throw new ExtractError("PAGE_OUT_OF_RANGE", `이 PDF는 ${total}쪽까지 있어요`, 400);
    const maxPages = Math.min(EXTRACT_LIMITS.pdfPagesPerCall, Math.max(1, Math.floor(opts.maxPages ?? EXTRACT_LIMITS.pdfPagesPerCall)));
    const budget = opts.budgetMs ?? EXTRACT_LIMITS.pdfBudgetMs;
    const maxChars = opts.maxChars ?? EXTRACT_LIMITS.maxCharsPerCall;
    const pages: ExtractedPage[] = [];
    let chars = 0;
    let p = from;
    for (; p <= total && p < from + maxPages; p++) {
      // 첫 쪽은 무조건 읽고, 그다음부터는 시간·글자 예산 확인 (최소 1쪽은 진행)
      if (pages.length > 0 && (now() - started > budget || chars >= maxChars)) break;
      const page = await pdf.getPage(p);
      try {
        const tc = await page.getTextContent();
        const text = tidy(joinPdfItems(tc.items as PdfItem[]));
        pages.push({ number: p, text });
        chars += text.length;
      } finally {
        page.cleanup();
      }
    }
    return {
      kind: "PDF", pageBasis: "PDF_PAGE", totalPages: total, fromPage: from, pages,
      nextFromPage: p <= total ? p : null, truncated: false,
      noText: pages.every((x) => x.text.replace(/\s/g, "").length < 2),
    };
  } finally {
    // PDFDocumentProxy.destroy (버전에 따라 cleanup만 있음)
    try { await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.(); } catch { /* 무시 */ }
  }
}

// ---------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------
/** word/document.xml → 쪽 목록 (쪽 정보가 없으면 1개) */
export function docxPages(xml: string, maxChars: number = EXTRACT_LIMITS.maxCharsPerCall): { pages: string[]; basis: PageBasis; truncated: boolean } {
  const bodyStart = xml.indexOf("<w:body");
  // 글상자는 새 형식(mc:Choice)과 옛 형식(mc:Fallback)에 같은 글이 두 번 들어 있음 → 옛 형식은 뺌
  const src = (bodyStart >= 0 ? xml.slice(bodyStart) : xml).replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, "");
  const pages: string[] = [];
  let cur = "";
  let inText = false;        // <w:t> 안
  let cellDepth = 0;         // 표 칸 안 (중첩 표 포함)
  let sawRendered = false, sawExplicit = false;
  let truncated = false;
  let chars = 0;

  const breakPage = () => {
    // 같은 자리에 직접 쪽 나눔 + Word가 남긴 쪽 표시가 같이 있으면 한 번만 나눔 (빈 쪽 안 만듦)
    if (cur.trim().length === 0) return;
    pages.push(cur);
    cur = "";
  };
  const add = (s: string) => {
    if (truncated) return;
    if (chars + s.length > maxChars) {
      cur += s.slice(0, Math.max(0, maxChars - chars));
      chars = maxChars;
      truncated = true;
      return;
    }
    cur += s;
    chars += s.length;
  };

  const re = /<(\/?)(w:p|w:t|w:tab|w:br|w:cr|w:lastRenderedPageBreak|w:tc|w:tr|w:noBreakHyphen|w:softHyphen|w:sym)(?=[\s/>])([^>]*)>|([^<]+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(src)) !== null;) {
    if (truncated) break;
    const [, close, tag, attrs, text] = m;
    if (text !== undefined) {
      if (inText) add(decodeXml(text));
      continue;
    }
    const selfClose = attrs.trimEnd().endsWith("/");
    switch (tag) {
      case "w:t":
        inText = !close && !selfClose;
        break;
      case "w:tab":
        if (!close) add("\t");
        break;
      case "w:br":
      case "w:cr":
        if (close) break;
        if (/w:type="page"/.test(attrs)) { sawExplicit = true; breakPage(); }
        else if (/w:type="column"/.test(attrs)) add("\n");
        else add("\n");
        break;
      case "w:lastRenderedPageBreak":
        sawRendered = true;
        breakPage();
        break;
      case "w:noBreakHyphen":
        if (!close) add("-");
        break;
      case "w:p":
        if (close) add(cellDepth > 0 ? " " : "\n");
        else if (!selfClose) { /* 문단 시작 */ }
        else add(cellDepth > 0 ? " " : "\n");     // <w:p/> 빈 문단
        break;
      case "w:tc":
        if (!close && !selfClose) cellDepth++;
        else if (close) { cellDepth = Math.max(0, cellDepth - 1); cur = cur.replace(/[ \t]+$/, ""); add(" | "); }
        break;
      case "w:tr":
        if (close) {
          // 줄 끝의 " | " 정리
          cur = cur.replace(/\s*\|\s*$/, "");
          add("\n");
        }
        break;
    }
  }
  if (cur.trim().length > 0 || pages.length === 0) pages.push(cur);
  const cleaned = pages.map((p) => tidy(p.replace(/[ \t]*\|[ \t]*\n/g, "\n")));
  const basis: PageBasis = cleaned.length <= 1 ? "NONE" : sawRendered ? "DOCX_RENDERED" : sawExplicit ? "DOCX_EXPLICIT" : "NONE";
  return { pages: cleaned, basis, truncated };
}

export function extractDocx(bytes: Uint8Array): ExtractResult {
  const files = safeUnzip(bytes, (n) => n === "word/document.xml");
  const doc = files["word/document.xml"];
  if (!doc) throw new ExtractError("UNSUPPORTED_TYPE", "Word(docx) 문서가 아니에요", 415);
  const { pages, basis, truncated } = docxPages(utf8.decode(doc));
  const out = pages.map((text, i) => ({ number: i + 1, text }));
  return {
    kind: "DOCX", pageBasis: basis, totalPages: out.length, fromPage: 1, pages: out, nextFromPage: null, truncated,
    noText: out.every((p) => p.text.replace(/\s/g, "").length === 0),
  };
}

// ---------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------
/** 슬라이드(또는 메모) XML의 글자. 문단마다 줄바꿈, 표 칸은 " | " */
export function drawingText(xml: string): string {
  let out = "";
  let inText = false;
  const re = /<(\/?)(a:p|a:t|a:br|a:tab|a:tc|a:tr)(?=[\s/>])([^>]*)>|([^<]+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(xml)) !== null;) {
    const [, close, tag, attrs, text] = m;
    if (text !== undefined) {
      if (inText) out += decodeXml(text);
      continue;
    }
    const selfClose = attrs.trimEnd().endsWith("/");
    if (tag === "a:t") inText = !close && !selfClose;
    else if (tag === "a:br" && !close) out += "\n";
    else if (tag === "a:tab" && !close) out += "\t";
    else if (tag === "a:p" && (close || selfClose)) out += "\n";
    else if (tag === "a:tc" && close) out = out.replace(/\n+$/, "") + " | ";
    else if (tag === "a:tr" && close) out = out.replace(/\s*\|\s*$/, "") + "\n";
  }
  return tidy(out);
}

/** 발표자 메모: 메모 칸(body 자리)의 글자만 (슬라이드 그림·쪽 번호 자리는 뺌) */
export function notesText(xml: string): string {
  const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>|<p:sp\s[\s\S]*?<\/p:sp>/g) ?? [];
  const body = shapes.filter((s) => /<p:ph\b[^>]*type="body"/.test(s));
  return tidy(body.map(drawingText).join("\n"));
}

function relsMap(xml: string | undefined): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = m[1];
    const id = a.match(/\bId="([^"]+)"/)?.[1];
    const target = a.match(/\bTarget="([^"]+)"/)?.[1];
    const type = a.match(/\bType="([^"]+)"/)?.[1] ?? "";
    if (id && target) map.set(id, { target: decodeXml(target), type });
  }
  return map;
}

/** "ppt/slides" 기준 상대 경로 → zip 안 경로 */
function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (baseDir ? baseDir.split("/") : []);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

export function extractPptx(bytes: Uint8Array, opts: { notes?: boolean; maxChars?: number } = {}): ExtractResult {
  const withNotes = opts.notes ?? true;
  const maxChars = opts.maxChars ?? EXTRACT_LIMITS.maxCharsPerCall;
  const files = safeUnzip(bytes, (n) =>
    n === "ppt/presentation.xml" || n === "ppt/_rels/presentation.xml.rels" ||
    /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(n) ||
    (withNotes && /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)));
  const pres = files["ppt/presentation.xml"];
  if (!pres) throw new ExtractError("UNSUPPORTED_TYPE", "PowerPoint(pptx) 문서가 아니에요", 415);
  const presXml = utf8.decode(pres);
  const rels = relsMap(files["ppt/_rels/presentation.xml.rels"] && utf8.decode(files["ppt/_rels/presentation.xml.rels"]));

  // 표시 순서: sldIdLst의 r:id → slides/slideN.xml (파일 이름 순서와 다를 수 있음)
  const order: string[] = [];
  const lst = presXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)?.[1] ?? "";
  for (const m of lst.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const r = rels.get(m[1]);
    if (r) order.push(resolvePath("ppt", r.target));
  }
  if (order.length > EXTRACT_LIMITS.maxSlides) throw new ExtractError("TOO_LARGE", `슬라이드가 너무 많아요 (${EXTRACT_LIMITS.maxSlides}장까지)`, 413);

  const pages: ExtractedPage[] = [];
  let chars = 0;
  let truncated = false;
  for (let i = 0; i < order.length; i++) {
    const path = order[i];
    const raw = files[path];
    if (!raw) continue;
    const xml = utf8.decode(raw);
    let text = drawingText(xml);
    let notes: string | undefined;
    if (withNotes) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      const file = path.slice(path.lastIndexOf("/") + 1);
      const srels = relsMap(files[`${dir}/_rels/${file}.rels`] && utf8.decode(files[`${dir}/_rels/${file}.rels`]));
      for (const r of srels.values()) {
        if (r.type.endsWith("/notesSlide")) {
          const n = files[resolvePath(dir, r.target)];
          if (n) notes = notesText(utf8.decode(n)) || undefined;
        }
      }
    }
    const size = text.length + (notes?.length ?? 0);
    if (chars + size > maxChars) {
      text = text.slice(0, Math.max(0, maxChars - chars));
      notes = undefined;
      truncated = true;
    }
    chars += text.length + (notes?.length ?? 0);
    const hidden = /<p:sld\b[^>]*\bshow="(0|false)"/.test(xml);
    pages.push({ number: i + 1, text, ...(hidden ? { hidden } : {}), ...(notes ? { notes } : {}) });
    if (truncated) break;
  }
  return {
    kind: "PPTX", pageBasis: "SLIDE", totalPages: order.length, fromPage: 1, pages, nextFromPage: null, truncated,
    noText: pages.every((p) => p.text.length === 0 && !p.notes),
  };
}

// ---------------------------------------------------------------------
// 쪽 표시를 넣어 하나의 글로 (앱 lib과 같은 규칙. /ocr의 "--- N쪽 ---"과 맞춤)
// ---------------------------------------------------------------------
export function pageMarker(basis: PageBasis, n: number): string | null {
  switch (basis) {
    case "PDF_PAGE": return `--- ${n}쪽 ---`;
    case "SLIDE": return `--- 슬라이드 ${n} ---`;
    case "DOCX_RENDERED":
    case "DOCX_EXPLICIT": return `--- 약 ${n}쪽 ---`;
    default: return null;
  }
}

export function joinPages(basis: PageBasis, pages: ExtractedPage[]): string {
  const parts: string[] = [];
  for (const p of pages) {
    const marker = pageMarker(basis, p.number);
    const body = [p.hidden ? "(숨긴 슬라이드)" : "", p.text || (marker ? "(글자 없음)" : ""), p.notes ? `[발표자 메모] ${p.notes}` : ""]
      .filter(Boolean).join("\n");
    parts.push(marker ? `${marker}\n${body}` : body);
  }
  return parts.join("\n\n").trim();
}
