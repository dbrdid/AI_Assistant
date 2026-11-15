// =====================================================================
// 문서 글자 추출 API (Edge Function `doc-extract`) — 요청 처리 로직
//   index.ts가 Supabase 클라이언트로 deps를 만들어 넘김. 테스트는 가짜 deps로 같은 코드를 돌림
//
//   POST /functions/v1/doc-extract
//     body (둘 중 하나):
//       { asset_id, from_page?, max_pages?, notes? }                   공유 공간에 올린 첨부 (읽기 권한 필요)
//       { file_base64, mime_type?, file_name?, from_page?, max_pages?, notes? }   기기에 있는 파일 (10MB까지)
//     200 { ok, kind: PDF|DOCX|PPTX, page_basis, total_pages, from_page, next_from_page, pages: [{number, text, hidden?, notes?}],
//           truncated, no_text }
//         PDF는 한 번에 최대 50쪽(시간 예산 안에서). next_from_page가 있으면 from_page로 이어서 부르세요
//         no_text: 읽은 쪽에 글자가 없음 → 스캔본일 수 있어요. 쪽 사진을 찍어 /ocr로 보내세요
//     400 INVALID_REQUEST | PAGE_OUT_OF_RANGE   401 AUTH_REQUIRED   404 ASSET_NOT_FOUND (없거나 볼 권한 없음)
//     413 TOO_LARGE   415 UNSUPPORTED_TYPE   422 FILE_DAMAGED | FILE_ENCRYPTED
//
//   문서는 서버에 저장되지 않고 외부 AI로도 보내지 않아요 (이 함수는 글자만 꺼냄). 그래서 AI 사용 횟수에 안 들어가요
//   권한: 첨부는 사용자 토큰으로 assets 행·Storage 객체를 읽음 → 기존 RLS(공간 멤버)가 그대로 적용
// =====================================================================
import {
  detectKind, type DocKind, EXTRACT_LIMITS, ExtractError, type ExtractResult, extractDocx, extractPdf, extractPptx,
} from "./extract.ts";

export interface AssetMeta {
  purpose: string;
  bucket: string;
  path: string;
  mime: string;
  name: string | null;
  sizeBytes: number;
}

export interface Deps {
  /** 로그인 토큰 → 사용자 id (아니면 null) */
  getUserId(token: string): Promise<string | null>;
  /** 사용자 권한으로 첨부 정보 (없거나 못 보면 null) */
  getAsset(token: string, assetId: string): Promise<AssetMeta | null>;
  /** 사용자 권한으로 내려받기 (없거나 못 보면 null) */
  download(token: string, bucket: string, path: string): Promise<Uint8Array | null>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// base64는 4/3배 + 다른 칸 여유
const MAX_BODY_CHARS = Math.ceil(EXTRACT_LIMITS.maxInlineBytes * 4 / 3) + 4096;

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return reply(status, { ok: false, code, message, ...extra });
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function decodeBase64(s: string): Uint8Array | null {
  const clean = s.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return null;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function intField(b: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new HttpError(400, "INVALID_REQUEST", `${key}는 ${min}~${max} 정수여야 합니다`);
  }
  return v;
}

async function loadSource(deps: Deps, token: string, b: Record<string, unknown>) {
  const hasAsset = b.asset_id !== undefined && b.asset_id !== null;
  const hasInline = b.file_base64 !== undefined && b.file_base64 !== null;
  if (hasAsset === hasInline) throw new HttpError(400, "INVALID_REQUEST", "asset_id 또는 file_base64 중 하나만 보내세요");

  if (hasAsset) {
    if (typeof b.asset_id !== "string" || !UUID_RE.test(b.asset_id)) throw new HttpError(400, "INVALID_REQUEST", "asset_id는 uuid여야 합니다");
    const meta = await deps.getAsset(token, b.asset_id.toLowerCase());
    if (!meta) throw new HttpError(404, "ASSET_NOT_FOUND", "파일을 찾을 수 없거나 볼 권한이 없어요");
    // 백업은 기기에서 암호화한 파일이라 서버가 읽을 수 없음
    if (meta.purpose !== "ATTACHMENT") throw new HttpError(415, "UNSUPPORTED_TYPE", "공유 첨부 파일만 읽을 수 있어요");
    if (meta.sizeBytes > EXTRACT_LIMITS.maxFileBytes) {
      throw new HttpError(413, "TOO_LARGE", "20MB 넘는 문서는 읽을 수 없어요", { max_bytes: EXTRACT_LIMITS.maxFileBytes });
    }
    const bytes = await deps.download(token, meta.bucket, meta.path);
    if (!bytes) throw new HttpError(404, "ASSET_NOT_FOUND", "파일을 찾을 수 없거나 볼 권한이 없어요");
    if (bytes.byteLength > EXTRACT_LIMITS.maxFileBytes) throw new HttpError(413, "TOO_LARGE", "20MB 넘는 문서는 읽을 수 없어요");
    return { bytes, mime: meta.mime, name: meta.name };
  }

  if (typeof b.file_base64 !== "string" || b.file_base64.length === 0) throw new HttpError(400, "INVALID_REQUEST", "file_base64가 비었어요");
  const bytes = decodeBase64(b.file_base64);
  if (!bytes) throw new HttpError(400, "INVALID_REQUEST", "file_base64 형식이 잘못됐어요");
  if (bytes.byteLength > EXTRACT_LIMITS.maxInlineBytes) {
    throw new HttpError(413, "TOO_LARGE", "10MB 넘는 파일은 공유 공간에 첨부로 올린 뒤 asset_id로 보내세요", { max_bytes: EXTRACT_LIMITS.maxInlineBytes });
  }
  const mime = typeof b.mime_type === "string" ? b.mime_type.slice(0, 200) : null;
  const name = typeof b.file_name === "string" ? b.file_name.slice(0, 255) : null;
  return { bytes, mime, name };
}

function toJson(r: ExtractResult) {
  return {
    ok: true,
    kind: r.kind,
    page_basis: r.pageBasis,
    total_pages: r.totalPages,
    from_page: r.fromPage,
    next_from_page: r.nextFromPage,
    pages: r.pages,
    truncated: r.truncated,
    no_text: r.noText,
  };
}

export function createHandler(deps: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST만 됩니다");

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다");
    try {
      const userId = await deps.getUserId(token);
      if (!userId) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다");

      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_CHARS) return fail(413, "TOO_LARGE", "요청이 너무 커요", { max_bytes: EXTRACT_LIMITS.maxInlineBytes });
      const text = await req.text();
      if (text.length > MAX_BODY_CHARS) return fail(413, "TOO_LARGE", "요청이 너무 커요", { max_bytes: EXTRACT_LIMITS.maxInlineBytes });
      let body: unknown;
      try { body = JSON.parse(text || "{}"); } catch { return fail(400, "INVALID_REQUEST", "JSON 형식이 아닙니다"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "INVALID_REQUEST", "JSON 객체가 필요합니다");
      const b = body as Record<string, unknown>;

      const fromPage = intField(b, "from_page", 1, 100_000);
      const maxPages = intField(b, "max_pages", 1, EXTRACT_LIMITS.pdfPagesPerCall);
      if (b.notes !== undefined && typeof b.notes !== "boolean") throw new HttpError(400, "INVALID_REQUEST", "notes는 true/false");

      const src = await loadSource(deps, token, b);
      const kind: DocKind | null = detectKind(src.bytes, src.mime, src.name);
      if (!kind) throw new HttpError(415, "UNSUPPORTED_TYPE", "PDF·Word(docx)·PowerPoint(pptx)만 읽을 수 있어요");
      if (kind !== "PDF" && fromPage !== undefined && fromPage !== 1) {
        throw new HttpError(400, "INVALID_REQUEST", "from_page는 PDF에서만 씁니다");
      }

      const result = kind === "PDF"
        ? await extractPdf(src.bytes, { fromPage, maxPages, now: deps.now })
        : kind === "DOCX" ? extractDocx(src.bytes) : extractPptx(src.bytes, { notes: (b.notes as boolean | undefined) ?? true });
      return reply(200, toJson(result));
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.code, e.message, e.extra);
      if (e instanceof ExtractError) return fail(e.status, e.code, e.message);
      deps.log?.("doc-extract failed", { message: (e as Error)?.message });
      return fail(500, "INTERNAL", "문서를 읽지 못했어요. 잠시 후 다시 시도해 주세요");
    }
  };
}
