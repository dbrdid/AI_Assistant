// ============================================================
// useInsets.js — 상태바·노치·하단 바에 가려지는 영역 크기 (useSafeAreaInsets 보강판)
// ============================================================
// 안드로이드 최신 버전은 앱 화면이 상태바(시계·배터리 줄) "뒤까지" 그려져요.
// 이때 기기가 위쪽 가려지는 영역을 0 으로 알려 주면 제목 줄이 상태바에 겹쳐 전체가 위로 올라가 보여요.
// 그래서 안드로이드에서는 상태바 높이(StatusBar.currentHeight)보다 작게 나오지 않도록 맞춰요.
import { Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function useInsets() {
  const insets = useSafeAreaInsets();
  const bar = Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0;
  return bar > insets.top ? { ...insets, top: bar } : insets;
}
