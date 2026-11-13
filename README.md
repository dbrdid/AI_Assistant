# SW 모바일 AI 비서 — AI Assistant

사용자의 기록을 관리하고 AI 초안을 검토하는 모바일 개인 비서 프로젝트입니다.

## 현재 상태 (2026-11-14)

백엔드는 `backend/local/`의 SQLite(Node.js 내장 node:sqlite) 구현만 유지합니다. 기존 별도 Fastify AI 서버와 Docker Compose 실행 설정은 제거했습니다. 로컬 Gateway·Worker·암호화 보관 어댑터는 유지합니다. 이 변경은 모델을 사용자 기기에서 실행한다는 뜻이 아닙니다. 자체 호스팅 Gemma의 클라우드 실행과 외부 AI API 선택은 통합 설계이며, 실제 추론 경로·호스팅은 아직 연결하지 않았습니다.

프론트는 `frontend/Frontend_UI/`에 있습니다. Node.js 백엔드 코드를 Expo에 바로 import할 수는 없으며 네이티브 SQLite 연결·Store·통신 경로를 별도로 통합해야 합니다. 모델 파일·사용자 데이터·비밀 키는 포함하지 않습니다.

## 실행과 검증

Node.js 22.13 이상이 필요합니다. 저장소 루트에서:

```sh
npm --prefix backend/local ci --ignore-scripts
npm --prefix backend/local test
npm --prefix backend/local run demo:ai
```

AI 데모는 실제 SQLite와 합성 제공자를 사용하는 로컬 검증입니다. 실제 Gemma·외부 AI API·운영 배포의 증거가 아닙니다. GitHub Actions는 `local-tests`를 실행합니다.

## 담당 영역

| 폴더 | 역할 |
| --- | --- |
| frontend/ | 화면·입력·화면 상태 |
| backend/local/ | SQLite·RPC·권한·AI Gateway·작업 큐·Worker |
| ai/ | AI 담당 영역. 문서 AI 구현은 현재 별도 AI 작업 브랜치에서 관리 |
| shared/ | 팀 공통 계약 |
| tests/ | 영역 간 통합 시험 |
| docs/ | 설계·검증 기록 |

## 문서

- [로컬 백엔드 실행·구현 범위](backend/local/README.md)
- [백엔드 구성과 계약](docs/SERVER.md)
- [전체 구조](docs/ARCHITECTURE.md)
- [AI 데이터·작업 큐](backend/local/AI-DATABASE.md)
- [검증 기록](docs/VERIFICATION.md)
- [팀 개발 규칙](docs/CONTRIBUTING.md)
- [제품 범위](docs/PRODUCT.md) · [데이터 흐름](docs/DATA_FLOW.md) · [개발 순서](docs/ROADMAP.md)
- [과거 서버 추론 결정](docs/decisions/0001-server-inference.md)

AI 초안은 사용자 승인과 문서 버전 검사 후 적용합니다. AI 전송 동의는 동기화·백업 동의와 구분합니다. 삭제된 서버의 과거 구현·시험 기록은 Git 이력으로 확인하며 현재 실행 안내로 사용하지 않습니다.
