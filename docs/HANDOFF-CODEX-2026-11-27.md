# Codex 인수인계 (2026-11-27)

Claude Code가 이어받아 진행한 작업을 Codex에 넘긴다. 변경 내용 전체는 [UPDATES-2026-11-27.md](UPDATES-2026-11-27.md)에 있다.

## 1. 지금 상태

| 항목 | 값 |
|---|---|
| 작업 위치 | `현재 앱/stella-ui-ai-integration/.claude/worktrees/block-renderer-registry` (git worktree) |
| 브랜치 | `worktree-block-renderer-registry` |
| 로컬 HEAD | 아래 "0.0.8 이후 커밋"의 마지막. 아직 `main`에 올리지 않았다 |
| `main` | `bedb3dc` = 0.0.8 릴리스. GitHub `dbrdid/AI_Assistant` |
| 릴리스 | v0.0.8 (versionCode 10) 사전 출시. 휴대폰(S22)에는 그 뒤 커밋까지 담은 개발 빌드가 같은 버전 번호로 덮어 설치됨 |
| 작업 트리 | 깨끗함 (커밋 안 한 변경 없음) |
| 검사 | 테스트 281개 통과, 타입 오류 0개 (`b6b9833` 기준) |

`7bce790`에 Codex가 하던 작업(54개 파일)을 Claude가 검토·마무리해 함께 커밋했다. 담긴 것:
- 원래 블록 자리에서 보여 주는 AI 블록 제안
- 프로젝트 끌어서 여러 개 선택
- 그 자리 삭제 확인
- 안쪽 화면이 탭 넘기기 제스처를 양보받기
- 로그아웃 방식 변경
- "·" 제거

### 0.0.8 이후 커밋 (모두 휴대폰에서 확인)

| 커밋 | 내용 |
|---|---|
| `2257d1d` | 일정, 할 일, 프로젝트 만들기·편집 화면을 앱 속성 줄 모양으로 |
| `eb0b5af` | 이 인수인계서 |
| `67dff3a`, `73a6f45` | 할 일 줄 왼쪽 밀기(내일로): 가만히 있을 때 뒤 패널이 비치지 않게, 붉은색 대신 회색, 끝까지 밀 때 흰색으로 날아가지 않게(색 보간 clamp) |
| `7a7056c` | 프로젝트 상세: 카드 상자 없는 평평한 구역, 흐린 12pt 구역 이름, 글자 버튼 |
| `e804458` | 캘린더: 일정 패널을 올리면 그 아래로 달력이 비치던 문제(패널 아래 같은 바탕 덮개), 일정 줄 카드 상자 제거 |
| `62257f6` | 블록 편집기(안드로이드): 엔터는 submit으로 커서 위치에서 바로 나눔(줄이 커졌다 줄던 깜빡임 제거), 엔터 한 번이 submit과 줄바꿈 두 경로로 와서 두 번 나뉘던 버그를 0.5초 가드로 막음, ↵ 키 유지(`returnKeyType: none`), 손잡이는 키보드가 내려간 뒤 시트를 엶 |
| `b6b9833` | 공용 하단 시트(`SheetModal`): 흐려지지 않고 자기 높이만큼 미끄러져 열리고 닫힘. 블록 메뉴는 닫히는 동안 마지막 내용을 유지해 툭 떨어지지 않음 |

## 2. 사용자 규칙 (지켜야 할 것)

- **답변:** 한국어로 짧게 쓴다. 핵심과 검증 결과만 쓴다.
- **디자인 기준:** 홈 > 개요(Notion 모바일 해석). UI를 바꾸기 전에 Notion 실제 화면을 확인한다(AGENTS.md).
- **글자:**
  - 앱에 보이는 글자에 "·"를 쓰지 않는다. 쉼표를 쓴다. 서버 오류 문구는 `StellaError`가 표시 직전에 바꾼다.
  - 설명·안내 문구와 요청 예시는 꼭 필요한 것만 둔다. 외부 전송 고지와 오류 해결 안내는 남긴다.
- **선택 표시:** 하위 탭 줄 아래의 선택 항목은 문서 목록의 "모든 문서 / 즐겨찾기"와 같게 한다. 글자 12, 높이 44, 간격 20, 고른 것은 굵게만. 밑줄·배경은 쓰지 않는다.
- **공간 선택:** 모든 공간, 개인, 팀을 목록 하나에서 고른다(`shared/components/SpaceFilter.js`).
- **버튼 배경:** 버튼 배경을 일괄로 없애는 시도는 사용자가 되돌렸다(`5a14a33`, `3a3beec`). 화면별로 앱 스타일을 맞출 때만 바꾼다.
- **앱 스타일 기준:**
  - 머리줄은 아래 구분선이 없다.
  - 메뉴와 속성은 아이콘이 있는 평평한 행(13~14pt)이다.
  - 확인 창은 글자 버튼만 쓰고, 위험한 동작은 붉은 글자로 표시한다.
  - 구역 이름은 흐린 12pt다.
- **AI 블록 제안:**
  - 흰 테두리만 쓴다.
  - "AI 제안 N개" 막대는 두지 않는다.
  - 원래 블록 자리에서 수용·거절한다. 삭제 제안은 삭제·유지다.
  - 수용하기 전에는 저장하지 않는다.
- **탭 고르기:** 길게 누름이 확정되면 밀기 전에도 지금 탭에 테두리를 켠다. Codex의 `SwipeNav` 재작성 때 빠져서 다시 넣었다.
- **보안·비밀:**
  - service_role 키, DB 비밀번호, OpenAI 키, 액세스 토큰을 앱·저장소·대화에 넣지 않는다. DB 비밀번호는 사용자가 `!` 명령으로 직접 입력한다.
  - 팀원 운영 Supabase(`zcblwwcukkbcwmgugknl`)를 바꾸기 전에는 반드시 사용자에게 묻는다. 시험은 테스트 서버(`dklcbitfexkolspauauc`)에서 먼저 한다.
- **커밋·배포:**
  - `main` push와 릴리스는 사용자가 요청할 때만 한다.
  - 버전은 0.0.x를 올리고 versionCode를 1씩 올린다.
  - 업데이트는 기존 앱 위에 덮어 설치한다. 지우고 다시 설치하지 않는다.
- **공용 라이브러리:** `src/lib/stella`는 팀원 공용 라이브러리다. 필요한 최소 변경만 한다.

## 3. 남은 일

1. **보안 마이그레이션 운영 적용(승인 대기):** `20261126170000_item_groups_remove_check.sql`. '편집' 권한만으로 공개 범위 제한을 풀 수 있는 문제를 막는다. 테스트 서버에는 적용했고 sync-verify 11-4가 통과했다.
2. **0.0.8 이후 커밋 반영:** `main`에 올리는 것과 다음 릴리스(0.0.9, versionCode 11)는 요청이 있을 때 한다.
3. **휴대폰 정리:** 확인용 백업 "2026-11-27 16:26"을 지워야 한다. 삭제 확인이 자동 안전 검사에 막혀 사용자가 지우기로 했다.
4. **UI 후보 (사용자가 지적했거나 검토에서 나온 것):**
   - 프로젝트 탭에 제목 줄이 없다.
   - 목록에는 "Test", 편집기에는 "제목 없는 문서"로 보여 이름이 다르다.
   - 빠른 입력의 "저장" 위치가 어색하다.
   - 아직 옛 모양이 남은 화면이 있다: 휴지통 카드, 설정 화면의 칩, 시간 고르기 칸, AI 채팅 옵션 카드.
5. **보류:** 브리지 계정 로그인(운영 마이그레이션 미적용), 키의 기기별 암호화(X25519), QR 키 입력, 캘린더 고도화(#9).
6. **검토에서 남긴 것:** 화면 낭독기 사용자의 블록 손잡이 접근. 지금은 선택한 블록에만 손잡이가 있다.
7. **캘린더 단계 구조(사용자가 제안, 아직 안 함):** 위로 끌면 주간 달력으로 줄고 목록이 커짐, 끝까지 끌면 목록 전체 화면, 아래로 끌면 일정 제목이 보이는 큰 달력. 지금은 "주간" 단계가 없다(`CalendarSheet.js`의 `lift`, `detailed`). 달력과 패널 높이를 함께 움직이게 다시 짜야 해서 사용자에게 진행 여부를 물어 둔 상태.
8. **확인 못 한 것:**
   - 한글 입력 중(조합 중) 엔터. 휴대폰 키보드가 영어 상태라 시험하지 못했다.
   - 블록 메뉴 외 다른 하단 시트의 새 열림·닫힘 움직임, 시트를 아래로 끌어 닫기.

## 4. 명령

```bash
# 저장소 루트(worktree)에서
node --test backend/local/tests/*.test.mjs tests/integration/*.test.mjs   # 281개
cd frontend/Frontend_UI && npx tsc --noEmit -p tsconfig.json             # 오류 0
npx expo export --platform web --platform android                       # 번들 확인

# 휴대폰 빌드·설치 (경로가 짧아야 해서 C:\sb 복사본에서 빌드)
W="<worktree>/frontend/Frontend_UI"
(cd "$W" && tar -cf - src) | (cd /c/sb/frontend/Frontend_UI && tar -xf -)
cd /c/sb/frontend/Frontend_UI/android && export ANDROID_HOME='C:\sapk\.android-sdk'
./gradlew.bat :app:createBundleReleaseJsAndAssets --rerun -PreactNativeArchitectures=arm64-v8a
./gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a
adb install -r app/build/outputs/apk/release/app-release.apk
# 버전 올릴 때: app.json, package.json(worktree)과 /c/sb/.../android/app/build.gradle의 versionCode·versionName을 함께

# 테스트 서버 동기화 검사 (tests/sync-verify/.env는 git에 없음)
cd tests/sync-verify && npm run verify   # 기준: 114 통과, 15 실패(모두 AI 키 필요 항목)
```

`adb` 경로: `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Google.PlatformTools_*\platform-tools\adb.exe`

## 5. 주의할 점

- **해시 고정:** `src/features/stella/appCommands.mjs`는 S22 평가 테스트가 파일 해시를 고정한다. 고치면 테스트가 깨진다.
  - 새 명령은 `itemCommands.mjs`나 `projectCommands.mjs`에 넣는다.
  - 화면 문구는 `InlineCommand.js`의 `useCommandPlanner`에서 바꾼다.
- **AI 앱 작업:**
  - 모델 명령은 원래 요청에 있는 값만 쓸 수 있다(`stated`). 요청한 동작과도 맞아야 한다(`intends`).
  - 문서 블록 작업은 초안 런타임(`draftRuntime`)으로 결과만 받은 뒤 `proposeBlocks`로 문서 안 제안을 만든다.
  - 앱의 store와 documents 객체는 freeze돼 있어 덮어쓸 수 없다. 복사본(`{ ...rt.store }`)으로 바꾼다.
- **편집기 갱신:** 블록 AI 시트에서 바꾼 뒤에는 편집기를 다시 읽어야 한다(`sheet.onApplied` → `reloadFromStore('')`).
- **빌드 결과 확인:** 빌드 번들은 Hermes라 한글이 UTF-16으로 들어 있다. 문구를 확인할 때 UTF-8 grep으로는 찾을 수 없다.
- **휴대폰 자동 조작:**
  - 화면 좌표는 탭 펼침 상태에 따라 바뀐다. 고정 좌표 스크립트로 연속 조작하면 앱 밖(갤러리, 전화, 알림창)이 열린 적이 있다.
  - 한 단계마다 스크린샷을 찍고 확인한다. 뒤로 가기 키를 누를 때 특히 조심한다.
  - 개인 정보가 찍힌 스크린샷은 바로 지운다.
- **git 경로:** git 명령은 실행 위치에 따라 경로가 달라진다. `frontend/Frontend_UI` 안에서 저장소 루트 기준 경로로 add하면 실패하거나 빠진다. 커밋 뒤에는 `git status`로 남은 변경이 없는지 확인한다. 이 실수로 리뷰 수정 일부가 한 번 빠졌다(`cd1f13e`로 복구).
- **휴대폰 애니메이션 확인:** 스크린샷은 0.5초쯤 걸려 짧은 움직임을 못 잡는다. `adb shell screenrecord`로 찍고 Python `cv2`로 바뀐 프레임만 뽑아 나란히 붙여 본다(ffmpeg는 없음). 화면 좌표는 축소 프레임에서 추정하지 말고 스크린샷 좌표 × 1.17로 구한다.
- **블록 수 세기:** `uiautomator dump` 결과에서 `블록 N 내용` 라벨을 센다(git bash에서는 `MSYS_NO_PATHCONV=1` 필요). 확인용으로 만든 블록은 손잡이 → 블록 삭제로 지워 원래대로 돌려놓는다.
- **줄바꿈:** 파일은 대부분 LF다. CRLF 경고는 무시해도 된다.
