# backend/local

기기 내부 SQLite, CRUD, 트랜잭션, AI 요청과 결과 적용을 담당합니다. 권한과 입력 검증 후 사용자 승인에 따라 DB를 변경합니다. 네이티브 구현은 아직 없습니다. 클라우드 추론 동의와 동기화 동의를 구분합니다.

## 현재 들어 있는 코드

동기화·협업·계정 삭제와 AI 동의·예산·큐를 **SQLite(Node 내장 `node:sqlite`)** 위에서 처리하는 백엔드입니다. 2026-11-13에 Supabase(PostgreSQL) 마이그레이션과 PL/pgSQL 함수를 JS로 옮겼습니다. 2026-11-14 기존 별도 Fastify 서버를 제거했으며, 이 폴더의 DB·RPC·Gateway·Worker는 유지합니다. 실제 모델·모바일 연결은 여전히 별도 통합 대상입니다.

| 경로 | 내용 |
|---|---|
| `db/schema.sql` | SQLite 테이블 19개. 복합 외래키(workspace_id 포함), CHECK, 부분 인덱스 |
| `db/database.js` | DB 열기(`foreign_keys=ON`, 파일이면 WAL), 스키마 적용(`user_version`), 트랜잭션 |
| `rpc/core.js` | 오류 계약(`RpcError`), 인자 타입 검사, 권한 계산(역할·폴더·문서 ACL), audit, 신호 |
| `rpc/sync.js` | 동기화 RPC 26개와 계정 삭제(`forgetUser`) |
| `rpc/ai.js` | AI RPC 13개와 계정 삭제 시 AI 행 정리 |
| `rpc/index.js` | `createBackend()`: 역할별 허용 목록, 호출 하나 = 트랜잭션 하나, `createUser`/`deleteUser` |
| `adapters/sqlite-ai.js` | gateway·worker가 쓰는 `userRpc`/`privilegedRpc` 브리지 |
| `adapters/encrypted-vault.js` | 서버용 AES-256-GCM 파일 보관(키는 호출자가 공급) |
| `gateway/`, `worker/` | AI Gateway(JWT 검증)와 1회 시도 worker. DB 종류와 무관 |
| `contracts/errors.js` | 오류 계약 v1(사유 → HTTP 상태) |
| `tests/` | `node --test`용 테스트. 실제 SQLite(메모리 또는 임시 파일)와 합성 데이터만 사용 |

실행: `cd backend/local && npm install && npm test` (Node 22.13 이상, `node:sqlite` 사용). AI 데모: `npm run demo:ai`(합성 제공자, 과금 없음).

배포·운영 DB 변경·실제 AI 제공자 호출은 하지 않았습니다.

## 사용법

```js
import { createBackend } from './rpc/index.js';
const backend = createBackend({ path: 'data/backend.sqlite' }); // 기본값 ':memory:'
backend.createUser(userId);                                      // 계정 등록(예전 auth.users)
backend.call({ role: 'authenticated', uid: userId }, 'create_workspace', { p_workspace_id, p_name });
backend.call({ role: 'ai_executor' }, 'ai_claim_job', { p_lease_seconds: 60 });
backend.call({ role: 'sync_maintainer' }, 'purge_expired_trash', { p_limit: 100 });
backend.deleteUser(userId);                                      // 계정 삭제와 정리(F24)
```

- 인자는 이름으로(`{p_x: ...}`, 예전 PostgREST 방식) 또는 위치 배열로 넘깁니다. 없는 인자 이름이나 빠진 필수 인자는 `RpcFault`(code `42883`)입니다.
- 역할 허용 목록(예전 GRANT): `authenticated`는 동기화 RPC 25개와 사용자 AI RPC 4개, `ai_executor`는 AI 실행 RPC 9개, `sync_maintainer`는 `purge_expired_trash`만 부를 수 있습니다. 그 밖의 호출은 `RpcFault`(code `42501`)입니다. `uid`는 `authenticated`에서만 쓰입니다. 호출자가 **검증한** 사용자 ID만 넘겨야 합니다(JWT 검증은 gateway 몫).
- 업무 오류는 `RpcError`이며 `code`는 `PT<상태>`, `message`는 계약 사유입니다(`contracts/errors.js`의 `serverError(code, message)`가 그대로 인식). 잘못된 JSON 타입은 `invalid_request`입니다.
- 시각은 DB에 마이크로초 정수로 저장되고, 응답에서는 `2026-11-10T01:02:03.456789Z` 형식 UTC 문자열입니다. 테스트는 `createBackend({ now })`로 시계를 주입합니다.

## 보안 모델: PostgreSQL에서 바뀐 점

- **DB 자체의 방어가 없습니다.** RLS, DB 역할, SECURITY DEFINER가 사라졌습니다. 모든 권한 검사는 `rpc/*.js`가 합니다. DB 파일을 읽을 수 있는 사람은 모든 워크스페이스의 행(암호문 제외 메타데이터, ACL, audit)을 읽을 수 있으므로 파일 권한을 서버 프로세스로 제한해야 합니다. 클라이언트에 DB 파일이나 `backend.db`를 노출하지 않습니다.
- **잠금 대신 단일 작성자.** 각 RPC는 `BEGIN IMMEDIATE` 트랜잭션 하나에서 동기 실행됩니다. 실행 중에는 다른 호출이 끼어들 수 없으므로 workspace 행 잠금, 잠금 순서, `SKIP LOCKED`, `lock_timeout`이 필요 없습니다. 대신 쓰기가 직렬화되므로 동시 접속이 많은 서버에는 맞지 않습니다.
- **계정 삭제는 함수 호출입니다.** 예전 `auth.users` BEFORE DELETE 트리거 대신 `backend.deleteUser(id)`가 같은 트랜잭션에서 정리하고 계정 행을 지웁니다.
- **Realtime·PostgREST·Supabase Auth가 없습니다.** `user_signals` 테이블은 남아 있지만, 이를 클라이언트에 밀어 주는 경로와 HTTP API는 아직 없습니다.
- **정수 범위.** 카운터와 금액은 JS 숫자로 다루므로 2^53을 넘는 값(펜싱 토큰, 비용, 예산 한도)은 `invalid_request`로 거부합니다. PostgreSQL bigint는 9.2×10^18까지 받았지만 실제로 도달할 수 없는 범위입니다. 문서 revision·ACL 버전 문자열은 여전히 19자리까지 형식 검사를 합니다.
- 서명된 JWT 검증, 운영 KMS, 키 복구, 실제 AI 제공자, Storage 소비자(`storage_deletions`)는 여전히 미구현입니다.

## 권한과 데이터 규칙 (예전 SQL과 같음)

- 기존 workspace를 다루는 RPC는 먼저 subject를 확인하고(`unauthenticated`), workspace를 찾은 뒤(없으면 `forbidden`) 현재 권한을 판단합니다. 입력 오류(`invalid_*`), 대상 없음(`*_not_found`), 상태 충돌은 그 뒤에 검사하므로 비멤버는 존재하는 workspace에서도 없는 workspace와 같은 `forbidden`만 받습니다.
- 콘텐츠 접근은 workspace 역할을 상한으로 모든 상위 폴더와 문서 ACL의 교집합입니다(owner 포함). ACL `null`은 상속, `{}`는 모두 금지입니다. 새 폴더·문서는 `null`(상속)입니다(F01). ACL 키는 현재 멤버여야 하고(F12) 정규 uuid로 저장됩니다(F15). 멤버가 빠지면 그 키를 모든 ACL에서 지우고 버전을 올립니다. owner는 `list_acls`로 자신이 볼 수 없는 폴더·문서의 메타데이터와 ACL을 볼 수 있지만, 내용을 읽으려면 자신에게 권한을 줘야 합니다.
- 가시성(멤버십, 역할, ACL)을 실제로 바꾸는 호출만 `access_epoch`를 정확히 1 올립니다. 아무것도 바꾸지 않는 호출은 epoch, audit, 신호를 모두 그대로 둡니다(`changed:false`).
- 문서 변경, journal(revision 스냅샷), audit, head, receipt, 신호는 하나의 트랜잭션입니다. `op_id` 재사용은 요청 해시(정규화 JSON의 SHA-256)로 검증합니다(`op_id_reused`).
- 삭제는 휴지통(tombstone)으로 남고 push로 부활하지 않습니다. `restore_document`만 720시간 안에 되살립니다(F27). `purge_expired_trash`는 기간이 지난 내용을 지우며, 클라이언트가 읽는 값은 바뀌지 않으므로 신호를 남기지 않습니다.
- 신호(`user_signals`)에는 user_id, workspace_id, generation만 있습니다. 문서 ID나 콘텐츠는 없습니다.
- 초대(`invitations`)에는 계정 외래키가 없습니다. 초대가 계정 존재 여부를 알려 주지 않게 하려는 것입니다.

## RPC 목록

UUID는 소문자 표준 형식입니다. revision, head, access_epoch, scanned_through, seq, acl_version은 JSON 문자열입니다. 목록 RPC는 id 순서의 keyset 페이지이고, 더 있을 때만 `next_id`를 줍니다(`p_limit` 1~500, 기본 100). 읽기 응답은 4 MiB 바이트 예산 안에서 자르며 첫 요소는 항상 포함합니다.

워크스페이스와 멤버십: `create_workspace`, `list_my_workspaces`, `invite_member`, `respond_invitation`, `set_member`, `leave_workspace`, `offer_ownership`, `accept_ownership`, `list_members`, `list_invitations`, `list_my_invitations`, `set_ai_enabled`

폴더와 ACL: `create_folder`, `list_folders`, `get_acl`, `list_acls`, `set_folder_acl`, `set_document_acl`(compare-and-set, 같은 ACL이면 버전과 무관하게 `changed:false`)

문서: `create_document`, `push_document`(`applied`/`conflict`/`deleted`), `restore_document`(`applied`/`conflict`/`deleted`/`restore_expired`), `list_trash`

읽기: `pull_changes`(epoch가 다르면 `reset_required`, 커서가 head보다 크면 `cursor_ahead`), `list_accessible_documents`(`restart_required`), `get_documents`(숨김·없는 ID는 건너뛰고 `processed`에만 셈)

운영: `purge_expired_trash`(sync_maintainer, 한 번에 workspace 하나, 가장 작은 id부터, `more`가 true인 동안 반복)

AI RPC 13개는 [AI-DATABASE.md](AI-DATABASE.md)를 봅니다.

## 테스트

`npm test`는 다음을 실행합니다.

- `tests/sync.test.mjs`: 역할 허용 목록, push/conflict/receipt, 암호문 검증, pull 커서와 창, 바이트 예산, 원자적 롤백, 신호
- `tests/lifecycle.test.mjs`: R1(외부인 거부와 무변경), 초대·소유권, ACL 정규화와 CAS, 상속과 제거, 목록, epoch 불변식, 휴지통·복구·purge, 계정 삭제(SEC-2 포함)
- `tests/ai.test.mjs`: 라우트·예산 불변, 동의 검증, 입장(멱등·예약), 펜싱과 리스, 정산, 취소·철회, 속도 제한, 계정 삭제
- `tests/ai.integration.test.mjs`: 서명된 JWT → gateway → SQLite → worker → 암호화 초안까지의 합성 파이프라인(파일 DB 재시작 포함)
- `tests/vault.test.mjs`, `gateway/tests`, `worker/tests`

예전 PGlite 테스트 중 PostgreSQL에만 의미가 있던 검증(xmax 잠금 관찰, `pg_stat` 읽기 비용, hosted Supabase 권한 시뮬레이션, 함수 본문 잠금 순서)은 옮기지 않았습니다. SQLite에서는 대응하는 개념이 없습니다. 여러 프로세스가 같은 파일에 동시에 쓰는 경우(`busy_timeout`)는 검증하지 않았습니다.
