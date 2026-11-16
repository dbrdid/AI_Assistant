# 데스크톱 자체 모델 서버를 이용한 테스트·시연

2026-11-16 결정: 테스트·시연에서는 데스크톱에 모델을 내려받고 기존 Fastify/Ollama 서버를 실행한다. 기기 RAM과 서버 RAM을 나누는 분산 추론은 사용하지 않는다. 모델은 데스크톱에서 실행하고 모바일 앱은 요청과 결과 표시를 담당한다. 운영 클라우드 이전은 별도 단계다.

## 두 단계로 확인

| 단계 | 연결 | 필요한 것 | 확인할 범위 |
|---|---|---|---|
| 서버 단독 시험 | 데스크톱 Fastify → 같은 데스크톱 Ollama | 모델, Node.js, 서버 설정 | 생성 API 연결·요약 출력·RAM·지연 |
| 앱 통합 시연 | 모바일 → Supabase Gateway → 데스크톱 Fastify → Ollama | 위 구성 + Supabase 테스트 계정·migration·Gateway 배포·데스크톱 HTTPS 주소 | 로그인·메모·실제 AI 요청·결과 확인/승인 |

서버 단독 시험에는 Supabase가 필요 없다. 현재 모바일 앱은 Supabase 로그인으로 계정별 DB를 초기화하므로, Supabase 없는 모바일 시연 모드는 **아직 구현되지 않았다**. 데스크톱 모델을 설치하는 것만으로 로그인과 Gateway 준비를 생략할 수는 없다.

## 데스크톱 서버 준비

1. RAM·GPU·VRAM·저장 공간을 확인한 다음 모델과 양자화 형식을 선택한다. 특정 Gemma 버전이나 필요한 메모리를 이번 작업에서 확정하거나 실측하지 않았다.
2. 데스크톱에 Ollama를 설치하고 선택한 모델을 내려받아 실행한다. 실제 설치된 모델 이름을 확인해 설정에 사용한다. 모델 파일·라이선스·출처·버전/해시를 기록하고 가중치는 Git에 올리지 않는다.
3. `backend/cloud`에서 `npm ci` 후 `.env.example`을 `.env`로 복사한다. `OLLAMA_MODEL`과 `AI_GATEWAY_SECRET`을 직접 채운다. 서비스 secret은 32자 이상이어야 하며 앱에 넣거나 Git에 커밋하지 않는다.
4. `npm start`로 Fastify를 실행한다. `http://127.0.0.1:3000/healthz`는 프로세스 생존 확인일 뿐 모델 로딩·추론 준비 완료를 뜻하지 않는다. 실제 `/internal/generate` 요청과 모델 출력을 별도로 시험한다.

```dotenv
HOST=127.0.0.1
PORT=3000
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=실제로_설치한_모델명
AI_AUTH_TOKENS=[]
AI_GATEWAY_SECRET=직접_생성한_32자_이상의_서비스_secret
```

Gateway 전용 실행에는 기존 사용자별 토큰을 비워 둘 수 있다. `/internal/generate`는 위 서비스 secret을 Bearer로 요구한다. 초기 동시성은 1로 설정해 측정할 수 있으며, 입력 길이·출력 길이·동시 요청 수를 함께 기록한다. 설정값을 크게 바꾼다고 모델 RAM이나 문맥 적합성이 보장되지는 않는다. 긴 문서 자동 청킹은 현재 앱 경로에 연결되지 않았다.

## 앱까지 연결할 때

```text
모바일 AI client → Supabase Gateway → 데스크톱 HTTPS 진입점
                                       → Fastify → 로컬 Ollama
```

클라우드 Gateway에서 `localhost`는 Gateway 자신을 뜻한다. 데스크톱의 사설 LAN IP도 클라우드에서 바로 접근할 수 있다고 가정하면 안 된다. 전체 시연에는 테스트용 HTTPS 터널 또는 인증·접근 제한을 둔 HTTPS 프록시 등 Gateway가 접근할 수 있는 진입점이 필요하다. Fastify는 loopback에 유지하고 HTTPS 진입점이 해당 포트로 전달하게 구성할 수 있다. Ollama 포트를 외부에 직접 노출하지 않는다.

Gateway 배포 secret에 아래를 지정한다.

- `SELF_HOSTED_URL`: 데스크톱 서버의 HTTPS origin. 경로·쿼리·URL 내 자격 증명은 넣지 않는다.
- `SELF_HOSTED_SECRET`: 데스크톱 `AI_GATEWAY_SECRET`과 동일한 값.
- `SELF_HOSTED_MODEL`: 데스크톱 `OLLAMA_MODEL`과 동일한 모델 이름.

Supabase 신규 동의 migration을 테스트 환경에서 검증·적용하고 Gateway를 배포한 다음 앱에서 자체 모델 경로와 `SERVER_AI` 전송 동의를 선택한다. 자체 모델 실패 시 외부 API로 자동 전환하지 않는다. 데스크톱 절전·네트워크 단절·모델 로딩 지연도 시연 전 확인한다.

## 시연 전 확인과 현재 상태

합성 문서로 cold/warm 응답 시간, 프로세스 RAM/VRAM, 출력 완결성·사실성, 입력 한도 초과·시간 초과·취소를 확인한다. 앱 결과는 원본 변경 검사와 사용자 승인을 거쳐 반영한다. 비밀 키·원문을 로그나 화면 공유에 노출하지 않는다.

현재는 연결 코드·모의 모델 개발 시험까지만 완료했다. 모델 다운로드, 데스크톱 실제 추론, HTTPS 진입점 생성, Supabase 배포, 실기기 시연은 실행하지 않았다. 전체 통합 상태는 [통합 현황](INTEGRATION-2026-11-16.md), 시험 범위는 [실행 증거](validation/EXECUTION-2026-11-16.md)를 따른다.
