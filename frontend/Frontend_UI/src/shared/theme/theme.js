// ============================================================
// theme.js — 앱 전체에서 쓰는 "디자인 값"을 모아 둔 파일
// ============================================================
// 색상, 간격, 글자 크기 같은 값을 여기에 한 번만 적어 두고
// 다른 파일에서는 `colors.mint` 처럼 가져다 씁니다.
// 나중에 디자인을 바꾸고 싶으면 이 파일의 숫자/색만 고치면 앱 전체가 바뀝니다.

// 앱의 색 기준은 이 palette 하나 (홈 개요의 Stella 화면과 예전 화면이 같은 값을 씀).
// 새 코드는 palette의 이름(background, surface, raised, text, muted, subtle, line, accent, danger)을 쓴다.
export const palette = {
  background: '#191a1b',
  surface: '#222325',
  raised: '#2b2c2e',
  text: '#f0f0ee',
  muted: '#aaa',
  subtle: '#969a9c',
  line: '#2d3032',
  accent: '#d9d9d6', // 강조색은 무채색으로 통일 (녹색 사용 안 함)
  danger: '#f0abab',
};

// 예전 화면이 쓰던 이름. 값은 모두 palette에서 온다 (mint, coral 같은 이름은 과거 시안의 흔적일 뿐 색은 무채색).
export const colors = {
  mint: palette.accent,
  mintDark: palette.text,
  mintSoft: palette.raised,
  ink: palette.text,
  muted: palette.muted,
  subtle: palette.subtle,
  cream: palette.background,
  line: palette.line,
  hairline: '#2a2c2e', // 카드 테두리처럼 거의 보이지 않아야 하는 선
  coral: palette.danger,
  coralSoft: '#38282a',
  card: palette.surface,
  raised: palette.raised,
  kakao: '#FEE500', // 카카오 로그인 버튼 노랑 (브랜드 규정 색)
  white: '#FFFFFF',
  black: '#000000',
  action: '#36383b',
  actionBorder: '#55585c',
  onPrimary: palette.text,
};

// 간격(여백) 크기. 숫자의 단위는 px 과 비슷한 "논리 픽셀"입니다.
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

// 모서리 둥글기. 클수록 더 동그랗습니다.
// Stella(features/stella/theme.js)와 같은 절제된 모서리: 버튼·입력 4~6, 카드 6, 알약 버튼·칩은 완전한 둥근 끝.
export const radius = { sm: 4, md: 6, lg: 6, card: 6, pill: 999 };

// 글자 크기
export const font = { caption: 12, body: 15, bodyLg: 16, header: 17, title: 22, headline: 28 };

// 카드 그림자 (Figma 시안의 아주 옅은 그림자). 웹/iOS 는 shadow*, 안드로이드는 elevation
export const shadow = {
  card: { shadowColor: '#f0f0ee', shadowOpacity: 0, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 0 },
  float: { shadowColor: '#f0f0ee', shadowOpacity: 0, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 0 },
};

// 부모 전체를 덮는 위치/크기. (StyleSheet.absoluteFill 대신 직접 정의: 최신 React Native 에서 값이 없어지는 경우를 막음)
export const FILL = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 };
