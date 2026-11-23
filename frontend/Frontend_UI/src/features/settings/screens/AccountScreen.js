// ============================================================
// AccountScreen.js — 계정 / 프로필 수정
// ============================================================

import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { changePassword, getSettings, saveProfile } from '../../../data/settings/SettingsStore';
import { Row, SaveButton, SectionTitle, same, useNotice } from '../../../shared/components/SettingsUi';
import { checkPasswordRule, PASSWORD_RULE_MESSAGE } from '../../../lib/stella/login-rules';

export default function AccountScreen({ navigation }) {
  const saved = getSettings();
  const [name, setName] = useState(saved.profile.name);
  const [aff, setAff] = useState(saved.profile.affiliation);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordDialog, setPasswordDialog] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const notice = useNotice();
  const dirty = !same({ name: name.trim(), affiliation: aff.trim() }, { name: saved.profile.name, affiliation: saved.profile.affiliation });

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return setError('이름을 입력해 주세요.');
    setError('');
    setBusy(true);
    try { await saveProfile({ name: name.trim(), affiliation: aff.trim() }); }
    catch (e) { setError(e.message); return; }
    finally { setBusy(false); }
    notice.show('저장했어요');
    setTimeout(() => navigation.goBack(), 600);
  };

  const closePasswordDialog = () => {
    if (passwordBusy) return;
    setPasswordDialog(false);
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError('');
  };

  const savePassword = async () => {
    setPasswordError('');
    if (!checkPasswordRule(newPassword)) {
      setPasswordError(PASSWORD_RULE_MESSAGE);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('비밀번호 확인이 일치하지 않아요.');
      return;
    }
    setPasswordBusy(true);
    try {
      await changePassword(newPassword);
      setPasswordDialog(false);
      setNewPassword('');
      setConfirmPassword('');
      notice.show('비밀번호를 변경했어요.');
    } catch (e) {
      setPasswordError(e?.message || '비밀번호를 변경하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setPasswordBusy(false);
    }
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
          icon="lock"
          label="비밀번호 변경"
          onPress={() => setPasswordDialog(true)}
        />

        <SaveButton onPress={save} disabled={!dirty || busy} />
      </ScrollView>
      {notice.view}
      <Modal transparent visible={passwordDialog} animationType="fade" onRequestClose={closePasswordDialog}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>비밀번호 변경</Text>
            <Text style={styles.dialogSub}>영문·숫자·특수문자를 포함해 8자 이상 입력해 주세요.</Text>
            <TextInput
              style={styles.passwordInput}
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="새 비밀번호"
              placeholderTextColor={colors.muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={128}
              accessibilityLabel="새 비밀번호"
            />
            <TextInput
              style={styles.passwordInput}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="새 비밀번호 확인"
              placeholderTextColor={colors.muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={128}
              accessibilityLabel="새 비밀번호 확인"
            />
            {!!passwordError && <Text style={styles.passwordError}>{passwordError}</Text>}
            <View style={styles.dialogActions}>
              <Pressable accessibilityRole="button" disabled={passwordBusy} onPress={closePasswordDialog} style={styles.dialogButton}>
                <Text style={styles.dialogButtonText}>취소</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={passwordBusy} onPress={savePassword} style={[styles.dialogButton, styles.dialogPrimary, passwordBusy && styles.disabled]}>
                <Text style={styles.dialogPrimaryText}>{passwordBusy ? '변경 중…' : '변경하기'}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  dialogTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  dialogSub: { fontSize: font.caption, color: colors.muted },
  passwordInput: { minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: spacing.md, fontSize: font.bodyLg, color: colors.ink },
  passwordError: { fontSize: font.caption, color: colors.coral },
  dialogActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  dialogButton: { flex: 1, minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  dialogPrimary: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  disabled: { opacity: 0.6 },
  dialogButtonText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  dialogPrimaryText: { fontSize: font.body, fontWeight: '800', color: colors.white },
  error: { fontSize: font.body, fontWeight: '700', color: colors.coral },
});
