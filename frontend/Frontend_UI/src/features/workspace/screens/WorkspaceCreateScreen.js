// ============================================================
// WorkspaceCreateScreen.js — 새 워크스페이스 만들기 (스토리보드 39장 3번)
// ============================================================
// 조직 이름(필수) · 설명(선택)을 입력해 만들면, 만든 사용자가 "관리자"가 되고 그 공간으로 바로 전환됩니다.

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { createWorkspace, getWorkspaces, switchWorkspace } from '../../../data/workspaces/WorkspaceStore';

export default function WorkspaceCreateScreen({ navigation }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = name.trim();
    if (!n) return setError('조직 이름을 입력해 주세요.');
    if (getWorkspaces().some((w) => w.name === n)) return setError('같은 이름의 공간이 이미 있어요.');
    setError('');
    setBusy(true);
    const id = createWorkspace({ name: n, desc });
    await switchWorkspace(id);
    setBusy(false);
    navigation.goBack();
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="새 워크스페이스" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.field}>
          <Text style={styles.label}>조직 이름 *</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="예) 팀 프로젝트 회의" placeholderTextColor={colors.muted} maxLength={30} autoFocus accessibilityLabel="조직 이름" />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>설명</Text>
          <TextInput style={[styles.input, { minHeight: 96, textAlignVertical: 'top' }]} value={desc} onChangeText={setDesc} placeholder="어떤 조직인지 간단히 적어 주세요" placeholderTextColor={colors.muted} multiline maxLength={120} accessibilityLabel="설명" />
        </View>
        <Text style={styles.note}>만든 사람이 관리자가 돼요. 팀원 초대는 서버가 연결된 뒤에 사용할 수 있어요.</Text>
        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
        <Pressable accessibilityRole="button" disabled={busy} onPress={submit} style={[styles.save, busy && { opacity: 0.5 }]}>
          <Text style={styles.saveText}>{busy ? '만드는 중…' : '만들기'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  field: { gap: spacing.sm },
  label: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  input: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: spacing.lg, fontSize: font.bodyLg, color: colors.ink },
  note: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  error: { fontSize: font.body, fontWeight: '700', color: colors.coral },
  save: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
});
