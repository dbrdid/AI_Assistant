# Orca 재개 지시서: Run run_005c12950703

너는 이 Run을 이어받는 Claude 코디네이터다. 먼저 `orca skills get orchestration`을 한 번 읽고, `orca orchestration run-use`로 Run을 이어받아라. 기존 Codex 터미널은 종료하지 마라.

## 목표
`improve-notion-style-app` 작업본의 앱 기능과 Android·iOS 오프라인 Qwen3.5-4B(Q4_K_M, Q5_K_M) 연동을 검증 가능한 상태로 마무리한다. 블록 편집은 답변 문구가 아니라 요청한 블록의 실제 변경과 주변 블록 보존으로 평가한다.

## 이미 확인된 상태 (재실행 금지)
- 기준: `SJW1212/improve-notion-style-app`, 커밋 `8c5c099`. 변경은 모두 미커밋 상태다.
- 완료 Task: task_df6dea3f26b8(앱 기능), task_5ad7101c2ef2(모바일 추론), task_0526c037429d(연구·13개 비교).
- 13개 개발셋: Q4, Q5 모두 기본 7개, 보완 후 10개 통과. 이 수치는 개발셋 재측정이다.
- 실패 Task: task_ee2044570116(독립 300문항 및 블록 명령 비교). 원인은 Codex 시작 시 `agent-update-prompt`이며, 평가가 실행된 적은 없다.
- 이 PC에서 Orca가 실행할 수 있는 에이전트는 claude다. Codex CLI는 없다.
- 근거 문서: `docs/validation/qwen35-mobile.md`, `ai/eval/README.md`.

## 남은 작업 (워커는 동시에 최대 2개, 같은 파일을 동시에 수정하지 않는다)
1. 결함 수정: Q5 제목 블록 생성 실패, Q4 종일 일정의 시각 손실, 인용 숫자·날짜·단위 변형, 검색 전 파일 부재 단정, 원문에 없는 검색 기간 추가. 프롬프트만 고치지 말고 앱의 승인 전 검증과 저장 후 값 검증에서 막는다.
2. 독립 평가: `--retry-of ctx_1d351ca1e27e`로 task_ee2044570116을 `--agent claude`로 재시도한다. 13개 개발셋과 겹치지 않는 한국어 300문항을 사용하고, 문항과 기대 상태는 모델 출력을 보기 전에 고정한다. 결함 수정이 끝난 코드로 Q4, Q5를 측정하고 프롬프트 조정에 이 300문항을 쓰지 않는다.
3. 리뷰: 변경 전체에 정확성 리뷰와 `ponytail-review`를 읽기 전용으로 수행하고, 확인된 결함과 동작이 보존되는 단순화만 반영한다.
4. 기록: `docs/validation/qwen35-mobile.md`를 실제 결과로 갱신한다.

## 모든 워커에 적용할 스킬
각 워커 지시에 다음을 포함하라. 이 스킬들은 자동 호출이 꺼져 있을 수 있으니 `~/.claude/skills/<이름>/SKILL.md`를 직접 읽게 하라.
- `loop`: 구현, 검증, 수리. 실패 분기당 자동 재시도 1회.
- `ponytail` (full): 최소 변경. 단, 입력 검증과 데이터 손실 방지는 줄이지 않는다.
- `token-efficient-workflow`: 긴 출력은 파일에 저장하고 실패와 수치만 보고한다.
- `code-simplification`: 테스트가 통과한 뒤 동작을 유지하는 범위에서만 사용한다.

## 금지와 중단 조건
- 커밋, 푸시, PR, 브랜치 변경, `git stash`, `git reset`, `git clean`을 하지 않는다.
- 새 의존성 설치, 모델 추가 다운로드, 전역 설정 변경을 하지 않는다. 필요하면 멈추고 보고한다.
- 비밀값과 실제 사용자 데이터를 사용하거나 출력하지 않는다. 평가는 합성 데이터로 한다.
- `ai/eval/data/`의 모델 파일을 수정하지 않는다.
- Galaxy S22와 iPhone 실기기가 연결되어 있지 않다. 실기기 성능은 NOT_RUN으로 남기고 추정치를 쓰지 않는다.
- Claude 세션 사용량이 80%에 이르면(`orca account list --json`의 rateLimits.claude) 새 워커를 시작하지 말고 진행 중인 작업을 정리한다.

## 작업 범위
모든 읽기와 쓰기는 현재 작업 폴더 안에서 한다. 이 지시서와 결과 파일은 커밋하지 않는다.

## 종료 시
`docs/validation/orca-resume-result.md`에 다음을 작성한다: Task별 결과, 실행한 검사와 통과 수, Q4·Q5 300문항 점수, 남은 결함, NOT_RUN 항목, 재개 명령. 실행하지 않은 것을 통과로 적지 않는다.
