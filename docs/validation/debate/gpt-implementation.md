# 앱 명령 검증기 구현 결과

2026-11-23 · task_f216e784c8a7 · PC 검증 완료, Claude 리뷰 대기

- `frontend/Frontend_UI/src/features/stella/appCommands.mjs:52`에서 할 일·일정 요청에 ISO 또는 월·일이 있어야 승인 카드를 만들도록 했다. 기준 시각 주입이나 날짜 치환은 없다.
- 같은 파일 78행과 122행에서 원문 값과 작업 종류를 대조한다. 문단과 본문은 같은 블록으로 처리하고 값 없는 블록 추가는 요청 표현을 확인한다.
- `tests/integration/mobile-command-verification.test.mjs:33`에 승인 차단과 정상 대조군을 추가했다.
- `ai/eval/s22-frozen-config.json:68`의 소스 LF 해시를 갱신했다. 렌더링 프롬프트·문법 해시 및 보정 임계값 검사가 통과했다.

## E1과 E2

- E1 최초 17건에서 수정 전 오승인 11건을 재현했다. 최종 19건 통과(차단 13건, 승인 유지 6건).
- E2 첫 실행에서 세 모델 모두 r20이 새로 막혔다. 현재 달을 여는 캘린더 요청을 기존 화면 라우터로 검증한 뒤 재채점했다.
- 원본과 최종 scores.json의 144개 문항별 결과를 비교했다.

| 모델 | 통과 / 48 (전 → 후) | 잘못 실행 (전 → 후) | 기존 통과 중 새 실패 | 주변 블록 변경 |
|---|---|---|---|---|
| Q4_K_M | 22 → 24 | 5 → 0 | 0 | 0 |
| IQ4_XS | 29 → 31 | 2 → 0 | 0 | 0 |
| Q3_K_M | 29 → 30 | 1 → 0 | 0 | 0 |

채점 결과는 `../.artifact_work/model-candidates/regression-e2/scores.json`에 있다. 녹화 출력 재생 결과이며 모델 후보 선별은 별도다.

## 기존 검사

- PASS · integration 106/106, local 85/85, ai 23/23, mobileModel 1/1.
- PASS · `node ai/eval/replay-mobile.mjs` 종료 코드 0.
- NOT_RUN · cloud(fastify 부재), 모델 실행, S22 E3~E5, 독립 300문항.
