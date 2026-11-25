# 문서 작업: 버전 기록과 브리지 설명서

담당: GPT(문서만). 사용량이 절약 모드이므로 아래 파일만 읽고 짧게 쓴다. 이 지시서는 커밋하지 않는다.

## 버전 체계 (Claude가 정함)

- 앱: `1.1.0`, 태그 `v1.1.0-preview.1`. 이전 태그는 `v1.0.0-preview.1`, `v1.0.0-guest.1`, `v1.0.0-guest.2`.
- 브리지: `0.1.0`, 태그 `bridge-v0.1.0`. 앱과 따로 버전을 올린다.
- 규칙: SemVer. 기능 추가는 MINOR, 수정은 PATCH, 테스트 배포는 `-preview.N`·`-guest.N`. Android `versionCode`는 배포할 때마다 1씩 올린다(이번 2).

## 작성할 파일

1. 저장소 루트 `CHANGELOG.md` (새 파일, 한국어)
   - 맨 위에 위 버전 규칙을 3줄 이내로 적는다.
   - `## [1.1.0-preview.1] - 2026-11-24`: 원장 `docs/validation/debate/token-ledger.md`의 최근 항목과 `docs/validation/ai-gateway.md`를 근거로 정리한다. 추가된 것(AI 게이트웨이와 연결 5종, Gemma 4 E2B 기본, 프로젝트 명령, 블록 길게 누르기 AI 요청, AI 제안 강조 블록 수용·거절, Android 4GB Q5 압축 설정), 바뀐 것(AI 연결 탭 설정 전용), 제거된 것(AI 채팅, 앱 작업 요청 메뉴), 수정된 것(웹 저장소 복구, 블록 대상 검증), 미검증 항목.
   - `## [bridge 0.1.0] - 2026-11-24`: 첫 배포. Windows 실행 파일과 npm 패키지.
   - 이전 버전은 태그 이름과 한 줄 요약만 적는다: `v1.0.0-guest.2`(355ecc0 UI 복원, 로그인 없는 테스트 APK), `v1.0.0-guest.1`(로그인 없는 테스트), `v1.0.0-preview.1`(첫 Android 미리보기).
2. `bridge/README.md` (새 파일, 한국어)
   - 무엇인지, 메모앱과 따로 설치한다는 점
   - 설치: Windows는 릴리스 `bridge-v0.1.0`의 `stella-bridge.exe`(SHA256SUMS로 확인, 서명되지 않아 SmartScreen 경고 가능), 다른 OS는 `.tgz`를 `npm i -g`(Node 20 이상)
   - 명령: `bridge/stella-bridge.mjs`의 사용법 줄 기준(init, serve, list, add-key, enable-cli, disable-cli, rotate-key, --version)
   - 앱 연결: `AI 연결 → 내 서버`에 init이 출력한 연결 문자열을 붙여 넣기
   - 보안: 연결 키는 비밀번호처럼, 외부 접속은 HTTPS나 Tailscale, 구독 CLI는 서버 주인 본인만, 키를 입력할 때 화면에 보임
   - 제한: Codex는 Node가 필요하고 도구 끄기 옵션이 없어 읽기 전용 샌드박스가 상한, 실제 API 키 호출은 미검증

## 금지

코드 수정, 커밋, 푸시. 실행하지 않은 것을 통과로 쓰지 않는다. 끝나면 한 줄로 보고하고 멈춘다.
