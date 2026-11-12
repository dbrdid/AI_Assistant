// ============================================================
// AccountScreen.js — 계정 / 프로필 수정
// ============================================================

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { changePassword, getSettings, updateSettings } from '../../../data/settings/SettingsStore';
import { Row, SaveButton, SectionTitle, same, useNotice } from '../../../shared/components/SettingsUi';

export default function AccountScreen({ navigation }) {
  const saved = getSettings();
  const [name, setName] = useState(saved.profile.name);
  const [aff, setAff] = useState(saved.profile.affiliation);
  const [error, setError] = useState('');
  const notice = useNotice();
  const dirty = !same({ name: name.trim(), affiliation: aff.trim() }, { name: saved.profile.name, affiliation: saved.profile.affiliation });

  const save = () => {
    if (!name.trim()) return setError('이름을 입력해 주세요.');
    setError('');
    updateSettings('profile', { name: name.trim(), affiliation: aff.trim() });
    notice.show('저장했어요');
    setTimeout(() => navigation.goBack(), 600);
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="계정" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{name.trim() ? name.trim().charAt(0) : '?'}</Text>
        </View>
        <Text style={styles.email}>{saved.profile.email || '로그인 전 (이메일은 가입 후 표시돼요)'}</Text>

        <SectionTitle>프로필 수정</SectionTitle>
        <View style={styles.field}>
          <Text style={styles.label}>이름</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="이름" placeholderTextColor={colors.muted} maxLength={20} accessibilityLabel="이름" />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>소속</Text>
          <TextInput style={styles.input} value={aff} onChangeText={setAff} placeholder="예) 대학생, 회사명" placeholderTextColor={colors.muted} maxLength={30} accessibilityLabel="소속" />
        </View>
        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

        <Row
          label="비밀번호 변경"
          onPress={async () => {
            const r = await changePassword();
            if (!r.ok) notice.show('로그인 기능이 연결되면 사용할 수 있어요');
          }}
        />

        <SectionTitle>연동된 계정</SectionTitle>
        <Row label="네이버" value={saved.linked.naver ? '연동됨' : '연동 안 됨'} />
        <Row label="카카오" value={saved.linked.kakao ? '연동됨' : '연동 안 됨'} />

        <SaveButton onPress={save} disabled={!dirty} />
      </ScrollView>
      {notice.view}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  avatar: { alignSelf: 'center', width: 72, height: 72, borderRadius: 36, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 30, fontWeight: '800', color: colors.white },
  email: { textAlign: 'center', fontSize: font.body, color: colors.muted, marginBottom: spacing.sm },
  field: { gap: spacing.xs },
  label: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  input: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: spacing.lg, fontSize: font.bodyLg, color: colors.ink },
  error: { fontSize: font.body, fontWeight: '700', color: colors.coral },
});
