// ============================================================
// ErrorScreens.js — 오류 안내 "전체 화면" 3종 (스토리보드 106 · 107 · 108장)
// ============================================================
// 화면 이동으로 열리는 버전이에요. (작성 중인 화면 위에는 ErrorModal 을 쓰세요 — 내용이 사라지지 않아요)
//   NetworkErrorScreen  : 다시 시도 → 연결되면 이전 화면 / 오프라인 모드로 이용 → 이전 화면
//   ServerErrorScreen   : 메인 화면으로 이동
//   AnalysisFailedScreen: 다시 분석하기 → 이전 화면 / 수동으로 등록 → 일정·할 일 추가 화면

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { colors, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { AnalysisFailedView, NetworkErrorView, ServerErrorView } from '../components/ErrorViews';

function Frame({ children }) {
  const insets = useSafeAreaInsets();
  return <View style={[styles.root, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl }]}>{children}</View>;
}

export function NetworkErrorScreen({ navigation }) {
  return <Frame><NetworkErrorView onRetry={navigation.goBack} onOffline={navigation.goBack} /></Frame>;
}
export function ServerErrorScreen({ navigation }) {
  return <Frame><ServerErrorView onHome={() => navigation.navigate(ROUTES.Home)} /></Frame>;
}
export function AnalysisFailedScreen({ navigation }) {
  return <Frame><AnalysisFailedView onRetry={navigation.goBack} onManual={() => navigation.navigate(ROUTES.TaskEdit)} /></Frame>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
});
