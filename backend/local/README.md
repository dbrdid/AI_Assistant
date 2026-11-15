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
  photos: { upload: async (ws, ref) => (await uploadAttachment(supabase, { workspaceId: ws, assetId: newId(), ...파일(ref) })).id },
  workspaces: { list: async () => (await listMyWorkspaces()).map(m => ({ id: m.workspace.id, name: m.workspace.name, description: m.workspace.description, role: m.role })) },
});
const stop = bridge.start({ onResult });   // 저장할 때마다 알아서 돎. 실패하면 2초 → 5초 → 15초 → 60초 간격으로 다시 시도
bridge.syncAll();                          // 앱이 앞으로 올 때, 실시간 신호(watchWorkspace)가 올 때
```

`accountId`는 꼭 넘겨 주세요. 다리가 첫 동기화 전에 `local-sync`의 `bindSyncAccount`를 불러서, 같은 기기를 다른 계정이 쓰던 경우 그 계정이 남긴 공유 공간 기록과 못 보낸 수정을 지웁니다(앞사람의 수정이 뒷사람 이름으로 올라가지 않게). 기기 저장소가 다른 계정에 묶여 있으면(`store.getAccount()`) 동기화하지 않고 `account_mismatch`로 실패합니다.

| 함수 | 하는 일 |
| --- | --- |
| `start(옵션)` | 공유 공간에서 저장할 때마다(0.4초 모아서) 동기화하고, 연결이 안 되거나 오류가 나면 간격을 늘려 다시 시도. 돌려주는 함수를 부르면 멈춤 |
| `syncAll()` / `syncWorkspace(id)` | 지금 한 번 동기화. `{ 기기 공간 id: 결과 }` / 그 공간의 결과 |
| `status()` | `{ state, unsent, workspaces }`. `state`: `synced` · `pending`(안 보낸 저장 있음) · `attention`(충돌·거절) · `needs_login`(로그인 만료). 배지·배너용 |
| `issues(id)` | 화면에서 풀어야 하는 것 `{ conflicts, rejected }`. 충돌마다 어느 기록의 어느 칸이 어떻게 다른지(`base`·`mine`·`server`) |
| `resolve(id, outboxSeq, 선택)` | 충돌 풀기: `keep_mine`(내 것) · `use_server`(상대 것) · `keep_both`(본문은 둘 다, 한 줄 칸은 내 것). 풀고 바로 이어서 동기화 |
| `discard(id, outboxSeq)` | 서버가 거절한 저장을 버림 (내 수정 취소) |
| `refresh(id)` | 화면용 표를 엔진 값으로 전부 다시 맞춤 |
| `signOut({ force })` | 로그아웃·탈퇴: 마지막으로 동기화한 뒤 기기 기록을 지움. 안 보낸 저장이 남으면 지우지 않고 `{ cleared: false, unsent }` → 알린 뒤 `force: true`. 개인 공간도 지워지므로 백업 먼저 |

`syncAll()` 결과는 공간마다 하나입니다. 한 공간이 실패해도 나머지는 계속 돕니다.

| 결과 | 뜻 | 화면에서 할 일 |
| --- | --- | --- |
| `status: 'OK'` | 보내고 받고 화면용 표를 맞춤 | `flush.status`가 `CONFLICT`·`BLOCKED`면 `issues`로 내용을 보여 주고 `resolve`·`discard` |
| `status: 'CLOSED'` | 공간에서 빠졌거나 공간이 삭제됨 | 알리고 `store.deleteWorkspace` |
| `status: 'ERROR'` (`code`, `error`) | 그 공간의 동기화가 오류로 끝남 | `start()`를 쓰면 알아서 다시 시도 |
| `merged: n` | 충돌 n건을 스스로 합쳐서 보냄 | 없음 |
| `uploadFailed: [{ memoId, ref, code }]` | 올릴 수 없는 사진(너무 큼·형식 등). 그 사진은 이 기기에만 남음 | 사용자에게 알림 |
| `handOff: { status: 'BLOCKED', seq, code, error }` | 엔진이 보낼 목록의 그 줄을 받지 않음. 그 공간의 뒤 줄은 순서를 지켜 기다림 | 고칠 수 없으면 `store.ackOutbox(seq)`로 버리고 `bridge.refresh(공간 id)` |

다리가 지키는 것:

- 동기화가 도는 동안 화면에서 한 저장은 그대로 남습니다. 그 기록은 이번에 서버 값으로 덮지 않고, 같은 `syncAll()` 안에서 이어서 한 번 더 돌아(최대 3번) 서버까지 올립니다.
- `syncAll`·`syncWorkspace`·`refresh`·`resolve`는 겹쳐 불러도 차례로 돕니다. 도는 중에 `syncAll()`을 다시 부르면 같은 실행을 돌려줍니다.
- 한 번에 많이 바꾼 저장(휴지통 비우기 등)은 저장할 때 100개씩 나눠 적습니다(`local-sync`가 한 묶음에 100개까지 받음).
- 넘긴 직후 앱이 꺼져 같은 줄을 다시 넘겨도 엔진에는 한 번만 들어갑니다(`saveLocal`의 `handoffKey`).
- 별표는 메모가 서버에 올라간 뒤에 보냅니다. 새 메모에 바로 별표를 눌러도 첫 동기화에서 저장됩니다.
- **충돌은 먼저 스스로 합칩니다.** 서버는 같은 기록을 두 기기가 고치면 칸이 달라도 일단 충돌로 돌려줍니다. 다리는 서로 다른 칸, 본문의 서로 다른 줄, 서로 다른 손글씨 획이면 둘 다 살려서 다시 보냅니다. 같은 자리에 둘 다 새 줄만 넣었으면 내 줄 다음에 상대 줄을 둡니다. 같은 칸·같은 줄을 다르게 고친 경우에만 멈추고 화면에 맡깁니다(`conflicts: 'ask'`로 만들면 항상 화면에 맡김).
- **공유 공간에서도 올리기 전 사진을 붙일 수 있습니다.** `photos`에 UUID가 아닌 값(기기 파일 경로 등)을 넣으면 올리기를 기다리고, 다리가 `photos.upload`로 올린 뒤 첨부 id로 바꿔 연결을 보냅니다. 오프라인이면 다음 동기화에 올립니다.
- **공간의 내 역할·멤버 수**는 받은 멤버 목록으로 맞춥니다. 보기 전용으로 바뀌면 기기에서도 저장이 `read_only`로 막힙니다. **공간 이름·설명과 다른 기기에서 새로 들어간 공간**은 `workspaces.list`를 넘기면 `syncAll()` 때 맞춥니다.
- **바뀐 기록만 화면용 표에 반영합니다.** 지난번에 반영한 내용과 같은 기록은 건너뛰고, 많을 때는 200개씩 나눠 사이사이 화면에 차례를 넘깁니다.

- 공간 만들기: `store.createWorkspace` → 서버 `create_workspace` → `store.linkWorkspace(기기 id, 서버 id)`.
- 초대 수락 뒤: 서버 `accept_invite` 결과로 `store.joinWorkspace({ id: 서버 공간 id, name, role: '멤버', members })`. 전체 받기·멤버 변경 뒤: `store.upsertServerWorkspace({ id, name, description, role, members })`.
- 프로젝트 화면 값: `store.serverMap.projectData(form)`으로 서버 값(`name`, `due_date`, `priority`, `progress_status`, `reminder_minutes` 등)을 만들어 `local-sync`의 `saveLocal`에 넘기고, 받을 때는 `projectFromServer(row)`.
- AI: `store.addProposals(store.serverMap.proposalsFromAnalyze(response.draft, { sourceType: 'memo', sourceId, sourceTitle, sourceRevision }))`.
- 백업: `createBackup`에 `store.exportAll()`을 넘기고, `restoreBackup`으로 받은 내용을 `store.importAll()`에 넘깁니다. 공유 공간은 백업에 넣지 않고 동기화로 다시 받습니다.

## 실행

```text
npm test                       # 단위 테스트 (Node.js 22.13 이상, 외부 패키지 없음)
npm run verify:server          # 서버 왕복 검증: supabase/tests/reset.sh로 만든 로컬 DB와 옆 폴더 stella-sync-verify 필요
```

## 검증 (2026-11-15)

- 단위 테스트 72개 통과: 원본 테스트 39개(바뀐 규칙에 맞게 고침) + 새 테스트 13개 + 동기화 다리 14개(`tests/bridge.test.mjs`) + 엔진 6개(`tests/engine.test.mjs`: 넘겨받기·계정·충돌 합치기·글 합치기 무작위 3,000번, `tests/sync-verify/lib`의 엔진 사본이 없으면 건너뜀).
- 핵심 규칙 22가지, 동기화 다리 규칙 30가지, 합치기·사진·알아서 돌기 등 규칙 44가지를 하나씩 일부러 망가뜨렸을 때 테스트가 모두 잡았습니다.
- 서버 왕복 검증 30개 통과: 마이그레이션 37개를 적용한 로컬 Postgres에서 기기 두 대(저장소 + `local-sync` + 다리)가 `sync_push`·`sync_pull`로 주고받았습니다. 서버 제약 통과, 같은 기록의 다른 칸 동시 수정, AI 제안 승인, 휴지통·복구·영구 삭제, 즐겨찾기, 한도 근처 손글씨, 프로젝트 화면 값 변환을 확인했습니다.
- 같은 검증에서 동기화 약점 수정(2026-11-15)도 확인했습니다: 동기화 도중에 쓴 메모·수정·AI 제안과 새 메모의 별표, 120개를 한 번에 휴지통으로·영구 삭제, 넘긴 직후 앱이 꺼진 뒤 다시 넘기기(서버에 한 번만 저장), 같은 기기에서 계정이 바뀐 경우(앞 계정이 못 보낸 수정은 올라가지 않음).
- 설계 한계 보완도 같은 검증에 넣었습니다: 두 기기가 같은 메모의 다른 줄·다른 칸을 동시에 고치면 스스로 합쳐져 둘 다 남는지, 같은 줄을 다르게 고치면 멈추고 어느 칸이 다른지 알려 주는지, '둘 다 남기기'로 풀리는지, 관리자가 역할을 보기 전용으로 바꾸면 상대 기기에서 저장이 막히는지.
- 화면 코드(`frontend/Frontend_UI/src`)가 부르는 저장소 함수와 읽는 칸을 모두 대조했습니다. 화면이 그대로 부르는 `switchWorkspace('personal')`과 `joinWorkspace`를 받도록 맞췄습니다.

## 남은 제한

- 실제 expo-sqlite, 실기기, 원격 Supabase에서는 실행하지 않았습니다. 왕복 검증은 로컬 Postgres입니다.
- 화면과는 아직 연결되지 않았습니다. 화면 쪽 `src/data/*Store.js`가 저장소에 없습니다.
- 중요도·알림 글자 목록은 추정값입니다. 화면 쪽 `TaskStore`의 `PRIORITIES`·`ALARMS`와 다르면 `labels` 옵션으로 맞춰야 합니다.
- 사진 올리기는 가짜 올리기 함수로만 확인했습니다. 실제 `attachments.ts`의 `uploadAttachment`와 이어서는 검증하지 않았습니다(로컬 Postgres에는 파일 보관함이 없음).
- 계정이 바뀌면 앞 계정이 못 보낸 수정은 버려집니다. 로그아웃은 `bridge.signOut()`으로 하면 남은 저장이 있을 때 지우지 않고 알려 줍니다.
- 같은 칸·같은 줄을 양쪽에서 다르게 고친 충돌은 사용자가 골라야 합니다. 고를 내용은 `bridge.issues()`가 주지만, 보여 주는 화면은 아직 없습니다. 제목 같은 한 줄 칸은 둘 다 남길 수 없어 한쪽을 고릅니다.
- 그런 충돌이나 서버 거절이 풀릴 때까지 그 공간의 뒤 저장은 기다립니다(뒤 저장이 앞 저장에 기대는 경우가 있어서).
- 공유 공간 기록은 엔진 표와 화면용 표에 두 벌 있습니다. 어긋나지 않게 하는 장치(한 번만 넘기기, 안 보낸 저장 보호, 바뀐 것만 반영)는 넣었지만 저장 공간은 두 배로 씁니다.
- 앱이 앞으로 올 때와 실시간 신호가 올 때는 앱이 `syncAll()`을 불러야 합니다. `start()`는 저장 직후와 실패 뒤 다시 시도만 맡습니다.
- AI 제안(승인 전)은 만든 기기에만 있습니다. 승인하면 일정·할 일·메모가 되어 동기화됩니다. 제안 자체를 기기 간에 맞추려면 서버에 표가 필요합니다.
- 프로젝트·팀원·회의·안건·파일·녹음·설정·알림은 이 저장소에 없습니다. 공유 공간에서는 `local-sync`에서 직접 읽습니다.
- 할 일(`kind: 'task'`)의 끝 시간과 `project`(이름 글자)는 서버에 칸이 없어 이 기기에만 남습니다. 끝 시간을 맞추려면 서버 `tasks`에 칸을 더하고 `sync_push`를 고치는 마이그레이션이 필요합니다.
- 표를 바꿀 때는 `src/schema.js`의 `STEPS` 끝에 단계를 더합니다. 기존 기록이 남고 실패한 단계는 되돌려지는 것을 테스트로 확인했습니다. 다만 스키마 1단계는 다시 썼습니다. 원본 `src/`로 만든 DB 파일이 이미 있는 기기에서는 열 때 오류를 내므로 그 파일을 지워야 합니다(화면 연결 전이라 해당 기기는 없을 것으로 봅니다).
