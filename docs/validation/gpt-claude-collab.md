# GPT·Claude 협업 규칙

대상: Orca Run `run_005c12950703`, 작업본 `improve-notion-style-app`. 이 파일과 `docs/validation/debate/`는 커밋하지 않는다.

## 참여자

- Claude 코디네이터: `term_ef0f4553-acbf-44ce-839c-083ffee608a9`. Task 관리, 최종 통합, 토론 정리.
- GPT-6 Luna(Codex): `term_dd06c76d-c5e5-45a8-b61a-e3ee97aa8024`. 독립 교차 검토, 반론, 합의 후 배정된 구현.

## 먼저 읽을 근거

1. `docs/validation/orca-resume-result.md`
2. `docs/validation/s22-performance-goal.md`
3. `docs/validation/s22-model-optimization-plan.md`
4. 판단에 필요한 코드와 `ai/eval/`의 관련 파일만 추가로 읽는다.

## 토론 안건

1. 다음 수정 우선순위: 상대 날짜 오류(c11, c31), 값 누락 실행(c05, c07), GBNF 실제 로드 검증 중 무엇을 어떤 순서로 처리할 것인가.
2. Q4_K_M, IQ4_XS, Q3_K_M 판단: 문법 적용 조건에서 다시 비교할 최소 실험은 무엇인가. 현재 48문항 결과에서 어디까지 말할 수 있는가.
3. S22 메모리: mmap과 ARM repack을 고려한 로드 조건, 요청마다 로드·해제하는 현재 방식의 유지 여부.
4. C단계 필요성: A·B 수정 후에도 QLoRA가 필요한지 판단할 사전 기준.
5. 독립 300문항 설계: 한 줄 앱 명령에 "JSON 99%" 기준을 어떻게 바꿔 적용할지, 문항과 정답을 어떻게 동결할지.

## 진행 방식

1. GPT 1라운드: 코드와 문서를 수정하지 않고 `docs/validation/debate/gpt-round1.md`만 작성한다.
2. Claude 응답: 안건별로 동의, 반대, 추가 근거를 `docs/validation/debate/claude-round1.md`에 작성한다.
3. 이견이 남으면 GPT가 `gpt-round2.md`로 한 번 더 답한다. 토론은 최대 2라운드다.
4. Claude가 `decision.md`에 합의, 이견, 실행 순서, 담당을 정리한다.
5. 남은 이견은 작은 실험으로 판정한다. 실험 없이 판정할 수 없거나 사용자 권한이 필요한 항목은 사용자에게 올린다.

각 주장에는 파일과 줄, 측정값, 또는 재현 명령을 붙인다. 근거가 없으면 가설로 표시한다. 안건별 분량은 10줄 이내로 한다.

## 작업 규칙

- 같은 파일을 두 에이전트가 동시에 수정하지 않는다. 구현은 `decision.md`에서 배정된 담당만 한다.
- 커밋, 푸시, PR, 브랜치 변경, `git stash`, `git reset`, `git clean`을 하지 않는다.
- 새 의존성, 모델, 학습 도구를 설치하거나 내려받지 않는다. C단계 이후는 사용자 승인이 필요하다.
- 앱 기본 모델을 바꾸지 않는다.
- 독립 300문항을 학습, 보정, 프롬프트 조정, 후보 선택에 쓰지 않는다.
- 실행하지 않은 검사를 통과로 적지 않는다. PC 결과를 S22 PASS로 쓰지 않는다.
- Claude 세션 사용량이 80%에 이르면 Claude는 새 워커를 시작하지 않고 현재 상태를 `decision.md`에 남긴다.
