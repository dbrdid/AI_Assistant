# 코드 작업: Android 4GB용 Q5 압축 설정 이식

작은 범위의 작업이다. ponytail full을 유지하고, 이 파일은 커밋하지 않는다.

## 배경

사용자가 `SJW1212/stella-mobile-apk`에 커밋을 요청했다. 그 저장소의 `f721319`(Add compact Android Q5 profile for 4 GB available RAM)는 통합본에 없는 작업이다. 이 작업은 예전 추론 코드를 기준으로 작성되어 그대로 붙일 수 없으므로, 현재 통합 폴더 코드에 옮겨 넣는다. 원본은 `git show f721319`로 볼 수 있다(통합 폴더에 `apk` 원격으로 가져와 두었다).

## 옮길 내용

- `StellaModelDeviceModule.kt`의 `memory`에 `rawAvailable`(`info.availMem`)을 추가한다.
- `mobileModelPolicy.mjs`에 `inferenceLimits(model, memory, platform)`과 `COMPACT_Q5_MIN_AVAILABLE_BYTES`를 추가한다. `loadCandidates`가 Qwen 경로에서 이를 사용하게 한다. Android의 Q5는 total 7e9 이상, rawAvailable 4e9 이상, available이 파일 크기 이상이면 compact(2048/64/32/256)로 허용한다.
- Gemma 경로(`deviceModels`의 `minTotal`·`minAvailable`)는 지금처럼 유지한다.
- `mobileModel.native.js`가 선택된 한도로 `n_ctx`, `n_batch`, `n_ubatch`, `n_predict`를 정한다. 단 `tests/integration/s22-metrics.test.mjs`는 소스에 `n_ctx: 4096`, `n_batch: 128`, `n_ubatch: 64` 문자열이 있는지 검사한다. 표준 값을 이 형태의 리터럴로 남겨 검사를 통과시킨다. 고정 평가 설정 파일은 수정하지 않는다.
- 명령 출력 상한(`outputLimit`)과 일반 출력 상한(`GENERAL_MAX_TOKENS`)의 기존 동작은 표준 한도에서 그대로 유지한다. compact에서는 둘 다 256을 넘지 않게 한다.
- `f721319`의 테스트를 `tests/integration/mobile-model-policy.test.mjs`에 옮긴다.

## 완료 조건

- `npm run -s test:integration`과 `node --test frontend/Frontend_UI/tests/mobileModel.test.cjs`가 통과한다.
- 원장에 한 줄을 남기고 멈춘다. 커밋과 푸시는 하지 않는다. 커밋은 Claude Code 세션이 맡는다.
