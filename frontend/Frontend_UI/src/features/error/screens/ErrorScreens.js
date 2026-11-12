// ============================================================
// ErrorScreens.js — 오류 안내
// ============================================================

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
