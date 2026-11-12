// ============================================================
// VerifyScreen.js — 이메일 인증 . 회원가입 · 비밀번호 재설정
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { sendCode, verifyCode } from '../../../services/auth/AuthApi';
import { AuthButton, AuthDialog, AuthField, AuthFrame } from '../components/AuthUi';

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function VerifyScreen({ email, initial, onVerified, onBack, onExpired }) {
  const [code, setCode] = useState('');
  const [expiresAt, setExpiresAt] = useState(initial.expiresAt);
  const [devCode, setDevCode] = useState(initial.devCode);
  const [left, setLeft] = useState(Math.max(0, Math.ceil((initial.expiresAt - Date.now()) / 1000)));
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const expiredShown = useRef(false);

  useEffect(() => {
    expiredShown.current = false;
    const tick = () => {
      const s = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (s === 0 && !expiredShown.current) {
        expiredShown.current = true;
        setDialog({ icon: '⚠', title: '제한시간 초과', message: '제한 시간을 초과했습니다\n다시 시도해주세요', expired: true });
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt]);

  const submit = async () => {
    if (busy) return;
    const r = verifyCode(email, code);
    if (!r.ok) {
      setDialog({ icon: '⚠', title: r.error.title, message: r.error.message, expired: r.error.type === 'expired' });
      return;
    }
    setBusy(true);
    await onVerified();
    setBusy(false);
  };

  const resend = async () => {
    const r = await sendCode(email);
    setExpiresAt(r.expiresAt);
    setDevCode(r.devCode);
    setCode('');
    setDialog({ icon: '✉', title: '인증번호 재전송', message: '새 인증번호를 보냈어요.\n이전 인증번호는 사용할 수 없어요.' });
  };

  return (
    <AuthFrame title="이메일 인증" subtitle={`${email}(으)로 인증번호가 발송됩니다.`} onBack={onBack}>
      {!!devCode && (
        <View style={styles.dev}>
          <Text style={styles.devTitle}>테스트 모드</Text>
          <Text style={styles.devText}>서버 연결 전이라 이메일을 보낼 수 없어요. 인증번호: <Text style={styles.devCode}>{devCode}</Text></Text>
        </View>
      )}
      <AuthField label="인증번호" value={code} onChangeText={(v) => setCode(v.replace(/[^0-9]/g, '').slice(0, 6))} keyboardType="number-pad" placeholder="6자리 인증번호" maxLength={6} />
      <Text style={[styles.timer, left === 0 && { color: colors.coral }]} accessibilityLabel={`남은 시간 ${fmt(left)}`}>{fmt(left)}</Text>
      <AuthButton label="확인" onPress={submit} busy={busy} disabled={code.length !== 6} />
      <Pressable accessibilityRole="button" onPress={resend} style={styles.link} hitSlop={8}>
        <Text style={styles.linkText}>인증번호 재전송</Text>
      </Pressable>
      <AuthDialog
        dialog={dialog}
        onConfirm={() => {
          const d = dialog;
          setDialog(null);
          if (d && d.expired) onExpired();
        }}
      />
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  dev: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: '#FFF1CC', gap: 2 },
  devTitle: { fontSize: font.caption, fontWeight: '800', color: '#9A6A00' },
  devText: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  devCode: { fontWeight: '800', letterSpacing: 2 },
  timer: { fontSize: 28, fontWeight: '800', color: colors.mintDark, textAlign: 'center' },
  link: { alignSelf: 'center', minHeight: 40, justifyContent: 'center' },
  linkText: { fontSize: font.body, color: colors.mintDark, fontWeight: '700' },
});
