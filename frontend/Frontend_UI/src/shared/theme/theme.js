// ============================================================
// theme.js — 앱 전체에서 쓰는 "디자인 값"을 모아 둔 파일
// ============================================================
// 색상, 간격, 글자 크기 같은 값을 여기에 한 번만 적어 두고
// 다른 파일에서는 `colors.mint` 처럼 가져다 씁니다.
// 나중에 디자인을 바꾸고 싶으면 이 파일의 숫자/색만 고치면 앱 전체가 바뀝니다.

// 색상표 (스토리보드의 Mint · Ink · Cream · Coral 디자인 시스템)
export const colors = {
  mint: '#5DC9B2',      // 밝은 민트 (강조선 등)
  mintDark: '#2A6858',  // 진한 녹색 (주요 버튼, 선택된 날짜)
  mintSoft: '#DCEBE6',  // 아주 연한 민트 (메뉴에서 선택된 항목 배경)
  ink: '#263935',       // 글자 기본색 (거의 검정에 가까운 짙은 녹색)
  muted: '#70827D',     // 흐린 글자색 (보조 설명)
  cream: '#FFFDF8',     // 화면 배경색 (따뜻한 흰색)
  line: '#D2E2DC',      // 얇은 구분선 색
  coral: '#F47D7F',     // 포인트 색 (일요일 글자 등)
  white: '#FFFFFF',     // 흰색
  black: '#000000'      // 검정색
};

// 간격(여백) 크기. 숫자의 단위는 px 과 비슷한 "논리 픽셀"입니다.
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

// 모서리 둥글기. 클수록 더 동그랗습니다.
export const radius = { sm: 8, md: 14, lg: 20 };

// 글자 크기
export const font = { caption: 12, body: 14, bodyLg: 16, title: 20, headline: 26 };

// 부모 전체를 덮는 위치/크기. (StyleSheet.absoluteFill 대신 직접 정의: 최신 React Native 에서 값이 없어지는 경우를 막음)
export const FILL = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 };
