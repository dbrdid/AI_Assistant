# AI API 서버

Node.js 24 이상 + Fastify 5의 모바일 전용 API입니다. 추론은 별도 Ollama 프로세스로 전달하고, 서버는 메모 DB·파일·프롬프트 이력을 저장하지 않습니다. 구현 경계와 API는 [상세 설계](../docs/SERVER.md)를 읽습니다.

## 로컬 실행

이 폴더에서 실행합니다.

```text
npm ci
npm run token:create -- team-user 7
```

토큰 생성 명령은 사용자별 32바이트 무작위 토큰과 SHA-256 레코드를 출력합니다. 토큰은 해당 사용자에게만 비공개 전달하고 모바일 OS 보안 저장소에 보관합니다. 공통 앱 코드에 포함하지 않습니다. 터미널 기록·CI 로그에 실제 토큰을 남기지 마세요.

1. `.env.example`을 `.env`로 복사합니다.
2. `AI_AUTH_TOKENS`에 생성된 레코드를 JSON 배열로 넣습니다. 실제 토큰은 넣지 않습니다.
3. 별도로 설치·실행한 Ollama에 사용할 모델을 내려받고 `OLLAMA_MODEL`에 모델명을 설정합니다.
4. 필요하면 `OLLAMA_BASE_URL`을 내부 추론 서버 주소로 바꿉니다.
5. 아래 명령으로 시작합니다.

```text
npm start
npm test
```

기본 API 주소는 `http://127.0.0.1:3000`입니다. `GET /healthz`는 API 프로세스 생존만 확인합니다. 모델 설치·추론 준비 상태는 보장하지 않습니다. 설정 누락·토큰 목록 없음·잘못된 설정은 시작 시 실패합니다. 만료된 토큰은 호출 시 401로 거절합니다.

## 호출 예제

`POST /v1/ai/organize`와 `Authorization: Bearer <개인 토큰>`, `Content-Type: application/json`을 사용합니다.

```json
{
  "clientRequestId": "mobile-request-001",
  "inputRevision": 1,
  "consent": true,
  "timeZone": "Asia/Seoul",
  "referenceTime": "2026-11-09T10:00:00+09:00",
  "text": "내일 보고서를 제출해야 한다."
}
```

다른 API와 응답 필드는 [API 계약](../docs/SERVER.md#api-계약)을 따릅니다. `consent: true`는 앱이 해당 전송 허용을 확인했다는 선언이며 서버가 사용자의 실제 UI 조작이나 로컬 기록 권한을 독립적으로 확인하는 수단은 아닙니다.

## 컨테이너 실행

저장소 루트에서 실행합니다. Docker Compose 및 Ollama 이미지의 대상 OS/CPU 지원을 확인해야 합니다.

```text
docker compose --env-file server/.env up --build -d
docker compose exec ollama ollama pull <선택한-모델명>
```

Compose는 API를 호스트 loopback 3000에만 공개하고 Ollama 포트를 외부에 공개하지 않습니다. 모델 볼륨에는 가중치가 보존됩니다. 모델 다운로드·GPU 드라이버·가속 설정은 자동 구성하지 않습니다. 기본 Compose에는 GPU 설정이 없으므로 GPU가 필요한 모델은 대상 호스트에서 별도 설정·측정해야 합니다.

모바일 실기기는 서버의 localhost에 연결할 수 없습니다. 배포 시 HTTPS 역방향 프록시를 앞에 두고 기기에서 접근 가능한 도메인을 모바일 API 주소로 설정합니다. 프록시의 48KiB 본문 상한, 요청 속도/연결 제한, 본문·Authorization 미기록, 모델 제한 시간보다 긴 응답 타임아웃을 설정합니다. 서버 간 Ollama 연결은 신뢰된 사설망에서만 허용합니다.

## 운영 범위

현재 인증은 소규모 팀 시험용 수동 발급·만료 토큰입니다. 레코드 제거/교체 후 서버를 재시작하면 폐기됩니다. 정식 로그인·자동 갱신·계정 연동·사용자별 과금은 구현하지 않았습니다. 현재 요청량·동시성 제한은 단일 프로세스 기준이므로 복제 서버 운영 전에 인증 제공자와 공유 제한 저장소를 설계해야 합니다.

요청 본문·인증 헤더·모델 원문 오류를 응답이나 로그에 기록하지 않습니다. 서버에서 파일로 기록하지 않더라도 OS swap·크래시 덤프·프록시·Ollama 런타임의 보관 정책은 운영 환경에서 별도로 검증해야 합니다.

## 검증

최종 자동 시험은 24/24 통과했습니다. 환경·범위·미검증 항목은 [검증 기록](../docs/VERIFICATION.md)을 읽습니다.

`npm test`는 인증·스키마·근거·기한·오류·요청량·동시성·타임아웃과 모의 Ollama HTTP 연동을 확인합니다. 실제 모델 호출·한국어 정확도·GPU/RAM·처리량·Docker 빌드·인터넷 배포를 통과했다는 의미는 아닙니다.
