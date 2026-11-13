# 팀 개발 운영

하나의 저장소에서 frontend, backend/local, ai를 담당 영역으로 관리합니다. shared는 공동 계약, tests는 영역 간 시험, docs는 설계 문서입니다. 폴더별 장기 브랜치는 만들지 않습니다.

작업 전 main 최신 상태에서 작업 브랜치를 만들고 Issue → 계약 합의 → 구현 → 관련 시험 → PR → 검토 → 병합 순으로 진행합니다. 예: feat/frontend-chat, feat/local-note-storage, feat/cloud-auth, feat/ai-tool-routing. 자동화 작업의 기본 브랜치 접두사는 codex/입니다.

현재 모바일 프로젝트를 Windows 중심으로 바꾸거나 Tauri/FastAPI를 도입하는 결정은 이번 구조 변경에 포함하지 않습니다. 백엔드는 Node.js SQLite 기반 구현입니다. 별도 HTTP 서버·모바일 네이티브 연결·운영 배포는 미구현입니다.

AI는 구조화된 후보를 반환합니다. 실제 기기 DB 변경, 대상 및 권한 확인, 사용자 승인과 트랜잭션은 로컬 백엔드가 통제합니다. 프론트에서 추론 엔진 또는 DB를 직접 조작하는 경로를 만들지 않습니다.

계약 변경 PR에는 입력·출력 예시, 오류, 호환성 영향과 관련 소비자 검토를 포함합니다. 실제 팀 계정이 정해지면 .github/CODEOWNERS.example을 수정해 CODEOWNERS로 활성화합니다. 이후 GitHub 설정에서 main PR 검토, 소유자 검토와 local-tests 필수 검사를 설정해야 합니다. 이 문서를 추가하는 것만으로 보호 규칙이 활성화되지는 않습니다.

루트에서 서버 시험: npm --prefix backend/local test
서버 실행: backend/local/README.md 참조.
CI는 서버 시험만 검증하며 앱·모델·배포 검증을 대체하지 않습니다.
