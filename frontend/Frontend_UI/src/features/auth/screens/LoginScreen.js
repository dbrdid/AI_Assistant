// ============================================================
// LoginScreen.js — 로그인 (스토리보드 1~4장)
// ============================================================
// 이메일 · 비밀번호 · [로그인 상태 유지] · [로그인] · [비밀번호를 잊으셨나요?] · 외부 계정 · [계정 만들기]
// 실패하면 "로그인에 실패하였습니다", 5회 연속 실패하면 "비밀번호 5회 불일치 / 10분 후 다시 시도해주세요".

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { startSession } from '../../../data/auth/AuthStore';
import { login, socialLogin } from '../../../services/auth/AuthApi';
import { AuthButton, AuthDialog, AuthField, AuthFrame } from '../components/AuthUi';

export default function LoginScreen({ prefillEmail = '', notice = '', onSignup, onForgot }) {
  const [email, setEmail] = useState(prefillEmail);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const r = await login({ email, password });
    if (r.ok) {
      await startSession(r.user, remember); // 로그인 상태가 바뀌면 앱이 자동으로 메인 화면으로 넘어가요
      return;
    }
    setBusy(false);
    setDialog({ icon: r.error.type === 'locked' ? '🔒' : '⚠', title: r.error.title, message: r.error.message });
    if (r.error.type === 'fail') setPassword('');
  };

  const social = async (name) => {
    const r = await socialLogin(name);
    if (!r.ok) setDialog({ icon: 'ℹ', title: `${name} 로그인`, message: '외부 계정 로그인은 서버가 연결되면 사용할 수 있어요.\n지금은 이메일로 로그인해 주세요.' });
  };

  return (
    <AuthFrame title="로그인" subtitle="오늘의 플래너에 오신 것을 환영해요">
      {!!notice && <View style={styles.notice}><Text style={styles.noticeText}>{notice}</Text></View>}
      <AuthField label="이메일" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="example@email.com" />
      <AuthField label="비밀번호" value={password} onChangeText={setPassword} secure placeholder="비밀번호" />
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: remember }} onPress={() => setRemember((v) => !v)} style={styles.check}>
        <Text style={[styles.box, remember && { color: colors.mintDark }]}>{remember ? '☑' : '☐'}</Text>
        <Text style={styles.checkText}>로그인 상태 유지</Text>
      </Pressable>
      <AuthButton label="로그인" onPress={submit} busy={busy} disabled={!email.trim() || !password} />
      <Pressable accessibilityRole="button" onPress={onForgot} style={styles.link} hitSlop={8}>
        <Text style={styles.linkText}>비밀번호를 잊으셨나요?</Text>
      </Pressable>

      <View style={styles.orRow}>
        <View style={styles.line} /><Text style={styles.or}>또는</Text><View style={styles.line} />
      </View>
      <AuthButton kind="ghost" label="네이버로 계속하기" onPress={() => social('네이버')} />
      <AuthButton kind="ghost" label="카카오로 계속하기" onPress={() => social('카카오')} />
      <AuthButton kind="ghost" label="계정 만들기" onPress={onSignup} />
      <AuthDialog dialog={dialog} onConfirm={() => setDialog(null)} />
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  notice: { padding: spacing.lg, borderRadius: 14, backgroundColor: colors.mintSoft },
  noticeText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark, lineHeight: 20 },
  check: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 40 },
  box: { fontSize: 24, color: colors.muted },
  checkText: { fontSize: font.body, color: colors.ink, fontWeight: '600' },
  link: { alignSelf: 'center', minHeight: 40, justifyContent: 'center' },
  linkText: { fontSize: font.body, color: colors.mintDark, fontWeight: '700' },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  line: { flex: 1, height: 1, backgroundColor: colors.line },
  or: { fontSize: font.caption, color: colors.muted },
});
