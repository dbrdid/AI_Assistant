# Orca 작업 위치 전환

기록일: 2026-11-24. 이 파일은 커밋하지 않는다.

## 현재 기준

- 유일한 작업 위치: `C:\Users\SonJuWon\Desktop\모바일 프로젝트\현재 앱\stella-ui-ai-integration`
- 브랜치: `SJW1212/stella-ui-ai-integration`, HEAD `355ecc0`, AI 변경은 스테이징·미추적 상태로 미커밋
- 이전 작업본 `improve-notion-style-app`과 `coral`은 읽기 전용 참고본이다. 수정하지 않는다.
- 웹 미리보기는 이미 `http://localhost:8101`에서 실행 중이다. 종료하거나 같은 포트로 다시 띄우지 않는다.

## 먼저 읽을 파일

1. `docs/validation/ui-ai-baseline-20261124.md`
2. `docs/validation/debate/decision.md`
3. `docs/validation/debate/claude-review.md`
4. `docs/validation/debate/token-coordination.md`
5. `docs/validation/debate/token-ledger.md`의 마지막 3개 항목

필요할 때만 `docs/validation/s22-memory-options.md`와 `docs/validation/orca-resume-result.md`를 추가로 읽는다.

## 역할

- Claude: 코디네이션, 통합 판단, 리뷰.
- GPT: 독립 검토와 배정된 구현.
- 사용량은 `docs/validation/debate/token-budget.ps1`로 확인하고 넘길 때 원장에 기록한다.
- 이전 문서의 터미널 ID는 더 이상 유효하지 않다. 새 터미널 ID는 원장의 최신 항목을 따른다.

## 지금 할 일

전환 확인까지만 한다. 위 파일을 읽고 현재 폴더, 브랜치, HEAD를 확인한 뒤 다음 세 가지를 5줄 이내로 답하고 멈춘다.

1. 전환 확인 결과
2. 다음 작업 1순위와 담당 제안
3. 사용자 결정이 필요한 항목

## 사용자 승인 전 금지

- 소스 수정, 새 워커, S22 기기 명령, 모델 실행
- 커밋, 푸시, PR, 브랜치 변경, `git stash`, `git reset`, `git clean`
- 의존성·모델·학습 도구 설치 또는 다운로드, 앱 기본 모델 교체
- 동결된 선별셋과 300문항을 수정하거나 조정 근거로 사용
- 실행하지 않은 검사를 통과로 기록
