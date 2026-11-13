# AI 동의와 내구성 큐 (SQLite)

`db/schema.sql`의 AI 테이블 6개와 `rpc/ai.js`의 RPC 13개입니다. 합성 데이터로만 검증한 로컬 인프라이며, 배포된 AI 서비스가 아닙니다. 라우트, 실제 예산, 자격 증명, 제공자 호출, KMS는 아무것도 설정되어 있지 않습니다. AI 초안은 문서를 바꾸지 않습니다.

## 신뢰와 권한

- 예전 PostgreSQL의 RLS·`ai_executor` 역할·`sync_backend` 소유권 대신 `rpc/index.js`의 역할 허용 목록이 막습니다. 사용자 RPC 4개는 `authenticated`(검증된 uid)만, 실행 RPC 9개는 `ai_executor`만 부를 수 있습니다. `ai_executor`는 서버 경로(gateway의 입장, worker)에서만 쓰고 모바일 클라이언트에 노출하지 않습니다. 클라이언트가 보낸 actor ID를 검증된 신원으로 받지 않습니다.
- DB 파일 접근 = 모든 행 접근입니다. 파일 권한으로 서버 프로세스만 읽게 해야 합니다.
- 라우트 레지스트리는 route ID마다 불변이고 비어 있습니다. 공급자·모델·보존 정책·상한이 바뀌면 새 route ID가 필요합니다. 등록은 설정일 뿐 유료 호출 허가가 아닙니다.
- 입력·결과는 불투명 참조(`[A-Za-z0-9_-]{1,200}`)만 저장합니다. URL이나 본문 바이트는 저장하지 않습니다.

## AI 스위치와 편집 권한 (F29 최소)

- 모든 workspace는 owner가 `set_ai_enabled(w, true)`를 부르기 전까지 AI가 꺼져 있습니다. 스위치는 `access_epoch`를 올리지 않습니다.
- `ai_grant_consent`: 요청 검사 → 라우트 검사(`invalid_route`) → 비멤버면 `invalid_consent`(존재하는 workspace와 없는 workspace를 구분할 수 없음) → AI 꺼짐이면 `ai_disabled` → `aiAllowed` 실패면 `invalid_consent`.
- `aiAllowed`(동의, 입장, `ai_begin_dispatch`에서 사용): actor가 없으면(계정 삭제) 거짓. 그 밖에는 문서 편집 권한(`document_rank >= 2`, 상위 폴더 ACL과 역할 상한 포함), AI 켜짐, 동의의 source revision과 같은 살아 있는 문서, 철회되지 않고 만료되지 않은 동의가 모두 필요합니다.
- `ai_admit_job`은 재요청 경로보다 먼저 AI 스위치를 확인하므로, AI가 꺼지면 같은 재시도도 거부되고 아무것도 예약되지 않습니다.
- `ai_begin_dispatch`는 `aiAllowed`를 다시 확인하여, 그 사이 AI가 꺼졌거나 권한·문서가 바뀌었거나 계정이 삭제되었으면 작업을 취소하고 예약을 해제합니다.
- `ai_job_status`는 호출자가 문서를 읽을 수 있을 때(`document_rank >= 1`)만 초안 참조를 포함한 전체 상태를 돌려주고, 아니면 `{id, state, cancel_requested}`만 줍니다.

## RPC 계약

금액·revision·펜싱 토큰은 응답에서 10진 문자열이고, `max_output_tokens`는 JSON 정수입니다. 금액은 모두 정수 마이크로USD(`1000000` = USD 1.00)이며 부동소수점을 쓰지 않습니다. 시각은 마이크로초까지의 UTC 문자열입니다.

사용자(`authenticated`):

- `ai_grant_consent(p_request)`: 허용 키 외에는 거부. `approved:true`, uuid 세 개, `source_revision`(1~19자리 10진 문자열), `max_cost_microusd`(1~18자리 10진 문자열), 정수 `max_output_tokens`, 소문자 SHA-256, `purpose:'summary'`, `retention_version`, 지금부터 24시간 이내의 `expires_at`. 같은 동의 재요청은 멱등, 같은 ID에 다른 내용이면 `consent_id_reused`.
- `ai_job_status(p_job_id)`, `ai_cancel_job(p_job_id)`, `ai_revoke_consent(p_consent_id)`: 다른 사람의 작업·동의와 없는 ID는 똑같이 `forbidden`. 취소·철회는 `queued`/`claimed`면 예약을 해제하고 `cancelled`로, `dispatched`/`outcome_unknown`이면 `cancel_requested`만 표시합니다(이미 제출되었을 수 있으므로).

실행(`ai_executor`):

- `ai_set_route(p_request)`, `ai_set_budget(p_workspace_id, p_actor_id, p_period, p_limit_microusd)`: 한 번 쓰면 불변(`route_immutable`, `budget_immutable`). 예산은 UTC 월(`YYYY-MM`)마다 workspace 행(scope `''`)과 actor 행(scope = actor uuid)이 있어야 합니다.
- `ai_admit_job(p_actor_id, p_request)`: 동의 하나에 작업 하나(`consent_already_used`). 같은 job_id와 같은 요청은 멱등, 다른 요청이면 `job_id_reused`. 활성 작업 3개 또는 분당 10개면 `rate_limited`. 이번 달 예산 행 두 개가 모두 있어야 하고(`budget_not_configured`), 둘 다 상한만큼 여유가 있어야 합니다(`budget_exceeded`). **예약(held 증가)과 큐 삽입은 같은 트랜잭션**이라 하나만 남는 일이 없습니다.
- `ai_claim_job(p_lease_seconds)`: 큐에서 가장 작은 workspace id의 가장 오래된 작업을 꺼내 펜싱 토큰을 1 올리고 리스를 겁니다(1~900초). 없으면 `null`.
- `ai_begin_dispatch`, `ai_fail_before_dispatch`, `ai_mark_unknown`, `ai_settle_job`: 펜싱 토큰이 다르면 `stale_fence`, 없는 작업은 `job_not_found`. dispatch 전 상태가 아니거나 리스가 끝났으면 `not_claimed`. 정산은 비용이 예약 이하(`invalid_cost`), 결과 참조와 결과가 맞아야 하고(`invalid_outcome`), 제공자 이벤트 ID는 한 번만(`event_id_reused`). 같은 정산 재요청은 멱등, 다른 값이면 `settlement_conflict`. 취소 요청된 작업의 늦은 결과는 비용만 정산하고 결과 참조를 버립니다.
- `ai_reap_jobs()`: 리스가 끝난 `claimed`는 다시 `queued`로, `dispatched`는 `outcome_unknown`으로 바꿉니다(예약 유지, 자동 재시도 없음). 이를 주기적으로 부르는 스케줄러는 아직 없습니다.

## 계정 삭제 (F24)

`backend.deleteUser(u)`는 동기화 정리 뒤 AI 행을 정리합니다. 혼자 쓰던 workspace는 문서와 함께 동의·작업·시도·원장·예산이 연쇄 삭제됩니다. 남는 workspace에서는 u의 동의·작업이 `actor_id = NULL`로 남고, 작업의 `request_hash`는 actor ID를 확인할 수 없도록 작업 ID의 해시로 바뀝니다. u의 예산 행은 삭제됩니다. actor 없는 작업은 `aiAllowed`가 항상 거짓이므로 dispatch되지 않고, 취소·실패 시 workspace 예약만 해제합니다.

## 알려진 한계

- 실제 제공자, 운영 KMS, 결과 파일 제공 경로, 자동 TTL 정리, reaper 스케줄러는 없습니다.
- `dispatched` 뒤 실패는 모두 `outcome_unknown`으로 남고 예약을 유지합니다. 정산은 검증된 제공자 증거로 수동 조정해야 합니다.
- 여러 프로세스가 같은 DB 파일에 동시에 쓰는 경우는 `busy_timeout`(기본 5초)에 맡기며 검증하지 않았습니다.
