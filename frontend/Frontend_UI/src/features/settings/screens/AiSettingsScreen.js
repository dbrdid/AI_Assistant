// ============================================================
// AiSettingsScreen.js — AI 및 브리핑 설정 (내용은 AiSettingsForm, AI 채팅의 오른쪽 창과 같음)
// ============================================================

import React from 'react';
import { StyleSheet, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import AiSettingsForm from '../components/AiSettingsForm';

export default function AiSettingsScreen({ navigation }) {
  return (
    <View style={styles.root}>
      <ScreenHeader title="AI 및 브리핑" onBack={navigation.goBack} />
      <AiSettingsForm onOpenUsage={() => navigation.navigate(ROUTES.AiUsage)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
});
