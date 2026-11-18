# 화면 ↔ 기기 저장소 약속

2026-11-15에 서버(Supabase) 스키마에 맞춰 다시 만든 버전입니다. 화면이 부르던 함수 이름과 모양은 그대로이고, 달라진 약속은 아래와 같습니다.

- id는 모두 UUID입니다(`newId`에 `expo-crypto`의 `randomUUID`). 서버 기록 id로 그대로 씁니다.
- 길이 한도가 서버와 같습니다: 메모 제목 200자, 일정 제목 200자, 담당자 100자, 장소 200자, 워크스페이스 이름 60자·설명 120자.
- 손글씨 획은 `{id, c, w, p}` 형식만 받습니다(InkCanvas 저장 형식). 메모 하나의 손글씨는 서버 기준 1MiB까지입니다.
- 워크스페이스 이름은 겹쳐도 됩니다(`name_taken` 없음). 개인 공간이 아닌 워크스페이스는 서버의 공유 공간입니다.
- 공유 공간에서는 중요도·상태·알림 글자가 서버 값으로 바뀔 수 있어야 합니다(아래 "서버 값"). 개인 공간은 예전처럼 50자 이내 아무 글자나 됩니다.
- 공유 공간에서 일정·할 일을 지우면 휴지통으로 갑니다. 개인 공간은 예전처럼 바로 지웁니다.
- 공유 공간에서는 일정·할 일 하나가 메모 하나에만 연결됩니다(다른 메모에 연결하면 옮겨짐).
- 공유 공간의 사진(`photos`, `attachPhoto`)은 서버에 올린 첨부 id(UUID)여야 합니다.

`createLocalStore({ db })`가 돌려주는 객체의 함수입니다. 모두 **현재 워크스페이스** 안에서만 동작하고, 쓰기는 하나의 SQLite 트랜잭션으로 끝나거나 아무것도 바꾸지 않습니다. 시각은 밀리초 숫자(`Date.now()`), 날짜는 `YYYY-MM-DD`, 시간은 `HH:MM`(24시간) 또는 빈 문자열입니다.

돌려주는 객체와 목록은 얼려 둔(frozen) 읽기 전용입니다. 정렬은 `list.slice().sort(...)`처럼 복사해서 하세요. 목록 함수는 바뀐 것이 없으면 같은 배열을 돌려주므로 `useSyncExternalStore`에 바로 쓸 수 있습니다.

## 메모

| 함수 | 입력 | 결과 |
| --- | --- | --- |
| `getMemos()` | | 휴지통 밖 메모, 최근 수정순 |
| `getTrashedMemos()` | | 휴지통 메모, 최근 삭제순 |
| `getMemo(id)` | | 메모(휴지통 포함) 또는 `null` |
| `addMemo(fields)` | `{title, body, strokes, photos, taskIds, favorite}` 중 일부 | 새 메모. 제목·본문·손글씨가 모두 비면 `empty_memo` |
| `updateMemo(id, patch, {expectedRevision}?)` | 같은 필드 | 바뀐 메모. 내용(제목·본문·손글씨)이 바뀔 때만 `revision`과 `updatedAt`이 오름 |
| `trashMemo(id)` / `trashMemos(ids)` | | `true` / 옮긴 개수 |
| `restoreMemos(ids)` | | 복구한 개수 |
| `deleteMemoForever(id)` / `deleteMemosForever(ids)` | | `true` / 지운 개수. 그 메모의 열린 AI 제안도 닫힘 |
| `setFavorites(ids, bool)` | | 바뀐 개수 |
| `attachPhoto(id, fileId)` / `detachPhoto(id, fileId)` | 파일 ID | 바뀐 메모 |
| `subscribeMemos(fn)` | | 구독 해제 함수 |

메모 객체: `{id, title, body, strokes, photos, taskIds, favorite, revision, createdAt, updatedAt, deletedAt}`. 여러 개를 받는 함수는 없는 ID를 건너뜁니다.

## 일정·할 일

| 함수 | 입력 | 결과 |
| --- | --- | --- |
| `getTasks()` | | 날짜순, 같은 날은 시간 없는 것 먼저, 그다음 시작 시간순 |
| `getTask(id)` | | 일정 또는 `null` |
| `addTask(fields)` | `{title, date, endDate, start, end, priority, status, alarm, assignee, place, project, projectId, desc, kind}`. `title`·`date` 필수 | 새 일정. 기본값 중요도 `보통`, 상태 `진행 전`, 알림 `없음`. `kind`를 안 주면 시작 시간이 있을 때 `event`, 없으면 `task` |
| `updateTask(id, patch, {expectedRevision}?)` | 같은 필드 | 바뀐 일정 |
| `deleteTask(id)` | | `true`. 이 일정을 연결한 메모에서도 빠짐. 공유 공간은 휴지통으로 |
| `getTrashedTasks()` / `restoreTasks(ids)` / `deleteTasksForever(ids)` | | 공유 공간의 휴지통 목록 / 복구한 개수 / 영구 삭제한 개수 |
| `toggleDone(id)` | | `완료` ↔ `진행 전` |
| `findOverlap(fields, excludeId?)` | `{date, start, end}` | 같은 날 시간이 겹치는 미완료 일정 또는 `null`. 시작이 같거나 범위가 겹치면 겹침, 맞닿기만 하면 아님 |
| `subscribeTasks(fn)` | | 구독 해제 함수 |

일정 객체: `{id, kind, title, date, endDate, start, end, priority, status, alarm, assignee, place, project, projectId, desc, revision, createdAt, updatedAt, deletedAt}`. `kind`(`task` 할 일 · `event` 일정)는 만들 때 정해지고 바뀌지 않습니다. `endDate`는 여러 날 일정의 끝 날짜입니다(같은 날이면 빈 문자열).

## AI 제안

| 함수 | 입력 | 결과 |
| --- | --- | --- |
| `getProposals()` | | 열린 제안(`pending`, `hold`), 최신순 |
| `getProposal(id)` | | 열린 제안 또는 `null`(이미 처리됨) |
| `addProposals(items)` | `{kind, title, date, endDate, start, end, place, assignee, priority, body, evidence, sourceType, sourceId, sourceTitle, sourceRevision}` 배열 | 추가된 제안 배열 |
| `approveProposal(id, edits)` | 확인 화면에서 고친 값. `kind`·`title`·`date`·`endDate`·`start`·`end`·`place`·`assignee`·`priority`·`body`만 읽고 나머지 키는 무시 | 저장된 일정 또는 메모에 `kind: 'task' \| 'memo'`를 붙인 것 (일정이면 `taskKind`에 `task`·`event`) |
| `setProposalStatus(id, status)` | `pending`, `hold`, `rejected` | `true` |
| `findDuplicate(fields)` | `{kind, title, date}` | 같은 날 같은 제목(대소문자·공백 무시)의 일정 또는 `null` |
| `subscribeProposals(fn)` | | 구독 해제 함수 |

- `kind`는 `event`, `task`, `memo`입니다. 승인할 때 `event`·`task`는 일정으로, `memo`는 메모로 저장합니다.
- 메모에서 온 제안(`sourceType: 'memo'`)은 분석한 메모의 `revision`을 기억합니다. 서버로 보내기 전에 읽은 `memo.revision`을 `sourceRevision`으로 넘기세요. 넘기지 않으면 추가하는 시점의 revision을 씁니다.
- 늦게 온 결과(메모가 그 사이 바뀌었거나 휴지통·삭제됨)는 추가하지 않고 빈 배열을 돌려줍니다. 같은 메모의 새 분석이 오면 이전 revision의 열린 제안은 대체(`superseded`)됩니다. 같은 출처의 똑같은 제안은 다시 추가하지 않습니다.
- 승인은 일정·메모 저장, 원본 메모와의 연결, 제안 상태 변경을 한 번에 합니다. 같은 제안을 다시 승인하면 처음 저장한 항목을 돌려줍니다. 원본 메모의 내용(제목·본문·손글씨)이 바뀌었으면 `source_changed`로 막습니다. 메모를 영구 삭제하면 그 제안은 닫혀서 `already_processed`가 됩니다. 휴지통으로 옮기기만 한 메모는 내용이 그대로이므로 승인할 수 있습니다.
- `store.serverMap.proposalsFromAnalyze(draft, source)`: Supabase `ai-gateway`의 `/analyze` 초안(`draft.tasks`, `draft.events`)을 `addProposals` 입력으로 바꿉니다. 중요도와 여러 날 일정의 끝 날짜도 옮깁니다.
- `candidatesToProposals(candidates, source)`: (팀 서버용) `backend/cloud`의 `POST /v1/ai/organize` 결과 후보(`{kind, title, dueDate, sourceQuote}`)를 `addProposals` 입력으로 바꿉니다.
- `pendingOf(list)`: 목록에서 열린 제안만 고르는 도우미입니다.

## 워크스페이스

| 함수 | 결과 |
| --- | --- |
| `getWorkspaceState()` | `{list, current}`. `useWorkspaces()`가 돌려주는 모양 |
| `getWorkspaces()`, `getCurrentWorkspace()` | 목록, 현재 공간 |
| `createWorkspace({name, desc})` | 새 ID(전환하지는 않음). 기기에 먼저 만드는 공유 공간. 서버에 만든 뒤 `linkWorkspace` |
| `linkWorkspace(id, serverId)` | 기기에서 만든 공간에 서버 공간 id를 연결. 그동안 쌓인 변경이 올라감 |
| `upsertServerWorkspace({id, name, description, role, members})` | 서버 공간을 기기에 넣거나 고침(초대 수락·멤버 변경 뒤). 기기 ID |
| `switchWorkspace(id)` | ID. 다시 켜도 기억함. `'personal'`을 주면 개인 공간 |
| `joinWorkspace({id, name, role, members})` | 초대를 수락한 서버 공간을 기기에 넣음. `id`는 서버 `accept_invite`가 돌려준 공간 id, `role`은 `멤버`·`관리자` 또는 서버 값 |
| `deleteWorkspace(id)` | `true`. 기기에서만 지움(서버 삭제·나가기는 앱이 먼저). 그 공간의 메모·일정·제안을 함께 지움. 개인 공간은 `personal_workspace`. 현재 공간을 지우면 개인 공간으로 전환 |
| `subscribeWorkspaces(fn)` | 구독 해제 함수 |

워크스페이스 객체: `{id, name, desc, personal, createdAt, serverId, roleCode, role, members}`. `role`은 화면 글자(`관리자`·`멤버`·`보기 전용`), `roleCode`는 서버 값(`OWNER`·`EDITOR`·`VIEWER`)입니다. 처음 열면 `개인 공간`이 만들어지고 선택됩니다.

## 모든 공간 합쳐 보기

| 함수 | 결과 |
| --- | --- |
| `getAllTasks()` | 모든 공간의 일정·할 일(휴지통 제외). 항목마다 `workspaceId`. 공간 순서(개인 먼저) → 공간 안에서는 `getTasks()` 순서 |
| `getAllMemos()` | 모든 공간의 메모(휴지통 제외). 항목마다 `workspaceId` |
| `inWorkspace(id, 동작, ...인자)` | 지정한 공간에서 한 번 씀. 동작: `toggleDone` · `updateTask` · `deleteTask` · `addTask` · `addMemo` · `trashMemos` · `restoreMemos` · `setFavorites` (인자는 같은 이름 함수와 같음). 현재 공간은 바뀌지 않고, 보낼 목록은 그 공간 것으로 적힘. 없는 공간·다른 공간의 항목은 `not_found`, 보기 전용 공간은 `read_only`, 모르는 동작은 `invalid_input`(`name`) |

두 목록은 바뀔 때까지 같은 배열이고, 어느 공간에서든 메모·일정·공간이 바뀌면 새로 만듭니다. 편집 화면처럼 그 공간의 프로젝트 등 다른 기록이 함께 필요하면 `switchWorkspace`로 그 공간으로 바꾼 뒤 엽니다.

## 오류

거절은 `LocalError`이고 `error.code`로 구분합니다. 입력 오류는 `error.field`에 필드 이름이 들어갑니다.

| code | 뜻 |
| --- | --- |
| `invalid_input` | 필드가 없거나 타입·형식·길이가 틀림(없는 날짜 `2026-02-30`, `24:00` 포함) |
| `empty_memo` | 제목·본문·손글씨가 모두 빈 메모 |
| `not_found` | 현재 워크스페이스에 그런 항목이 없음 |
| `revision_conflict` | `expectedRevision`이 현재 값과 다름 |
| `source_changed` | AI 분석 뒤 원본 메모가 바뀜 |
| `already_processed` | 이미 승인·거절·대체된 제안 |
| `personal_workspace` | 개인 공간은 지우거나 서버와 연결할 수 없음 |
| `read_only` | 공유 공간에서 내 역할이 보기 전용 |
| `account_mismatch` | 이 기기 DB는 다른 계정의 것 (`clearAll` 뒤 다시 `bindAccount`) |
| `unsupported_backup` | 백업 형식이 다르거나 더 새 버전, 또는 손상됨 |

`LocalError`가 아닌 오류(SQLite 실패 등)도 저장은 되지 않은 상태입니다.

## 서버 값 (공유 공간)

| 화면 값 | 서버 값 |
| --- | --- |
| 메모 → `notes` | 빈 제목은 `null` |
| `kind: 'task'` → `tasks` | `due_at`(날짜+시작 시간), 시간이 없으면 `all_day` |
| `kind: 'event'` → `events` | `start_at`·`end_at`. 시간이 없으면 하루 종일(끝 날짜 다음 날 0시까지), 끝 시간이 없으면 시작과 같은 시점 |
| 중요도 `낮음`·`보통`·`높음` | `priority` 1·2·3 (서버 0은 화면에 `보통`) |
| 상태 `진행 전`·`진행 중`·`완료`·`취소` | `TODO`·`IN_PROGRESS`·`DONE`·`CANCELED` |
| 알림 `없음`·`정시`·`N분 전`·`N시간 전`·`N일 전`·`하루 전` 등 | `reminder_minutes` (없으면 `null`) |
| `assignee`·`place`·`desc`·`projectId` | `assignee_name`·`location`·`description`·`project_id` |
| 메모의 `taskIds` | 각 항목의 `note_id` |
| `photos` | `note_attachments` (첨부 id) |
| `favorite` | `note_favorites` (사람마다 따로, 동기화와 다른 길) |

화면의 글자 목록이 다르면 `createLocalStore({ labels: { priority, status, alarm, priorityNone } })`로 바꿉니다. 시간대는 `timezone` 옵션(기본 `Asia/Seoul`)입니다.

## 서버 연결·백업·계정

| 함수 | 결과 |
| --- | --- |
| `peekOutbox(limit?, {workspaceId?, afterSeq?}?)` | 공유 공간에서 한 저장들 `{seq, workspaceId, serverId, changes, createdAt}`. `changes`는 `local-sync`의 `saveLocal`에 그대로 넘기는 모양이고 한 줄에 100개까지(넘으면 여러 줄로 나눠 적음). 옵션으로 공간 하나만, 또는 `afterSeq` 다음부터 |
| `ackOutbox(seq)` / `outboxCount()` / `subscribeOutbox(fn)` | 넘긴 줄 지우기 / 남은 줄 수 / 구독 |
| `applyServer(workspaceId, items)` | 서버에서 받은 행을 화면용 표에 반영 `{notes, tasks, photos}` 바뀐 개수 |
| `applyFavorites(workspaceId, noteIds)` | 내 즐겨찾기를 서버 값으로 맞춤 |
| `createBridge({store, engine, db, transport, accountId, favorites, photos, workspaces, conflicts})` | 위 함수들을 `local-sync`와 이어 주는 다리: `start()`·`syncAll()`·`syncWorkspace(id)`·`status()`·`issues(id)`·`resolve(id, seq, 선택)`·`discard(id, seq)`·`refresh(id)`·`signOut()`. 겹쳐 불러도 차례로 돌고, 공간별 결과(`OK`·`CLOSED`·`ERROR`, 막힌 줄은 `handOff`)를 돌려줌. `accountId`가 기기 저장소의 계정과 다르면 `account_mismatch`. 자세한 표는 README |
| `resolveUpload(공간, memoId, ref, assetId)` | 기기 파일을 서버에 올린 뒤 메모의 그 사진을 첨부 id로 바꾸고 연결을 보낼 목록에 적음 (다리가 부름). 그새 지워졌으면 `false` |
| 공유 공간의 `photos` | UUID는 서버 첨부 id, 그 밖의 값은 아직 안 올린 기기 파일(올리기를 기다림). 개인 공간은 아무 id |
| `applyServer` · `applyFavorites` | 보낼 목록에 아직 남은 저장이 건드린 기록·별표는 건너뜀 (방금 한 저장을 서버 값으로 덮지 않음) |
| `exportAll()` / `importAll(payload)` / `counts()` | 개인 공간 내보내기 / 통째로 가져오기 / 개수 (`backup.ts`에 넘길 내용) |
| `clearAll()` | 기기 기록을 모두 지우고 빈 개인 공간으로 (로그아웃·탈퇴 뒤) |
| `bindAccount(accountId)` / `getAccount()` | 이 기기 DB를 쓰는 계정 기억. 다른 계정이면 `account_mismatch` |
