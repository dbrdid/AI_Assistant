# 화면 ↔ backend/local 약속

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
| `addTask(fields)` | `{title, date, start, end, priority, status, alarm, assignee, place, project, desc}`. `title`·`date` 필수 | 새 일정. 기본값 중요도 `보통`, 상태 `진행 전`, 알림 `없음` |
| `updateTask(id, patch, {expectedRevision}?)` | 같은 필드 | 바뀐 일정 |
| `deleteTask(id)` | | `true`. 이 일정을 연결한 메모에서도 빠짐 |
| `toggleDone(id)` | | `완료` ↔ `진행 전` |
| `findOverlap(fields, excludeId?)` | `{date, start, end}` | 같은 날 시간이 겹치는 미완료 일정 또는 `null`. 시작이 같거나 범위가 겹치면 겹침, 맞닿기만 하면 아님 |
| `subscribeTasks(fn)` | | 구독 해제 함수 |

## AI 제안

| 함수 | 입력 | 결과 |
| --- | --- | --- |
| `getProposals()` | | 열린 제안(`pending`, `hold`), 최신순 |
| `getProposal(id)` | | 열린 제안 또는 `null`(이미 처리됨) |
| `addProposals(items)` | `{kind, title, date, start, end, place, assignee, body, evidence, sourceType, sourceId, sourceTitle, sourceRevision}` 배열 | 추가된 제안 배열 |
| `approveProposal(id, edits)` | 확인 화면에서 고친 값. `kind`·`title`·`date`·`start`·`end`·`place`·`assignee`·`body`만 읽고 나머지 키는 무시 | 저장된 일정 또는 메모에 `kind: 'task' \| 'memo'`를 붙인 것 |
| `setProposalStatus(id, status)` | `pending`, `hold`, `rejected` | `true` |
| `findDuplicate(fields)` | `{kind, title, date}` | 같은 날 같은 제목(대소문자·공백 무시)의 일정 또는 `null` |
| `subscribeProposals(fn)` | | 구독 해제 함수 |

- `kind`는 `event`, `task`, `memo`입니다. 승인할 때 `event`·`task`는 일정으로, `memo`는 메모로 저장합니다.
- 메모에서 온 제안(`sourceType: 'memo'`)은 분석한 메모의 `revision`을 기억합니다. 서버로 보내기 전에 읽은 `memo.revision`을 `sourceRevision`으로 넘기세요. 넘기지 않으면 추가하는 시점의 revision을 씁니다.
- 늦게 온 결과(메모가 그 사이 바뀌었거나 휴지통·삭제됨)는 추가하지 않고 빈 배열을 돌려줍니다. 같은 메모의 새 분석이 오면 이전 revision의 열린 제안은 대체(`superseded`)됩니다. 같은 출처의 똑같은 제안은 다시 추가하지 않습니다.
- 승인은 일정·메모 저장, 원본 메모와의 연결, 제안 상태 변경을 한 번에 합니다. 같은 제안을 다시 승인하면 처음 저장한 항목을 돌려줍니다. 원본 메모의 내용(제목·본문·손글씨)이 바뀌었으면 `source_changed`로 막습니다. 메모를 영구 삭제하면 그 제안은 닫혀서 `already_processed`가 됩니다. 휴지통으로 옮기기만 한 메모는 내용이 그대로이므로 승인할 수 있습니다.
- `candidatesToProposals(candidates, source)`: `backend/cloud`의 `POST /v1/ai/organize` 결과 후보(`{kind, title, dueDate, sourceQuote}`)를 `addProposals` 입력으로 바꿉니다.
- `pendingOf(list)`: 목록에서 열린 제안만 고르는 도우미입니다.

## 워크스페이스 (이 기기 안에서만)

| 함수 | 결과 |
| --- | --- |
| `getWorkspaceState()` | `{list, current}`. `useWorkspaces()`가 돌려주는 모양 |
| `getWorkspaces()`, `getCurrentWorkspace()` | 목록, 현재 공간 |
| `createWorkspace({name, desc})` | 새 ID(전환하지는 않음). 이름 중복이면 `name_taken` |
| `switchWorkspace(id)` | ID. 다시 켜도 기억함 |
| `deleteWorkspace(id)` | `true`. 그 공간의 메모·일정·제안을 함께 지움. 개인 공간은 `personal_workspace`. 현재 공간을 지우면 개인 공간으로 전환 |
| `subscribeWorkspaces(fn)` | 구독 해제 함수 |

워크스페이스 객체: `{id, name, desc, personal, createdAt}`. 처음 열면 `개인 공간`이 만들어지고 선택됩니다.

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
| `name_taken`, `personal_workspace` | 워크스페이스 규칙 위반 |

`LocalError`가 아닌 오류(SQLite 실패 등)도 저장은 되지 않은 상태입니다.
