# 개발 시험 실행 증거 — 2026-11-16

대상: `codex/integration-cloud-contracts`, main `e7397a5a79ce202af19a5af5ff67bb2b977f10f8` 기반 작업 트리. Windows, Node `v26.13.0`, Deno `2.9.6`. 작성자 실행이며 평가자 독립 재실행은 아니다. 저장소에는 사용자 DB/모델 가중치/실토큰/테스트 원문을 포함하지 않는다.

| 실행 | 명령 또는 방법 | 실제 결과 | 증거 수준·제한 |
|---|---|---|---|
| DEV-LOCAL | `npm run test:local` | 72 PASS / 0 FAIL | L2. 실제 local Store와 Node SQLite 및 모의 sync transport. 기기 SQLite 실행 아님 |
| DEV-AI | `npm run test:ai` | 23 PASS / 0 FAIL | L2. 문서 청킹·합성 요약/QA·인용·취소·Ollama 요청 검증. 실제 모델 없음 |
| DEV-CLIENT | `npm run test:integration` | 8 PASS / 0 FAIL | L2. 정책 교집합, 기기 선차단, 실제 local Store→초안 제안, 원본 수정·계정 교체·취소·동의 철회, 수동 요약 preview 무저장 |
| DEV-HOST | `npm run test:cloud` | 28 PASS / 0 FAIL | L2. 실제 Fastify/loopback HTTP, 모의 Ollama, 내부 인증·입출력 제한·공유 동시성·연결 종료 |
| DEV-EDGE | Deno `provider_routing.test.ts` | 4 PASS (하위 3 step 포함) / 0 FAIL | L2. 실제 Gateway handler+모의 Auth/RPC로 자체 경로·동의·UNKNOWN 정산 검증. 별도로 Edge adapter→실제 Fastify HTTP→모의 Ollama. 실제 DB 시험 아님 |
| STATIC-EDGE | `deno check --node-modules-dir=none .../ai-gateway/index.ts` | exit 0 | 정적 타입 검사. 동의 migration/RPC 실행 증거 아님 |
| STATIC-IMPORT | Babel parser로 화면의 data 모듈 named import/export 대조 | 234 참조, 누락 0 | 정적 연결 검사. 반환 데이터 모양·화면 동작 보장 아님 |
| STATIC-PACKAGES | 프론트 `npm ls --depth=0` | exit 0, 누락 없음 | 설치 의존성 확인. SDK 네이티브 실행 보장 아님 |
| BUILD-ANDROID | `EXPO_OFFLINE=1`, `expo export --platform android` | exit 0, 1,070 modules, 3.4 MB Hermes bundle | 번들 생성. APK 생성·설치·권한·SQLite GUI·화면 상호작용 시험 아님 |
| STATIC-DIFF | `git diff --check` | exit 0 | whitespace 오류 없음. Windows CRLF 변환 경고는 있음 |

합계 135개 최상위 개발 시험 PASS(Deno 하위 step 3개는 합계에 다시 더하지 않음). 이 수치는 서로 다른 suite의 시험 수 합계이며, 135명의 사용자/문서/독립 품질 표본이나 수용 Gate 통과 수가 아니다. fixture는 합성 데이터이며 비용/품질/메모리 수치가 아니다. 해당 시점의 Android bundle 파일명은 `index-fa14f959436a945ad16f078a414717e0.hbc`이며 생성물은 `.integration-build/android`에만 있고 Git에서 제외한다.

첫 서버 실행은 샌드박스의 loopback 접근 제한 때문에 실제 소켓을 여는 기존 시험에서 EACCES가 났다. 동일 시험을 허용된 실행 환경에서 다시 실행하여 위 결과를 얻었다. Deno의 루트 package.json에 따른 SDK/Node 해석 충돌은 `--node-modules-dir=none`과 테스트 전용 import map으로 해결했다. map은 Fastify/Ajv의 서버 버전과 일치시키며 deno.lock을 포함한다. 이는 제품 실패로 숨기거나 타입 검사 성공으로 대체하지 않았다. Node의 프론트 ESM 재해석 경고와 Metro 색상 환경 경고는 남아 있다. 프론트 lockfile은 `npm ci --dry-run --offline --ignore-scripts` exit 0으로 추가 확인했다.

## 실행하지 않은 것

- 새 Supabase migration 전체 재생, RLS/원자 사용량 예약·정산, 테스트 프로젝트 배포, 실제 메일/OAuth/동의 기록.
- 실제 모델·외부 유료 API·실기기·두 기기·iOS 실행, 모델 RAM/배터리/열/지연, 한국어 품질 holdout, 실제 네트워크 전체 경로 canary.
- 공유 첨부 업로드/복원, 프로젝트·안건·백업·삭제 UI의 전체 통합, 알림 중복/철회, 부하와 장애 복구.
- GitHub Actions 원격 실행, 원격 main 병합·push·운영 배포.

따라서 V01~V34 상위 수용 상태는 `cases-v2.csv`에 선행조건을 적은 BLOCKED로 둔다. 예를 들어 DEV-CLIENT의 계정 교체 시험 PASS는 V07 실기기 계정 전환 PASS가 아니며, DEV-EDGE는 V02 실제 migration 호환성 PASS가 아니다. M0 개발 계약의 일부 증거를 확보한 상태이며 M1~M3 수용 완료로 판정하지 않는다.

다음 실행 순서는 테스트 Supabase 신규 재생(V29/V02) → 실제 계정·기기 기본 저장과 재시작(V01/V03/V07/V08) → 한 모델 경로의 양 구간 전송 관측(V09/V10/V33/V34) → baseline/목표 동결 → holdout 품질(V17~V21)이다. 배포 설정·기기·모델·승인 목표를 준비하기 전 임의 PASS를 기록하지 않는다.
