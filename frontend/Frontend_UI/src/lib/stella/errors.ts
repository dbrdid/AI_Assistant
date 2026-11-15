// 서버 오류를 앱에서 다루기 쉬운 형태로 바꿉니다.
//   DB 함수(sync_push 등)는 "CODE: 설명" 형식의 메시지로 오류를 냅니다. 예) "FORBIDDEN: VIEWER는 수정할 수 없습니다"
//   AI Gateway는 { ok:false, code, message } JSON으로 오류를 돌려줍니다.

export class StellaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StellaError';
  }
}

/** sync_push / sync_pull / create_workspace 등 DB 함수 오류 */
export class SyncError extends StellaError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, undefined, details);
    this.name = 'SyncError';
  }
}

/** AI Gateway 오류 */
export class AiError extends StellaError {
  constructor(code: string, message: string, status?: number, details?: unknown) {
    super(code, message, status, details);
    this.name = 'AiError';
  }
}

const CODE_RE = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/;

/** PostgREST 오류 → SyncError. 서버가 붙인 코드가 없으면 Postgres 오류 코드를 씀 */
export function toSyncError(err: { message?: string; code?: string; details?: unknown; hint?: unknown }): SyncError {
  const msg = err.message ?? '알 수 없는 오류';
  const m = CODE_RE.exec(msg);
  if (m) return new SyncError(m[1], m[2] || msg, err);
  // 외래키·형식 오류 등: Postgres SQLSTATE
  const pg: Record<string, string> = {
    '23503': 'REFERENCE_NOT_FOUND',   // 연결 대상(메모·프로젝트·원문 등)이 이 공간에 없음
    '23514': 'CHECK_FAILED',          // 값 범위·형식 위반 (예: 제목 길이, end_at < start_at)
    '23502': 'REQUIRED_FIELD',        // 필수 값 누락
    '23505': 'DUPLICATE',
    '22P02': 'INVALID_FORMAT',        // uuid·날짜 형식 오류
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
export function canRetryWithSameRequestId(code: string): boolean {
  return ![
    'RESULT_UNKNOWN', 'ALREADY_DONE', 'PROVIDER_TIMEOUT', 'REQUEST_ID_REUSED',
    'CONSENT_REQUIRED', 'QUOTA_EXCEEDED', 'FORBIDDEN', 'INVALID_REQUEST', 'INPUT_TOO_LONG', 'AUTH_REQUIRED',
  ].includes(code);
}
