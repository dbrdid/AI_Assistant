# backend/local

기기 내부 SQLite, CRUD, 트랜잭션, AI 요청과 결과 적용을 담당합니다. 권한과 입력 검증 후 사용자 승인에 따라 DB를 변경합니다. 네이티브 구현은 아직 없습니다. 클라우드 추론 동의와 동기화 동의를 구분합니다.

## 현재 구현 (2026-11-15)

메모, 일정·할 일, AI 제안을 휴대폰 안 SQLite(expo-sqlite)에 저장하는 계층입니다. 화면(`frontend/Frontend_UI`)이 `src/data/*Store.js`에서 부르는 함수의 이름과 동작을 따릅니다. 서버·네트워크 코드는 없습니다. 함수별 약속은 [CONTRACT.md](CONTRACT.md)에 있습니다.

| 파일 | 역할 |
| --- | --- |
| `src/store.js` | `createLocalStore`: 쓰기마다 트랜잭션 하나, 목록 캐시, 변경 알림 |
| `src/memos.js`, `src/tasks.js`, `src/proposals.js`, `src/workspaces.js` | 영역별 저장 규칙 |
| `src/schema.js` | 테이블과 버전(`PRAGMA user_version`) |
| `src/hooks.js` | `useMemos` 같은 React 훅 연결(이 폴더는 React를 import하지 않음) |
| `tests/` | Node 내장 SQLite로 expo-sqlite 동기 API를 흉내 낸 대역에서 실행 |

## 화면에 연결하는 방법

```js
import { openDatabaseSync } from 'expo-sqlite';
import { useSyncExternalStore } from 'react';
import { createLocalStore, createHooks } from '<backend/local 경로>/src/index.js';

export const store = createLocalStore({ db: openDatabaseSync('planner.db') });
export const { useMemos, useTrashedMemos, useTasks, useProposals, useWorkspaces } = createHooks(useSyncExternalStore, store);
```

화면 쪽 `MemoStore.js` 등은 `store.addMemo`, `store.getMemos`처럼 같은 이름을 다시 내보내면 됩니다. 화면 전용 도우미(`memoTitle`, `formatMD`, `classify`, `PRIORITIES` 같은 상수)는 화면 쪽에 남습니다. expo-sqlite 설치(`npx expo install expo-sqlite`)와 Metro가 `frontend/Frontend_UI` 밖의 `backend/local`을 읽게 하는 설정은 프론트 작업이며, 경로 방식은 함께 정합니다. 기기에 `crypto.randomUUID`가 없으면 expo-crypto의 `randomUUID`를 `newId`로 넘기세요.

## 정한 규칙 (2026-11-15)

1. 범위: 메모, 일정·할 일, AI 제안. 프로젝트·파일·알림·설정·백업·로그인은 아직 화면 쪽 더미 저장소가 맡습니다.
2. 메모: 화면이 쓰는 필드(제목, 본문, 손글씨, 사진, 즐겨찾기, 연결된 할 일, 만든·수정·삭제 시각)를 그대로 저장합니다. 사진은 파일 ID만 저장하고 파일 본문은 앱 전용 저장소에 둡니다. 지우면 휴지통으로 갑니다.
3. 일정과 할 일은 한 종류입니다. 시작 시간이 있으면 일정입니다. 삭제는 바로 지웁니다.
4. AI 제안: 분석한 뒤 원본 메모의 내용이 바뀌면 승인을 막습니다(`source_changed`). 오래된 분석 결과는 저장하지 않고, 같은 메모의 새 분석이 오면 이전 제안을 대체합니다. 승인은 일정 저장·메모 연결·제안 상태 변경을 한 트랜잭션으로 처리하고, 두 번 눌러도 하나만 저장합니다.
5. 워크스페이스: 기기 안에서만 나눕니다. 전환하면 다른 목록이 보입니다. 공유·초대는 서버가 필요해 범위 밖입니다.
6. 호출 방식: `addMemo` 등은 결과를 바로 돌려줍니다(expo-sqlite 동기 API). 화면 코드를 고치지 않아도 됩니다.

## 실행

```text
cd backend/local
npm test
```

Node.js 22.13 이상이 필요하고 외부 패키지는 없습니다. CI는 아직 이 폴더를 검사하지 않습니다.

## 검증과 남은 제한

- 자동 테스트 39개가 통과했습니다(Node.js 26, 테스트 대역). 핵심 규칙 18개를 하나씩 일부러 망가뜨린 변이 검사에서 17개를 테스트가 잡았습니다. 남은 1개는 결과가 같은 변이(날짜 검사의 중복 조건)입니다.
- 실제 expo-sqlite, Expo Go, 실기기에서는 실행하지 않았습니다. 대역은 expo-sqlite 문서의 동기 API 이름과 결과 모양을 따르고, 불리언 바인딩·중첩 트랜잭션을 막고 외래키를 꺼 둔 채 여는 등 더 엄격하게 만들었지만, 실제 차이는 기기에서 확인해야 합니다.
- 화면과는 아직 연결되지 않았습니다. 화면이 import하는 `src/data/*Store.js` 12개가 저장소에 없어서, 연결은 프론트 담당과 함께 해야 합니다. 기존 더미 데이터(AsyncStorage)를 옮기는 기능도 없습니다.
- `approveProposal`이 `source_changed`를 던지면 화면이 잡아서 "메모가 바뀌었어요" 같은 안내를 해야 합니다. 지금 `ProposalConfirmScreen`에는 예외 처리가 없습니다.
- 검색은 지금처럼 화면이 목록에서 거릅니다. 기록 질문(ROADMAP 4단계)용 로컬 검색은 다음 단계입니다.
- 목록 전체를 메모리에 둡니다. 기록이 수천 건을 넘으면 측정한 뒤 페이지 단위로 바꿉니다.
- 워크스페이스에 멤버 수·역할이 없습니다. `WorkspacePicker`는 개인 공간이 아닌 곳에 "멤버 N명 · 역할"을 표시하므로 화면 쪽 조정이 필요합니다.
