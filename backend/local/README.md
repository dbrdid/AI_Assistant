# backend/local: 서버에 맞춘 기기 저장소

> 저장소 위치: `backend/local/`. 2026-11-15에 이전 `backend/local`(기기 안에서만 쓰던 저장소)을 이 버전으로 바꿨어요. 화면이 부르는 함수 이름은 그대로예요. 아래 글의 `fe/stella`는 `frontend/Frontend_UI/src/lib/stella/`, `stella-sync-verify`는 `tests/sync-verify/`예요.

메모, 일정·할 일, AI 제안을 휴대폰 안 SQLite(expo-sqlite)에 저장합니다. 손주원 님의 `backend/local/src`(2026-11-15)를 바탕으로, 저장 규칙을 서버(Supabase, 마이그레이션 37개 기준)에 맞춰 다시 만들었습니다. 화면이 부르는 함수 이름은 그대로입니다. 함수별 약속은 [CONTRACT.md](CONTRACT.md)에 있습니다.

이전 `backend/local/src`와 `tests`를 이 폴더가 대신합니다. 이전 버전은 git 기록(커밋 `9d6bb42`)에 남아 있습니다.

## 원본에서 달라진 것

| 원본 | 지금 | 이유 |
| --- | --- | --- |
| id는 200자 이내 아무 문자열 | UUID만 | 서버 기록 id로 그대로 씀 |
| 메모 제목 500자, 담당자 200자, 공간 이름 100자·설명 500자 | 200자, 100자, 60자·120자 | 서버 check 제약 |
| 손글씨는 배열이면 통과, 200만 자 | 획 형식 검사, 서버 기준 1MiB | 서버가 거절하면 동기화가 멈춤 |
| 워크스페이스 이름 중복 금지 | 중복 허용 | 서버 공간은 이름이 겹칠 수 있음 |
| 워크스페이스는 기기 안에서만 | 서버 공간 id·내 역할·멤버 수를 가짐 | 화면이 `멤버 N명 · 역할`을 표시함 |
| 일정·할 일은 바로 삭제 | 공유 공간은 휴지통·복구·영구 삭제 | 서버 휴지통과 같게 |
| 일정과 할 일 구분 없음 | `kind`(`task`·`event`)를 저장 | 서버는 `tasks`와 `events`가 따로 |
| 하루짜리 일정만 | `endDate` | 서버 일정은 여러 날일 수 있음 |
| 공유·동기화 없음 | 보낼 목록(outbox), `applyServer`, 다리(`createBridge`) | 공유 공간 기록을 같은 화면 함수로 다룸 |
| 팀 서버 AI 결과만 변환 | `proposalsFromAnalyze` 추가 | `ai-gateway`의 `/analyze` 결과 |
| 내보내기 없음 | `exportAll`·`importAll`·`clearAll`·`bindAccount` | 백업, 로그아웃, 탈퇴 |

## 파일

| 파일 | 역할 |
| --- | --- |
| `src/store.js` | `createLocalStore`: 쓰기마다 트랜잭션 하나, 목록 캐시, 변경 알림, 보낼 목록 기록 |
| `src/schema.js` | 표와 버전 (`PRAGMA user_version`) |
| `src/validate.js` | 입력 검사 (서버 한도와 같은 값) |
| `src/memos.js`, `tasks.js`, `proposals.js`, `workspaces.js` | 영역별 저장 규칙 |
| `src/server.js` | 화면 값 ↔ 서버 값 변환, AI 초안 변환 |
| `src/apply.js` | 서버에서 받은 행을 표에 반영 |
| `src/bridge.js` | 저장소 ↔ `fe/stella/local-sync.ts` ↔ 서버를 잇는 다리 |
| `src/backup.js` | 내보내기·가져오기·전체 지우기·계정 묶기 |
| `src/hooks.js` | `useMemos` 같은 React 훅 연결 |
| `tests/` | Node 내장 SQLite로 expo-sqlite 동기 API를 흉내 낸 대역에서 실행 |
| `verify/server-roundtrip.mjs` | 실제 서버 스키마(로컬 Postgres)와 두 기기 왕복 검증 |

## 화면에 연결

```js
import { openDatabaseSync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { createLocalStore, createHooks } from '<경로>/backend/local/src/index.js';

export const store = createLocalStore({ db: openDatabaseSync('planner.db'), newId: randomUUID });
export const { useMemos, useTrashedMemos, useTasks, useTrashedTasks, useProposals, useWorkspaces } = createHooks(useSyncExternalStore, store);
```

로그인 직후에 `store.bindAccount(계정 id)`를 부릅니다. `account_mismatch`가 나면 확인을 받고 `store.clearAll()` 뒤에 다시 부릅니다.

## 공유 공간과 서버

개인 공간의 저장은 기기에만 남습니다. 공유 공간에서 한 저장은 같은 트랜잭션에서 보낼 목록에 서버 형식으로 적히고, 다리가 가져갑니다.

```js
import * as engine from '@/lib/stella/local-sync';
import { createBridge } from '<경로>/backend/local/src/index.js';

const bridge = createBridge({
  store, engine, db: expoSqliteDb(await SQLite.openDatabaseAsync('stella.db')), transport: supabaseTransport(supabase),
  accountId, deviceId,
  favorites: { set: (ws, ids, on) => setNoteFavorites(supabase, ws, ids, on), list: ws => listNoteFavorites(supabase, ws) },
});
await bridge.syncAll();                 // 앱 시작, 화면 복귀, 실시간 신호, 저장 직후(store.subscribeOutbox)
```

`accountId`는 꼭 넘겨 주세요. 다리가 첫 동기화 전에 `local-sync`의 `bindSyncAccount`를 불러서, 같은 기기를 다른 계정이 쓰던 경우 그 계정이 남긴 공유 공간 기록과 못 보낸 수정을 지웁니다(앞사람의 수정이 뒷사람 이름으로 올라가지 않게). 기기 저장소가 다른 계정에 묶여 있으면(`store.getAccount()`) 동기화하지 않고 `account_mismatch`로 실패합니다. 로그아웃·탈퇴 때는 `store.clearAll()`과 함께 `local-sync`의 `clearLocalSync(db)`를 부릅니다.

`syncAll()`은 `{ 기기 공간 id: 결과 }`를 돌려줍니다. 한 공간이 실패해도 나머지는 계속 돕니다.

| 결과 | 뜻 | 화면에서 할 일 |
| --- | --- | --- |
| `status: 'OK'` | 보내고 받고 화면용 표를 맞춤 | `flush.status`가 `CONFLICT`·`BLOCKED`면 아래 충돌 처리 |
| `status: 'CLOSED'` | 공간에서 빠졌거나 공간이 삭제됨 | 알리고 `store.deleteWorkspace` |
| `status: 'ERROR'` (`code`, `error`) | 그 공간의 동기화가 오류로 끝남 | 다음 동기화에서 다시 시도 |
| `handOff: { status: 'BLOCKED', seq, code, error }` | 엔진이 보낼 목록의 그 줄을 받지 않음. 그 공간의 뒤 줄은 순서를 지켜 기다림 | 고칠 수 없으면 `store.ackOutbox(seq)`로 버리고 `bridge.refresh(공간 id)` |

다리가 지키는 것:

- 동기화가 도는 동안 화면에서 한 저장은 그대로 남습니다. 그 기록은 이번에 서버 값으로 덮지 않고, 같은 `syncAll()` 안에서 이어서 한 번 더 돌아(최대 3번) 서버까지 올립니다.
- `syncAll`·`syncWorkspace`·`refresh`는 겹쳐 불러도 차례로 돕니다. 도는 중에 `syncAll()`을 다시 부르면 같은 실행을 돌려줍니다.
- 한 번에 많이 바꾼 저장(휴지통 비우기 등)은 저장할 때 100개씩 나눠 적습니다(`local-sync`가 한 묶음에 100개까지 받음).
- 넘긴 직후 앱이 꺼져 같은 줄을 다시 넘겨도 엔진에는 한 번만 들어갑니다(`saveLocal`의 `handoffKey`).
- 별표는 메모가 서버에 올라간 뒤에 보냅니다. 새 메모에 바로 별표를 눌러도 첫 동기화에서 저장됩니다.

- 공간 만들기: `store.createWorkspace` → 서버 `create_workspace` → `store.linkWorkspace(기기 id, 서버 id)`.
- 초대 수락 뒤: 서버 `accept_invite` 결과로 `store.joinWorkspace({ id: 서버 공간 id, name, role: '멤버', members })`. 전체 받기·멤버 변경 뒤: `store.upsertServerWorkspace({ id, name, description, role, members })`.
- 프로젝트 화면 값: `store.serverMap.projectData(form)`으로 서버 값(`name`, `due_date`, `priority`, `progress_status`, `reminder_minutes` 등)을 만들어 `local-sync`의 `saveLocal`에 넘기고, 받을 때는 `projectFromServer(row)`.
- `syncAll()` 결과의 `flush.status`가 `CONFLICT`나 `BLOCKED`면 `local-sync`의 `resolveConflict`·`discardOutbox`로 푼 뒤 `bridge.refresh(공간 id)`를 부릅니다.
- AI: `store.addProposals(store.serverMap.proposalsFromAnalyze(response.draft, { sourceType: 'memo', sourceId, sourceTitle, sourceRevision }))`.
- 백업: `createBackup`에 `store.exportAll()`을 넘기고, `restoreBackup`으로 받은 내용을 `store.importAll()`에 넘깁니다. 공유 공간은 백업에 넣지 않고 동기화로 다시 받습니다.

## 실행

```text
npm test                       # 단위 테스트 (Node.js 22.13 이상, 외부 패키지 없음)
npm run verify:server          # 서버 왕복 검증: supabase/tests/reset.sh로 만든 로컬 DB와 옆 폴더 stella-sync-verify 필요
```

## 검증 (2026-11-15)

- 단위 테스트 61개 통과: 원본 테스트 39개(바뀐 규칙에 맞게 고침) + 새 테스트 12개 + 동기화 다리 8개(`tests/bridge.test.mjs`) + 엔진의 넘겨받기·계정 규칙 2개(`tests/engine.test.mjs`, `tests/sync-verify/lib`의 엔진 사본이 없으면 건너뜀).
- 핵심 규칙 22가지와 동기화 다리 규칙 30가지를 하나씩 일부러 망가뜨렸을 때 테스트가 모두 잡았습니다.
- 서버 왕복 검증 26개 통과: 마이그레이션 37개를 적용한 로컬 Postgres에서 기기 두 대(저장소 + `local-sync` + 다리)가 `sync_push`·`sync_pull`로 주고받았습니다. 서버 제약 통과, 같은 기록의 다른 칸 동시 수정, AI 제안 승인, 휴지통·복구·영구 삭제, 즐겨찾기, 한도 근처 손글씨, 프로젝트 화면 값 변환을 확인했습니다.
- 같은 검증에서 동기화 약점 수정(2026-11-15)도 확인했습니다: 동기화 도중에 쓴 메모·수정·AI 제안과 새 메모의 별표, 120개를 한 번에 휴지통으로·영구 삭제, 넘긴 직후 앱이 꺼진 뒤 다시 넘기기(서버에 한 번만 저장), 같은 기기에서 계정이 바뀐 경우(앞 계정이 못 보낸 수정은 올라가지 않음).
- 화면 코드(`frontend/Frontend_UI/src`)가 부르는 저장소 함수와 읽는 칸을 모두 대조했습니다. 화면이 그대로 부르는 `switchWorkspace('personal')`과 `joinWorkspace`를 받도록 맞췄습니다.

## 남은 제한

- 실제 expo-sqlite, 실기기, 원격 Supabase에서는 실행하지 않았습니다. 왕복 검증은 로컬 Postgres입니다.
- 화면과는 아직 연결되지 않았습니다. 화면 쪽 `src/data/*Store.js`가 저장소에 없습니다.
- 중요도·알림 글자 목록은 추정값입니다. 화면 쪽 `TaskStore`의 `PRIORITIES`·`ALARMS`와 다르면 `labels` 옵션으로 맞춰야 합니다.
- 사진은 변경 모양만 단위 테스트로 확인했습니다. 실제 올리기(`attachments.ts`)와 이어서는 검증하지 않았습니다.
- 계정이 바뀌면 앞 계정이 못 보낸 수정은 버려집니다. 로그아웃 전에 `local-sync`의 `getSyncStatus`와 `store.outboxCount()`로 남은 수정이 있는지 알려 주는 일은 화면 몫입니다.
- 충돌이나 서버 거절이 나면 그 공간의 뒤 저장이 멈춥니다. 사용자가 고르는 화면(내 것 유지 / 서버 값)이 아직 없습니다.
- 공간 이름·내 역할·멤버 수가 바뀐 것은 다리가 반영하지 않습니다. 화면이 `store.upsertServerWorkspace`를 불러야 합니다.
- 다리는 스스로 돌지 않습니다. 앱 시작, 화면 복귀, 실시간 신호, 저장 직후에 앱이 `syncAll()`을 불러야 합니다.
- 다리는 sync 때마다 그 공간의 기록 전체를 다시 맞춥니다. 기록이 수천 건을 넘으면 바뀐 것만 맞추도록 바꿔야 합니다.
- 프로젝트·팀원·회의·안건·파일·녹음·설정·알림은 이 저장소에 없습니다. 공유 공간에서는 `local-sync`에서 직접 읽습니다.
- 할 일(`kind: 'task'`)의 끝 시간과 `project`(이름 글자)는 서버에 칸이 없어 이 기기에만 남습니다.
- 스키마 1단계를 다시 썼습니다. 원본 `src/`로 만든 DB 파일이 이미 있는 기기에서는 열 때 오류를 내므로 그 파일을 지워야 합니다(화면 연결 전이라 해당 기기는 없을 것으로 봅니다).
