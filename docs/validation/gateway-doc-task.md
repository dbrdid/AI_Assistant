# 문서 작업 지시: AI 게이트웨이

담당: GPT(Codex). 사용자 지시로 코드는 Claude가, 문서는 GPT가 맡는다. 이 파일은 커밋하지 않는다.

## 작성할 문서

1. 새 문서 `docs/validation/ai-gateway.md`
   - 목적: 어떤 AI를 연결해도 같은 앱 지침을 보내고, 앱 변경은 검토·승인 뒤에만 실행되는 구조
   - 연결 방식 5가지와 설정 방법: 이 기기(Gemma 4 E2B 기본), 내 서버의 로컬 LLM(OpenAI 호환 `/v1`), Stella 클라우드 AI(`/command`), 내 OpenAI 계정(API 키), 내 Anthropic 계정(API 키)
   - ChatGPT·Claude 구독 로그인은 다른 앱에서 쓸 수 없어 API 키로 연결한다는 점, 키는 기기에 저장하지 않고 앱 실행 중에만 메모리에 둔다는 점
   - 요청 흐름: 규칙 해석 → 게이트웨이 프롬프트 → 제공자 응답 → `앱 작업:` 한 줄만 명령으로 인정 → 앱 작업 검토 → 승인 → 저장 후 검증
   - 새 프로젝트 명령 3가지와 예시
   - 검증 결과와 NOT_RUN 항목(아래 "확인된 사실")
2. `docs/validation/ui-ai-baseline-20261124.md`에 "AI 게이트웨이 추가" 절을 짧게 덧붙인다.
3. `docs/validation/debate/token-ledger.md`에 GPT -> Claude 항목을 추가한다.

## 읽을 코드 (수정 금지)

- `frontend/Frontend_UI/src/integration/aiGateway.mjs`
- `frontend/Frontend_UI/src/features/stella/projectCommands.mjs`
- `frontend/Frontend_UI/src/features/stella/LocalModelScreen.js`
- `frontend/Frontend_UI/src/integration/mobileModelPolicy.mjs`의 `deviceModels`
- `backend/supabase/functions/ai-gateway/index.ts`의 `handleCommand`
- `tests/integration/ai-gateway.test.mjs`

## 확인된 사실 (Claude가 실행함)

- integration 112/112, local 85/85, ai 23/23, mobileModel 1/1, replay 종료 코드 0, Android 번들 성공
- 서버 TypeScript는 문법 진단 0건. Deno 타입 검사와 배포는 NOT_RUN
- 웹 미리보기에서 "신제품 출시라는 프로젝트 만들어줘" → 규칙 해석 → 앱 작업 검토 → 승인 → 프로젝트 생성·상세 화면 이동 확인
- 기본 기기 모델: ggml-org/gemma-4-E2B-it-GGUF Q4_0, 2,841,481,184바이트, Apache-2.0, 리비전 고정과 SHA-256 검사
- NOT_RUN: 실기기 Gemma 다운로드·추론, 실제 OpenAI·Anthropic·내 서버·클라우드 호출(모의 응답 테스트만), Supabase `/command` 배포
- 알려진 제한: 클라우드 `/command`는 새 DB 한도 없이 `query_plan` 한도를 함께 쓴다. Gemma 로드 조건(가용 메모리 1.5GiB)은 S22 측정 전 임시값이다. Android에서 `http://` 서버는 평문 통신 설정에 따라 막힐 수 있다. 웹에서 사용자의 서버를 직접 부를 때 CORS 허용이 필요할 수 있다.

## 금지

코드 수정, 커밋, 푸시, 다운로드, 설치. 실행하지 않은 것을 통과로 쓰지 않는다. 문서는 한국어로, 짧고 사실 위주로 쓴다. 끝나면 한 줄로 보고하고 멈춘다.
