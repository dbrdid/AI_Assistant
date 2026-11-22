// ============================================================
// theme.js — 앱 전체에서 쓰는 "디자인 값"을 모아 둔 파일
// ============================================================
// 색상, 간격, 글자 크기 같은 값을 여기에 한 번만 적어 두고
// 다른 파일에서는 `colors.mint` 처럼 가져다 씁니다.
// 나중에 디자인을 바꾸고 싶으면 이 파일의 숫자/색만 고치면 앱 전체가 바뀝니다.

// 색상표 (스토리보드의 Mint · Ink · Cream · Coral 디자인 시스템)
export const colors = {
  mint: '#b8cbb3',      // 밝은 민트 (강조선 등)
  mintDark: '#f0f0ee',  // 진한 녹색 (주요 버튼, 선택된 날짜)
  mintSoft: '#2b2c2e',  // 아주 연한 민트 (메뉴에서 선택된 항목 배경)
  ink: '#f0f0ee',       // 글자 기본색 (거의 검정에 가까운 짙은 녹색)
  muted: '#aaa',     // 흐린 글자색 (보조 설명)
  cream: '#191a1b',     // 화면 배경색 (따뜻한 흰색)
  line: '#2d3032',      // 얇은 구분선 색
  coral: '#f0abab',     // 포인트 색 (일요일 글자 등)
  coralSoft: '#38282a', // 아주 연한 코랄 (회원탈퇴 아이콘 배경 등)
  card: '#222325',      // 카드 배경 (Figma 시안: 흰 카드 + 얇은 테두리)
  kakao: '#FEE500',     // 카카오 로그인 버튼 노랑
  white: '#FFFFFF',
  action: '#36383b',
  actionBorder: '#55585c',
  onPrimary: '#f0f0ee',
  raised: '#2b2c2e',     // 흰색
  black: '#000000'      // 검정색
};

// 간격(여백) 크기. 숫자의 단위는 px 과 비슷한 "논리 픽셀"입니다.
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

// 모서리 둥글기. 클수록 더 동그랗습니다.
export const radius = { sm: 4, md: 6, lg: 8, card: 6, pill: 4 };

// 글자 크기
export const font = { caption: 12, body: 15, bodyLg: 16, header: 17, title: 22, headline: 28 };

// 카드 그림자 (Figma 시안의 아주 옅은 그림자). 웹/iOS 는 shadow*, 안드로이드는 elevation
export const shadow = {
  card: { shadowColor: '#f0f0ee', shadowOpacity: 0, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 0 },
  float: { shadowColor: '#f0f0ee', shadowOpacity: 0, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 0 },
};

// 부모 전체를 덮는 위치/크기. (StyleSheet.absoluteFill 대신 직접 정의: 최신 React Native 에서 값이 없어지는 경우를 막음)
export const FILL = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 };
