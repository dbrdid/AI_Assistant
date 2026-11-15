"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecordingError = exports.RECORDING_AUDIO = exports.RECORDING_FAILED_KEEP_DAYS = exports.RECORDING_BUCKET = exports.RECORDING_MAX_SEGMENT_BYTES = exports.RECORDING_SEGMENT_SECONDS = exports.MAX_RECORDING_SECONDS = void 0;
exports.formatClock = formatClock;
exports.shouldStopRecording = shouldStopRecording;
exports.planSegments = planSegments;
exports.createRecording = createRecording;
exports.uploadRecordingSegments = uploadRecordingSegments;
exports.getRecordingStatus = getRecordingStatus;
exports.isRecordingSettled = isRecordingSettled;
exports.recordingProgressText = recordingProgressText;
exports.retryRecordingSegments = retryRecordingSegments;
exports.cancelRecording = cancelRecording;
exports.watchRecording = watchRecording;
exports.missingSegmentMarker = missingSegmentMarker;
exports.getRecordingTranscript = getRecordingTranscript;
exports.ackRecordingTranscript = ackRecordingTranscript;
exports.recordingErrorMessage = recordingErrorMessage;
exports.segmentErrorMessage = segmentErrorMessage;
exports.MAX_RECORDING_SECONDS = 3 * 60 * 60; // 3시간
exports.RECORDING_SEGMENT_SECONDS = 5 * 60; // 약 5분 구간 → 3시간이면 36개
exports.RECORDING_MAX_SEGMENT_BYTES = 25 * 1024 * 1024;
exports.RECORDING_BUCKET = 'stt-recordings';
exports.RECORDING_FAILED_KEEP_DAYS = 3;
/** 전송용 녹음 설정 (expo-audio RecordingOptions에 그대로). 모노 64kbps부터 품질 테스트 */
exports.RECORDING_AUDIO = { extension: '.m4a', sampleRate: 22050, numberOfChannels: 1, bitRate: 64000 };
class RecordingError extends Error {
    code;
    detail;
    constructor(code, message, detail) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.name = 'RecordingError';
    }
}
exports.RecordingError = RecordingError;
// ---------------------------------------------------------------------
// 1·2. 녹음 시간, 구간 나누기 계획
// ---------------------------------------------------------------------
/** 녹음 화면 경과 시간 "1:02:05" / "02:05" */
function formatClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
/** 3시간이 되면 녹음을 멈춰야 하는지 (일시정지 시간은 빼고 녹음된 길이 기준) */
function shouldStopRecording(recordedMillis) {
    return recordedMillis >= exports.MAX_RECORDING_SECONDS * 1000;
}
/**
 * 구간 계획: 약 5분씩, 마지막 조각이 너무 짧으면(30초 미만) 앞 구간에 붙임
 *   네이티브 분할 모듈에 그대로 넘기거나, 결과 확인용으로 써요
 */
function planSegments(totalSeconds, segmentSeconds = exports.RECORDING_SEGMENT_SECONDS, minLastSeconds = 30) {
    const total = Math.max(0, totalSeconds);
    if (total <= 0)
        return [];
    const n = Math.max(1, Math.ceil(total / segmentSeconds));
    const out = [];
    for (let i = 0; i < n; i++) {
        const start = i * segmentSeconds;
        out.push({ seq: i, startSeconds: start, durationSeconds: Math.min(segmentSeconds, total - start) });
    }
    const last = out[out.length - 1];
    if (out.length > 1 && last.durationSeconds < minLastSeconds) {
        out.pop();
        out[out.length - 1].durationSeconds += last.durationSeconds;
    }
    return out.map((s) => ({ ...s, durationSeconds: Math.round(s.durationSeconds * 100) / 100 }));
}
// ---------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------
function toStatus(d) {
    const c = d.counts ?? {};
    return {
        recordingId: d.recording_id,
        workspaceId: d.workspace_id ?? null,
        state: d.state,
        total: Number(d.total),
        totalSeconds: Number(d.total_seconds),
        counts: {
            pendingUpload: Number(c.pending_upload ?? 0), queued: Number(c.queued ?? 0), processing: Number(c.processing ?? 0),
            done: Number(c.done ?? 0), failed: Number(c.failed ?? 0), gaveUp: Number(c.gave_up ?? 0), canceled: Number(c.canceled ?? 0),
        },
        chargedMinutes: Number(d.charged_minutes ?? 0),
        retryUntil: d.retry_until ?? null,
        ackedAt: d.acked_at ?? null,
        segments: (d.segments ?? []).map((s) => ({
            seq: Number(s.seq), status: s.status, errorCode: s.error_code ?? null, path: s.path, mimeType: s.mime_type,
            sizeBytes: Number(s.size_bytes), startSeconds: Number(s.start_seconds), durationSeconds: Number(s.duration_seconds),
            retainUntil: s.retain_until ?? null, hasTranscript: !!s.has_transcript,
        })),
    };
}
async function rpc(client, fn, args) {
    let res;
    try {
        res = await client.rpc(fn, args);
    }
    catch (e) {
        throw new RecordingError('NETWORK', '서버에 연결하지 못했어요', e);
    }
    if (res.error) {
        const msg = String(res.error.message ?? '');
        if (/AUTH_REQUIRED|JWT|permission denied/i.test(msg))
            throw new RecordingError('AUTH_REQUIRED', '로그인이 필요해요', res.error);
        throw new RecordingError('NETWORK', '서버에 연결하지 못했어요', res.error);
    }
    if (res.data && res.data.ok === false) {
        throw new RecordingError(res.data.code ?? 'REJECTED', recordingErrorMessage({ code: res.data.code }), res.data);
    }
    return res.data;
}
async function byteLength(b) {
    if (typeof Blob !== 'undefined' && b instanceof Blob)
        return b.size;
    return b instanceof Uint8Array ? b.byteLength : b.byteLength;
}
/**
 * 녹음 등록. 같은 recordingId로 다시 부르면 기존 녹음을 돌려줘요(existing: true) → 이어서 업로드
 *   minutesNeeded > remainingMinutes면 "이번 달 남은 변환 시간 N분 — 앞부분만 변환돼요" 같은 안내를 보여 주세요
 */
async function createRecording(client, input) {
    if (input.segments.length === 0)
        throw new RecordingError('INVALID_REQUEST', '녹음 구간이 없어요');
    const total = input.segments.reduce((a, s) => a + s.durationSeconds, 0);
    if (total > exports.MAX_RECORDING_SECONDS + 60)
        throw new RecordingError('RECORDING_TOO_LONG', recordingErrorMessage({ code: 'RECORDING_TOO_LONG' }));
    const big = input.segments.find((s) => s.sizeBytes > exports.RECORDING_MAX_SEGMENT_BYTES);
    if (big)
        throw new RecordingError('TOO_LARGE', recordingErrorMessage({ code: 'TOO_LARGE' }), { seq: big.seq });
    const d = await rpc(client, 'stt_recording_create', {
        p_recording_id: input.recordingId,
        p_segments: input.segments.map((s) => ({
            seq: s.seq, duration_seconds: Math.round(s.durationSeconds * 100) / 100, size_bytes: s.sizeBytes, mime_type: s.mimeType ?? 'audio/mp4',
        })),
        p_workspace_id: input.workspaceId ?? null,
        p_languages: input.languages ?? ['ko', 'en'],
        p_keywords: (input.keywords ?? []).map((k) => k.replace(/[<>\r\n]/g, ' ').trim().slice(0, 60)).filter(Boolean),
    });
    return {
        ...toStatus(d), existing: !!d.existing, minutesNeeded: d.minutes_needed ?? null,
        remainingMinutes: Number(d.remaining_minutes ?? 0), plan: d.plan ?? 'FREE',
    };
}
/**
 * 남은 구간 업로드 (끊겼다가 다시 불러도 됨: 업로드 대기 구간만 올림)
 *   readSegment(seq)       : 구간 파일 내용 (expo-file-system: await new File(uri).bytes())
 *   onSegmentConfirmed(seq): 서버가 확인·등록한 구간 → 그 구간 임시 파일을 지우세요
 *                            (이미 등록된 구간도 한 번 불러 줘요: 지난번에 못 지운 임시 파일 정리용)
 *   결과 allUploaded면 기기 원본을 지워도 돼요
 */
async function uploadRecordingSegments(client, input) {
    let status = await getRecordingStatus(client, input.recordingId);
    if (status.state === 'CANCELED')
        throw new RecordingError('CANCELED', recordingErrorMessage({ code: 'CANCELED' }));
    const uploadedNow = [];
    let uploaded = status.segments.filter((s) => s.status !== 'PENDING_UPLOAD').length;
    input.onProgress?.({ uploaded, total: status.total });
    for (const s of status.segments) {
        if (s.status !== 'PENDING_UPLOAD') {
            if (s.status !== 'GAVE_UP')
                await input.onSegmentConfirmed?.(s.seq, { already: true });
            continue;
        }
        if (input.shouldStop?.())
            break;
        for (let attempt = 1;; attempt++) {
            const bytes = await input.readSegment(s.seq);
            const size = await byteLength(bytes);
            if (size !== s.sizeBytes) {
                throw new RecordingError('SIZE_MISMATCH', '구간 파일이 등록할 때와 달라요. 녹음을 다시 나눠 주세요', { seq: s.seq, expected: s.sizeBytes, actual: size });
            }
            const body = typeof Blob !== 'undefined' && bytes instanceof Blob ? bytes : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            const { error } = await client.storage.from(exports.RECORDING_BUCKET).upload(s.path, body, { contentType: s.mimeType, upsert: true });
            if (error)
                throw new RecordingError('UPLOAD_FAILED', recordingErrorMessage({ code: 'UPLOAD_FAILED' }), { seq: s.seq, error });
            const { data, error: cErr } = await client.rpc('stt_segment_confirm', { p_recording_id: input.recordingId, p_seq: s.seq });
            if (cErr)
                throw new RecordingError('NETWORK', '서버에 연결하지 못했어요', cErr);
            if (data?.ok)
                break;
            // 올라갔는데 확인이 안 되면(크기 다름·아직 안 보임) 한 번 더 올림
            if (attempt < 2 && (data?.code === 'SIZE_MISMATCH' || data?.code === 'NOT_UPLOADED'))
                continue;
            throw new RecordingError(data?.code ?? 'UPLOAD_FAILED', recordingErrorMessage({ code: data?.code ?? 'UPLOAD_FAILED' }), data);
        }
        uploadedNow.push(s.seq);
        uploaded++;
        input.onProgress?.({ uploaded, total: status.total });
        await input.onSegmentConfirmed?.(s.seq, { already: false });
    }
    status = await getRecordingStatus(client, input.recordingId);
    return { allUploaded: status.counts.pendingUpload === 0 && status.state !== 'CANCELED', uploadedNow, status };
}
// ---------------------------------------------------------------------
// 4. 진행 상태·재시도·취소
// ---------------------------------------------------------------------
async function getRecordingStatus(client, recordingId) {
    return toStatus(await rpc(client, 'stt_recording_status', { p_recording_id: recordingId }));
}
/** 더 기다려도 바뀌지 않는 상태인지 (사용자 행동이 필요하거나 끝남) */
function isRecordingSettled(state) {
    return state !== 'UPLOADING' && state !== 'PROCESSING';
}
/**
 * 진행 문구 (줄 단위). 예)
 *   ["음성 변환 중 · 36개 중 24개 완료", "실패한 구간 1개 · 재시도 가능"]
 */
function recordingProgressText(s, now = new Date()) {
    const c = s.counts;
    const lines = [];
    const canRetry = c.failed > 0 && (!s.retryUntil || new Date(s.retryUntil) > now);
    switch (s.state) {
        case 'UPLOADING':
            lines.push(`업로드 중 · ${s.total}개 중 ${s.total - c.pendingUpload}개 올림`);
            break;
        case 'PROCESSING':
            lines.push(`음성 변환 중 · ${s.total}개 중 ${c.done}개 완료`);
            break;
        case 'NEEDS_RETRY':
            lines.push(`음성 변환 · ${s.total}개 중 ${c.done}개 완료`);
            break;
        case 'DONE':
            lines.push('음성 변환 완료');
            break;
        case 'DONE_WITH_GAPS':
            lines.push(`음성 변환 완료 · ${c.gaveUp + c.canceled}개 구간은 복구하지 못함`);
            break;
        case 'FAILED':
            lines.push('음성 변환 실패');
            break;
        case 'CANCELED':
            lines.push('취소됨');
            break;
    }
    if (c.failed > 0 && s.state !== 'CANCELED') {
        lines.push(canRetry ? `실패한 구간 ${c.failed}개 · 재시도 가능${s.retryUntil ? ` (${formatDeadline(s.retryUntil)}까지)` : ''}`
            : `실패한 구간 ${c.failed}개`);
    }
    return { lines, canRetry };
}
function formatDeadline(iso) {
    const d = new Date(iso);
    const p = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return p.format(d);
}
/** 실패 구간 다시 시도 (seqs 생략하면 전부). 보관 기한(최초 실패 + 3일)은 늘어나지 않아요 */
async function retryRecordingSegments(client, recordingId, seqs) {
    const d = await rpc(client, 'stt_recording_retry', { p_recording_id: recordingId, p_seqs: seqs ?? null });
    return Number(d.requeued ?? 0);
}
/** 취소: 새 처리 중단, 서버의 음성·전사문 정리. 기기 임시 파일은 앱이 지우세요 */
async function cancelRecording(client, recordingId) {
    await rpc(client, 'stt_recording_cancel', { p_recording_id: recordingId });
}
/**
 * 진행 상태를 주기적으로 받기. 끝나거나 사용자 행동이 필요해지면(isRecordingSettled) 스스로 멈춤
 *   업로드 중에는 업로드와 함께 쓰세요. 앱을 닫아도 서버 처리는 계속돼요
 */
function watchRecording(client, recordingId, opts) {
    let stopped = false;
    let timer = null;
    const tick = async () => {
        if (stopped)
            return;
        try {
            const s = await getRecordingStatus(client, recordingId);
            if (stopped)
                return;
            opts.onUpdate(s);
            if (isRecordingSettled(s.state)) {
                stopped = true;
                return;
            }
        }
        catch (e) {
            opts.onError?.(e);
        }
        if (!stopped)
            timer = setTimeout(tick, opts.intervalMs ?? 4000);
    };
    void tick();
    return { stop: () => { stopped = true; if (timer)
            clearTimeout(timer); } };
}
function missingSegmentMarker(seq, startSeconds, durationSeconds, status) {
    const what = status === 'QUEUED' || status === 'PROCESSING' || status === 'PENDING_UPLOAD' ? '변환 중' : '변환 실패';
    return `[구간 ${seq + 1} (${formatClock(startSeconds)}~${formatClock(startSeconds + durationSeconds)}) ${what}]`;
}
async function getRecordingTranscript(client, recordingId) {
    const d = await rpc(client, 'stt_recording_transcript', { p_recording_id: recordingId });
    const segments = (d.segments ?? []).map((s) => ({
        seq: Number(s.seq), status: s.status, errorCode: s.error_code ?? null,
        startSeconds: Number(s.start_seconds), durationSeconds: Number(s.duration_seconds),
        text: typeof s.text === 'string' ? s.text : null, languages: s.languages ?? [],
    }));
    const parts = segments.map((s) => s.status === 'DONE' && s.text !== null
        ? s.text.trim()
        : missingSegmentMarker(s.seq, s.startSeconds, s.durationSeconds, s.status));
    const missing = segments.filter((s) => !(s.status === 'DONE' && s.text !== null))
        .map((s) => ({ seq: s.seq, status: s.status, errorCode: s.errorCode, startSeconds: s.startSeconds, durationSeconds: s.durationSeconds }));
    return {
        text: parts.filter((p) => p.length > 0).join('\n\n'),
        segments: segments.map(({ errorCode: _e, ...rest }) => rest),
        missing, complete: missing.length === 0, state: d.state,
    };
}
/** 전사문을 기기(SQLite)·공유 공간에 저장한 뒤 호출 → 서버 임시 전사문 삭제 */
async function ackRecordingTranscript(client, recordingId) {
    const d = await rpc(client, 'stt_recording_ack', { p_recording_id: recordingId });
    return Number(d.cleared ?? 0);
}
/** 오류 → 화면 문구 */
function recordingErrorMessage(err) {
    const code = err?.code ?? '';
    switch (code) {
        case 'CONSENT_REQUIRED': return '녹음을 글자로 바꾸려면 외부 AI 사용 동의가 필요해요';
        case 'FORBIDDEN': return '이 공간에 녹음을 저장할 권한이 없어요';
        case 'RECORDING_TOO_LONG': return '녹음은 3시간까지 처리할 수 있어요';
        case 'TOO_LARGE': return '구간 파일이 너무 커요 (25MB까지). 더 짧게 나눠 주세요';
        case 'UNSUPPORTED_TYPE': return '이 형식은 처리할 수 없어요 (m4a·mp3)';
        case 'TOO_MANY_SEGMENTS': return '구간이 너무 많아요 (60개까지)';
        case 'TOO_MANY_ACTIVE': return '처리 중인 녹음이 3개 있어요. 끝난 뒤에 다시 시도해 주세요';
        case 'RECORDING_EXISTS':
        case 'RECORDING_ID_TAKEN': return '이미 등록된 녹음이에요. 새 녹음으로 다시 시도해 주세요';
        case 'UPLOAD_FAILED':
        case 'NOT_UPLOADED': return '구간을 올리지 못했어요. 연결을 확인하면 남은 구간부터 이어서 올려요';
        case 'SIZE_MISMATCH': return '구간 파일이 손상됐어요. 녹음을 다시 나눠 주세요';
        case 'CANCELED': return '취소된 녹음이에요';
        case 'NOT_FOUND': return '서버에 이 녹음이 없어요 (정리됐거나 다른 계정)';
        case 'QUOTA_EXCEEDED': return '이번 달 녹음 변환 시간을 모두 썼어요';
        case 'AUTH_REQUIRED': return '로그인이 필요해요';
        case 'NETWORK': return '서버에 연결하지 못했어요. 연결을 확인해 주세요';
        default: return '녹음을 처리하지 못했어요. 잠시 후 다시 시도해 주세요';
    }
}
/** 구간 실패 이유 → 짧은 문구 (실패 구간 목록에) */
function segmentErrorMessage(code) {
    switch (code) {
        case 'QUOTA_EXCEEDED': return '이번 달 변환 시간 초과';
        case 'AUDIO_REJECTED':
        case 'AUDIO_MISSING': return '음성을 읽지 못함';
        case 'UPLOAD_EXPIRED': return '3일 안에 올리지 못함';
        case 'CONSENT_REQUIRED': return '외부 AI 동의 필요';
        case 'FORBIDDEN': return '공간 권한 없음';
        case 'PROVIDER_TIMEOUT': return '변환 시간 초과';
        default: return '일시 오류';
    }
}
