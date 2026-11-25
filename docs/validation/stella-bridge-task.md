# 코드 작업: Stella 브리지

담당: Orca Claude(코드). 문서는 끝난 뒤 GPT가 맡는다. 이 지시서는 커밋하지 않는다.
작업 위치: `stella-ui-ai-integration`. 스킬: `ponytail`(full), `loop`, `token-efficient-workflow`를 적용한다.

## 목표

사용자가 원하는 PC나 서버에 설치하는 작은 프로그램이다. 그 서버에서 쓸 수 있는 AI를 하나의 OpenAI 호환 API로 묶는다. 앱은 기존 `AI 연결 → 내 서버`(`aiGateway.mjs`의 `server` 제공자: `GET {base}/models`, `POST {base}/chat/completions`, 선택적 `authorization: Bearer`)를 그대로 써서 연결한다.

## 위치와 형태

- 새 폴더 `bridge/`. Node.js 20 이상, 외부 의존성 없이 표준 라이브러리만 쓴다. 진입점 하나(`bridge/stella-bridge.mjs`)와 필요한 최소 모듈.
- 설정 파일: 기본 `~/.stella-bridge/config.json`. 환경 변수로 위치를 바꿀 수 있게 한다. 키가 들어 있으므로 Windows가 아닌 곳에서는 권한 0600으로 만든다.

## 명령

- `init`: 연결 키(무작위 32바이트 이상)를 만들고 설정 파일을 생성한다. 앱에 넣을 주소와 키를 한 줄 문자열로 출력한다. QR은 만들지 않는다.
- `serve [--host 0.0.0.0] [--port 8787]`: 서버를 실행한다. 시작할 때 같은 네트워크의 접속 주소를 출력한다. 연결 키가 없으면 실행하지 않는다.
- `list`: 사용할 수 있는 모델 목록과 각 공급원 상태를 출력한다.
- `add-key <openai|anthropic|gemini|openai-compatible> ...`: API 키나 OpenAI 호환 주소를 추가한다. 키는 명령 인자가 아니라 표준 입력으로 받아 셸 기록에 남지 않게 한다.
- `enable-cli <claude|codex>` / `disable-cli`: 이 서버에 설치된 공식 CLI의 구독 로그인을 쓰도록 켜고 끈다. 켤 때 "서버 주인 본인만 사용"이라는 안내를 출력한다.
- `rotate-key`: 연결 키를 바꾼다.

## 모델 공급원

- 로컬 자동 감지: Ollama(`127.0.0.1:11434`), LM Studio(`127.0.0.1:1234`). 응답이 없으면 목록에서 뺀다. 모델 ID는 `ollama/<이름>`, `lmstudio/<이름>`처럼 공급원 접두사를 붙인다.
- API 키: `openai/<모델>`, `anthropic/<모델>`, `gemini/<모델>`, 사용자가 추가한 OpenAI 호환 서버. 기본 모델 이름은 설정 파일에서 정한다.
- 구독 CLI: `claude-cli/default`, `codex-cli/default`. 해당 CLI가 설치되어 있고 사용자가 켰을 때만 목록에 보인다.
  - 셸 없이 `spawn`하고, 프롬프트는 표준 입력으로 넘긴다. 사용자 입력이 명령 인자로 들어가지 않게 한다.
  - 도구 실행과 파일 수정을 막는 옵션으로 단일 응답만 받는다. 정확한 옵션은 이 PC에서 `claude --help`, `codex exec --help`로 확인하고, 확인한 옵션을 코드 주석에 남긴다.
  - 동시 실행 1개, 시간 제한 120초. 넘으면 프로세스를 끝낸다.

## 서버 동작

- `GET /v1/models`: `{ data: [{ id, object: 'model', owned_by }] }`.
- `POST /v1/chat/completions`: `model`, `messages`(system·user·assistant), `max_tokens` 또는 `max_completion_tokens`, `temperature`를 받는다. `stream: true`는 400으로 거절한다. 응답은 OpenAI 형식 `{ choices: [{ message: { role: 'assistant', content } }], model }`.
- 공급원별 변환: Anthropic은 system을 분리, Gemini는 해당 API 형식, CLI는 system과 대화를 하나의 텍스트로 합쳐 표준 입력으로 보낸다.
- 보안:
  - 모든 `/v1` 요청에 `authorization: Bearer <연결 키>`를 요구한다. 키는 시간 상수 비교로 확인한다.
  - 본문 256KB 제한, 요청 시간 제한, 공급원 오류 메시지에 키나 내부 주소를 넣지 않는다.
  - 프롬프트, 응답, 키를 로그에 남기지 않는다. 남기는 것은 시각, 모델 ID, 상태 코드, 걸린 시간 정도로 한다.
  - 브라우저에서 쓸 수 있게 CORS는 허용하되, 인증 없이 되는 것은 `OPTIONS`뿐이다.
- 외부 접속은 HTTPS 역방향 프록시나 Tailscale을 권장한다고 시작 메시지에 한 줄 출력한다.

## 앱 쪽 수정 (최소)

- `AI 연결 → 내 서버`에 `init`이 출력한 연결 문자열을 붙여 넣으면 주소와 서버 키가 채워지게 한다. 서버 키는 지금처럼 이번 실행에만 메모리에 둔다.
- `aiGateway.mjs`의 서버 제공자는 그대로 쓴다. 모델 ID의 `/`가 그대로 전달되는지 확인한다.

## 완료 조건

- `tests/integration/stella-bridge.test.mjs`에 다음을 확인하는 테스트를 추가한다. 가짜 상위 서버와 가짜 CLI 스크립트를 사용한다.
  - 인증 없음·틀린 키 → 401
  - 목록과 응답 형식
  - Anthropic·CLI 변환
  - 시간 초과
  - 본문 크기 제한
  - 로그와 오류에 키가 없음
- 이 PC에서 실제로 실행해 본다. `init` 후 `serve`를 실행하고, Ollama가 없으면 없다는 상태가 나오는지, `claude-cli`를 켜면 짧은 질문 하나에 응답하는지 확인한다. 구독 CLI 호출은 짧은 테스트 1회만 한다.
- `npm run -s test:integration`이 통과한다.
- 원장에 Claude -> GPT 항목을 남기고 GPT에 `bridge/README.md`와 `docs/validation/ai-gateway.md` 갱신을 요청한다.

## 금지

- 외부 의존성 설치, 전역 설정 변경, 실제 API 키 사용, 커밋·푸시.
- 다른 사용자가 구독 CLI를 쓸 수 있게 하는 기능(계정 공유, 다중 사용자)은 만들지 않는다.
- 테스트가 실제 키나 실제 구독을 호출하지 않게 한다. 위의 짧은 수동 확인 1회만 예외다.
