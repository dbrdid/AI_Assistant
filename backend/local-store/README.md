# local-store: 서버에 맞춘 기기 저장소

> 저장소 위치: `backend/local-store/`. 기존 `backend/local`은 그대로 두었고, 어느 쪽을 쓸지는 팀이 정해요. 아래 글의 `fe/stella`는 `frontend/Frontend_UI/src/lib/stella/`, `stella-sync-verify`는 `tests/sync-verify/`예요.

메모, 일정·할 일, AI 제안을 휴대폰 안 SQLite(expo-sqlite)에 저장합니다. 손주원 님의 `backend/local/src`(2026-11-15)를 바탕으로, 저장 규칙을 서버(Supabase, 마이그레이션 37개 기준)에 맞춰 다시 만들었습니다. 화면이 부르는 함수 이름은 그대로입니다. 함수별 약속은 [CONTRACT.md](CONTRACT.md)에 있습니다.

원본 폴더(`backend/local`)는 고치지 않았습니다. 이 폴더가 `backend/local/src`와 `tests`를 대신합니다.

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
import { createLocalStore, createHooks } from '<경로>/local-store/src/index.js';

export const store = createLocalStore({ db: openDatabaseSync('planner.db'), newId: randomUUID });
export const { useMemos, useTrashedMemos, useTasks, useTrashedTasks, useProposals, useWorkspaces } = createHooks(useSyncExternalStore, store);
```

로그인 직후에 `store.bindAccount(계정 id)`를 부릅니다. `account_mismatch`가 나면 확인을 받고 `store.clearAll()` 뒤에 다시 부릅니다.

## 공유 공간과 서버

개인 공간의 저장은 기기에만 남습니다. 공유 공간에서 한 저장은 같은 트랜잭션에서 보낼 목록에 서버 형식으로 적히고, 다리가 가져갑니다.

```js
import * as engine from '@/lib/stella/local-sync';
import { createBridge } from '<경로>/local-store/src/index.js';

const bridge = createBridge({
  store, engine, db: expoSqliteDb(await SQLite.openDatabaseAsync('stella.db')), transport: supabaseTransport(supabase),
  accountId, deviceId,
  favorites: { set: (ws, ids, on) => setNoteFavorites(supabase, ws, ids, on), list: ws => listNoteFavorites(supabase, ws) },
});
await bridge.syncAll();                 // 앱 시작, 화면 복귀, 실시간 신호, 저장 직후(store.subscribeOutbox)
```

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

- 단위 테스트 51개 통과: 원본 테스트 39개(바뀐 규칙에 맞게 고침) + 새 테스트 12개.
- 핵심 규칙 22가지를 하나씩 일부러 망가뜨렸을 때 테스트가 22가지 모두 잡았습니다.
- 서버 왕복 검증 18개 통과: 마이그레이션 37개를 적용한 로컬 Postgres에서 기기 두 대(저장소 + `local-sync` + 다리)가 `sync_push`·`sync_pull`로 주고받았습니다. 서버 제약 통과, 같은 기록의 다른 칸 동시 수정, AI 제안 승인, 휴지통·복구·영구 삭제, 즐겨찾기, 한도 근처 손글씨, 프로젝트 화면 값 변환을 확인했습니다.
- 화면 코드(`frontend/Frontend_UI/src`)가 부르는 저장소 함수와 읽는 칸을 모두 대조했습니다. 화면이 그대로 부르는 `switchWorkspace('personal')`과 `joinWorkspace`를 받도록 맞췄습니다.

## 남은 제한

- 실제 expo-sqlite, 실기기, 원격 Supabase에서는 실행하지 않았습니다. 왕복 검증은 로컬 Postgres입니다.
- 화면과는 아직 연결되지 않았습니다. 화면 쪽 `src/data/*Store.js`가 저장소에 없습니다.
- 중요도·알림 글자 목록은 추정값입니다. 화면 쪽 `TaskStore`의 `PRIORITIES`·`ALARMS`와 다르면 `labels` 옵션으로 맞춰야 합니다.
- 사진은 변경 모양만 단위 테스트로 확인했습니다. 실제 올리기(`attachments.ts`)와 이어서는 검증하지 않았습니다.
- 다리가 보낼 목록 한 줄을 엔진에 넘긴 직후, 그 줄을 지우기 전에 앱이 꺼지면 같은 줄이 한 번 더 넘어갑니다. 서버가 중복 만들기를 충돌로 돌려주므로 기록이 둘이 되지는 않지만 화면에서 충돌을 풀어야 합니다.
- 다리는 sync 때마다 그 공간의 기록 전체를 다시 맞춥니다. 기록이 수천 건을 넘으면 바뀐 것만 맞추도록 바꿔야 합니다.
- 프로젝트·팀원·회의·안건·파일·녹음·설정·알림은 이 저장소에 없습니다. 공유 공간에서는 `local-sync`에서 직접 읽습니다.
- 할 일(`kind: 'task'`)의 끝 시간과 `project`(이름 글자)는 서버에 칸이 없어 이 기기에만 남습니다.
- 스키마 1단계를 다시 썼습니다. 원본 `src/`로 만든 DB 파일이 이미 있는 기기에서는 열 때 오류를 내므로 그 파일을 지워야 합니다(화면 연결 전이라 해당 기기는 없을 것으로 봅니다).
