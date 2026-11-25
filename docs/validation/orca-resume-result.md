# Orca 재개 결과: Run run_005c12950703

기록일: 2026-11-23. 기준: `SJW1212/improve-notion-style-app`, 커밋 `8c5c099`와 미커밋 작업본. 이 파일은 커밋 대상이 아니다.

**결론: Galaxy S22 실기기 지표와 Q4·Q5 독립 300문항은 모두 NOT_RUN이다.** PC 검사와 Android 번들은 통과했지만 S22 통과 근거가 아니다. 앱 기본 모델은 Q4_K_M 그대로다.

## 1. Task별 결과

| Task | 내용 | 결과 |
|---|---|---|
| `task_f24d6197dd69` | 결함 수정 5건: 제목 블록, 시각 손실, 인용 변형, 검색 전 부재 단정, 없는 검색 기간 | 완료. 승인 전 검증과 저장 후 값 검증 추가, 회귀 테스트 15개 |
| `task_a2a1a5c498bc` | 변경 전체 정확성 리뷰와 ponytail-review | 완료. 13건 중 8건 반영, 2건 기각, 3건 사용자 결정으로 넘김. 단순화 순감소 2줄 |
| `task_d40e6079d199` | S22 측정 도구, 로드 조건 분석, 출력 상한, 설정 고정 | 완료. 로드 조건 수치는 바꾸지 않음. 실기기 지표 NOT_RUN |
| `task_7279ff55b6cc` | 사용자 결정 반영 | 완료. 원문에 없는 시각 경고, Android 모델 백업 제외, iOS 권한 보류 |
| `task_654c1f12a5d0` | A단계: 규칙 라우터, GBNF, 입력 상한, 기기 제한, 되묻기 보정 | 완료. GBNF 실제 로드와 네이티브 컴파일은 NOT_RUN |
| `task_2063eba75737` | B단계: Q4_K_M, IQ4_XS, Q3_K_M 비교 | 완료. 추천은 **판단 불가** |
| `task_ee2044570116` | 독립 300문항 및 블록 명령 비교 | **미실행.** 최초 실패 원인은 Codex 시작 시 `agent-update-prompt`였고, 이후 사용자 지시로 최종 후보 확정까지 보류 |

## 2. 현재 코드 검사 (2026-11-23 실행)

| 검사 | 명령 | 통과 | 실패 | NOT_RUN |
|---|---|---:|---:|---:|
| integration | `npm run -s test:integration` | 87 | 0 | 0 |
| local | `npm run -s test:local` | 85 | 0 | 0 |
| ai | `npm run -s test:ai` | 23 | 0 | 0 |
| frontend | `node --test frontend/Frontend_UI/tests/mobileModel.test.cjs` | 1 | 0 | 0 |
| 녹화 응답 replay | `node ai/eval/replay-mobile.mjs` | 1 (exit 0) | 0 | 0 |
| Android 번들 | `npx --no-install expo export --platform android` | 1 (Hermes 4,288,131바이트) | 0 | 0 |
| cloud | `backend/cloud/test/internal.test.js`, `server.test.js` | 0 | 0 | 2 |

- 합계: 테스트 196개, replay 1회, 번들 1회 통과. 실패 0. NOT_RUN 2.
- cloud는 `backend/cloud/node_modules`가 없어 `fastify` import에서 멈춘다. Node 실행기는 이 2개 파일을 fail로 표시하지만 테스트 본문이 실행되지 않았으므로 NOT_RUN으로 적는다.
- 보고서와의 차이: integration 수는 작업 진행에 따라 56, 63, 69, 72, 87로 늘었고 현재 값은 마지막 보고서와 같다. 번들 크기는 리뷰 시점 4,260,027바이트에서 현재 4,288,131바이트로 달라졌다.
- `ai/eval/s22-frozen-config.json`의 현재 SHA-256은 `197c783b089e5219fe36a38d5fe0d21f983cc95f1f7e789f3f3a4492c1afae5b`로 A·B단계 기록과 같다.

## 3. Q4·Q5 독립 300문항 점수

| 모델 | 점수 |
|---|---|
| Q4_K_M | **NOT_RUN** |
| Q5_K_M | **NOT_RUN** |

사용자 지시로 최종 후보가 정해질 때까지 보류했고, 문항도 작성하지 않았다. 아래의 13개, 보정 40개, 개발 28개 결과는 개발용 측정이며 독립 평가 점수가 아니다.

## 4. B단계 비교

**모든 수치 조건: 문법 미적용, n_ubatch 128, x86 Ollama, 앱 조건 아님.** 추천은 **판단 불가**이고 앱 기본 모델은 Q4_K_M 그대로다.

| 항목 | Q4_K_M | IQ4_XS | Q3_K_M |
|---|---:|---:|---:|
| 통과 (모델 경로 48문항) | 22/48 | 29/48 | 29/48 |
| Q4 대비 정확 McNemar p (보정 기준 0.025) | 기준 | 0.039 | 0.065 |
| 잘못 실행 | 5 | 2 | 1 |
| 주변 블록 변경 | 0 | 0 | 0 |
| PC 참고: 최대 작업 메모리(MiB) | 4,346 | 2,754 | 3,093 |
| PC 참고: 첫 토큰 중앙값(ms) | 1,410 | 1,211 | 1,506 |
| PC 참고: 지속 속도 평균(tok/s) | 7.97 | 6.83 | 7.53 |

- 두 p값 모두 보정 기준 0.025를 넘어, Q4와의 차이를 유의하다고 볼 수 없다.
- 세 모델 모두 잘못 실행한 문항이 있어 필수 품질을 충족하지 못했다.
- PC 속도와 메모리는 참고값이다. x86 가중치 repack 차이가 포함될 수 있어 ARM이나 S22 성능으로 옮겨 해석하지 않는다.
- 표본은 48문항, 1회 실행, seed 1개다. 일부 정답은 B단계 Task에서 모델 출력 전에 작성했다.

## 5. S22 지표별 상태

기준은 [S22 쾌적 동작 목표](s22-performance-goal.md)다. 실기기 측정이 없으므로 모두 NOT_RUN이다. PC, 에뮬레이터, 번들 결과는 PASS 근거로 쓰지 않았다.

| 지표 | 기준 | 판정 | 수집 도구 |
|---|---|---|---|
| 콜드 스타트 후 조작 가능 | 2.5초 이하 | NOT_RUN | 부분: adb `TotalTime`은 첫 표시 시점 |
| 문서 열기(블록 500개) | 500ms 이하 | NOT_RUN | 있음(debug): `document_open` |
| 블록 입력·이동 반응 | 100ms 이하 | NOT_RUN | 부분(debug): 터치 지연 제외 |
| 추론 중 스크롤·입력 | 느린 프레임 5% 이하, 700ms 이상 멈춘 프레임 0, ANR 0 | NOT_RUN | 있음: gfxinfo, exit-info |
| 모델 첫 로드 / 재로드 | 20초 이하 / 8초 이하 | NOT_RUN | 있음(debug): `model_load` |
| 짧은 앱 명령의 첫 토큰 | 4초 이하 | NOT_RUN | 있음(debug): `firstTokenMs` |
| 512토큰 입력의 첫 토큰 | 8초 이하 | NOT_RUN | 있음(debug): 합성 입력 수동 투입 |
| 블록 명령 요청부터 승인 카드까지 | 10초 이하 | NOT_RUN | 부분(debug): 추론+계획 시간, 탭 2회 제외 |
| 15분 지속 생성 | 평균 10 tok/s 이상, 마지막 5분이 처음 5분의 70% 이상 | NOT_RUN | 부분(debug): 호출별 tok/s만, 자동 구동기 없음 |
| 취소 후 생성 중단 | 500ms 이하 | NOT_RUN | 있음(debug): `cancel` |
| 로드·생성·해제 30회 반복 | OOM·앱 강제 종료 0, 해제 후 기준선 대비 +200MB 이하 | NOT_RUN | 부분: 메모리·PSS·종료 사유 수집, 반복은 수동 |
| 일반 앱 동시 사용 | 다른 앱 3개 상태에서 로드 성공 또는 명확한 안내, 문서 데이터 손실 0 | NOT_RUN | 부분: 앱 전환과 데이터 확인은 수동 |
| 15분 발열·전력 | `THERMAL_STATUS_SEVERE` 미만, 배터리 온도 43°C 이하, 배터리 소모 5% 이하 | NOT_RUN | 있음: 시작·종료 snapshot |
| 비행기 모드 전체 흐름 | 추론, 승인, 저장, 재시작 후 보존 성공 | NOT_RUN | 없음: 수동 확인 |
| S22 설정의 Q4 독립 300문항 | JSON 99% 이상, 블록 명령에서 주변 블록 변경 0 | NOT_RUN | 없음: 별도 평가 Task |

앱 명령 출력은 JSON이 아니라 한 줄 명령이므로, 이 경로에 "JSON 99%"를 어떻게 적용할지 300문항 실행 전에 정해야 한다.

## 6. S22 연결 후 실행할 명령 (모두 미실행)

명령과 인자는 `frontend/Frontend_UI/scripts/s22-collect.cjs`와 설치된 Expo CLI의 `run:android` 옵션에 대조했다. 실제 기기에서 실행한 적은 없고, 파서는 합성 출력으로만 검증했다.

### 실행 전 정할 항목

1. **`android.package`:** `frontend/Frontend_UI/app.json`에 값이 없다. 네이티브 빌드 전에 정해야 한다.
2. **release 측정 방식:** 목표는 release 측정이지만 앱 내부 측정 도구는 release에서 꺼진다. debug 값은 그대로 PASS 근거로 쓸 수 없다.
3. **15분·30회 구동 방식:** 자동 구동기가 없다. 수동으로 할지 구동기를 만들지 정해야 한다.
4. **adb:** 현재 PC의 PATH에 `adb`가 없다.

`expo run:android`는 `frontend/Frontend_UI/android`를 생성한다. 이 폴더는 `.gitignore` 대상이다.

### 순서

```powershell
# 0. 준비 (저장소 루트 기준)
cd "frontend/Frontend_UI"
$pkg = "<android.package 값>"
$out = "$env:TEMP\s22-results"
adb devices

# 1. debug 빌드와 설치
npx expo run:android --variant debug --device

# 2. 첫 확인: GBNF 실제 로드
#    앱에서 로컬 모델을 준비한 뒤 앱 작업 요청 > 자연어 요청 해석에
#    합성 요청 "학급 회의 문서 만들어줘"를 입력한다. 이 요청은 규칙 라우터를 지나 모델로 간다.
node scripts/s22-collect.cjs pull $pkg $out
Get-ChildItem $out -Filter "s22-metrics-*.json" | Sort-Object LastWriteTime | Select-Object -Last 1 |
  Get-Content -Raw | ConvertFrom-Json | ForEach-Object { $_.events } |
  Where-Object { $_.name -eq "inference" -and $_.task -eq "command" } |
  Select-Object outcome, predicted, firstTokenMs
# outcome=ok, predicted>0 이어야 한다. error면 아래로 원인을 보고 측정을 중단한다.
adb logcat -d | Select-String -SimpleMatch "grammar"

# 3. debug 앱 내부 지표: 합성 데이터로 문서 열기, 블록 편집, 모델 로드, 명령, 취소 수행 후 회수
node scripts/s22-collect.cjs pull $pkg $out

# 4. release 빌드와 시스템 지표 (비행기 모드, 충전 해제, 배터리 50% 이상)
npx expo run:android --variant release --device
node scripts/s22-collect.cjs cold-start $pkg $out 30
node scripts/s22-collect.cjs snapshot $pkg $out      # 시작 상태
node scripts/s22-collect.cjs reset-frames $pkg
# 추론 중 스크롤·입력 또는 15분 생성을 수행한다
node scripts/s22-collect.cjs snapshot $pkg $out      # 종료 상태

# 5. 결과 JSON 확인
Get-ChildItem $out -Filter "*.json" | Select-Object Name, Length
```

`pull`은 `run-as`를 쓰므로 debug 빌드에서만 동작한다. 결과 파일은 `cold-start-*.json`, `snapshot-*.json`, `s22-metrics-*.json`이다. 측정 시 SoC, One UI, 빌드 번호, 배터리 상태, 실내 온도를 함께 기록한다.

## 7. 남은 결함

### 가장 먼저 해결할 결함

1. **상대 날짜 오류 (c11, c31):** 프롬프트에 오늘 날짜가 없어 "내일" 요청에 모델이 임의 날짜를 만든다. 앱 검증기를 통과해 잘못된 날짜가 승인 카드에 오른다. c31은 세 모델 모두, c11은 Q4와 IQ4_XS에서 발생했고 GBNF로도 막히지 않는다.
2. **값 누락 실행 (c05, c07):** Q4가 c07에서 내용 없는 목록 블록을, c05에서 표 블록을 만들었다.

### 미검증 위험

3. GBNF를 실제 llama.cpp 파서로 로드하지 않았다. 파서 오류가 있으면 모델 경유 앱 명령이 실패한다. 저장은 일어나지 않고 규칙 경로와 문서 기능은 유지된다.
4. Kotlin·Swift 변경과 Android 매니페스트 병합을 빌드하지 않았다.
5. Q4 로드 조건(사용 가능 메모리 3.01GB + 700MiB)이 S22에서 자주 거부될 수 있다. ARM repack 대상은 헤더 계산으로 Q4 2,199,142,400바이트(73.3%)이며 실기기 RSS가 아니다.
6. iOS 메모리 한도 확장 권한 없이 Q4 로드 조건을 넘는지 확인되지 않았다.
7. GBNF 미적용 B단계의 안전 거부 상당수가 형식 오류여서, 앱 조건의 품질은 B단계 수치와 다를 수 있다.

### 기능 한계

8. 근거 비율 검사는 불용어 목록의 단어(값 안의 `일정`, `변경` 등)가 빠진 경우를 감지하지 못한다. 임계값 0.84는 실제 모델 출력 성능을 보여 주지 않는다.
9. 긴 입력 제한은 토큰 수가 필요해 모델 로드 후 판정하므로, 제한되는 요청도 로드 비용이 든다.
10. Android API 29 미만은 발열 상태가 없어 긴 입력이 항상 제한된다. iOS는 `lowMemory` 플래그가 없어 기존 로드 조건과 메모리 경고에 의존한다.
11. 요청마다 모델을 로드하고 해제하므로 고정 프롬프트 재사용 절감은 현재 0이다.
12. 모델이 할 일의 마감 시각을 비우면 앱이 복원하지 않는다. 다른 일의 시각이 잘못 들어가는 결함을 막기 위한 선택이다.
13. 모델이 요청을 반복한 "~이라는" 제목은 경계를 확정할 수 없어 저장하지 않고 형식을 안내한다.
14. "세 시"처럼 한글 수사로 쓴 시각은 원문 시각으로 인식하지 못해 경고가 뜰 수 있다. 값은 유지된다.
15. 기기 간 직접 전송은 자동 백업 규칙 대상이 아니어서 모델 파일이 포함될 수 있다.
16. 웹 미리보기 경로는 `num_predict: 1024`를 유지하며 이번 출력 상한 대상이 아니다.
17. 현재 replay에서 Q5 일정 제목은 장소 없이 "2026년 12월 2일 낭독회"로 저장된다. 시각 15:00은 보존된다.
18. 결정 11·12 회귀 테스트는 수정 전 실패를 별도로 확인하지 않았다.

## 8. NOT_RUN 전체

- Q4·Q5 독립 300문항 (`task_ee2044570116`), 문항 작성 포함.
- BF16 대비 3%p 비교, JSON 99% 판정.
- 5절의 S22 지표 15개 전체.
- iPhone 15 Pro 실기기 전체.
- `backend/cloud/test/internal.test.js`, `server.test.js`.
- Kotlin·Swift 네이티브 빌드, Android 매니페스트 병합, 실제 Android 백업·복원.
- GBNF의 llama.cpp 실제 로드, 앱 조건(`llama.rn`)의 Q4 개발 측정.
- `s22-collect.cjs`의 실제 adb 실행.
- Deno 게이트웨이 실행과 배포.
- 승인 카드 실제 화면 렌더링과 스크린 리더 동작.
- 결함 수정 후 13개 개발셋 재측정.
- raw 프롬프트와 `enable_thinking=false` 템플릿 렌더링의 바이트 일치 확인.
- C단계(QLoRA), D단계(지식 증류), E단계(구조 변경).

## 9. 사용자 결정 기록

| 항목 | 결정 |
|---|---|
| cloud 테스트 | 의존성을 설치하지 않고 NOT_RUN으로 유지 |
| 원문에 없는 시각 | 값을 바꾸지 않고 승인 카드에 경고. 정오·자정은 확인된 시각으로 처리 |
| 모델 백업 | Android 자동 백업에서 모델 폴더(`qwen35/`)만 제외 |
| iOS 메모리 권한 | 보류. iPhone 실기기에서 확인 |
| 평가 샘플링 | temperature 0.2, seed 42. 평가 전용이며 앱 런타임 seed는 미지정 |
| B단계 | 문법 없이 상대 비교 |
| 300문항 | 최종 후보가 정해질 때까지 보류 |

## 10. 재개 명령 (미실행)

```powershell
orca orchestration run-use --id run_005c12950703

# 최종 후보 확정 후에만 실행
orca orchestration worker-start --task task_ee2044570116 --retry-of ctx_1d351ca1e27e --agent claude --worktree current
```

독립 300문항은 **최종 후보 1개와 기준 Q4에만** 쓴다. 학습, 임계값 조정, 프롬프트 조정, 후보 선택에는 쓰지 않는다. 재개 지시서의 재시도 대상은 Q4·Q5이므로, 실행 시 측정 대상을 최종 후보와 Q4로 지정해야 한다. 모델이나 출력 설정이 바뀌면 이전 300문항 점수를 최종 결과로 쓰지 않는다.

## 11. 저장소 밖 산출물

- 위치: 작업본 상위의 `.artifact_work\model-candidates`.
- 내용: 후보 가중치(`weights`), 전용 모델 폴더(`ollama-store`), B단계 평가 결과(`eval`).
- 크기: 13,509,499,968바이트(약 13.5GB, 12.58GiB). 삭제하지 않았다.
- Ollama 등록 이름: `stella-b-q4km`, `stella-b-iq4xs`, `stella-b-q3km`.
- B단계 중 기본 Ollama 앱이 시작되어 실행 중일 수 있다. 대기 중인 0.40.17 업데이트가 있어 종료하지 않았다.

## 관련 문서

- [Qwen3.5-4B 모바일 앱 검증 기록](qwen35-mobile.md)
- [S22 쾌적 동작 목표](s22-performance-goal.md)
- [S22 모델 경량화·보정 계획](s22-model-optimization-plan.md)
- [모바일 텍스트 AI 평가](../../ai/eval/README.md)
- [S22 고정 설정](../../ai/eval/s22-frozen-config.json)
