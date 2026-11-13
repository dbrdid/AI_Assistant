# backend/local

기기 내부 SQLite, CRUD, 트랜잭션, AI 요청과 결과 적용을 담당합니다. 권한과 입력 검증 후 사용자 승인에 따라 DB를 변경합니다. 네이티브 구현은 아직 없습니다. 클라우드 추론 동의와 동기화 동의를 구분합니다.

## 현재 들어 있는 코드 (dbrdid)

이 폴더의 코드는 별도 로컬 프로젝트(차곡 모바일 프로젝트)의 백엔드 부분을 옮긴 것입니다. 위 역할 설명과 달리 기기 내부 SQLite 구현이 아니라, Supabase(PostgreSQL) 동기화 서버 SQL과 AI 큐입니다. 저장소의 `backend/cloud`(Fastify + Ollama)와는 아직 연결되지 않았습니다.

- 포함: PostgreSQL/Supabase 마이그레이션(동기화·협업·계정 삭제, AI 동의·예산·큐), AI Gateway·Worker·어댑터, PGlite 기반 테스트.
- 오류 계약: 원래 `shared/contracts/errors.js`에 있던 파일을 `contracts/errors.js`로 복사해 이 폴더 안에서 참조합니다. 저장소의 `shared/contracts`에 합칠지는 팀과 계약을 합의한 뒤 정합니다.
- 포함하지 않음: 모바일 앱, 클라이언트 동기화 엔진과 기기 저장소 모듈. 아래 본문의 `shared/…`, `frontend/…`, `docs/implementation-status.md` 언급은 원래 프로젝트 기준입니다.
- 배포·운영 DB 변경·실제 AI 제공자 호출은 하지 않았습니다. 검증은 모두 로컬 PGlite(단일 세션)와 합성 데이터로만 했습니다.

실행: `cd backend/local && npm install && npm test` (Node 22.13 이상). AI 데모: `npm run demo:ai`(합성 제공자, 과금 없음).

---

# Supabase 동기화 기반

## 구현 및 검증 범위

`supabase/migrations/202611090001_sync.sql`은 로컬 검증용 초기 마이그레이션입니다. 배포하거나 운영 서비스 설정을 변경하지 않았습니다. Supabase의 `auth.users`, `auth.uid()`, `authenticated`, `anon`이 이미 존재하는 환경을 전제로 합니다. 테스트만 별도 auth 스텁을 생성합니다. 첫 hosted 배포 전까지는 마이그레이션 파일을 제자리에서 고치고, 배포한 뒤에는 모든 변경을 새 마이그레이션 파일로 추가해야 합니다.

루트에서 실행:

```sh
node --test backend/supabase/tests/*.test.mjs
```

PGlite에서 실제 PostgreSQL SQL을 실행합니다. RLS/권한, ACL 교집합과 상속, 복합 외래키, 멱등성, 충돌, tombstone, 커서, 읽기 응답의 바이트 예산, manifest 재시작, 아무것도 바꾸지 않는 호출, 암호문 검증, 원자적 롤백, 사용자 신호, 오류 계약(SQLSTATE와 사유)을 검증합니다. P0-3부터는 `lifecycle.test.mjs`가 초대·탈퇴·소유권 이전, ACL 정규화와 compare-and-set, 휴지통·복구·purge, 계정 삭제 트리거를 검사합니다. 이 파일은 거부와 무변경 호출 뒤에 app 스키마의 모든 행을 비교해 아무것도 쓰지 않았는지 확인합니다. 계정 삭제가 잠그는 workspace는 롤백하는 삭제 트랜잭션 안의 xmax로, 계정 삭제와 purge가 읽는 행 수(purge는 generic plan과 custom plan에서 각각)와 내용 push가 HOT 업데이트로 남는지는 통계 뷰로 확인합니다. 초대받은 사람의 계정 삭제가 초대한 쪽에 거절처럼 보이는지(SEC-2)는 예전 멤버, 다른 초대 대기자, 두 역할의 초대를 둔 쌍둥이 workspace에서 거절과 삭제가 바꾼 모든 신호 행과 초대 목록을 비교해 확인합니다. 잠금 순서는 단일 세션에서 관찰할 수 없으므로 함수 본문을 검사해 고정합니다: workspace를 받는 RPC는 첫 문장에서 그 행을 잠그고(중첩 블록 안의 잠금은 첫 문장으로 치지 않고, 첫 문장보다 먼저 실행되는 선언부의 초기값에는 select나 app·private 함수 호출이 없어야 함. 상수인 private.page_budget()만 허용), 계정 삭제 트리거는 멤버인 workspace만 id 순서로 먼저 잠그고 초대 행(과 멤버 신호 증가)을 그 사용자의 신호 행보다 먼저 바꾸며, purge는 잠긴 workspace를 건너뜁니다. 실제 Supabase API, Realtime, 여러 PostgreSQL 세션의 경쟁 상태(계정 삭제 트리거의 잠금 대기와 lock_timeout, purge의 SKIP LOCKED 포함)나 모바일 기기를 검증한 것은 아닙니다.

기본 하네스는 PGlite superuser로 마이그레이션하고 테스트용 auth.uid() 스텁을 씁니다. 테스트의 역할과 JWT subject는 트랜잭션 범위로만 설정되어 이후 SQL 문에 남지 않습니다. 하네스 옵션으로 hosted auth.uid()(request.jwt.claims의 sub를 읽는 정의), Supabase 기본 권한, superuser가 아닌 마이그레이터를 흉내 낼 수 있습니다(`backend/supabase/tests/hosted-compat.test.mjs`). 이 시뮬레이션에서 확인한 알려진 실패인 service_role의 public RPC 실행 권한과 superuser가 아닌 마이그레이터의 소유권 이전 실패는 TODO 테스트로 표시했습니다. P0-4에서 해결하면 TODO 표시를 지우고 이 문장과 `backend/AI-DATABASE.md`를 함께 고쳐야 합니다. 이것도 hosted 환경 검증은 아닙니다. P0-3에서 하네스에 `join`(owner가 초대하고 사용자가 수락), `setAcl`(get_acl로 버전을 읽은 뒤 set_*_acl), `enableAi`, `rpcNamed`(PostgREST처럼 인자 이름으로 호출), `deleteUserAsAuthAdmin`(app·private 권한과 JWT subject가 없는 역할로 auth.users 행 삭제), `dryRunDeletion`(같은 삭제를 실행하고 그 트랜잭션 안에서 상태를 살핀 뒤 롤백), `tableReads`(누적 통계에서 app 테이블별로 읽은 행 수), `asMaintainer`(sync_maintainer로 실행), `appState`(app 테이블 전체 스냅샷)를 더했습니다. superuser가 아닌 마이그레이터 픽스처는 auth.users의 TRIGGER 권한도 받습니다.

## 권한과 데이터

- 모든 app 테이블(P0-3에서 더한 invitations, storage_deletions 포함)은 RLS를 활성화하고 클라이언트 직접 쓰기 및 콘텐츠 조회를 금지합니다. 사용자별 신호 테이블만 자기 행 SELECT를 허용합니다.
- public RPC 실행 권한은 시그니처 단위 허용 목록으로만 부여합니다. 동기화 RPC 25개는 authenticated에, `purge_expired_trash`는 운영용 sync_maintainer(NOLOGIN, 권한 속성 없음)에만 줍니다. private 함수에는 클라이언트 권한이 없고 search_path는 pg_catalog로 고정합니다. RPC SECURITY DEFINER와 app 테이블/private 함수는 전용 sync_backend NOLOGIN 역할 소유입니다. 이 역할은 SUPERUSER/BYPASSRLS 권한 없이 자신이 소유한 테이블에만 소유자 RLS 우회를 사용하며, auth 스키마 USAGE와 auth.uid() EXECUTE만 추가 부여합니다. 계정 삭제를 정리하는 `private.forget_user()`도 sync_backend 소유의 SECURITY DEFINER 함수이며, auth.users의 `forget_user` BEFORE DELETE 트리거가 부릅니다(아래 '계정 삭제'). 배포 계정은 역할 생성/소유권 이전 권한과 auth.users의 TRIGGER 권한이 필요합니다.
- 배포 전제의 알려진 차이(코드와 로컬 시뮬레이션으로 확인했으며 hosted에서는 검증하지 않았습니다):
  - Supabase의 public 스키마 기본 권한은 새 public 함수의 EXECUTE를 service_role에 부여하고, 마이그레이션은 이를 회수하지 않습니다. 따라서 service_role이 public RPC 39개(동기화 26개, AI 13개)를 모두 실행할 수 있고, 여기에는 ai_executor 전용 RPC와 sync_maintainer 전용 purge_expired_trash도 들어갑니다(P0-4에서 수정 예정).
  - superuser가 아닌 배포 계정은 sync_backend 멤버십이 없으면 객체 소유권을 sync_backend로 이전할 수 없어 마이그레이션이 실패합니다(P0-4에서 수정 예정). 로컬 시뮬레이션에서 auth.users의 TRIGGER 권한이 있으면 트리거 생성은 통과하고 그 뒤 소유권 이전에서 실패하며, 이 권한이 없으면 트리거 생성에서 'permission denied for table users'로 실패합니다. 멤버십이 있어도 SET만 되는(INHERIT 없는) 멤버십이면 sync 마이그레이션의 소유권 이전 블록에서 이미 실패합니다. sync_backend가 public 스키마에 객체를 만들 수 있으면(CREATE 권한) public 함수의 소유권 이전은 통과하지만, `alter schema app owner to sync_backend` 뒤에는 배포 계정에 app 스키마 USAGE가 없어 `alter table app.workspaces owner to sync_backend`가 'permission denied for schema app'으로 실패하며, P0-3 전 마이그레이션에서도 같았습니다. 그래서 P0-3 전부터 sync_backend의 권한을 상속하는(INHERIT) 멤버십이나 그에 해당하는 명시적 권한(app·private 스키마 USAGE·CREATE, app 테이블 REFERENCES 등)이 필요했습니다. sync_backend가 public 스키마에 객체를 만들 수 없으면 SET만 되는 멤버십은 그보다 앞의 첫 `alter function public.create_workspace(uuid,text) owner to sync_backend`에서 'permission denied for schema public'으로 실패하고, SET과 INHERIT를 모두 가진 멤버십도 같은 곳에서 실패하므로 sync_backend의 public CREATE 권한도 필요합니다. AI 마이그레이션이 sync_backend 소유 hook `private.forget_user_hook`을 `create or replace`로 바꾸는 것은 이유를 하나 더할 뿐이며, 그 명시적 권한을 모두 줘도 SET만 되는 멤버십으로는 이 hook에서 'must be owner of function'으로 실패합니다(모두 PGlite에서 확인, hosted에서는 확인하지 않음).
  - 배포 계정이 auth 스키마와 auth.uid()에 GRANT OPTION 없이 권한만 가지고 있으면, 마이그레이션의 GRANT는 경고만 남기고 아무것도 부여하지 않습니다. 이후 이를 확인하는 검사도 없습니다.
  - search_path는 pg_catalog만 지정하고 pg_temp를 마지막 순서로 고정하지 않았습니다. 임시 객체를 만들 수 있는 세션에 대비한 강화가 빠져 있습니다.
- 기존 workspace를 다루는 RPC는 먼저 workspace 행을 잠그고(`lock_workspace`: subject가 없으면 unauthenticated, 없는 workspace는 forbidden) 현재 권한을 판단합니다. 입력 오류(invalid_*), 대상 없음(not_found), 상태 충돌(conflict)은 모두 그 뒤에 검사하므로, 비멤버는 존재하는 workspace에서도 없는 workspace와 같은 forbidden만 받습니다. 새 workspace 생성은 새 PK 삽입으로 직렬화됩니다. JWT subject 없이 실행되는 코드(계정 삭제 트리거, purge)는 lock_workspace를 쓰지 않고 workspace 행을 id 순서로 직접 잠그며(계정 삭제는 그 사용자가 멤버인 workspace만, 아래 '계정 삭제'), audit 행위자를 NULL로 남깁니다(`private.audit_anonymous`).
- owner를 포함한 모든 역할의 콘텐츠 접근은 workspace 역할을 상한으로 모든 상위 폴더 및 문서 ACL의 교집합을 적용합니다. ACL null은 상속, {}는 모두 콘텐츠 접근 금지입니다. 새 폴더와 새 문서의 ACL은 null(상속)입니다(F01, 아래 '생성 기본 권한'). ACL 키는 그 workspace의 현재 멤버여야 하고, 멤버가 빠지면 그 멤버를 가리키는 키를 모든 폴더·문서 ACL에서 지웁니다(F12). owner는 ACL/멤버 관리 권한을 별도로 가지며 `list_acls`로 자신이 볼 수 없는 폴더·문서의 메타데이터와 ACL까지 보지만(내용은 없음), 제한 콘텐츠를 읽으려면 명시적으로 자신에게 권한을 부여해야 합니다.
- 가시성(멤버십, 역할, 폴더·문서 ACL)을 실제로 바꾸는 호출만 access_epoch를 호출당 정확히 1 올립니다(아래 I2). 무언가를 바꾼 클라이언트 RPC는 audit을 남기고, 현재 멤버 모두와 관련 사용자(제거되거나 나간 멤버, 초대되거나 초대가 취소된 사용자, 초대를 거절한 사용자)에게 신호를 남깁니다. 계정 삭제는 남은 멤버(그 사용자가 빠진 workspace의 멤버와, 그 사용자를 초대해 둔 workspace의 멤버. 뒤의 경우는 이미 있는 신호 행만)에게만 신호를 남기고 삭제되는 사용자에게는 남기지 않으며, purge는 클라이언트가 읽는 상태를 바꾸지 않으므로 신호를 남기지 않습니다. 아무것도 바꾸지 않는 호출은 epoch, audit, 신호를 모두 그대로 둡니다(아래 'RPC 계약'의 `changed`). 신호에는 user_id, workspace_id, generation만 있고 제한 문서 ID나 콘텐츠는 없습니다.
- journal은 문서의 각 revision 스냅샷 원장입니다. 별도 audit에는 행위자, 변경 종류, 대상, head/epoch, 시간이 기록됩니다. audit 행위자는 subject 없이 실행한 코드(계정 삭제, purge)가 남긴 행이거나 그 계정이 삭제되었으면 NULL입니다. 문서 변경/원장/audit/head/receipt는 단일 RPC 트랜잭션입니다.
- key_envelopes와 attachments는 복합 workspace 외래키가 있는 메타데이터 기반만 제공합니다. 실제 키 지급/교체, 저장소 업로드, 다운로드 API는 아직 없습니다. 어떤 RPC나 클라이언트 코드도 키를 발급하거나 읽지 않으므로(purge, 멤버 제거, 계정 삭제는 key_envelopes 행을 지우기만 함), F01로 새 문서를 보게 된 멤버도 문서 키를 받을 경로가 없습니다. purge와 계정 삭제가 지운 첨부의 저장 경로는 `app.storage_deletions`에 남지만 이를 처리하는 소비자는 없습니다(Storage 미연결). storage_deletions는 경로가 키이고 attachments.storage_path는 유일하지 않으므로, 한 workspace를 지울 때 다른 workspace의 첨부가 아직 가리키는 경로도 삭제 대기열에 들어갈 수 있습니다. 첨부를 쓰는 코드를 만들 때 저장 경로를 유일하게 유지하거나, 소비자가 아직 참조되는 경로를 건너뛰어야 합니다(지금은 첨부를 쓰는 RPC가 없어 생기지 않음).
- `app.invitations`에는 auth.users 외래키가 없습니다. 초대가 계정 존재 여부를 알려 주지 않게 하려는 것입니다(아래 '멤버십과 초대').

## RPC 계약

UUID는 소문자 표준 형식을 사용합니다. revision/head/access_epoch/scanned_through/seq/acl_version은 JSON 문자열입니다. key_epoch는 양의 정수이고, get_documents의 processed, list_my_workspaces의 member_count, purge_expired_trash의 purged는 JSON 정수입니다. 시각(invited_at, deleted_at, purge_after)은 세션 시간대와 관계없이 마이크로초까지 적은 UTC 문자열(`2026-11-10T01:02:03.456789Z` 형식)입니다. 불리언 필드는 null이 아니고, 목록 필드는 비어 있으면 `[]`입니다.

두 마이그레이션을 모두 적용하면 public RPC는 39개입니다. 아래 동기화 RPC 26개 가운데 25개는 authenticated가 실행하고 purge_expired_trash는 sync_maintainer만 실행합니다. AI RPC 13개는 `backend/AI-DATABASE.md`에 있습니다. PostgREST는 인자를 이름으로 맞추므로 매개변수 이름도 계약입니다.

워크스페이스와 멤버십:

- create_workspace(p_workspace_id uuid, p_name text) → {workspace_id, head, access_epoch}. 이름은 1~200자입니다.
- list_my_workspaces(p_after_id uuid = null, p_limit integer = 100) → {workspaces: [{id, name, role, member_count, ai_enabled, ownership_offered}], next_id}
- invite_member(p_workspace_id uuid, p_user_id uuid, p_role text) → {changed}. owner 전용. 역할 null은 초대 취소입니다.
- respond_invitation(p_workspace_id uuid, p_accept boolean) → {changed, role, access_epoch}
- list_invitations(p_workspace_id uuid, p_after_id uuid = null, p_limit integer = 100) → {invitations: [{user_id, role, invited_at}], next_id, pending_owner_id}. owner 전용.
- list_my_invitations(p_after_id uuid = null, p_limit integer = 100) → {invitations: [{workspace_id, name, role, invited_at}], next_id}
- list_members(p_workspace_id uuid, p_after_id uuid = null, p_limit integer = 100) → {members: [{user_id, role}], next_id, access_epoch}
- set_member(p_workspace_id uuid, p_user_id uuid, p_role text) → {access_epoch, changed}. owner 전용. 역할을 바꾸거나 null이면 제거하며, 멤버를 추가하지는 않습니다.
- leave_workspace(p_workspace_id uuid) → {changed, access_epoch}
- offer_ownership(p_workspace_id uuid, p_user_id uuid) → {changed, pending_owner_id}. owner 전용. null은 제안 취소입니다.
- accept_ownership(p_workspace_id uuid) → {changed, access_epoch}
- set_ai_enabled(p_workspace_id uuid, p_enabled boolean) → {ai_enabled, changed}. owner 전용.

폴더와 ACL:

- create_folder(p_workspace_id uuid, p_folder_id uuid, p_parent_id uuid = null, p_acl jsonb = null) → {id, acl_version}. owner 전용.
- list_folders(p_workspace_id uuid, p_after_id uuid = null, p_limit integer = 100) → {folders: [{id, parent_id, can_edit}], next_id}
- get_acl(p_workspace_id uuid, p_kind text, p_id uuid) → {id, acl, acl_version}. owner 전용. kind는 folder 또는 document입니다.
- list_acls(p_workspace_id uuid, p_kind text, p_after_id uuid = null, p_limit integer = 100) → {entries, next_id}. owner 전용. 폴더 원소는 {id, parent_id, acl, acl_version}, 문서 원소는 {id, folder_id, deleted, deleted_at, purged, acl, acl_version}입니다.
- set_folder_acl(p_workspace_id uuid, p_folder_id uuid, p_acl jsonb, p_expected_version text) → {access_epoch, changed, acl_version}. owner 전용.
- set_document_acl(p_workspace_id uuid, p_document_id uuid, p_acl jsonb, p_expected_version text) → {access_epoch, changed, acl_version}. owner 전용.

문서와 동기화:

- create_document(p_workspace_id uuid, p_document_id uuid, p_folder_id uuid, p_kind text, p_ciphertext jsonb, p_key_epoch integer = 1, p_op_id uuid = null) → {op_id, document_id, status: applied, revision, head}
- push_document(p_workspace_id uuid, p_document_id uuid, p_op_id uuid, p_base_revision text, p_ciphertext jsonb, p_deleted boolean = false, p_key_epoch integer = 1) → {op_id, document_id, status: applied|conflict|deleted, revision, head}
- restore_document(p_workspace_id uuid, p_document_id uuid, p_op_id uuid, p_base_revision text) → {op_id, document_id, status: applied|conflict|deleted, revision, head}
- list_trash(p_workspace_id uuid, p_after_id uuid = null, p_limit integer = 100) → {documents: [{id, folder_id, kind, key_epoch, revision, deleted_at, purge_after, ciphertext}], next_id, head, access_epoch}
- pull_changes(p_workspace_id uuid, p_after text, p_limit integer = 100, p_expected_epoch text = null) → {reset_required, changes, scanned_through, head, access_epoch}
- list_accessible_documents(p_workspace_id uuid, p_after_id uuid = null, p_limit integer = 100, p_expected_epoch text = null) → {restart_required, documents, next_id, head, access_epoch}
- get_documents(p_workspace_id uuid, p_ids uuid[], p_expected_epoch text) → {restart_required, documents, processed, head, access_epoch}

운영 전용(sync_maintainer, JWT subject 없이 호출):

- purge_expired_trash(p_limit integer = 100) → {purged, more}

목록 RPC(list_my_workspaces, list_my_invitations, list_members, list_invitations, list_folders, list_acls, list_trash)는 id 오름차순 keyset 페이지입니다(list_members와 list_invitations는 user_id, list_my_invitations는 workspace_id 순서). `p_after_id`보다 큰 행을 최대 p_limit개 돌려주고, 더 있으면 next_id에 마지막으로 돌려준 id를, 없으면 null을 줍니다. p_limit이 null이거나 1~500 밖이면 접근 판단 뒤에 invalid_limit입니다. list_trash는 바이트 예산 때문에 일찍 끊겨도 next_id를 줍니다. list_my_workspaces와 list_my_invitations는 workspace를 받지 않으므로 subject만 확인합니다(없으면 unauthenticated).

`changed`를 돌려주는 RPC는 실제로 바꾼 것이 없으면 `changed: false`와 현재 값을 돌려주고 아무것도 쓰지 않습니다(epoch 증가, audit 행, 사용자 신호 모두 없음). 무변경 판단은 기존 검사와 오류 뒤에 하므로, owner가 아닌 호출자는 무변경 호출에도 forbidden을 받고 owner 지정이나 자기 자신의 변경은 그대로 owner_change_not_supported입니다. RPC별 검사 순서와 의미는 아래 소절에 있습니다.

ACL은 사용자 UUID를 viewer/editor로 매핑한 JSON 객체입니다. kind는 meeting/agenda/note입니다. 문서 객체(get_documents와 pull_changes의 원소)는 id, workspace_id, folder_id, kind, ciphertext, key_epoch, revision, deleted를 포함하고, Pull 원소에는 seq도 있습니다. tombstone의 ciphertext는 null입니다. list_accessible_documents의 원소는 정확히 `{id, revision}`이며 암호문을 담지 않습니다. 삭제된 문서의 내용은 list_trash만 돌려줍니다(편집 권한자에게, 720시간 동안).

암호문 객체의 필드는 정확히 algorithm, nonce, ciphertext, aad 네 개입니다. algorithm은 A256GCM, nonce는 12바이트 base64, ciphertext는 인증 태그 포함 최소 16바이트 base64, aad는 다음 JavaScript 결과와 정확히 일치해야 합니다:

```js
JSON.stringify(['local-first-v1', workspace_id, document_id, 'content', key_epoch])
```

서버는 형식과 바인딩을 검사하지만 암호문 인증 태그를 검증하거나 복호화하지 않습니다. 테스트의 가짜 암호문은 SQL 형식 검증용이며 실제 암호화 구현으로 간주하면 안 됩니다.

### 멤버십과 초대

- 멤버는 초대를 받아 스스로 수락해야만 들어옵니다(F13). invite_member는 owner만 부르며, user_id가 null이면 invalid_request, 대상이 이미 멤버(호출자 자신 포함)이면 already_member, 역할이 editor·viewer·null이 아니면 invalid_role('owner' 포함)입니다. 같은 역할로 다시 초대하면 `changed: false`이고, 다른 역할이면 초대를 바꾸면서 invited_at을 새로 씁니다. 역할 null은 대기 중인 초대를 취소합니다(없으면 `changed: false`). 계정이 없는 UUID도 똑같이 받으므로 응답으로 계정 존재 여부를 알 수 없습니다. 그런 초대는 owner가 취소할 때까지 남고, 그 ID에는 신호가 남지 않습니다. 초대받은 계정이 삭제되면 그 초대는 거절할 때처럼 사라지고 그 workspace 멤버의 신호 행이 하나씩 오릅니다(SEC-2). 거절과 달리 audit 행은 남지 않지만 어떤 RPC도 audit을 읽지 않고 클라이언트에는 audit 권한이 없으므로, 초대한 쪽은 계정 삭제와 거절을 구분할 수 없습니다. 초대는 가시성을 바꾸지 않으므로 epoch를 올리지 않습니다. 초대에는 받는 사람의 동의, 수 제한, 속도 제한이 없어서, UUID를 아는 사용자는 자기가 정한 이름(최대 200자)의 workspace에서 그 사람에게 초대와 신호를 계속 보낼 수 있습니다(남용 방지는 P0-4 이후).
- respond_invitation은 초대받은 사용자가 부릅니다. 대기 중인 초대도 멤버십도 없으면 forbidden(없는 workspace와 같음)이고, 그다음 p_accept가 null이면 invalid_request입니다. 수락하면 초대받은 역할의 멤버가 되고 epoch가 한 번 오릅니다. 거절하면 초대만 지우고 role은 null입니다. 이미 멤버이면(수락 응답을 잃은 뒤의 재시도 등) `{changed: false, role: <현재 역할>}`입니다. 거절은 초대를 지우므로 재시도하면 forbidden입니다. 삭제된 계정의 아직 유효한 토큰으로 그 ID에 새로 온 초대에 답하면 unauthenticated입니다.
- set_member는 owner가 멤버의 역할을 바꾸거나(역할 null이면) 제거합니다. 멤버가 아닌 사용자에게 역할을 주면 member_not_found이고, 멤버가 아닌 사용자를 제거하면 `changed: false`입니다. 같은 역할도 `changed: false`이며, 자기 자신의 변경이나 'owner' 지정은 owner_change_not_supported입니다.
- leave_workspace는 owner가 아닌 멤버가 스스로 나갑니다. 비멤버는 forbidden, owner는 owner_must_transfer입니다. 나간 뒤에 재시도하면 forbidden입니다.
- 멤버가 빠질 때(set_member의 null, leave_workspace, 계정 삭제)는 한 트랜잭션에서 멤버 행과 그 멤버의 key_envelopes를 지우고, 그 멤버를 가리키는 키를 모든 폴더·문서 ACL에서 지우면서 그 ACL의 acl_version을 올리고, 그 멤버에게 걸린 소유권 제안을 취소하고, epoch를 한 번 올립니다(F12). 그래서 다시 초대받아도 예전 제한 권한은 되살아나지 않고 상속 권한부터 시작합니다. 키가 그 멤버 하나뿐이던 ACL은 `{}`(모두 금지)로 남으므로, owner가 list_acls에서 찾아 다시 정해야 합니다.

### 소유권 이전

- owner가 offer_ownership으로 멤버 한 명에게 소유권을 제안하고, 그 멤버가 accept_ownership으로 받습니다. 대상이 멤버가 아니면 member_not_found, 자기 자신이면 owner_change_not_supported, 이미 같은 대상이면 `changed: false`이고, 다른 멤버를 지정하면 제안 대상이 바뀝니다. null은 대기 중인 제안을 취소합니다(없으면 `changed: false`). 제안과 취소는 접근을 바꾸지 않으므로 epoch를 올리지 않습니다. 제안에는 만료가 없습니다.
- 수락하면 이전 owner는 editor가 되고 호출자가 owner가 되며, 제안이 지워지고 epoch가 한 번 오릅니다. 이미 owner인 호출자(응답을 잃은 뒤의 재시도)는 `changed: false`이고, 제안받지 않은 호출자는 forbidden입니다.
- owner가 제안 대상의 역할을 바꾸거나 그 멤버가 빠지면 제안은 취소됩니다(역할 변경으로 취소되면 audit에 대상 없는 'offer_ownership'이 남음). 다시 들어와도 제안은 되살아나지 않습니다.
- 받은 제안은 list_my_workspaces의 ownership_offered(제안받은 사람에게만 true)로, 대기 중인 제안은 list_invitations의 pending_owner_id(owner용)로 보입니다.

### 폴더·문서 ACL

- ACL은 사용자 UUID를 viewer/editor로 매핑한 JSON 객체이며, null은 상속, {}는 모두 금지입니다. ACL을 받는 create_folder, set_folder_acl, set_document_acl은 먼저 형식을 정규화합니다(F15). JSON 객체가 아니거나, 키를 UUID로 바꿀 수 없거나, 값이 viewer/editor가 아니거나, 표준 UUID 표기로 바꾸면 같은 키가 둘 이상이면 invalid_acl입니다. 키는 소문자 표준 UUID로 바꿔 저장하므로 표기만 다른 ACL은 같은 ACL입니다. 그다음 모든 키가 그 workspace의 현재 멤버인지 확인하며, 초대 대기자, 예전 멤버, 다른 workspace의 멤버, 없는 ID는 member_not_found입니다.
- set_folder_acl과 set_document_acl은 acl_version에 대한 compare-and-set입니다(F02). 검사 순서는 lock → owner → p_expected_version 형식(0으로 시작하지 않는 19자리 이하 십진수로 bigint 범위 안, 아니면 invalid_request) → ACL 형식(invalid_acl) → 대상(folder_not_found, document_not_found) → 저장된 ACL과 같으면 `changed: false`와 현재 acl_version → 버전이 다르면 acl_version_mismatch → 키 멤버(member_not_found) → 저장, acl_version + 1, epoch + 1, audit, 신호입니다. 같은 ACL은 기대 버전이 낡았어도 `changed: false`이므로 응답을 잃은 뒤의 재시도가 그대로 끝납니다. 멤버 제거로 키가 지워진 ACL도 버전이 오르므로, 그 멤버가 남아 있는 오래된 사본은 저장되지 않습니다. acl_version_mismatch를 받으면 get_acl이나 list_acls로 다시 읽은 뒤 고칩니다. 예전 3개 인자 호출은 함수를 찾지 못해 실패합니다.
- create_folder는 owner만 부르며, 상위 폴더에서 owner가 편집할 수 있어야 합니다(없거나 볼 수 없는 상위 폴더는 forbidden). 그 뒤 folder_id null(invalid_request), ACL 형식, 키 멤버, 이미 있는 ID(id_conflict) 순서로 검사합니다. p_acl을 주면 처음부터 제한된 폴더가 되고, 생략하거나 null이면 상속합니다. 새 폴더에는 문서가 없으므로 epoch를 올리지 않고 멤버에게 신호만 남깁니다.
- list_folders는 호출자가 볼 수 있는 폴더(모든 조상 폴더까지 보이는 폴더)만 돌려주며, can_edit은 그 폴더에 문서를 만들 수 있는 권한(folder_rank 2)입니다. access_epoch로 버전을 매기지 않으므로, 클라이언트는 신호를 받거나 모르는 folder_id를 가진 문서를 받으면 다시 받습니다.
- get_acl과 list_acls는 owner 전용 관리 조회입니다. kind가 folder/document가 아니면 접근 판단 뒤에 invalid_request입니다. owner를 빼는 ACL을 가진 행도 보여 주지만 암호문은 담지 않습니다. 문서 원소의 deleted_at은 삭제 시각(살아 있으면 null), purged는 purge로 내용이 지워졌는지입니다.
- 문서 ACL이 역할보다 좁아서 편집할 수 없는 문서를 따로 알려 주는 조회는 없습니다(manifest 원소는 `{id, revision}`뿐). 클라이언트는 push가 access_denied로 보류될 때 알게 됩니다.

### 휴지통과 복구

- 문서 삭제(push_document의 p_deleted true)는 편집과 같은 권한(document_rank 2)으로 합니다(F27). 삭제하면 revision이 오르고 원장 행이 생기지만, 저장된 내용은 그대로 휴지통에 남습니다. 요청의 암호문은 검증하고 요청 해시에만 쓰며 저장하지 않으므로, 삭제하는 사람이 휴지통 내용을 바꿀 수 없습니다. pull_changes와 get_documents는 삭제된 문서를 전처럼 tombstone(`deleted: true`, ciphertext null)으로 돌려주고, list_accessible_documents는 삭제된 문서를 담지 않습니다.
- 삭제된 문서에 대한 push(편집이든 삭제든)는 receipt 조회와 암호문 검사 뒤, revision 비교보다 먼저 `status: deleted`와 현재 revision을 받으며 이 receipt도 저장됩니다(C101). 같은 op의 재시도는 처음 receipt를 받으므로, 응답을 잃은 자신의 삭제는 다시 보내도 applied를 받습니다.
- list_trash는 멤버면 부를 수 있지만 그 문서의 편집 권한(document_rank 2)이 있는 문서만 돌려주므로 viewer는 빈 목록을 받습니다. 삭제된 지 720시간이 지나지 않았고 내용이 남은 문서를 id 순서로 암호문과 함께 돌려주며, get_documents처럼 바이트 예산(4,194,304바이트, 첫 원소는 항상 포함)에서 끊습니다. purge_after는 deleted_at + 720시간입니다. 삭제 뒤에 들어온 편집자도 휴지통 내용을 볼 수 있습니다.
- restore_document의 검사 순서는 lock → 편집 권한(document_rank 2, 아니면 forbidden) → op_id와 base_revision 형식(push와 같은 규칙, 아니면 invalid_request) → 같은 사용자·workspace의 op_id receipt 재생(요청 해시 ['restore', 문서, base]가 다르면 op_id_reused) → 문서 상태입니다. 문서가 살아 있으면 `conflict`(receipt.revision에 살아 있음, 누군가 이미 복구함), 삭제됐지만 revision이 base와 다르면 `deleted`(현재 revision. 그 값을 base로 새 op_id를 써서 다시 시도), 삭제한 지 720시간이 지났거나 내용이 purge됐으면 restore_expired(아무것도 저장하지 않음), 그 밖에는 삭제 전 내용 그대로 살리고 revision + 1, 원장 행, audit 'restore_document', `applied`입니다. applied·conflict·deleted는 receipt로 저장되므로 같은 op_id의 재시도는 같은 답을 받습니다. 복구는 가시성을 바꾸지 않으므로 epoch를 올리지 않고, 다른 멤버는 Pull로 받습니다.
- 보관 기간은 `private.trash_retention()` = interval '720 hours'입니다. 일 단위로 계산하면 세션 시간대의 일광 절약 시간 변경에 따라 경계가 한 시간 움직이므로 시간 단위로 정했고, list_trash, restore_document, purge_expired_trash가 같은 경계를 씁니다.
- 720시간이 지나면 복구할 수 없고 휴지통 목록에서도 빠집니다. 그러나 내용(문서 행의 암호문과 이전 revision의 원장 스냅샷)은 purge가 실행될 때까지 서버에 남습니다(아래 '휴지통 영구 삭제(purge) 운영'). 이를 돌려주는 RPC는 없습니다.

### AI 스위치

- set_ai_enabled는 owner가 workspace의 AI 사용을 켜고 끕니다(F29 최소). 기본값은 꺼짐이고, 상태는 list_my_workspaces의 ai_enabled로 보입니다. p_enabled가 null이면 invalid_request, 같은 값이면 `changed: false`입니다. AI 사용은 가시성이 아니므로 epoch를 올리지 않고 audit과 멤버 신호만 남깁니다. AI RPC는 workspace 잠금 아래에서 이 값을 읽고, 동의·접수·전송에 문서 편집 권한을 요구합니다(`backend/AI-DATABASE.md`).

## 재시도/동기화 규칙

- create_document의 op_id는 p_op_id이고, 주지 않으면 document_id입니다. receipt는 push·restore와 같은 (사용자, workspace, op_id) 이름공간에 저장되며 요청 해시는 ['create', 문서, 폴더, kind, 암호문, key_epoch]입니다(op_id는 해시에 들어가지 않음). 같은 사용자가 같은 op_id로 같은 생성 요청을 다시 보내면 최초 receipt를 돌려주고(그 문서의 편집 권한을 잃었으면 forbidden), 다른 요청이면 op_id_reused입니다. 응답은 push receipt와 같은 모양입니다(F20). 동기화 클라이언트는 큐의 op_id를 p_op_id로 보냅니다. push와 restore에는 그와 다른 새 op_id를 써야 합니다.
- push op_id는 사용자/workspace 범위입니다. JSONB 정규화 요청 해시를 저장하고 payload가 달라지면 거부합니다. conflict와 deleted도 receipt를 저장하므로 재시도 결과가 바뀌지 않습니다. 현재 권한을 잃으면 이전 receipt도 조회할 수 없습니다.
- 삭제 문서는 push로는 어떤 revision으로도 부활하지 않고 restore_document로만 돌아옵니다(위 '휴지통과 복구'). 삭제 push도 올바른 암호문 envelope와 key_epoch가 필요합니다. 삭제한 문서의 내용과 이전 revision의 원장 스냅샷은 purge가 지울 때까지 서버에 남으므로 삭제는 암호학적 삭제가 아닙니다.
- restore_document는 큐에 넣지 않는 요청입니다. 응답을 잃으면 같은 op_id와 base로 다시 보내 저장된 receipt를 받습니다. 새 op_id로 보내면 이미 복구된 문서에는 conflict가 오므로, conflict는 'sync한 뒤 확인'으로 처리합니다. deleted를 받으면 receipt.revision을 base로 새 op_id를 써서 다시 시도합니다. 클라이언트 순서는 `shared/contracts/README.md`의 '휴지통과 복구'를 참고하세요.
- 응답을 잃은 수명주기 호출을 다시 보내면, 그 사이 다른 사람이 상태를 바꾸지 않은 한 invite_member, set_member, offer_ownership, set_ai_enabled, 같은 ACL의 set_folder_acl·set_document_acl, accept_ownership, 수락하는 respond_invitation은 `changed: false`로 같은 상태를 확인합니다. 그 사이 상태가 바뀌었으면 다른 답을 받습니다. 예를 들어 초대받은 사람이 그 사이 거절했으면 같은 invite_member가 초대를 새로 만들어(`changed: true`, 그 사람에게 신호도 다시 감) 거절을 덮어쓰고, 수락했으면 already_member를 받습니다. 제안받은 멤버가 그 사이 나갔으면 offer_ownership은 member_not_found입니다. 그래서 owner 클라이언트는 응답을 잃은 초대나 제안을 다시 보내기 전에 list_invitations나 list_members로 현재 상태를 확인합니다. 거절하는 respond_invitation과 leave_workspace는 forbidden을 받습니다.
- workspace와 폴더 생성에는 receipt 기반 멱등성이 없어, 같은 ID로 다시 보내면 id_conflict(409)입니다. 응답을 잃은 뒤 id_conflict를 받았다면 앞선 요청이 성공했을 수 있으므로, 새 ID로 다시 만들기 전에 list_my_workspaces(그 ID가 role owner로 있는지)나 list_acls(p_kind 'folder')로 확인합니다. workspace ID는 다른 사용자가 먼저 썼을 수도 있습니다.
- Pull은 `p_after`보다 큰 원장 행을 seq 순서로 최대 limit개 읽어(창) 문서별로 묶습니다. 창 안에서 문서 d의 가장 큰 seq를 L(d)라 하면, 문서를 L(d) 오름차순으로 한 번씩 보내고 원소는 그 문서의 현재 상태에 `seq: L(d)`를 붙인 것입니다. 과거 원장 암호문은 노출하지 않습니다. 한 응답에 같은 문서는 한 번만 나오지만, 다음 창에 그 문서의 행이 또 있으면 다시 나옵니다(창마다 한 번). 원장에 revision 열이 없어 이미 대체된 행을 건너뛸 수 없기 때문입니다. 원소는 현재 상태이므로 문서 revision은 해당 seq의 행보다 최신일 수 있습니다. 현재 ACL로 볼 수 없는 문서는 상태를 만들지 않고 건너뛰지만, 그 행도 scanned_through를 전진시킵니다.
- pull_changes와 get_documents의 응답은 바이트 예산 4,194,304바이트(`private.page_budget()`)로 끊습니다. 원소를 순서대로 넣다가, 이미 하나 이상 넣은 상태에서 다음 원소의 텍스트 크기(`octet_length(원소::text)`)를 더해 예산을 넘으면 그 원소 앞에서 멈춥니다. 첫 원소는 예산보다 커도 넣으므로 매 호출이 전진합니다(cipher_ok가 envelope를 약 1.05MB로 제한하므로 직접 넣은 테스트 데이터에서만 생깁니다). Pull이 끊기면 scanned_through는 끊긴 문서의 L(d) - 1이고, 끊기지 않으면 창의 마지막 seq, 빈 창이면 p_after입니다. 비어 있지 않은 창에서는 항상 p_after보다 큽니다. scanned_through 이하의 행은 모두 이번에 보낸 문서, 볼 수 없는 문서, 또는 scanned_through 뒤에도 행이 있어 이후 페이지가 현재 상태를 보낼 문서의 것입니다. scanned_through는 창 크기나 예산 때문에 head보다 작은 채로 끝날 수 있으므로, 반환 문서 개수가 limit보다 작다고 종료하면 안 되고 scanned_through와 head를 비교해야 합니다.
- 응답 크기 상한은 문서로만 정하고 강제하지 않습니다. 예산은 원소의 텍스트 크기만 셉니다. jsonb 텍스트 본문은 max(예산, 첫 원소) + 응답 틀(19자리 카운터일 때 pull 최대 152바이트, get_documents 최대 132바이트) + 첫 원소 뒤 원소마다 구분자 2바이트(500개면 약 1KB) 이하입니다. 공백 없는 JSON으로 쓰면 원소마다 공백이 빠져 원소가 많을 때는 예산보다 작지만, 큰 원소 몇 개가 예산을 거의 채우면 예산을 몇십 바이트 넘을 수 있습니다(원소 4개로 예산을 정확히 채워 쟀을 때 1~47바이트). 이 값은 PGlite에서 jsonb 텍스트와 공백 없는 JSON으로 잰 것이며, 실제 PostgREST 응답 본문으로 잰 것은 아닙니다.
- expected_epoch가 없거나 다르면 reset_required입니다. 클라이언트는 문서 목록을 처음부터 받아 캐시에 없거나 더 오래된 revision인 문서만 get_documents로 받고, 목록에 없는 캐시를 지운 뒤 목록 첫 페이지의 head(H0)에서 Pull을 이어 갑니다. 목록과 내용을 받는 동안 생긴 쓰기는 H0부터의 Pull이 전달합니다(아래 I3). 미전송 개인 편집본은 별도 보관합니다. 클라이언트 절차는 `shared/contracts/README.md`의 '재구축'을 참고하세요.
- list_accessible_documents는 lock_workspace → 멤버 확인 → invalid_limit 순서로 검사합니다. 볼 수 있고 삭제되지 않은 문서의 `{id, revision}`을 `p_after_id`보다 큰 id 순서로 최대 limit개 돌려주고, 더 있으면 next_id에 마지막 id를, 없으면 null을 줍니다. 첫 페이지는 기대 epoch 없이 시작할 수 있고, 후속 페이지는 첫 페이지의 access_epoch를 전달해야 합니다. `p_after_id`를 주면서 epoch를 빼거나 epoch가 현재 값과 다르면 restart_required(documents `[]`, next_id null)이며, 받은 목록을 버리고 처음부터 다시 받습니다. head가 움직이는 것은 재시작 사유가 아닙니다.
- get_documents는 lock_workspace(unauthenticated·forbidden) → 멤버 확인(forbidden) → p_ids 검사 순서입니다. p_ids가 null이거나 비었거나 500개를 넘거나, 1차원 배열이 아니거나(PostgREST가 중첩 JSON 배열을 2차원 uuid[]로 넘길 수 있어 막습니다. 실제 PostgREST로는 확인하지 않았습니다), null 원소나 중복이 있으면 invalid_request입니다. p_expected_epoch가 null이거나 현재 값과 다르면 restart_required(documents `[]`, processed 0)입니다. 그 밖에는 ID를 배열의 저장 순서대로 처리합니다. 볼 수 없거나 없는 ID는 조용히 건너뛰고 처리한 것으로 세므로 존재 여부가 드러나지 않습니다. 볼 수 있는 문서는 tombstone(`deleted: true`, ciphertext null)도 현재 상태로 돌려주고, 예산에 들어가지 않는 첫 문서 앞에서 멈춥니다(그 문서는 처리하지 않은 것으로 셉니다). processed는 앞에서부터 처리한 ID 수인 JSON 정수이고, restart_required가 false이면 1 이상입니다. 나머지 ID는 다음 요청으로 보냅니다.
- 목록과 내용을 모두 받기 전에는 기존 로컬 캐시를 지우거나 커서와 epoch를 옮기지 마세요. 더 새로운 revision의 내용은 Pull처럼 먼저 캐시에 넣어도 됩니다.
- 오류는 아래 '오류 계약'을 따릅니다. 네트워크 실패와 계약에 없는 오류는 같은 요청과 op_id로 나중에 재시도하고, 계약 오류는 종류에 따라 처리합니다.

## 동기화가 기대는 불변식

클라이언트의 캐시 재사용, Pull 적용의 단조 검사, 재구축 뒤 H0부터 이어 가는 Pull은 아래 세 가지에 기댑니다. 기능을 더하거나 잠금 방식을 바꿀 때 함께 지켜야 합니다.

- I1: 스냅샷 필드(ciphertext, deleted, key_epoch, kind, folder_id)가 바뀌면 같은 트랜잭션에서 revision이 오르고 원장 행이 추가됩니다. 따라서 (workspace_id, id, revision)은 스냅샷 하나를 가리킵니다. 삭제와 복구(restore_document)도 revision을 올리고 원장 행을 추가합니다. 스냅샷은 삭제된 문서의 암호문을 null로 보여 주므로, 휴지통에 남긴 내용을 purge가 지워도(문서 행과 원장 스냅샷의 암호문) 스냅샷은 바뀌지 않아 revision이나 원장 행이 생기지 않습니다. 같은 revision 번호를 다시 쓰는 복원 서버는 이 불변식을 깹니다(F16, P1).
- I2: 호출자의 가시성(멤버십, 역할, 폴더 ACL, 문서 ACL)이 바뀌면 access_epoch가 호출 한 번에 정확히 한 번 오릅니다. 초대 수락, set_member의 역할 변경과 제거, leave_workspace, 계정 삭제의 멤버 제거(ACL 키 정리 포함), set_folder_acl, set_document_acl, accept_ownership이 여기에 해당합니다. 초대·초대 취소·거절, 소유권 제안·취소, AI 스위치, 폴더 생성(새 폴더에는 문서가 없음), 문서 삭제·복구(내용 변경이라 Pull이 전달), purge는 epoch를 올리지 않습니다. folder_id와 parent_id는 바뀌지 않고(이동 없음), 문서 행은 계정 삭제가 혼자 남은 workspace를 통째로 지울 때 말고는 물리적으로 지우지 않습니다. 따라서 한 epoch 안에서는 가시성이 고정됩니다.
- I3: 읽기 RPC가 보고하는 head와 돌려주는 행은 그 head보다 오래되지 않은 하나의 스냅샷에서 나옵니다. 지금은 기존 workspace를 다루는 모든 동기화 RPC가 `lock_workspace`에서 workspace 행을 FOR UPDATE로 잠그고 모든 쓰기가 커밋할 때까지 그 잠금을 쥐므로 성립합니다. subject 없이 실행되는 purge는 처리하는 workspace 행을 직접 잠그고, 계정 삭제 트리거는 그 사용자가 멤버인 workspace(멤버십과 접근이 바뀌는 곳)만 직접 잠급니다. 트리거가 다른 workspace에서 바꾸는 행(그 사용자의 초대·receipt·신호 행 삭제, 그 사용자를 초대한 workspace 멤버의 신호 행, journal·audit·AI 기록의 행위자)은 읽기 RPC가 보고하는 head나 문서 행에 들어가지 않으므로 I3에 영향이 없습니다. workspace를 받지 않는 list_my_workspaces와 list_my_invitations는 잠금 없이 SELECT 문 하나로 읽으므로 모든 필드가 한 스냅샷에서 나옵니다. 읽기에서 잠금을 없애는 F21(P1)도 같은 문장이나 REPEATABLE READ로 이 성질을 지켜야 합니다. 그렇지 않으면 쓰기가 H0 아래로 들어가 영영 전달되지 않을 수 있습니다.

P0-3의 새 RPC는 위 방식으로 I1과 I2를 지킵니다. 문서·폴더 이동은 이전 문서가 P0-3에 넣겠다고 적었지만 범위에서 빠졌습니다. 이동을 더하면 folder_id(스냅샷 필드, I1)와 parent_id(가시성, I2)가 바뀌므로 같은 규칙을 지켜야 합니다.

## 계정 삭제

계정 삭제는 인증 서비스가 auth.users 행을 실제로 지우는 것(하드 삭제)입니다(F24). auth.users의 `forget_user` BEFORE DELETE 트리거가 같은 트랜잭션에서 `private.forget_user()`(SECURITY DEFINER, sync_backend 소유, search_path pg_catalog, lock_timeout 250ms)를 실행해 정리합니다. 지우는 세션에는 JWT subject가 없고, 그 역할은 app·private 권한이 없어도 됩니다. 테스트는 auth 스키마 USAGE와 auth.users의 DELETE·SELECT(id)만 가진 역할로 지웁니다(PostgreSQL은 DELETE의 WHERE가 읽는 열에 SELECT 권한을 요구합니다). auth.users를 가리키는 외래키는 NO ACTION 그대로 두므로, 정리하지 못한 참조가 남으면 삭제 전체가 23503으로 실패합니다.

1. 그 사용자가 멤버인 workspace(멤버십과 접근이 바뀌는 곳)만 한 문장에서 id 순서로 잠급니다. 초대만 받았거나, 떠났거나, 거절했거나, AI 동의·작업·예산만 남은 workspace는 잠그지 않고 그곳의 행만 정리합니다(4·5단계). 그 사용자가 멤버인 workspace를 쥔 호출(주로 공동 멤버의 RPC)은 커밋할 때까지 삭제를 기다리게 하고, workspace 잠금을 쥔 채 이 auth.users 행을 기다리는 RPC(그 사용자 ID를 참조하는 행을 쓰는 RPC)와는 서로 기다리게 됩니다. 그래서 트리거는 lock_timeout 250ms로 실행되며, 어느 잠금이든 250ms 안에 얻지 못하면 55P03으로 실패합니다(호출자가 재시도). 그 사용자가 먼저 그 workspace에서 나가면(owner는 소유권을 넘긴 뒤) 그 workspace의 잠금 대기는 없어지지만, 잠그지 않는 곳의 행을 두고 생기는 대기와 순환(아래 운영 메모)은 그대로입니다.
2. 잠근 뒤 다시 읽어, 그 사용자가 owner인 workspace에 다른 멤버가 있으면 owner_must_transfer(PT409)로 전체를 되돌립니다. 혼자인 workspace는 통째로 지웁니다. 첨부 저장 경로를 storage_deletions에 남긴 뒤 원장, key_envelopes, 첨부, 문서(AI 동의·작업과 작업의 전송 기록(ai_attempts)·사용 원장(ai_usage_ledger) 행이 함께 지워짐. 그 순간 전송된(dispatched) 작업이 있으면 과금됐을 수 있는 호출의 SQL 기록이 남지 않음, `backend/AI-DATABASE.md`), 폴더, 멤버, 초대, receipt, 신호, audit, workspace(AI 예산이 함께 지워짐) 순서로 지웁니다.
3. owner가 아닌 멤버십은 '멤버십과 초대'의 제거와 같이 지웁니다(ACL 키 정리, 제안 취소, epoch 한 번). 다만 audit은 행위자와 대상 없이 'account_deleted'로 남기고, 신호는 남은 멤버에게만 보냅니다.
4. 그 사용자의 대기 중인 초대를 모두 지우면서, 같은 문장에서 그 초대가 있던 workspace 멤버의 신호 행을 거절할 때처럼 하나씩 올립니다. 이미 있는 신호 행만 올리고 새 신호 행과 audit 행은 쓰지 않습니다. 삽입의 외래키 검사가 잠그지 않은 workspace 행을 FOR KEY SHARE로 잠그기 때문입니다. 이 문장은 초대한 workspace를 잠그지 않으므로 멤버 목록을 문장의 스냅샷으로 읽습니다. 그래서 같은 순간에 나가는 멤버는 신호를 한 번 더 받을 수 있고 같은 순간에 들어오는 멤버는 이 신호를 받지 못할 수 있습니다(workspace 잠금으로 직렬화되는 거절에서는 둘 다 생기지 않음. 그 멤버 자신의 신호 행만 다르고 데이터는 바뀌지 않음, 코드로 추론). 그다음 그 사용자의 신호 행과 receipt를 지웁니다. 초대 행 → 멤버 신호 행 → 초대받은 사람의 신호 행은 invite_member가 초대하거나 초대를 취소할 때와 같은 순서이므로, owner가 같은 순간에 그 사용자를 초대하거나 초대를 취소해도 서로 기다리는 순환은 생기지 않습니다. 다만 삭제의 초대 문장이 보지 못한(그 뒤에 커밋한) 초대는 삭제된 ID에 대한 초대로 남을 수 있습니다. 계정이 없는 ID를 초대한 것과 같은 상태이며, 그런 초대는 원래 허용됩니다('멤버십과 초대'). 이어서 남은 소유권 제안을 지우고 journal 행위자를 NULL로 바꾸며, audit의 행위자와 대상은 UPDATE 한 문장으로 NULL로 바꿉니다(이 트랜잭션이 이미 쓴 행을 다시 UPDATE하면 audit→workspace 외래키를 다시 검사해 workspace 행을 FOR KEY SHARE로 잠급니다). audit 대상은 값으로만 비교하므로, 그 사용자 ID와 같은 ID의 문서·폴더·workspace를 가리키던 audit 행도 대상을 잃습니다(클라이언트가 ID를 정하므로 생길 수 있음, audit 메타데이터에만 영향). 공유 workspace에 쓴 문서와 원장은 남습니다.
5. AI hook(`private.forget_user_hook`)이 AI 동의·작업의 행위자를 지우고 그 사용자의 예산 행을 지웁니다(`backend/AI-DATABASE.md`). 그 사용자가 더는 멤버가 아닌 workspace의 AI 기록도 workspace를 잠그지 않고 행 단위로 정리합니다. sync 마이그레이션만 적용하면 이 hook은 아무것도 하지 않습니다.

운영 메모(코드로 강제하지 않고 문서로만 정한 것입니다):

- 하드 삭제만 지원합니다. Supabase admin API의 소프트 삭제(shouldSoftDelete)는 auth.users 행을 남기므로 트리거가 실행되지 않고 멤버십, 소유권, 초대, ACL 키, receipt가 모두 남습니다.
- 한 문장으로 한 사용자만 지웁니다. 여러 사용자를 한 문장으로 지우면 행 처리 순서에 따라 성공 여부가 달라질 수 있습니다(예: A가 owner이고 B가 유일한 다른 멤버인 workspace에서 A와 B를 함께 삭제).
- Supabase 문서에 따르면 인증 서비스(GoTrue)는 트리거 오류를 모두 HTTP 500 'Database error deleting user'로 보고하므로, owner_must_transfer는 API 호출자에게 그대로 전달되지 않습니다(이 저장소에서 확인하지 않았습니다). 앞으로 만들 계정 삭제 엔드포인트는 먼저 list_my_workspaces의 모든 페이지에서 role이 owner이고 member_count가 1보다 큰 workspace를 찾아 직접 owner_must_transfer를 돌려주고(소유권 이전은 offer_ownership 뒤 상대의 accept_ownership), 삭제가 55P03(잠금 대기 초과)이나 40P01(교착)로 실패하면 다시 시도해야 합니다. 이 엔드포인트(Edge Function)는 아직 없습니다. 재시도가 계속 55P03이면 그 사용자가 멤버인 workspace에서 먼저 나가게(leave_workspace) 할 수 있지만, 그것으로 없어지는 것은 그 workspace의 잠금 대기와 그 멤버십이 엇갈려 생기는 순환(아래 다섯째 경우의 한 형태)뿐입니다(위 1단계). 삭제는 잠그지 않는 workspace에서도 그 사용자를 가리키는 행과 초대한 workspace 멤버의 신호 행을 바꾸므로(4·5단계), 같은 순간에 그 행을 쓰는 호출은 커밋할 때까지 삭제를 기다리게 하고, 그 대기가 250ms를 넘거나 서로 기다리는 순환이 되면 lock_timeout의 55P03으로 끝납니다(재시도). 순환은 아래 경우에 생길 수 있으며, 다섯째 경우 가운데 멤버십이 엇갈린 형태 말고는 모두 그 사용자가 먼저 나가도 생깁니다. owner가 같은 순간에 그 사용자를 초대하거나 초대를 취소하는 것은 순환을 만들지 않습니다(4단계). 재검증은 실행자 호출(첫째 경우), purge(둘째 경우), 그 사용자 자신의 respond_invitation(셋째 경우), 혼자인 workspace를 지우는 계정 삭제와 그곳에 원장 행·신호 행·receipt를 남긴 사용자의 계정 삭제(다섯째 경우)에서 양쪽 방향의 대기를, 그 사용자 자신의 ai_cancel_job(대기 중이거나 claim된 작업)과 ai_revoke_consent(대기 중인 작업, 첫째 경우)에서는 auth.users 행을 기다리는 쪽만 PGlite의 prepared transaction으로 하나씩 보였을 뿐입니다. 순환 자체와 lock_timeout의 발동은 단일 세션 PGlite에서 실행할 수 없어 확인하지 않았고, 나머지(넷째 경우, 엇갈린 멤버십과 초대, 혼자인 workspace에서 초대·audit·AI 행이 만나는 경우)는 코드로 추론했습니다.
  - 그 사용자의 AI 작업 행을 한 트랜잭션에서 두 번 바꾸는 호출(`private.ai_release`에서 한 번, 마지막 UPDATE에서 한 번): 실행자의 ai_begin_dispatch 취소 경로, ai_fail_before_dispatch, ai_settle_job과, 그 사용자 자신이 대기 중이거나 claim된 작업을 취소하는 ai_cancel_job·ai_revoke_consent. 두 번째 UPDATE가 행위자 외래키를 다시 검사하며 이 auth.users 행을 기다리고, 삭제의 AI hook은 그 작업 행을 기다립니다. 그 사용자가 그 workspace의 멤버이든 이미 떠났든 같습니다(`backend/AI-DATABASE.md`).
  - 그 사용자가 더는 멤버가 아닌 workspace를 처리하는 purge 호출. 문서마다 원장 행을 바꾸므로 그 사용자가 쓴 원장 행도 커밋할 때까지 쥐고, 삭제의 원장 문장(4단계)은 그 행을 기다립니다. 삭제가 먼저 잡은 다른 문서의 원장 행을 purge가 기다리게 되면 순환입니다.
  - 그 사용자 자신이 같은 순간에 부른 respond_invitation(초대 행을 지운 채 이 auth.users 행을 기다리고, 삭제는 그 초대 행을 기다림).
  - 4단계의 신호 증가가 초대한 workspace에서 같은 멤버 신호 행을 다른 순서로 잠그는 다른 RPC의 신호 문장과 만날 때(둘 다 짧은 단일 문장이라 드묾).
  - 같은 순간에 진행되는 두 계정 삭제가 서로의 행을 만날 때. 하나는 멤버십과 초대가 엇갈린 경우입니다. 예를 들어 한 사용자가 멤버인 workspace에 다른 사용자가 초대되어 있고 그 반대도 그러면, 두 삭제가 각각 3단계에서 자기 workspace 멤버의 신호 행을 잡은 채 4단계에서 상대 workspace 멤버의 신호 행을 올리려 합니다. 같은 두 workspace에 초대된 두 사용자의 삭제도 4단계의 신호 증가가 같은 멤버 신호 행을 서로 다른 순서로 잡으면 같습니다(둘 다 멤버가 아니므로 나가는 것과 관계없음). 다른 하나는 한 삭제가 혼자인 workspace를 통째로 지우는데(2단계) 그 workspace에 다른 사용자의 행(원장 행, receipt, 신호 행, 초대, audit, AI 행. 대개 그곳에 쓰고 나간 뒤 남은 것)이 있는 경우입니다. `private.delete_workspace`는 원장, AI 행(문서와 함께), 초대, receipt, 신호, audit 순서로 잡고 다른 사용자의 삭제는 초대, 신호, receipt, 원장, audit(4단계), AI 행(5단계) 순서로 잡으므로, 예를 들어 앞의 삭제는 원장 행을 잡은 채 receipt를, 뒤의 삭제는 receipt를 잡은 채 원장 행을 기다립니다. 남은 owner는 혼자라 나갈 수 없고 다른 사용자는 이미 나갔으므로 이 경우도 나가는 것으로 피할 수 없습니다.
- 트리거를 지우거나 끄려면 auth.users 소유자 권한이 필요합니다(hosted에서는 인증 서비스의 역할이 소유자로 알려져 있으나 확인하지 않았습니다). 마이그레이션 계정의 TRIGGER 권한으로는 트리거를 만들거나 바꿀 수만 있습니다(PGlite에서 DROP·DISABLE은 소유자가 아니라는 오류로 실패). 정리를 멈추려면 함수 본문을 `return old`로 바꾸면 되지만, 그러면 앱 데이터가 있는 계정은 외래키 때문에 삭제되지 않습니다.
- 삭제된 계정의 아직 유효한 토큰은 workspace를 받는 RPC에서 forbidden을 받습니다(멤버십이 없음). 예외로 create_workspace는 새 ID면 unauthenticated, 이미 있는 ID면 id_conflict이고, respond_invitation은 삭제 뒤 그 ID로 온 초대에 답할 때만 unauthenticated입니다(초대가 없으면 forbidden). list_my_workspaces는 빈 목록입니다. AI RPC의 답은 `backend/AI-DATABASE.md`에 있습니다. 남겨 둔 외래키가 그 ID로 멤버십, receipt, 신호, audit 행위자 같은 행을 만들지 못하게 막습니다. 초대에는 auth.users 외래키가 없으므로 다른 owner는 삭제된 ID도 계속 초대할 수 있고, 그 초대는 그 토큰의 list_my_invitations에도 보입니다(계정이 없는 ID를 초대할 때와 같음).
- 혼자인 workspace를 지우면 그 workspace의 신호 행과 초대도 지워집니다. workspace는 계정 삭제로만 지워지므로, 예전 멤버와 초대받은 사람은 자기 신호 행이(초대받은 사람은 초대도) 사라진 것으로 그 owner의 계정 삭제를 알아챌 수 있습니다. 지운 workspace ID는 예약되지 않아 누구든 같은 ID로 create_workspace를 다시 부를 수 있습니다.
- 정리가 닿지 않는 곳: Supabase 인증 서비스의 자체 테이블과 로그(확인하지 않음), 백업과 WAL·PITR, 다른 사용자의 기기에 이미 내려받은 데이터, AI vault 객체(`backend/AI-DATABASE.md`), 삭제한 사용자 기기의 로컬 데이터(앱이 그 workspace의 큐 쓰기·충돌 해결·버리기를 멈춘 뒤 workspace마다 `engine.forgetWorkspace`를 불러야 하고, 잊은 workspace에는 다시 큐를 넣지 않아야 함. 저장소는 그런 큐 쓰기도 받지만 그 op는 보내지도 보류되지도 않음, `frontend/mobile/README.md`. 저장소는 workspace 목록을 주지 않고 삭제 뒤에는 list_my_workspaces도 빈 목록이므로, 앱이 동기화한 workspace ID를 기억해 둬야 함).

## 휴지통 영구 삭제(purge) 운영

- purge_expired_trash는 sync_maintainer(NOLOGIN)만 실행할 수 있습니다. 운영 작업은 이 역할을 부여받은 연결에서 `set role sync_maintainer`처럼 이 역할로 바꿔, JWT subject 없이 부릅니다. 어느 계정에 역할을 줄지와 실행 일정은 운영 승인 대상이라 정하지 않았습니다. 그래서 지금은 아무도 purge를 실행하지 않고, 720시간이 지난 휴지통 내용도 서버에 남습니다. hosted 기본 권한에서는 service_role도 실행할 수 있습니다(F46).
- 한 호출은 기한이 지난 휴지통 문서(삭제됨, 내용 있음, 삭제한 지 720시간이 지남. 경계는 호출을 시작한 시각에 한 번 정함)가 있는 workspace 하나만, id가 가장 작은 것부터 `for update skip locked`로 잠가 처리하므로 다른 세션이 잡은 workspace를 기다리지 않습니다(같은 순간의 계정 삭제가 잡은 원장 행은 기다릴 수 있음, 위 '계정 삭제'의 운영 메모). 후보는 workspace를 하나씩 훑지 않고, 내용이 남은 휴지통만 담은 documents_trash 인덱스로 찾습니다(아래 '다음 단계와 제한'). 다만 이 검색은 호출마다 기한이 지나고 내용이 남은 휴지통 행을 모두 읽어 workspace 목록을 만든 뒤 하나를 잠급니다(읽는 동안에는 workspace 잠금이 없음). 그래서 그런 행이 E개 밀려 있으면 호출마다 인덱스 항목과 행을 합쳐 약 2E행을 읽습니다. 한 호출은 workspace 하나만 처리하므로, workspace마다 밀린 문서가 k개씩이면 한 호출이 min(k, p_limit)개를 지우고, 모두 비우는 동안 후보 검색만 약 E²/min(k, p_limit)행을 읽습니다(지우는 문서마다 몇 행이 더 듦). 밀린 문서가 workspace마다 하나씩 흩어져 있으면 p_limit과 관계없이 약 E²행이므로 p_limit을 올려도 빨라지지 않습니다(PGlite에서 E = 400을 비우는 데 workspace 400개에 하나씩이면 p_limit 100과 500 모두 400번 호출해 문서 163,197행, 20개에 20개씩이면 10,418행, 4개에 100개씩이면 4,106행을 읽음). 밀리지 않도록 정기적으로 실행해 E를 작게 유지해야 합니다. 그 workspace에서 최대 p_limit개(1~500, 기본 100)를 id 순서로 잠금 아래에서 다시 확인한 뒤, 문서마다 (workspace, 문서) 조건으로 문서의 암호문을 NULL로, 그 문서의 원장 스냅샷 암호문을 JSON null로 바꾸고, key_envelopes와 첨부를 지우면서 첨부 저장 경로를 storage_deletions에 남기고, 행위자 없는 audit 'purge_document'(대상: 문서 ID)를 남깁니다. 삭제된 문서는 이미 암호문 null로 보이므로 revision, 원장 행, 신호는 바꾸지 않습니다(I1).
- 결과는 `{purged, more}`이고, more는 어느 workspace에든 후보가 남았는지입니다(같은 경계, 같은 인덱스). 이 확인은 처리한 workspace를 잠근 채 실행하므로 EXISTS 대신 min(deleted_at)을 써서 documents_trash를 deleted_at 순서로 읽다가 첫 항목에서 멈춥니다. 오래된 tombstone이 통계를 채운 데이터베이스에서는 EXISTS가 새 연결이 먼저 쓰는 custom plan에서 문서 테이블 전체를 훑는 계획이 될 수 있었습니다(EXISTS로 되돌리면 테스트 픽스처에서 purge하는 호출 하나가 문서 1,815행을 읽음. 지금은 custom plan에서도 30행 이하로 테스트가 고정). 운영 작업은 more가 false가 될 때까지 다시 부르되, 각 호출을 자기 트랜잭션에서 실행하고 커밋해야 합니다(자동 커밋, 또는 호출 사이에 COMMIT). 반복을 한 트랜잭션(DO 블록, 함수, BEGIN…COMMIT)으로 감싸면 처리한 모든 workspace의 행 잠금이 그 트랜잭션이 끝날 때까지 남아, 그동안 그 workspace의 RPC가 기다리고 그 잠금을 만나는 계정 삭제는 55P03으로 실패합니다. 후보가 있는 workspace가 모두 다른 세션에 잠겨 있으면 `{purged: 0, more: false}`를 받으므로 다음 실행을 기다려야 합니다.
- purge한 문서는 list_acls에서 `purged: true`이고 restore_document는 restore_expired입니다. storage_deletions를 처리할 소비자는 없고(Storage 미연결), purge는 그 문서의 AI 기록과 vault 객체를 건드리지 않습니다.

## 오류 계약

단일 기준은 `shared/contracts/errors.js`의 `SERVER_ERRORS`입니다. 사유를 추가하거나 바꾸면 SQL, 클라이언트, 테스트와 이 문서를 함께 고쳐야 합니다.

- 업무 오류는 모두 `raise exception '<사유>' using errcode='PT<상태>'` 형식으로 발생합니다. PostgREST는 SQLSTATE `PTxyz`를 HTTP 상태 xyz로 바꾸고 `{code: 'PT<상태>', message: '<사유>', details: null, hint: null}` 본문을 반환합니다. message에는 사유 이름만 들어가며 입력값, 제약 조건 이름, 키 값은 들어가지 않습니다. 제약 조건이 실제 방어선인 경우(workspace ID 중복, 사용자 외래키, ACL 키의 UUID 변환)에는 그 문장 하나만 특정 SQLSTATE로 잡아 계약 사유로 바꿉니다.
- 표에 없는 SQLSTATE(배포 권한 설정 오류인 42501, 23505, 22P02, 22003, 서버 오류 등)가 호출자에게 도달하면 서버 결함이나 배포 설정 오류입니다. 업무상 거부로 해석하지 말고, 로컬 상태를 바꾸지 않은 채 나중에 같은 요청과 op_id로 재시도합니다.
- PostgREST가 함수를 호출하기 전에 JSON 인자를 선언된 타입으로 바꾸다 실패하면(uuid가 아닌 문자열, integer 범위를 넘는 수, boolean이 아닌 값) 함수 코드가 실행되지 않으므로 22P02나 22003이 그대로 반환됩니다. 클라이언트는 이를 RPC_FAILED(나중에 재시도)로 분류하지만 같은 요청은 계속 실패하므로, 보내기 전에 형식을 검사해야 합니다(동기화 클라이언트는 UUID와 카운터를 미리 검사합니다).
- JWT subject가 UUID가 아니면 함수 안의 `auth.uid()`가 22P02를 냅니다. 이는 토큰 발급 설정 오류이며 계약 사유로 바꾸지 않습니다.
- 결함이 여러 개인 요청은 그중 한 사유만 받습니다. 클라이언트는 검사 순서에 의존하면 안 됩니다.
- HTTP 상태 매핑은 PostgREST 문서를 기준으로 적었으며, 이 저장소에서 PostgREST를 실행해 확인하지는 않았습니다. 테스트는 PGlite에서 SQLSTATE와 message를 확인합니다.

### 동기화 RPC 사유

| 사유 | HTTP | 종류 | 발생 조건 |
|---|---|---|---|
| unauthenticated | 401 | auth | JWT subject가 없음. create_workspace(새 ID)와 respond_invitation(삭제 뒤 그 ID로 온 초대에 답함)에서는 subject가 auth.users에 없는 경우(삭제된 계정의 아직 유효한 토큰)도 포함 |
| forbidden | 403 | access | 멤버가 아님(없는 workspace 포함), owner 전용 RPC를 owner가 아닌 사용자가 호출(아무것도 바꾸지 않는 호출 포함), 역할·상위 폴더·문서 ACL 권한 부족(없는 상위 폴더나 문서 포함). respond_invitation은 초대도 멤버십도 없는 호출자(이미 거절한 초대의 재시도 포함), leave_workspace는 비멤버(이미 나간 뒤의 재시도 포함), accept_ownership은 owner도 제안받은 멤버도 아닌 호출자, restore_document는 문서 편집 권한(document_rank 2) 없음. get_documents는 볼 수 없거나 없는 문서 ID에 이 오류를 내지 않고 건너뜀 |
| folder_not_found | 404 | not_found | set_folder_acl, get_acl의 대상 폴더가 없음 |
| document_not_found | 404 | not_found | set_document_acl, get_acl의 대상 문서가 없음 |
| member_not_found | 404 | not_found | set_member로 역할을 줄 대상이 멤버가 아님(멤버는 초대 수락으로만 추가), offer_ownership 대상이 멤버가 아님, create_folder·set_folder_acl·set_document_acl의 ACL 키가 현재 멤버가 아님. 멤버가 아닌 사용자를 제거하면 오류 없이 `changed: false` |
| op_id_reused | 409 | conflict | 같은 사용자·workspace의 op_id를 다른 요청에 다시 사용. push, create_document(p_op_id, 없으면 document_id), restore_document가 같은 op_id 이름공간을 씀 |
| id_conflict | 409 | conflict | create_workspace, create_folder, create_document의 ID가 이미 있음(폴더와 문서는 같은 workspace 안에서 비교) |
| invalid_key_epoch | 409 | conflict | key_epoch가 문서의 현재 값과 다름(새 문서는 1) |
| cursor_ahead | 409 | conflict | pull_changes의 p_after가 형식은 맞지만 workspace head보다 큼 |
| already_member | 409 | conflict | invite_member의 대상이 이미 멤버(호출자 자신 포함) |
| owner_must_transfer | 409 | conflict | owner가 leave_workspace를 호출. 다른 멤버가 있는 workspace의 owner 계정을 삭제(삭제 트리거가 발생시킴. Supabase 문서에 따르면 인증 서비스는 이를 HTTP 500으로 보고하지만 이 저장소에서 확인하지 않음, 위 '계정 삭제'의 운영 메모) |
| acl_version_mismatch | 409 | conflict | set_folder_acl, set_document_acl의 p_expected_version이 저장된 acl_version과 다름. 새 ACL이 저장된 ACL과 같으면 이 오류 없이 `changed: false` |
| restore_expired | 409 | conflict | restore_document 대상의 삭제 시각이 보관 기간(720시간)을 지났거나 내용이 이미 영구 삭제(purge)됨 |
| invalid_request | 400 | invalid | create_workspace의 ID나 이름이 null이거나 이름이 1~200자가 아님. create_folder의 folder_id, create_document의 document_id, set_member·invite_member의 user_id가 null. create_document의 kind가 meeting/agenda/note가 아님. respond_invitation의 p_accept, set_ai_enabled의 p_enabled가 null. get_acl·list_acls의 kind가 folder/document가 아님. set_folder_acl·set_document_acl의 p_expected_version, restore_document의 op_id나 base_revision이 null이거나 push의 base_revision과 같은 형식 규칙에 맞지 않음. get_documents의 p_ids가 null이거나 비었거나 500개를 넘거나, 1차원 배열이 아니거나, null 원소나 중복이 있음 |
| invalid_acl | 400 | invalid | ACL이 JSON 객체가 아니거나, 키를 UUID로 변환할 수 없거나, 값이 viewer/editor가 아니거나, 표준 UUID 표기로 바꾸면 같은 키가 둘 이상 |
| invalid_role | 400 | invalid | set_member의 역할이 viewer, editor, null(제거) 중 하나가 아님('owner'는 owner_change_not_supported). invite_member의 역할이 editor, viewer, null(초대 취소) 중 하나가 아님 |
| owner_change_not_supported | 400 | invalid | set_member로 자기 자신의 멤버십 변경 또는 owner 지정, offer_ownership으로 자기 자신에게 제안 |
| invalid_ciphertext | 400 | invalid | 암호문 envelope의 형식, 크기, AAD 바인딩 오류 |
| invalid_push | 400 | invalid | op_id나 deleted가 null이거나, base_revision이 0으로 시작하지 않는 19자리 이하 십진수 문자열로서 1 이상 bigint 최댓값 이하가 아님 |
| invalid_cursor | 400 | invalid | p_after가 '0' 또는 0으로 시작하지 않는 19자리 이하 십진수 문자열로서 bigint 최댓값 이하가 아님 |
| invalid_limit | 400 | invalid | pull_changes, list_accessible_documents, list_my_workspaces, list_members, list_invitations, list_my_invitations, list_folders, list_acls, list_trash, purge_expired_trash의 limit이 null이거나 1~500 범위 밖 |

`SERVER_ERRORS`의 나머지 사유는 AI RPC, Gateway, worker용입니다. AI RPC는 위 표의 일부 사유(예: unauthenticated, forbidden, invalid_request)도 함께 씁니다. 발생 조건은 `backend/AI-DATABASE.md`를 참고하세요.

| HTTP | 종류 | AI용 사유 |
|---|---|---|
| 403 | access | invalid_consent, ai_disabled |
| 404 | not_found | workspace_not_found, job_not_found |
| 409 | conflict | consent_id_reused, consent_already_used, job_id_reused, route_immutable, budget_immutable, stale_fence, not_claimed, not_dispatched, settlement_conflict, event_id_reused |
| 400 | invalid | invalid_route, invalid_lease, invalid_cost, invalid_outcome, actor_not_member |
| 402 | throttled | budget_exceeded, budget_not_configured |
| 429 | throttled | rate_limited |

### 클라이언트 처리 기준

`classifyRpcFailure(status, body)`는 HTTP 상태와 본문을 함께 보고 계약에 있는 사유만 돌려줍니다. 상태와 code가 맞지 않거나 표에 없는 사유는 RPC_FAILED가 되므로, 신뢰할 수 없는 본문 문자열이 오류나 로그에 들어가지 않습니다.

| 종류 | 분류 | 클라이언트 처리 |
|---|---|---|
| auth | AUTH_REQUIRED | 세션을 갱신하거나 다시 로그인합니다. 로컬 상태는 바꾸지 않습니다. 본문과 관계없이 모든 401이 여기에 해당합니다. |
| access | ACCESS_DENIED | 지금 권한으로는 허용되지 않습니다. push라면 그 op만 보류하고, 권한이 바뀐 뒤(사용자 신호, access_epoch 변경) 다시 시도합니다. pull, manifest, get_documents에서 받은 forbidden은 workspace 접근 철회이므로 공유 캐시, 커서, epoch를 지우되 개인 기록, 미전송 편집본, outbox 복구 정보는 보존합니다. |
| not_found, conflict, invalid | REQUEST_REJECTED | 같은 요청은 다시 보내도 실패합니다. outbox에서는 그 op만 따로 보류하고 다음 op를 계속 보냅니다. op 하나가 outbox 전체를 막으면 안 되며, 같은 실행에서 이미 반영된 앞선 op의 receipt는 확인 처리합니다. cursor_ahead는 로컬 커서가 서버보다 앞선 상태(예: 서버 복원)이므로, 클라이언트는 공유 캐시·커서·epoch를 지운 뒤(미전송 편집본과 outbox는 보존) manifest부터 한 번 다시 받습니다. 복원된 서버가 같은 revision 번호를 다른 내용으로 다시 쓰면 그 번호를 기준으로 한 미전송 편집이 확인 없이 반영될 수 있는 위험은 남아 있습니다(이력 식별자 도입은 P1). |
| throttled | RATE_LIMITED | 나중에 재시도합니다. |
| 계약 밖 | RPC_FAILED | 서버 결함, 설정 오류, 네트워크 실패입니다. 로컬 상태를 바꾸지 않고 나중에 같은 요청과 op_id로 재시도합니다. 42501 권한 설정 오류도 여기에 해당하므로 공유 캐시를 지우거나 op를 access_denied로 보류하지 않습니다. |

push와 restore_document 응답의 `status: conflict`와 `status: deleted`는 오류가 아니라 정상 receipt(HTTP 200)입니다. 큐에 넣은 문서 생성(create_document)도 push와 같은 기준으로 op별로 보류합니다. 클라이언트 처리는 `shared/contracts/README.md`를 참고하세요.

## 다음 단계와 제한

- hosted Supabase에서 마이그레이션, PostgREST 노출 스키마, auth JWT, 다중 세션 경쟁/잠금 순서(계정 삭제 트리거와 RPC 사이의 대기와 lock_timeout 포함), Realtime RLS, auth.users 트리거 생성 권한, 인증 서비스가 트리거 오류를 보고하는 방식을 별도로 검증해야 합니다.
- Realtime publication을 수정하지 않았습니다. 향후 게시 대상은 app.user_signals만 허용하고 콘텐츠/키/원장은 게시하지 마세요.
- 폴더 이동/삭제, 문서 이동, workspace 삭제(계정 삭제 외), 멤버·폴더 표시 이름, 이메일 초대와 사용자 검색, 키 배포(key_envelopes를 읽고 쓰는 RPC), key_epoch 회전과 기존 멤버의 키 회수, 키 복구/KMS, 첨부파일과 storage_deletions 처리, purge 일정, 계정 삭제 엔드포인트, 원장 보존/정리 정책은 미구현입니다. 권한 회수는 서버 접근을 막지만 이미 내려받은 데이터/키를 회수하지 못합니다.
- 대형 workspace의 ACL 조회/목록 성능과 저장량 상한은 실제 서버에서 따로 측정해야 합니다. P0-2부터 manifest는 access_epoch가 바뀔 때만 재시작하고 메타데이터만 보내며, pull과 get_documents는 바이트 예산으로 끊습니다(비판적 검토 high 4·5, `docs/implementation-status.md`의 'P0-2 결과'). 남은 비용은 다음과 같습니다. 목록의 접근 검사는 여전히 행마다 실행되어, 보이는 문서가 드물고 폴더가 깊으면 한 페이지에 몇 초가 걸릴 수 있습니다(F22, P1). 한 번도 ANALYZE하지 않은 테이블에서는 통계 없는 계획 때문에 첫 몇 페이지가 느립니다(PGlite에서 볼 수 있는 문서 10,000개, limit 100일 때 처음 5~6페이지가 각각 약 170~240ms, 이후 약 2ms). 실제 공유는 여전히 모든 멤버가 목록을 다시 받게 하고(사용자별 epoch 없음, 다만 캐시에 없거나 바뀐 문서만 내려받음), Pull은 창마다 한 번 보내므로 자주 바뀐 큰 문서는 따라잡는 동안 창 수만큼 다시 받습니다. 원장 정리(F25)는 미구현입니다. P0-3의 list_folders와 list_trash도 행마다 접근을 계산합니다. 계정 삭제와 purge가 쓰는 인덱스를 더했습니다(F61 일부). 사용자 ID별 조회 인덱스(members_user, invitations_user, receipts_actor, journal_actor, audit_actor, audit_target, workspaces_pending_owner, AI의 ai_consents_actor·ai_jobs_actor), workspace·문서·상위 폴더별로 지우는 문장과 그 외래키 검사용 인덱스(journal_document, documents_folder, folders_parent, audit_workspace, user_signals_workspace, attachments_document, AI의 ai_consents_document, 그리고 두 예산 외래키의 열과 정확히 같은 ai_jobs_actor_budget(workspace_id, actor_scope, period)·ai_jobs_workspace_budget(workspace_id, workspace_scope, period)), 내용이 남은 휴지통만 담는 documents_trash(`(deleted_at) where deleted and not purged`)입니다. 예산 인덱스로는 지우는 예산 행을 가리키는 작업만 읽으므로, 작업들과 같은 달의 예산 행을 지울 때도 다른 작업을 읽지 않습니다((workspace_id, period) 인덱스 하나였을 때는 다른 사용자의 작업 1,000개와 같은 달인 예산 행 하나를 지우며 작업 2,000행을 읽었음). 대신 작업을 넣을 때와 작업 상태를 바꿀 때마다(state가 ai_queue의 조건에 있어 이 UPDATE는 HOT가 아님) 두 인덱스에 항목을 하나씩 쓰므로 인덱스 하나였을 때보다 항목을 하나 더 쓰고, PGlite에서 RPC로 실행한 작업 200개의 수명주기(동의, 접수, claim, dispatch, 정산)는 WAL을 약 9.8% 더 썼습니다. purge의 세 문장(후보 검색, workspace 안의 반복, more 확인)은 documents_trash를 쓸 수 있도록 인덱스와 같은 조건 `not purged`를 씁니다(같은 뜻의 `ciphertext is not null`은 계획기가 인덱스 조건과 맞춰 보지 않음). purged는 `ciphertext is null`로 계산해 저장하는 문서의 생성 열입니다(아래 '생성 기본 권한' 문단). 인덱스 키나 부분 인덱스 조건에 쓰인 열이 바뀌는 UPDATE는 HOT 업데이트가 될 수 없으므로, 조건에 ciphertext를 직접 쓰던 이전 정의에서는 내용을 바꾸는 push가 하나도 HOT가 아니었습니다(PGlite에서 100번 중 0번, 2,000번이면 WAL 약 6.6% 증가). push는 purged를 바꾸지 않으므로 지금은 다시 HOT입니다(100번 중 100번, 2,000번 중 1,714번으로 조건이 `deleted`뿐이던 때와 같음). 테스트가 PGlite의 통계 뷰로 읽은 행 수와 HOT 업데이트 수를 고정하지만(ANALYZE한 테이블에서, 기한이 지난 내용 없이 purge한 tombstone과 기한 전 휴지통만 있으면 purge는 문서·workspace 행을 읽지 않음, 오래된 tombstone이 통계를 채워도 purge하는 호출은 generic plan과 custom plan 모두 문서를 30행 넘게 읽지 않음, 다른 workspace에 기한이 지난 문서 100개가 남아 more가 true인 custom plan 호출은 3×100+30행 넘게 읽지 않음(more 확인은 첫 항목에서 멈춤), 내용 push 20번 가운데 16번 이상이 HOT, 혼자인 workspace를 지울 때 다른 tenant의 audit·신호 행을 훑지 않음, 초대받은 사람의 계정 삭제가 다른 tenant의 신호 행 5,000개를 훑지 않음, 문서마다 동의를 훑지 않음, 예산 행을 지울 때 작업들과 같은 달의 행을 포함해 workspace의 작업을 훑지 않음), 실제 PostgreSQL에서 잠금을 쥔 동안의 실행 시간과 HOT 비율은 재지 않았습니다. purge의 후보 검색은 여전히 호출마다 기한이 지나고 내용이 남은 휴지통 행을 모두 읽으므로, 밀린 E개를 비우는 동안 후보 검색만 약 E²/min(k, p_limit)행(k는 workspace마다 밀린 수)을 읽습니다(위 '휴지통 영구 삭제(purge) 운영'). 테스트 픽스처의 통계에서는 workspace 안의 반복도 잠금 아래에서 그 항목을 다시 읽었습니다. custom plan은 그 workspace의 문서와 documents_trash를 함께 쓰는 BitmapAnd로 기한이 지난 항목의 인덱스 항목을, generic plan은 documents_trash를 훑으며 행까지 읽었습니다(다른 workspace에 100개가 남았을 때 반복 하나가 custom plan에서 documents_trash 항목 101개, generic plan에서 항목과 행 101개씩).
- AI Gateway, 예산 예약, 영속 큐, worker는 로컬 모듈로 구현했습니다(`backend/AI-DATABASE.md`, `backend/gateway/README.md`, `backend/worker/README.md` 참고). 배포하거나 실제 서비스에 연결하지는 않았고, 외부 AI 전송은 구현하지 않았습니다.

문서 생성 key_epoch는 1로 시작하고 push는 해당 문서의 현재 key_epoch와 비교합니다. workspace 공통 키를 강제하지 않습니다. 폴더 조상 순회는 순환 또는 128개 초과 깊이에서 owner를 포함하여 접근을 거부합니다.

업무상 접근 거부는 forbidden(PT403, HTTP 403)이고, JWT subject가 없으면 unauthenticated(PT401, HTTP 401)입니다. lock_workspace는 subject를 먼저 확인한 뒤 workspace를 찾습니다. 따라서 subject 없는 호출은 workspace 존재 여부와 관계없이 unauthenticated를 받고, 인증된 비멤버는 lock_workspace를 쓰는 RPC에서 존재하는 workspace와 없는 workspace 모두 forbidden을 받아 존재 여부를 구분할 수 없습니다. 다만 ID를 클라이언트가 정하는 create_workspace는 이미 있는 ID에 id_conflict를 반환하므로, ID를 아는 사람은 그 workspace가 있다는 사실을 알 수 있습니다. invite_member는 아무 UUID나 받으므로 계정이 있는지 알려 주지 않습니다. 배포 권한 설정 오류(예: EXECUTE 권한 누락)는 SQLSTATE 42501로 남습니다. PostgREST는 이를 HTTP 403(anon 요청은 401)으로 반환하지만 본문 code가 PT403이 아니므로 forbidden과 구분됩니다. 그러므로 HTTP 403만으로 접근 철회를 판단하면 안 되며, code PT403과 message forbidden이 함께 올 때만 공유 캐시를 정리해야 합니다. 이때도 미전송 편집본과 outbox 복구 정보는 유지해야 합니다. 동기화 클라이언트(`shared/contracts/sync-client.js`, `sync-engine.js`)는 이 기준을 따릅니다(`shared/contracts/README.md` 참고).

암호문 크기 제한: ciphertext base64 문자열은 최대 1,048,576자(디코딩 최대 786,432바이트, 태그 포함)이며 전체 envelope의 PostgreSQL jsonb 텍스트 표현은 UTF-8 기준 최대 1,049,600바이트입니다. 디코딩 전에 크기를 검사합니다. nonce/ciphertext 모두 표준 canonical base64만 허용하며 잘못된 패딩, 생략된 패딩, 0이 아닌 패딩 비트, 개행을 거부합니다. 정확한 상한/상한 초과/비정규 패딩을 SQL 테스트로 검증합니다.

생성 기본 권한: 폴더 생성은 owner만 할 수 있고, 새 폴더와 새 문서의 ACL은 null이라 상위 폴더 사슬과 workspace 역할을 상속합니다(F01, P0-3 전에는 생성자에게만 editor를 주었습니다). owner는 create_folder에 ACL을 주어 처음부터 제한된 폴더를 만들 수 있습니다. 문서는 만들 때 제한할 수 없으므로, 숨길 문서는 제한된 폴더에 만들거나 만든 뒤 owner가 set_document_acl로 제한해야 하며, 그 사이에 sync한 멤버는 내용을 받을 수 있습니다. owner도 콘텐츠 ACL을 우회하지 않으며 멤버/ACL 관리만 독립적으로 수행할 수 있습니다. key_envelopes의 키는 (workspace_id, document_id, user_id, key_epoch)이며 문서 복합 외래키로 테넌트를 분리합니다. head>=0, revision/seq/access_epoch/acl_version>=1, request_hash 32바이트, workspace 이름 1~200자 제약과, 살아 있는 문서에는 암호문이 있고 삭제 여부와 삭제 시각이 함께 움직인다는 문서 CHECK 제약(documents_content_check, documents_deleted_at_check)을 적용합니다. 문서의 purged는 `ciphertext is null`로 계산해 저장하는 생성 열(STORED. PostgreSQL 18의 기본인 VIRTUAL 생성 열은 인덱스에 쓸 수 없음)로, documents_trash와 purge만 씁니다. 어떤 RPC 응답에도 들어가지 않으며(list_acls의 purged는 따로 계산), deleted 바로 뒤에 두었으므로 대개 정렬 여백이 그 1바이트를 받아 행이 커지지 않습니다. 생성 열에는 값을 넣을 수 없으므로 app.documents에 INSERT할 때는 열 이름을 적어야 합니다(열 순서대로 넣으면 deleted 다음 자리가 이 열).
