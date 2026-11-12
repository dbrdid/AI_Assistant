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

## 폴더 구조 (`src/`)
- `navigation/` : 화면 이동·사이드 메뉴
- `shared/` : 공통 부품 (theme, ScreenHeader, ConfirmDialog, DateTimePicker, SettingsUi, hooks)
- `features/<기능>/screens · components · utils` : 홈, 캘린더, 일정, 메모, 프로젝트, 파일, 로그인, 설정, AI 제안, 녹음, 카메라, 알림 …
- `data/<영역>/…Store.js` : 저장소
- `services/ai · notify · auth · device` : 서버 연결 지점은 `services/` 쪽

## 알아둘 점
- 임시 로그인: 이메일 `1234` / 비밀번호 `1234` (`src/services/auth/AuthApi.js`, 서버 연결 시 교체)
- 더미 데이터: 메모, 프로젝트, 일정 등 더미 데이터가 들어가 있으니 서버 연결 시 삭제

Expo Go 사용 또는 안드로이드 에뮬레이터 다운 후 실행
