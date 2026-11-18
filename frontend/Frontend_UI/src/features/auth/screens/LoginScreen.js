// ============================================================
// LoginScreen.js — 로그인
// ============================================================

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { startSession } from '../../../data/auth/AuthStore';
import { login, socialLogin } from '../../../services/auth/AuthApi';
import { AuthButton, AuthDialog, AuthField, AuthFrame, AuthLogo } from '../components/AuthUi';
import Icon from '../../../shared/components/Icon';

export default function LoginScreen({ prefillEmail = '', notice = '', onSignup, onForgot }) {
  const [email, setEmail] = useState(prefillEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const r = await login({ email, password });
    if (r.ok) {
      try { await startSession(); }
      catch (e) { setDialog({ icon: '⚠', title: '앱 초기화 실패', message: e.message }); }
      finally { setBusy(false); }
      return;
    }
    setBusy(false);
    setDialog({ icon: r.error.type === 'locked' ? '🔒' : '⚠', title: r.error.title, message: r.error.message });
    if (r.error.type === 'fail') setPassword('');
  };

  const social = async (name) => {
    const r = await socialLogin(name);
    if (!r.ok && r.reason !== 'cancelled') setDialog({ icon: 'ℹ', title: `${name} 로그인`, message: r.error?.message ?? '로그인에 실패했습니다.' });
  };

  return (
    <AuthFrame title={'오늘의 플래너에\n오신 것을 환영해요'} hero={<AuthLogo />}>
      {!!notice && <View style={styles.notice}><Text style={styles.noticeText}>{notice}</Text></View>}
      <AuthField label="이메일" icon="mail" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="example@email.com" />
      <AuthField label="비밀번호" icon="lock" value={password} onChangeText={setPassword} secure placeholder="비밀번호" />
      {/* 로그인 상태는 항상 이 기기에 유지됩니다 (선택 항목이 아니라 안내) */}
      <View style={styles.optionRow}>
        <View style={styles.keep}>
          <Icon name="checkSquare" size={18} color={colors.mintDark} />
          <Text style={styles.keepText}>로그인 상태 유지</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onForgot} hitSlop={8}>
          <Text style={styles.linkText}>비밀번호를 잊으셨나요?</Text>
        </Pressable>
      </View>
      <AuthButton label="로그인" onPress={submit} busy={busy} disabled={!email.trim() || !password} />

      <View style={styles.orRow}>
        <View style={styles.line} /><Text style={styles.or}>또는</Text><View style={styles.line} />
      </View>
      <View style={styles.socials}>
        <AuthButton kind="ghost" icon="globe" label="Google로 계속하기" onPress={() => social('Google')} />
        <AuthButton kind="kakao" icon="messageFill" label="카카오로 계속하기" onPress={() => social('카카오')} />
      </View>
      <View style={styles.signup}>
        <AuthButton kind="outline" label="계정 만들기" onPress={onSignup} />
      </View>
      <AuthDialog dialog={dialog} onConfirm={() => setDialog(null)} />
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  notice: { padding: spacing.lg, borderRadius: 14, backgroundColor: colors.mintSoft },
  noticeText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark, lineHeight: 20 },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: -spacing.xs },
  keep: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  keepText: { fontSize: 13, color: colors.ink, fontWeight: '600' },
  linkText: { fontSize: 13, color: colors.mintDark, fontWeight: '800' },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  line: { flex: 1, height: 1, backgroundColor: colors.line },
  or: { fontSize: font.caption, color: colors.muted },
  socials: { gap: spacing.sm, marginTop: -spacing.xs },
  signup: { marginTop: spacing.xxl },
});
