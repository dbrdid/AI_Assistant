// 문서 글자 추출 (PDF · Word docx · PowerPoint pptx) — Edge Function `doc-extract`
//
//  흐름: 파일 고르기 → extractDocumentText → 글자 초안을 화면에 보여줌(쪽 표시 포함) → 사용자가 확인·수정
//        → 메모로 저장하거나 analyzeMemo / organizeMemo로 정리
//   - 공유 공간에 이미 올린 첨부: { assetId } (공간 멤버만, 20MB까지)
//   - 기기에 있는 파일: { bytes, mimeType, fileName } (10MB까지. 더 크면 첨부로 올린 뒤 assetId로)
//   - PDF는 서버가 한 번에 최대 50쪽씩 읽어요. 이 함수가 끝까지 이어서 불러 하나로 합쳐 줘요 (onProgress로 진행률)
//   - 결과 글에는 쪽 표시가 들어가요: PDF "--- 3쪽 ---", PPTX "--- 슬라이드 3 ---", Word "--- 약 3쪽 ---"
//     (Word 파일에는 고정된 쪽이 없어서, 저장할 때 Word가 남긴 쪽 표시가 있을 때만 "약 N쪽"으로 나눠요)
//   - noText: 글자층이 없는 PDF(스캔본) → "사진으로 찍어 글자 인식(ocrImages)" 안내
//
//  문서는 서버에 저장되지 않고 외부 AI로도 가지 않아요 (글자만 꺼냄) → 외부 AI 동의·AI 사용 횟수와 무관
//  이 파일은 react-native를 쓰지 않아요 (파일 읽기는 앱이: expo-file-system `await new File(uri).bytes()`)
import type { SupabaseClient } from '@supabase/supabase-js';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

export const DOCUMENT_LIMITS = {
  maxInlineBytes: 10 * 1024 * 1024,
  maxAssetBytes: 20 * 1024 * 1024,
  pdfPagesPerCall: 50,
} as const;

export const DOCUMENT_MIME = {
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export type DocumentKind = 'PDF' | 'DOCX' | 'PPTX';
export type PageBasis = 'PDF_PAGE' | 'SLIDE' | 'DOCX_RENDERED' | 'DOCX_EXPLICIT' | 'NONE';

export interface DocumentPage {
  number: number;
  text: string;
  hidden?: boolean;
  notes?: string;
}

export interface DocumentText {
  kind: DocumentKind;
  pageBasis: PageBasis;
  totalPages: number;
  pages: DocumentPage[];
  /** 쪽 표시를 넣어 이은 글 (화면에 보여 주고 사용자가 고칠 초안) */
  text: string;
  /** 글자가 없는 쪽 번호 (스캔된 쪽일 수 있음) */
  emptyPages: number[];
  /** 읽은 쪽 전부 글자가 없음 → 사진 OCR 안내 */
  noText: boolean;
  /** 글자가 너무 많아 뒷부분이 잘림 (Word·PowerPoint) 또는 maxPages에서 멈춤 (PDF) */
  truncated: boolean;
}

export class DocumentError extends Error {
  constructor(public code: string, message: string, public status?: number, public detail?: unknown) {
    super(message);
    this.name = 'DocumentError';
  }
}

export type DocumentSource =
  | { assetId: string }
  | { bytes: Uint8Array | ArrayBuffer; mimeType?: string | null; fileName?: string | null };

type ServerResult = {
  ok: true; kind: DocumentKind; page_basis: PageBasis; total_pages: number; from_page: number;
  next_from_page: number | null; pages: DocumentPage[]; truncated: boolean; no_text: boolean;
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** 바이트 → base64 (btoa 없는 환경에서도 동작) */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    const t = (a << 16) | (b << 8) | c;
    out += B64[(t >> 18) & 63] + B64[(t >> 12) & 63] + (i + 1 < n ? B64[(t >> 6) & 63] : '=') + (i + 2 < n ? B64[t & 63] : '=');
  }
  return out;
}

/** 파일 이름·형식으로 지원 여부 (고르기 화면에서 미리 거르기용. 최종 판단은 서버가 내용으로) */
export function isExtractableDocument(mimeType?: string | null, fileName?: string | null): boolean {
  const m = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (Object.values(DOCUMENT_MIME).includes(m as never)) return true;
  return /\.(pdf|docx|pptx)$/i.test(fileName ?? '');
}

export function pageMarker(basis: PageBasis, n: number): string | null {
  switch (basis) {
    case 'PDF_PAGE': return `--- ${n}쪽 ---`;
    case 'SLIDE': return `--- 슬라이드 ${n} ---`;
    case 'DOCX_RENDERED':
    case 'DOCX_EXPLICIT': return `--- 약 ${n}쪽 ---`;
    default: return null;
  }
}

/** 쪽 표시를 넣어 하나의 글로 (서버 extract.ts joinPages와 같은 규칙) */
export function joinDocumentPages(basis: PageBasis, pages: DocumentPage[]): string {
  const parts: string[] = [];
  for (const p of pages) {
    const marker = pageMarker(basis, p.number);
    const body = [p.hidden ? '(숨긴 슬라이드)' : '', p.text || (marker ? '(글자 없음)' : ''), p.notes ? `[발표자 메모] ${p.notes}` : '']
      .filter(Boolean).join('\n');
    parts.push(marker ? `${marker}\n${body}` : body);
  }
  return parts.join('\n\n').trim();
}

async function invoke(client: SupabaseClient, body: Record<string, unknown>): Promise<ServerResult> {
  const { data, error } = await client.functions.invoke<ServerResult>('doc-extract', { body });
  if (!error) return data as ServerResult;
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response;
    let payload: { code?: string; message?: string } | null = null;
    try { payload = await res.json(); } catch { /* 본문 없음 */ }
    const code = payload?.code ?? `HTTP_${res.status}`;
    throw new DocumentError(code, documentErrorMessage({ code, message: payload?.message }), res.status, payload);
  }
  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    throw new DocumentError('NETWORK', documentErrorMessage({ code: 'NETWORK' }), undefined, error);
  }
  throw new DocumentError('UNKNOWN', String((error as Error)?.message ?? error), undefined, error);
}

/**
 * 문서 글자 꺼내기. PDF는 끝까지(또는 maxPages까지) 이어서 불러 합쳐요
 *   onProgress({ done, total }) : PDF 진행률 ("120쪽 중 50쪽 읽음")
 *   signal                      : 화면을 나가면 멈춤 (지금 요청이 끝난 뒤 DocumentError('CANCELED'))
 */
export async function extractDocumentText(client: SupabaseClient, source: DocumentSource, opts: {
  notes?: boolean;
  maxPages?: number;
  onProgress?: (p: { done: number; total: number }) => void;
  signal?: { aborted: boolean };
} = {}): Promise<DocumentText> {
  let base: Record<string, unknown>;
  if ('assetId' in source) {
    base = { asset_id: source.assetId };
  } else {
    const bytes = source.bytes instanceof Uint8Array ? source.bytes : new Uint8Array(source.bytes);
    if (bytes.byteLength === 0) throw new DocumentError('INVALID_REQUEST', '빈 파일이에요');
    if (bytes.byteLength > DOCUMENT_LIMITS.maxInlineBytes) {
      throw new DocumentError('TOO_LARGE', documentErrorMessage({ code: 'TOO_LARGE_INLINE' }));
    }
    base = { file_base64: toBase64(bytes), mime_type: source.mimeType ?? null, file_name: source.fileName ?? null };
  }
  if (opts.notes !== undefined) base.notes = opts.notes;
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? 2000));

  const pages: DocumentPage[] = [];
  let first: ServerResult | null = null;
  let from: number | null = 1;
  let truncated = false;
  for (let guard = 0; from !== null; guard++) {
    if (opts.signal?.aborted) throw new DocumentError('CANCELED', '읽기를 멈췄어요');
    if (guard > 1000) throw new DocumentError('UNKNOWN', '문서를 끝까지 읽지 못했어요');
    const left = maxPages - pages.length;
    // max_pages는 PDF에만 쓰이고 Word·PowerPoint에선 무시돼요
    const r = await invoke(client, { ...base, ...(from > 1 ? { from_page: from } : {}),
      max_pages: Math.min(DOCUMENT_LIMITS.pdfPagesPerCall, left) });
    first ??= r;
    pages.push(...r.pages);
    truncated ||= r.truncated;
    opts.onProgress?.({ done: pages.length, total: r.total_pages });
    // 서버가 진행하지 못했으면(쪽 0개) 무한 반복 방지
    if (r.next_from_page !== null && (r.pages.length === 0 || r.next_from_page <= from)) {
      throw new DocumentError('UNKNOWN', '문서를 끝까지 읽지 못했어요');
    }
    from = r.next_from_page;
    if (from !== null && pages.length >= maxPages) { truncated = true; break; }
  }
  const f = first!;
  const emptyPages = pages.filter((p) => p.text.replace(/\s/g, '').length === 0 && !p.notes).map((p) => p.number);
  return {
    kind: f.kind, pageBasis: f.page_basis, totalPages: f.total_pages, pages,
    text: joinDocumentPages(f.page_basis, pages),
    emptyPages, noText: pages.length > 0 && emptyPages.length === pages.length, truncated,
  };
}

export function documentErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'TOO_LARGE': return '파일이 너무 커요 (첨부는 20MB까지)';
    case 'TOO_LARGE_INLINE': return '10MB 넘는 파일은 공유 공간에 첨부로 올린 뒤 읽을 수 있어요';
    case 'UNSUPPORTED_TYPE': return 'PDF·Word(docx)·PowerPoint(pptx) 파일만 읽을 수 있어요 (옛 doc·ppt는 다시 저장해 주세요)';
    case 'FILE_ENCRYPTED': return '암호가 걸린 PDF는 읽을 수 없어요';
    case 'FILE_DAMAGED': return '파일을 열 수 없어요 (손상된 파일일 수 있어요)';
    case 'ASSET_NOT_FOUND': return '파일을 찾을 수 없거나 볼 권한이 없어요';
    case 'PAGE_OUT_OF_RANGE': return '없는 쪽이에요';
    case 'AUTH_REQUIRED': return '다시 로그인해 주세요';
    case 'NETWORK': return '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요';
    case 'CANCELED': return '읽기를 멈췄어요';
    default: return (err as { message?: string })?.message || '문서를 읽지 못했어요';
  }
}

/** 스캔본 안내 문구 (noText이거나 빈 쪽이 있을 때) */
export function documentNoticeText(d: Pick<DocumentText, 'noText' | 'emptyPages' | 'kind' | 'truncated' | 'pageBasis'>): string[] {
  const out: string[] = [];
  if (d.noText) out.push('글자를 찾지 못했어요. 스캔한 문서라면 쪽을 사진으로 찍어 글자 인식을 써 주세요');
  else if (d.kind === 'PDF' && d.emptyPages.length > 0) {
    const shown = d.emptyPages.slice(0, 5).join(', ') + (d.emptyPages.length > 5 ? ` 외 ${d.emptyPages.length - 5}쪽` : '');
    out.push(`글자가 없는 쪽: ${shown}쪽 (그림·스캔한 쪽이면 사진 글자 인식을 써 주세요)`);
  }
  if (d.truncated) out.push('문서가 길어서 앞부분만 가져왔어요');
  if (d.kind === 'DOCX' && d.pageBasis !== 'NONE') out.push('Word 문서의 쪽 번호는 대략이에요');
  return out;
}
