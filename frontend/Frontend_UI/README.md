# Stella 문서 MVP 실행

Windows에서 이 폴더의 `package-lock.json`을 기준으로 설치한 뒤 실행합니다.

```powershell
npm ci
npm run preview:local
```

브라우저에서 http://127.0.0.1:8098/ 를 엽니다. 같은 브라우저와 주소로 다시 열면 로컬 SQLite에 저장한 문서를 이어서 편집할 수 있습니다. 홈의 작성 버튼으로 문서를 만들고, 블록 경계에서 삽입 메뉴를 엽니다. 왼쪽 메뉴에서 하위 문서를 관리하고 상단 메뉴에서 버전을 저장하거나 복원합니다. 로컬 모델을 쓸 때만 PC에서 Ollama를 실행하면 됩니다.

# 오늘의 플래너 (Expo SDK 58)

## 처음 한 번만 (VS Code 터미널에서)
Node.js 22.13 이상(또는 24.3 이상)이 필요해요. `node -v` 로 확인하세요.

```
npm run setup
```

## 실행
```bash
npm start          # QR 코드가 나와요 → 폰의 Expo Go 앱으로 스캔
npm run web        # 브라우저에서 실행
```
폰의 Expo Go 앱이 SDK 58 을 지원하는 최신 버전이어야 해요.

## 공유 문서 검증

검증할 Supabase 환경의 URL과 공개 키를 `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_KEY`로 설정합니다. 앱 번들에는 공개 키만 사용합니다.

서버의 적용 이력을 확인한 뒤, `backend/supabase/migrations/`의 새 협업 마이그레이션을 다음 순서로 적용합니다.

1. `20261119090000_note_hierarchy.sql`
2. `20261119100000_project_table_properties.sql`
3. `20261119110000_validate_project_table_properties.sql`

서버에 적용한 뒤 `EXPO_PUBLIC_SHARED_PAGE_HIERARCHY=true`로 다시 빌드하면 공유 페이지 계층을 사용할 수 있습니다. 개인 페이지 계층은 기본 제공됩니다.

서로 다른 테스트 계정 두 개를 `tests/sync-verify/.env`에 설정하고 저장소 루트에서 `npm --prefix tests/sync-verify run verify:collaboration`을 실행합니다. 스키마 확인에 실패하면 테스트 공간을 만들기 전에 중단합니다. [협업 검증 범위와 계정 설정](../../tests/sync-verify/README.md)

## 폴더 구조 (`src/`)
- `navigation/` : 화면 이동·사이드 메뉴
- `shared/` : 공통 부품 (theme, ScreenHeader, ConfirmDialog, DateTimePicker, SettingsUi, hooks)
- `features/<기능>/screens · components · utils` : 홈, 캘린더, 일정, 메모, 프로젝트, 파일, 로그인, 설정, AI 제안, 녹음, 카메라, 알림 …
- `data/<영역>/…Store.js` : 저장소
- `services/ai · notify · auth · device` : 서버 연결 지점은 `services/` 쪽

## 알아둘 점
- 일반 앱은 연결된 Supabase 환경의 계정으로 로그인한 뒤 기기 저장소를 엽니다.
- 로그인 없이 샘플 데이터를 여는 Windows 중간 점검본은 별도 배포 패키지입니다.

Expo Go 사용 또는 안드로이드 에뮬레이터 다운 후 실행


## Orca UI 기준 통합 (2026-11-20)

승인된 노션 참고 UI는 `src/features/stella/`와 `src/navigation/TabBar.js`에 통합했습니다. 홈, 문서 목록, 즐겨찾기, 관계도, 검토와 기본 문서 편집은 Stella 화면을 사용합니다. 블록 삽입, 변환, 이동, 삭제, 표 검토 적용과 버전 복구를 기본 편집기에서 제공합니다. 기존 Markdown 편집과 목록은 명시적인 고급 도구로 접근합니다. 작업 지침은 저장소 루트 `AGENTS.md`를 따릅니다. 관계도 위치와 수동 연결은 기기 설정이며 공유 동기화 대상은 아닙니다.
