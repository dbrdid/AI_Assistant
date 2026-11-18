# SW 모바일 AI 비서 — AI Assistant

사용자의 메모와 기록에서 할 일·일정 후보를 정리하고, 저장한 기록을 근거로 질문에 답하는 모바일 개인 비서 프로젝트입니다.

## 현재 상태

2026-11-16 통합 브랜치에서는 Expo 화면을 계정별 SQLite/local Store·기존 Supabase 동기화·AI Gateway에 연결했습니다. 자체 추론 경로는 Gateway → Fastify → Ollama이며 외부 API 경로와 동의를 분리합니다. 로컬 합성 시험과 Android 번들 검사는 실제 앱·DB 배포·모델 품질 수용 시험과 구분합니다. 공유 첨부·백업·삭제 등 전체 기능 통합은 미완료입니다. [적용 범위·실행 준비·제한 사항](docs/INTEGRATION-2026-11-16.md)을 먼저 확인하세요.

## 이번 변경

모바일 기기에서 LLM을 직접 실행하는 기본 경로를 **별도로 구축할 AI 서버에서 추론하는 경로**로 변경합니다. 모바일 성능·메모리 부담을 줄이기 위한 설계 결정이며, 특정 모델이 모든 모바일에서 실행 불가능하다는 실험 결과는 아닙니다.

로컬 SQLite 중심의 기록 관리, 기존 화면과 기능 범위, AI 초안 검토·사용자 승인 원칙은 유지합니다. AI 서버 사용은 데이터 동기화·클라우드 백업 동의와 별개입니다. 서버 연결이 없으면 AI 기능은 사용할 수 없으며, 수동 저장·수정·조회·기본 검색은 계속 동작하도록 설계합니다.

## 문서

- [데스크톱 모델 서버 테스트·시연 준비](docs/DESKTOP-MODEL-DEMO.md)
- [통합 설계 검증 계획 v2와 Gate](docs/validation/PLAN-v2.md)
- [수용 시험 기록표 V01~V34](docs/validation/cases-v2.csv)
- [개발 시험 실행 증거와 미검증 범위](docs/validation/EXECUTION-2026-11-16.md)
- [AI 서버 실행과 설정](backend/cloud/README.md)
- [AI 서버 구조·API 계약](docs/SERVER.md)
- [서버 검증 결과와 미검증 범위](docs/VERIFICATION.md)

- [제품 기능과 범위](docs/PRODUCT.md)
- [전체 구조와 책임](docs/ARCHITECTURE.md)
- [데이터와 AI 요청 흐름](docs/DATA_FLOW.md)
- [개발 순서와 검증 기준](docs/ROADMAP.md)
- [AI 실행 위치 변경 결정](docs/decisions/0001-server-inference.md)

## 기술 방향

| 영역 | 방향 | 상태 |
| --- | --- | --- |
| 모바일 | React Native / Expo | Android 번들 확인, 실제 기기 실행 미검증 |
| 로컬 데이터 | 계정별 SQLite와 local Store | UI 어댑터 연결, 기기 재시작·첨부 복구 미검증 |
| AI | 기기 client → Supabase Gateway → 자체 Fastify/Ollama 또는 허용 외부 API | 텍스트 경로 연결, 실제 모델·배포 미검증 |
| 계정·동기화 | 기존 Supabase Auth/RPC와 기기 sync Bridge | 코드 연결, 실제 DB·권한·두 기기 수용 시험 미실행 |

서버는 JavaScript·Fastify와 Ollama 어댑터를 사용합니다. 기존 사용자별 만료 토큰 API는 유지하며 앱 통합 경로는 Supabase 계정 인증과 별도 Gateway 서비스 자격 증명을 사용합니다. 호스팅·GPU·모델·운영 비용은 미확정입니다. 이전 설계 문서의 상태보다 최신 통합 현황 문서를 우선합니다.

## 공유 범위

기존 현재 앱의 제품·아키텍처·M1·AI·데이터 설계에서 팀 개발에 필요한 골자를 정리하고 서버 코드를 추가했습니다. 과거 기기 내 추론 우선 정책은 서버 추론 결정으로 대체합니다. 다른 독립 프로젝트의 코드·기능·검증 결과, 사용자 데이터, 모델 파일, 비밀 키, 발표자료와 과거 보관본은 포함하지 않습니다.

## 팀별 모노레포 구조

frontend/, backend/local/, backend/cloud/, ai/, shared/, tests/, docs/, .github/로 구분합니다. 기존 server/는 backend/cloud/로 이동했습니다. 나머지 앱 영역은 책임을 명시한 준비 폴더이며 구현 완료를 뜻하지 않습니다. [팀 개발 규칙](docs/CONTRIBUTING.md)을 따릅니다.

서버 시험: npm --prefix backend/cloud test

