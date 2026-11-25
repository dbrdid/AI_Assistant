# UI·AI 통합 기준

기록일: 2026-11-24. 이 파일은 커밋 대상이 아니다.

## 기준

- 작업 폴더: `현재 앱/stella-ui-ai-integration`
- 로컬 브랜치: `SJW1212/stella-ui-ai-integration`
- UI 기준: `355ecc0` (`Refine Stella mobile UI and complete integration updates`). GitHub에는 없다.
- AI 기준: `improve-notion-style-app`의 미커밋 변경. 스냅샷은 `.artifact_work/integration-snapshot-20261124`에 있다.
- 커밋과 푸시는 하지 않았다. 추적 파일 20개는 스테이징되어 있고 새 파일 62개는 미추적이다. `origin`의 push URL은 사용자 승인 전까지 막아 두었다.

## 통합 판단

- `WorkspaceScreen.js`: `355ecc0`의 화면과 메뉴를 유지했다.
- `LocalModelScreen.js`: Orca의 AI 동작을 유지하고 `355ecc0`의 제목 제거와 안내 문구 방향을 반영했다.
- `routes.js`: AI 탭에 `앱 작업 요청`을 추가했다.
- `s22Metrics.dev.web.js`: 웹에서 S22 측정 파일을 만들다 앱이 흰 화면으로 멈추는 오류를 막았다. Orca 원본 작업본에도 같은 원인이 남아 있다.

## 검증

| 검사 | 결과 |
|---|---|
| integration | 106/106 |
| local | 85/85 |
| ai | 23/23 |
| mobileModel | 1/1 |
| 녹화 응답 replay | 종료 코드 0 |
| Android 번들 | 성공, Hermes 4,295,234바이트 |
| 웹 미리보기 | 홈, AI 탭, 앱 작업 요청, 로컬 AI 진입 확인 |

## 미검증과 남은 문제

- 웹 미리보기는 AI 호출이 꺼져 있어 로컬 AI 응답과 승인 후 저장을 통합본에서 확인하지 않았다.
- 통합본의 S22 설치·실행, Kotlin·Swift 빌드, cloud 테스트, 독립 300문항은 NOT_RUN이다.
- `claude-review.md`의 검증기 과잉 차단과 잘못된 날짜 승인 문제는 그대로 남아 있다.
- AI 탭의 `앱 작업 요청`, `로컬 AI` 화면에는 탭 안에서도 뒤로 가기 헤더가 함께 보인다.
- `improve-notion-style-app`에서 이후 수정한 내용은 이 폴더에 자동 반영되지 않는다.

## AI 게이트웨이 추가

다섯 가지 AI 연결에 공통 앱 지침과 승인 절차를 적용했다. Claude는 integration 112/112 통과와 웹 미리보기의 프로젝트 생성·승인 후 상세 화면 이동을 확인했다. 실기기 Gemma 추론, 외부 제공자 실호출, Supabase 배포는 NOT_RUN이다. [연결 설정과 검증 기록](ai-gateway.md)
