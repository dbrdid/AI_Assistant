"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranscribeError = exports.STT_UPLOAD_KEEP_DAYS = exports.STT_MONTHLY_MINUTES = exports.STT_MAX_BYTES = exports.STT_MAX_SECONDS = void 0;
exports.uploadRecording = uploadRecording;
exports.transcribeUploaded = transcribeUploaded;
exports.transcribeAudio = transcribeAudio;
exports.retryPlan = retryPlan;
exports.canRetryTranscribe = canRetryTranscribe;
exports.continuationPrompt = continuationPrompt;
exports.getSttUsage = getSttUsage;
exports.transcribeErrorMessage = transcribeErrorMessage;
const supabase_js_1 = require("@supabase/supabase-js");
exports.STT_MAX_SECONDS = 1800;
exports.STT_MAX_BYTES = 25 * 1024 * 1024;
exports.STT_MONTHLY_MINUTES = { FREE: 60, PRO: 600 };
exports.STT_UPLOAD_KEEP_DAYS = 3;
class TranscribeError extends Error {
    code;
    status;
    detail;
    constructor(code, message, status, detail) {
        super(message);
        this.code = code;
        this.status = status;
        this.detail = detail;
        this.name = 'TranscribeError';
    }
}
exports.TranscribeError = TranscribeError;
async function invoke(client, path, body) {
    const { data, error } = await client.functions.invoke(`ai-gateway/${path}`, { body });
    if (!error)
        return data;
    if (error instanceof supabase_js_1.FunctionsHttpError) {
        const res = error.context;
        let payload = null;
        try {
            payload = await res.json();
        }
        catch { /* 본문 없음 */ }
        throw new TranscribeError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? '녹음 변환 요청이 실패했습니다', res.status, payload);
    }
    if (error instanceof supabase_js_1.FunctionsRelayError || error instanceof supabase_js_1.FunctionsFetchError) {
        throw new TranscribeError('NETWORK', '서버에 연결하지 못했어요. 잠시 후 다시 시도하세요', undefined, error);
    }
    throw new TranscribeError('UNKNOWN', String(error?.message ?? error), undefined, error);
}
function toUint8(b) {
    return b instanceof Uint8Array ? b : new Uint8Array(b);
}
/** ① 녹음을 서버 임시 보관함에 올리기 (같은 uploadId로 다시 부르면 덮어씀) */
async function uploadRecording(client, input) {
    const type = (input.mimeType ?? 'audio/mp4').toLowerCase();
    const isBlob = typeof Blob !== 'undefined' && input.bytes instanceof Blob;
    const size = isBlob ? input.bytes.size : toUint8(input.bytes).byteLength;
    if (size === 0)
        throw new TranscribeError('INVALID_REQUEST', '빈 녹음 파일이에요');
    if (size > exports.STT_MAX_BYTES)
        throw new TranscribeError('TOO_LARGE', '녹음 파일은 25MB까지 보낼 수 있어요');
    const prep = await invoke(client, 'transcribe/prepare', {
        upload_id: input.uploadId, mime_type: type, size_bytes: size, file_name: input.fileName ?? 'recording.m4a',
    });
    const body = isBlob ? input.bytes : toUint8(input.bytes);
    const { error } = await client.storage.from(prep.bucket).uploadToSignedUrl(prep.path, prep.token, body, { contentType: type, upsert: true });
    if (error)
        throw new TranscribeError('UPLOAD_FAILED', '녹음을 올리지 못했어요. 연결을 확인하고 같은 녹음으로 다시 시도하세요', undefined, error);
    return { uploadId: input.uploadId, expiresAt: prep.expires_at };
}
/** ② 올린 녹음 → 글자 초안. 실패하면 녹음은 3일 남아 있어서 같은 uploadId로 다시 부르면 돼요 */
async function transcribeUploaded(client, input) {
    const dur = Number(input.durationSeconds);
    if (!Number.isFinite(dur) || dur <= 0)
        throw new TranscribeError('INVALID_REQUEST', '녹음 길이를 알 수 없어요');
    if (dur > exports.STT_MAX_SECONDS)
        throw new TranscribeError('DURATION_TOO_LONG', `한 번에 ${exports.STT_MAX_SECONDS / 60}분까지 보낼 수 있어요. 녹음을 나눠 주세요`);
    const keywords = (input.keywords ?? []).map((k) => k.replace(/[<>\r\n]/g, ' ').trim().slice(0, 60)).filter(Boolean);
    const d = await invoke(client, 'transcribe', {
        client_request_id: input.clientRequestId,
        upload_id: input.uploadId,
        duration_seconds: Math.round(dur * 10) / 10,
        workspace_id: input.workspaceId ?? null,
        languages: input.languages ?? ['ko', 'en'],
        keywords,
        prompt: input.prompt ? input.prompt.slice(-1000) : null,
    });
    return {
        requestId: d.request_id, text: d.draft.text, languages: d.draft.languages, durationSeconds: d.duration_seconds,
        chargedMinutes: d.charged_minutes, remainingMinutes: d.remaining_minutes, model: d.model, inputHash: d.input_hash,
        uploadDeleted: d.upload_deleted,
    };
}
/** ①+② 한 번에 */
async function transcribeAudio(client, input) {
    const dur = Number(input.durationSeconds);
    if (!Number.isFinite(dur) || dur <= 0)
        throw new TranscribeError('INVALID_REQUEST', '녹음 길이를 알 수 없어요');
    if (dur > exports.STT_MAX_SECONDS)
        throw new TranscribeError('DURATION_TOO_LONG', `한 번에 ${exports.STT_MAX_SECONDS / 60}분까지 보낼 수 있어요. 녹음을 나눠 주세요`);
    await uploadRecording(client, input);
    return transcribeUploaded(client, input);
}
/**
 * 실패했을 때 다음 행동
 *   same_request            잠시 뒤 같은 clientRequestId·uploadId로 transcribeUploaded
 *   new_request_same_upload 새 clientRequestId, 같은 uploadId로 transcribeUploaded (다시 올릴 필요 없음)
 *   reupload                uploadRecording부터 다시 (지워졌거나 안 올라감)
 *   stop                    사용자에게 알리고 멈춤 (동의·한도·형식·길이 등)
 */
function retryPlan(code) {
    if (['NETWORK', 'PROVIDER_ERROR', 'PROVIDER_UNREACHABLE', 'PROVIDER_RATE_LIMITED', 'PROVIDER_BAD_RESPONSE',
        'IN_PROGRESS', 'INTERNAL', 'STORAGE_ERROR'].includes(code))
        return 'same_request';
    if (['PROVIDER_TIMEOUT', 'RESULT_UNKNOWN', 'REQUEST_ID_REUSED'].includes(code))
        return 'new_request_same_upload';
    if (['NOT_UPLOADED', 'UPLOAD_GONE', 'UPLOAD_FAILED', 'NOT_FOUND'].includes(code))
        return 'reupload';
    return 'stop';
}
/** 같은 clientRequestId로 다시 시도해도 되는지 (retryPlan === 'same_request') */
function canRetryTranscribe(code) {
    return retryPlan(code) === 'same_request';
}
/** 나눠 녹음한 다음 조각에 넘길 prompt: 앞 조각의 끝부분 (문장 중간에서 자르지 않게) */
function continuationPrompt(previousText, maxChars = 300) {
    const t = previousText.trim();
    if (!t)
        return null;
    if (t.length <= maxChars)
        return t;
    const tail = t.slice(-maxChars);
    const cut = tail.search(/[.!?。]\s|\n/);
    return (cut >= 0 && cut < maxChars / 2 ? tail.slice(cut + 1) : tail).trim();
}
/** 이번 달 녹음 변환 사용량 (분). 남은 분 = STT_MONTHLY_MINUTES[plan] - used - reserved */
async function getSttUsage(client, now = new Date()) {
    const ym = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).format(now);
    const { data, error } = await client
        .from('usage_counters')
        .select('used, reserved')
        .eq('metric', 'AI_STT')
        .eq('period_start', `${ym.slice(0, 7)}-01`)
        .maybeSingle();
    if (error)
        throw new TranscribeError('NETWORK', '사용량을 불러오지 못했어요', undefined, error);
    return { usedMinutes: Number(data?.used ?? 0), reservedMinutes: Number(data?.reserved ?? 0) };
}
/** 오류 → 화면 문구 */
function transcribeErrorMessage(err) {
    const code = err?.code ?? '';
    switch (code) {
        case 'CONSENT_REQUIRED': return '녹음을 글자로 바꾸려면 외부 AI 사용 동의가 필요해요';
        case 'QUOTA_EXCEEDED': return '이번 달 녹음 변환 시간을 모두 썼어요';
        case 'DURATION_TOO_LONG': return `녹음은 한 번에 ${exports.STT_MAX_SECONDS / 60}분까지 바꿀 수 있어요. 나눠서 녹음해 주세요`;
        case 'TOO_LARGE': return '녹음 파일이 너무 커요 (25MB까지)';
        case 'UNSUPPORTED_TYPE': return '이 형식의 녹음은 바꿀 수 없어요 (m4a·mp3·wav)';
        case 'AUDIO_REJECTED': return '녹음 파일을 읽지 못했어요. 다시 녹음해 주세요';
        case 'FORBIDDEN': return '이 공간의 녹음을 바꿀 권한이 없어요';
        case 'TOO_MANY_PENDING': return '변환을 기다리는 녹음이 너무 많아요. 먼저 변환해 주세요';
        case 'UPLOAD_FAILED':
        case 'NOT_UPLOADED': return '녹음을 올리지 못했어요. 연결을 확인하고 다시 시도해 주세요';
        case 'UPLOAD_GONE':
        case 'NOT_FOUND': return '서버에 녹음이 없어요(변환이 끝났거나 3일이 지남). 다시 올려 주세요';
        case 'PROVIDER_TIMEOUT':
        case 'RESULT_UNKNOWN':
            return '변환이 늦어 결과를 받지 못했어요. 녹음은 서버에 3일 남아 있어서 다시 시도할 수 있어요';
        case 'ALREADY_DONE': return '이미 변환한 녹음이에요';
        case 'IN_PROGRESS': return '변환 중이에요. 잠시 후 다시 확인해 주세요';
        case 'AUTH_REQUIRED': return '로그인이 필요해요';
        case 'NOT_CONFIGURED':
        case 'PROVIDER_AUTH_FAILED':
        case 'PROVIDER_BAD_REQUEST':
            return '지금은 녹음 변환을 쓸 수 없어요 (서버 설정 확인 필요)';
        case 'NETWORK':
        case 'STORAGE_ERROR': return '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요';
        default: return '녹음을 글자로 바꾸지 못했어요. 잠시 후 다시 시도해 주세요';
    }
}
