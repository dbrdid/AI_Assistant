// SocialLogos.js — 소셜 로그인 버튼 왼쪽에 붙는 로고 (각 회사의 로그인 버튼 가이드 모양)
import Svg, { Path } from 'react-native-svg';

// Google "G" (4색)
export function GoogleLogo({ size = 18 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </Svg>
  );
}

// 카카오 말풍선 심볼 (검정)
export function KakaoLogo({ size = 18 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path fill="#000000" d="M12 3C6.48 3 2 6.53 2 10.88c0 2.82 1.88 5.29 4.7 6.68l-.96 3.5c-.08.31.27.55.54.37l4.17-2.77c.5.05 1.02.08 1.55.08 5.52 0 10-3.53 10-7.86S17.52 3 12 3z" />
    </Svg>
  );
}
