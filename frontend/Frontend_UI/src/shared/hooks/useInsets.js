// ============================================================
// useInsets.js — 상태바·노치·하단 바에 가려지는 영역 크기 (useSafeAreaInsets 보강판)
// ============================================================
// 화면 밀림 방지용

import { Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function useInsets() {
  const insets = useSafeAreaInsets();
  const bar = Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0;
  return bar > insets.top ? { ...insets, top: bar } : insets;
}
