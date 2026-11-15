"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttachmentError = exports.MAX_ATTACHMENT_BYTES = void 0;
exports.sha256Hex = sha256Hex;
exports.uploadAttachment = uploadAttachment;
exports.getAttachmentUrl = getAttachmentUrl;
exports.downloadAttachment = downloadAttachment;
exports.deleteAttachment = deleteAttachment;
exports.canRetryUpload = canRetryUpload;
exports.attachmentErrorMessage = attachmentErrorMessage;
const supabase_js_1 = require("@supabase/supabase-js");
exports.MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
class AttachmentError extends Error {
    code;
    status;
    detail;
    constructor(code, message, status, detail) {
        super(message);
        this.code = code;
        this.status = status;
        this.detail = detail;
        this.name = 'AttachmentError';
    }
}
exports.AttachmentError = AttachmentError;
async function invoke(client, path, body) {
    const { data, error } = await client.functions.invoke(`assets/${path}`, { body });
    if (!error)
        return data;
    if (error instanceof supabase_js_1.FunctionsHttpError) {
        const res = error.context;
        let payload = null;
        try {
            payload = await res.json();
        }
        catch { /* 본문 없음 */ }
        throw new AttachmentError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? '파일 요청이 실패했습니다', res.status, payload);
    }
    if (error instanceof supabase_js_1.FunctionsRelayError || error instanceof supabase_js_1.FunctionsFetchError) {
        throw new AttachmentError('NETWORK', '서버에 연결하지 못했습니다. 잠시 후 같은 파일로 다시 시도하세요', undefined, error);
    }
    throw new AttachmentError('UNKNOWN', String(error?.message ?? error), undefined, error);
}
function toBytes(b) {
    return b instanceof Uint8Array ? b : new Uint8Array(b);
}
async function sha256Hex(bytes, digest) {
    let buf;
    if (digest)
        buf = await digest(bytes);
    else {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle)
            throw new AttachmentError('DIGEST_REQUIRED', 'SHA-256 계산 함수(digest)를 넘겨 주세요 (expo-crypto)');
        buf = await subtle.digest('SHA-256', bytes);
    }
    return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** 업로드 → 서버 확인까지. 성공하면 AVAILABLE 첨부 행 */
async function uploadAttachment(client, input) {
    const bytes = toBytes(input.bytes);
    if (bytes.byteLength === 0)
        throw new AttachmentError('INVALID_REQUEST', '빈 파일은 올릴 수 없어요');
    if (bytes.byteLength > exports.MAX_ATTACHMENT_BYTES)
        throw new AttachmentError('TOO_LARGE', '파일은 50MB까지 올릴 수 있어요');
    const mimeType = input.mimeType.toLowerCase();
    const sha256 = await sha256Hex(bytes, input.digest);
    const prep = await invoke(client, 'prepare', {
        asset_id: input.assetId,
        purpose: input.purpose ?? 'ATTACHMENT',
        workspace_id: input.workspaceId,
        original_name: input.name ?? null,
        mime_type: mimeType,
        size_bytes: bytes.byteLength,
        sha256,
    });
    if (prep.status === 'AVAILABLE')
        return prep.asset;
    const { error: upErr } = await client.storage
        .from(prep.bucket)
        .uploadToSignedUrl(prep.path, prep.token, bytes, { contentType: mimeType, upsert: true });
    if (upErr) {
        throw new AttachmentError('UPLOAD_FAILED', '파일을 올리지 못했어요. 같은 파일로 다시 시도하세요', undefined, upErr);
    }
    const done = await invoke(client, 'complete', { asset_id: input.assetId });
    return done.asset;
}
/** 첨부를 볼 수 있는 임시 주소 (기본 1시간). 공간 멤버가 아니거나 삭제된 첨부면 NOT_FOUND */
async function getAttachmentUrl(client, asset, opts = {}) {
    const { data, error } = await client.storage
        .from(asset.bucket_id)
        .createSignedUrl(asset.object_path, opts.expiresIn ?? 3600, opts.download !== undefined ? { download: opts.download } : undefined);
    if (error || !data?.signedUrl)
        throw new AttachmentError('NOT_FOUND', '파일을 열 수 없어요 (권한이 없거나 삭제됨)', undefined, error);
    return data.signedUrl;
}
/** 첨부 내용을 바로 받기 (전사·OCR 등에 넘길 때) */
async function downloadAttachment(client, asset) {
    const { data, error } = await client.storage.from(asset.bucket_id).download(asset.object_path);
    if (error || !data)
        throw new AttachmentError('NOT_FOUND', '파일을 받을 수 없어요 (권한이 없거나 삭제됨)', undefined, error);
    return new Uint8Array(await data.arrayBuffer());
}
/** 삭제: 공유 첨부는 올린 사람 또는 공간 소유자, 백업은 본인. 메모 연결은 남고 "삭제된 첨부"로 보여 주세요 */
async function deleteAttachment(client, assetId) {
    await invoke(client, 'delete', { asset_id: assetId });
}
/** 같은 assetId로 다시 시도해도 되는 오류인지 */
function canRetryUpload(code) {
    return ['NETWORK', 'UPLOAD_FAILED', 'NOT_UPLOADED', 'STORAGE_ERROR', 'SERVER_ERROR', 'TOO_MANY_PENDING'].includes(code);
}
/** 오류 → 화면 문구 */
function attachmentErrorMessage(err) {
    const code = err?.code ?? '';
    switch (code) {
        case 'UNSUPPORTED_TYPE': return '이 형식의 파일은 올릴 수 없어요 (사진·녹음·PDF·문서만)';
        case 'TOO_LARGE': return '파일은 50MB까지 올릴 수 있어요';
        case 'QUOTA_EXCEEDED': {
            // 서버 문구에 지금 요금제 기준 용량이 있음: "이 공간의 첨부 용량(2GB)을 넘습니다" / "백업 용량(1GB)을 넘습니다"
            const msg = String(err?.message ?? '');
            const size = /\((\d+(?:MB|GB))\)/.exec(msg)?.[1] ?? null;
            if (msg.includes('백업'))
                return `백업 용량${size ? `(${size})` : ''}이 가득 찼어요. 예전 백업을 지우거나 요금제를 올려 주세요`;
            return `공간의 첨부 용량(${size ?? '500MB'})이 가득 찼어요. 안 쓰는 첨부를 지우거나 공간 관리자의 요금제를 올려 주세요 (FREE 500MB · PRO 2GB · TEAM 10GB)`;
        }
        case 'TOO_MANY_PENDING': return '올리는 중인 파일이 너무 많아요. 잠시 후 다시 시도해 주세요';
        case 'FORBIDDEN': return '이 공간에 파일을 올리거나 지울 권한이 없어요';
        case 'NOT_FOUND': return '파일을 찾을 수 없어요';
        case 'HASH_MISMATCH':
        case 'SIZE_MISMATCH':
        case 'TYPE_MISMATCH':
        case 'ASSET_FAILED':
            return '파일 확인에 실패했어요. 다시 올려 주세요';
        case 'ASSET_DELETED': return '삭제된 파일이에요';
        case 'AUTH_REQUIRED': return '로그인이 필요해요';
        case 'NETWORK':
        case 'UPLOAD_FAILED':
        case 'NOT_UPLOADED':
        case 'STORAGE_ERROR':
            return '파일을 올리지 못했어요. 연결을 확인하고 다시 시도해 주세요';
        default: return '파일을 처리하지 못했어요. 잠시 후 다시 시도해 주세요';
    }
}
