# 코드 작업 지시: AI 진입점을 블록 중심으로 바꾸기

담당: Orca Claude(코드). GPT는 문서만 맡는다. 이 파일은 커밋하지 않는다.
작업 위치: `stella-ui-ai-integration`, 브랜치 `SJW1212/stella-ui-ai-integration`. 웹 미리보기는 `http://localhost:8101`에서 이미 실행 중이니 새로 띄우지 말고 한 탭에서만 연다.
스킬: `loop`, `ponytail`(full), `token-efficient-workflow`를 적용한다.

## 사용자 요구

1. AI 채팅 화면을 없앤다.
2. 앱 작업 요청 화면도 메뉴에서 없앤다.
3. 문서의 각 블록을 길게 누르면 그 블록을 대상으로 AI에게 요청할 수 있게 한다.
4. AI 제안은 문서 블록으로 만들어 강조 표시하고, 사용자가 블록 단위와 문서 단위로 수용할지 거절할지 정한다.

## 이미 파악한 구조 (다시 조사하지 않아도 됨)

- AI 채팅 진입점: `navigation/routes.js` 73행(AI 탭의 `AI 채팅`), 74행(`앱 작업 요청`), 84행(더보기 `AI 채팅`), `navigation/AppNavigator.js` 99행 `[ROUTES.Ai]: AiChatScreen`, `features/home/screens/HomeScreen.js` 179행, `features/spaces/screens/SpaceHomeScreen.js` 185행, `features/stella/EditorTools.js` 73~76행 `이 문서에 작업 요청`.
- `appCommands.mjs`의 `screens`에 `'AI 채팅': ROUTES.Ai`가 있다. 이 파일은 S22 평가 고정 대상(파일 SHA-256)이라 수정하지 않는다. 대신 `ROUTES.Ai`를 `LocalModelScreen`에 연결해 명령이 깨지지 않게 한다.
- `AiChatScreen`을 지울 때 `lib/stella/ai-chat.ts`, `data/ai/ChatStore.js`, `runtime.js`의 `askFromDevice`, `SearchScreen.js`가 같은 기능을 쓰는지 확인하고, 다른 화면이 쓰는 코드는 남긴다.
- 블록 UI: `features/stella/BlockEditor.js`. 블록 왼쪽 `⠿` 핸들은 누르면 메뉴, 웹에서는 드래그. 본문은 `TextInput`, 표는 셀마다 `Pressable`.
- `DocumentEditor.js`의 `attemptSave()`로 저장한 뒤 이동해야 블록 번호가 저장본과 맞는다.
- `normalizeBlocks`(`backend/local/src/stella-documents.js` 17행)는 블록의 추가 필드를 버린다. 대기 상태를 블록에 넣지 말고 별도로 저장한다.
- 제안 모델: `backend/local/src/proposals.js`. 종류는 `event`, `task`, `memo`. `approveProposal`은 할 일·일정·메모를 만들고, `setProposalStatus(id, 'rejected')`로 거절한다. 화면은 `features/proposal/`.
- AI 연결 화면은 `features/stella/LocalModelScreen.js`, 게이트웨이는 `integration/aiGateway.mjs`. 답변이 `앱 작업:` 한 줄이면 `AppCommand` 검토 화면으로 간다.

## 권장 설계 (더 단순한 방법이 있으면 이유를 남기고 바꿔도 된다)

### 1·2. 메뉴 정리
- AI 탭은 `제안 검토`, `AI 연결`만 남긴다. 더보기의 `AI 채팅`, 홈의 `AI 채팅` 버튼, 문서 도구의 `이 문서에 작업 요청`을 없앤다.
- `AppCommand` 화면은 메뉴에서만 빼고, AI 답변 검토와 승인 단계로 계속 쓴다.

### 3. 블록 길게 누르기
- `BlockEditor`에 `onAskAI(block, index)`를 추가한다. 핸들과 표 셀은 `onLongPress`, 본문 `TextInput`은 `onPressIn`/`onPressOut` 타이머(약 450ms)로 처리한다. 읽기 전용이면 끈다.
- `DocumentEditor`는 저장 후 `LocalModel`로 `{ memoId, block: { id, index, type, text } }`를 넘긴다.
- `LocalModelScreen`은 대상 블록을 보여 주고, 게이트웨이에 `대상: 현재 문서의 N번 블록(유형): "내용"` 줄을 요청 앞에 붙여 채팅 모드로 보낸다. 규칙 해석은 먼저 입력 그대로, 다음으로 `N번 블록 ` + 입력으로 시도한다. 검토 화면에 넘기는 원래 요청에는 대상 줄을 포함한다.
- `aiGateway.mjs`의 채팅 지침에 "요청 앞에 대상 줄이 있으면 그 블록 번호를 그대로 쓴다"를 추가하고 테스트를 갱신한다.

### 4. 강조된 AI 블록과 수용·거절
- 대기 블록 ID는 `writePreference('ai-pending:' + memoId, [...ids])`, AI가 만든 새 문서는 `ai-pending-doc:` + memoId에 둔다. 동기화되는 문서 데이터와 스키마는 바꾸지 않는다.
- 블록 대기 표시: 배경 강조와 `AI 제안` 표시, 블록별 `수용`·`거절`. 문서 위에는 `AI 제안 N개 · 모두 수용 · 모두 거절`. 수용은 표시만 지우고, 거절은 해당 블록을 지운다. 대기 문서를 거절하면 문서를 휴지통으로 보낸다.
- AI 블록이 생기는 곳:
  - 길게 누르기 요청의 일반 답변: `블록으로 넣기`를 누르면 대상 블록 바로 뒤에 문단별 블록으로 넣고 대기 상태로 만든다. 넣는 것만으로는 확정되지 않는다.
  - 제안 검토: 원본 메모가 있는 할 일·일정 제안은 그 문서에 체크 블록이나 문단 블록으로 넣고 대기 상태로 만든다. 메모 제안은 새 문서로 만들고 문서 단위 대기로 둔다. 블록을 수용하면 `approveProposal`, 거절하면 `setProposalStatus(..., 'rejected')`로 기존 제안 상태도 맞춘다.
- 저장은 `documents.saveContent(..., revision)`을 쓰고, 문서가 바뀌었으면 다시 검토하라고 안내한다. 주변 블록이 바뀌지 않았는지 기존 방식대로 확인한다.

## 완료 조건

- 새 동작마다 실패하면 드러나는 테스트를 하나 이상 추가한다(대기 블록 수용·거절, 길게 누르기 대상 문맥, 메뉴에서 빠진 항목).
- `npm run -s test:integration`, `test:local`, `test:ai`, `node --test frontend/Frontend_UI/tests/mobileModel.test.cjs`, `node ai/eval/replay-mobile.mjs`, Android 번들 내보내기가 통과한다.
- 웹 미리보기에서 블록 길게 누르기 → AI 요청 화면, 블록 넣기 → 강조 → 수용·거절, 제안 검토 → 문서 블록 강조를 직접 확인한다. 웹에서 확인할 수 없는 것은 NOT_RUN으로 남긴다.
- 끝나면 `docs/validation/debate/token-ledger.md`에 Claude -> GPT 항목을 남기고, GPT에게 문서 갱신을 요청한다.

## 금지

커밋, 푸시, 브랜치 변경, 의존성 설치, 모델 다운로드, `appCommands.mjs`·`s22-frozen-config.json`·선별셋 수정. 실행하지 않은 검사를 통과로 쓰지 않는다. 세션 사용량이 85%에 이르면 원장에 상태를 남기고 멈춘다.
