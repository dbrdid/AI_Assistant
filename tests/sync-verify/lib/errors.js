"use strict";
// 서버 오류를 앱에서 다루기 쉬운 형태로 바꿉니다.
//   DB 함수(sync_push 등)는 "CODE: 설명" 형식의 메시지로 오류를 냅니다. 예) "FORBIDDEN: VIEWER는 수정할 수 없습니다"
//   AI Gateway는 { ok:false, code, message } JSON으로 오류를 돌려줍니다.
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiError = exports.SyncError = exports.StellaError = void 0;
exports.toSyncError = toSyncError;
exports.canRetryWithSameRequestId = canRetryWithSameRequestId;
class StellaError extends Error {
    code;
    status;
    details;
    constructor(code, message, status, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = 'StellaError';
    }
}
exports.StellaError = StellaError;
/** sync_push / sync_pull / create_workspace 등 DB 함수 오류 */
class SyncError extends StellaError {
    constructor(code, message, details) {
        super(code, message, undefined, details);
        this.name = 'SyncError';
    }
}
exports.SyncError = SyncError;
/** AI Gateway 오류 */
class AiError extends StellaError {
    constructor(code, message, status, details) {
        super(code, message, status, details);
        this.name = 'AiError';
    }
}
exports.AiError = AiError;
const CODE_RE = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/;
/** PostgREST 오류 → SyncError. 서버가 붙인 코드가 없으면 Postgres 오류 코드를 씀 */
function toSyncError(err) {
    const msg = err.message ?? '알 수 없는 오류';
    const m = CODE_RE.exec(msg);
    if (m)
        return new SyncError(m[1], m[2] || msg, err);
    // 외래키·형식 오류 등: Postgres SQLSTATE
    const pg = {
        '23503': 'REFERENCE_NOT_FOUND', // 연결 대상(메모·프로젝트·원문 등)이 이 공간에 없음
        '23514': 'CHECK_FAILED', // 값 범위·형식 위반 (예: 제목 길이, end_at < start_at)
        '23502': 'REQUIRED_FIELD', // 필수 값 누락
        '23505': 'DUPLICATE',
        '22P02': 'INVALID_FORMAT', // uuid·날짜 형식 오류
        '22007': 'INVALID_FORMAT',
        '22008': 'INVALID_FORMAT',
        '42501': 'FORBIDDEN',
        '28000': 'AUTH_REQUIRED',
        'PGRST301': 'AUTH_REQUIRED',
    };
    return new SyncError(pg[err.code ?? ''] ?? (err.code || 'UNKNOWN'), msg, err);
}
/**
 * AI 요청이 실패했을 때 "같은 client_request_id로 다시 보내도 되는지"
 *   true  → 같은 id로 재시도 (FAILED는 사용 횟수에 안 들어감)
 *   false → 새 id로 보내야 함 (RESULT_UNKNOWN·ALREADY_DONE·타임아웃은 이미 횟수에 포함)
 */
function canRetryWithSameRequestId(code) {
    return ![
        'RESULT_UNKNOWN', 'ALREADY_DONE', 'PROVIDER_TIMEOUT', 'REQUEST_ID_REUSED',
        'CONSENT_REQUIRED', 'QUOTA_EXCEEDED', 'FORBIDDEN', 'INVALID_REQUEST', 'INPUT_TOO_LONG', 'AUTH_REQUIRED',
    ].includes(code);
}
