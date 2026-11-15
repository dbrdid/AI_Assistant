/**
 * 기기 저장소가 요청을 거절할 때 던지는 오류. `code`는 화면이 분기할 수 있게 고정된 값입니다.
 *   invalid_input        칸이 없거나 타입·형식·길이가 틀림 (`field`가 그 칸 이름)
 *   empty_memo           제목·본문·손글씨가 모두 빈 메모
 *   not_found            현재 워크스페이스에 그런 메모·일정·제안·워크스페이스가 없음
 *   revision_conflict    expectedRevision이 현재 값과 다름
 *   source_changed       AI 분석 뒤 원본 메모가 바뀌었거나 지워짐
 *   already_processed    이미 승인·거절·대체된 제안
 *   personal_workspace   개인 공간은 지울 수 없고 서버 공간과 연결할 수 없음
 *   read_only            공유 공간에서 내 역할이 보기 전용(VIEWER)
 *   account_mismatch     이 기기 DB는 다른 계정의 것 (clearAll 뒤에 다시 bindAccount)
 *   unsupported_backup   백업 형식이 다르거나 더 새 버전
 * 그 밖의 오류(SQLite 실패, 코드 오류)는 LocalError가 아니며, 그때도 저장은 되지 않은 상태입니다.
 */
export class LocalError extends Error {
  constructor(code, field) {
    super(field ? `${code}: ${field}` : code);
    this.name = 'LocalError';
    this.code = code;
    if (field) this.field = field;
  }
}

export function fail(code, field) {
  throw new LocalError(code, field);
}
