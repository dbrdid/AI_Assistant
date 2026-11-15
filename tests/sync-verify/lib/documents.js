"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentError = exports.DOCUMENT_MIME = exports.DOCUMENT_LIMITS = void 0;
exports.toBase64 = toBase64;
exports.isExtractableDocument = isExtractableDocument;
exports.pageMarker = pageMarker;
exports.joinDocumentPages = joinDocumentPages;
exports.extractDocumentText = extractDocumentText;
exports.documentErrorMessage = documentErrorMessage;
exports.documentNoticeText = documentNoticeText;
const supabase_js_1 = require("@supabase/supabase-js");
exports.DOCUMENT_LIMITS = {
    maxInlineBytes: 10 * 1024 * 1024,
    maxAssetBytes: 20 * 1024 * 1024,
    pdfPagesPerCall: 50,
};
exports.DOCUMENT_MIME = {
    PDF: 'application/pdf',
    DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
class DocumentError extends Error {
    constructor(code, message, status, detail) {
        super(message);
        this.code = code;
        this.status = status;
        this.detail = detail;
        this.name = 'DocumentError';
    }
}
exports.DocumentError = DocumentError;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** 바이트 → base64 (btoa 없는 환경에서도 동작) */
function toBase64(bytes) {
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
function isExtractableDocument(mimeType, fileName) {
    const m = (mimeType ?? '').toLowerCase().split(';')[0].trim();
    if (Object.values(exports.DOCUMENT_MIME).includes(m))
        return true;
    return /\.(pdf|docx|pptx)$/i.test(fileName ?? '');
}
function pageMarker(basis, n) {
    switch (basis) {
        case 'PDF_PAGE': return `--- ${n}쪽 ---`;
        case 'SLIDE': return `--- 슬라이드 ${n} ---`;
        case 'DOCX_RENDERED':
        case 'DOCX_EXPLICIT': return `--- 약 ${n}쪽 ---`;
        default: return null;
    }
}
/** 쪽 표시를 넣어 하나의 글로 (서버 extract.ts joinPages와 같은 규칙) */
function joinDocumentPages(basis, pages) {
    const parts = [];
    for (const p of pages) {
        const marker = pageMarker(basis, p.number);
        const body = [p.hidden ? '(숨긴 슬라이드)' : '', p.text || (marker ? '(글자 없음)' : ''), p.notes ? `[발표자 메모] ${p.notes}` : '']
            .filter(Boolean).join('\n');
        parts.push(marker ? `${marker}\n${body}` : body);
    }
    return parts.join('\n\n').trim();
}
async function invoke(client, body) {
    const { data, error } = await client.functions.invoke('doc-extract', { body });
    if (!error)
        return data;
    if (error instanceof supabase_js_1.FunctionsHttpError) {
        const res = error.context;
        let payload = null;
        try {
            payload = await res.json();
        }
        catch { /* 본문 없음 */ }
        const code = payload?.code ?? `HTTP_${res.status}`;
        throw new DocumentError(code, documentErrorMessage({ code, message: payload?.message }), res.status, payload);
    }
    if (error instanceof supabase_js_1.FunctionsRelayError || error instanceof supabase_js_1.FunctionsFetchError) {
        throw new DocumentError('NETWORK', documentErrorMessage({ code: 'NETWORK' }), undefined, error);
    }
    throw new DocumentError('UNKNOWN', String(error?.message ?? error), undefined, error);
}
/**
 * 문서 글자 꺼내기. PDF는 끝까지(또는 maxPages까지) 이어서 불러 합쳐요
 *   onProgress({ done, total }) : PDF 진행률 ("120쪽 중 50쪽 읽음")
 *   signal                      : 화면을 나가면 멈춤 (지금 요청이 끝난 뒤 DocumentError('CANCELED'))
 */
async function extractDocumentText(client, source, opts = {}) {
    let base;
    if ('assetId' in source) {
        base = { asset_id: source.assetId };
    }
    else {
        const bytes = source.bytes instanceof Uint8Array ? source.bytes : new Uint8Array(source.bytes);
        if (bytes.byteLength === 0)
            throw new DocumentError('INVALID_REQUEST', '빈 파일이에요');
        if (bytes.byteLength > exports.DOCUMENT_LIMITS.maxInlineBytes) {
            throw new DocumentError('TOO_LARGE', documentErrorMessage({ code: 'TOO_LARGE_INLINE' }));
        }
        base = { file_base64: toBase64(bytes), mime_type: source.mimeType ?? null, file_name: source.fileName ?? null };
    }
    if (opts.notes !== undefined)
        base.notes = opts.notes;
    const maxPages = Math.max(1, Math.floor(opts.maxPages ?? 2000));
    const pages = [];
    let first = null;
    let from = 1;
    let truncated = false;
    for (let guard = 0; from !== null; guard++) {
        if (opts.signal?.aborted)
            throw new DocumentError('CANCELED', '읽기를 멈췄어요');
        if (guard > 1000)
            throw new DocumentError('UNKNOWN', '문서를 끝까지 읽지 못했어요');
        const left = maxPages - pages.length;
        // max_pages는 PDF에만 쓰이고 Word·PowerPoint에선 무시돼요
        const r = await invoke(client, { ...base, ...(from > 1 ? { from_page: from } : {}),
            max_pages: Math.min(exports.DOCUMENT_LIMITS.pdfPagesPerCall, left) });
        first ?? (first = r);
        pages.push(...r.pages);
        truncated || (truncated = r.truncated);
        opts.onProgress?.({ done: pages.length, total: r.total_pages });
        // 서버가 진행하지 못했으면(쪽 0개) 무한 반복 방지
        if (r.next_from_page !== null && (r.pages.length === 0 || r.next_from_page <= from)) {
            throw new DocumentError('UNKNOWN', '문서를 끝까지 읽지 못했어요');
        }
        from = r.next_from_page;
        if (from !== null && pages.length >= maxPages) {
            truncated = true;
            break;
        }
    }
    const f = first;
    const emptyPages = pages.filter((p) => p.text.replace(/\s/g, '').length === 0 && !p.notes).map((p) => p.number);
    return {
        kind: f.kind, pageBasis: f.page_basis, totalPages: f.total_pages, pages,
        text: joinDocumentPages(f.page_basis, pages),
        emptyPages, noText: pages.length > 0 && emptyPages.length === pages.length, truncated,
    };
}
function documentErrorMessage(err) {
    const code = err?.code ?? '';
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
        default: return err?.message || '문서를 읽지 못했어요';
    }
}
/** 스캔본 안내 문구 (noText이거나 빈 쪽이 있을 때) */
function documentNoticeText(d) {
    const out = [];
    if (d.noText)
        out.push('글자를 찾지 못했어요. 스캔한 문서라면 쪽을 사진으로 찍어 글자 인식을 써 주세요');
    else if (d.kind === 'PDF' && d.emptyPages.length > 0) {
        const shown = d.emptyPages.slice(0, 5).join(', ') + (d.emptyPages.length > 5 ? ` 외 ${d.emptyPages.length - 5}쪽` : '');
        out.push(`글자가 없는 쪽: ${shown}쪽 (그림·스캔한 쪽이면 사진 글자 인식을 써 주세요)`);
    }
    if (d.truncated)
        out.push('문서가 길어서 앞부분만 가져왔어요');
    if (d.kind === 'DOCX' && d.pageBasis !== 'NONE')
        out.push('Word 문서의 쪽 번호는 대략이에요');
    return out;
}
