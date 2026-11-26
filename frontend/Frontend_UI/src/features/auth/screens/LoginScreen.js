// ============================================================
// LoginScreen.js — 로그인
// ============================================================

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { enabledProviders } from '../../../lib/stella/auth';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { startSession } from '../../../data/auth/AuthStore';
import { login, socialLogin } from '../../../services/auth/AuthApi';
import { AuthButton, AuthDialog, AuthField, AuthFrame } from '../components/AuthUi';
import { GoogleLogo, KakaoLogo } from '../components/SocialLogos';

export default function LoginScreen({ prefillEmail = '', notice = '', onSignup, onForgot }) {
  const [email, setEmail] = useState(prefillEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [providers, setProviders] = useState({ google: false, kakao: false });
  useEffect(() => {
    let alive = true;
    enabledProviders().then(p => { if (alive) setProviders(p); });
    return () => { alive = false; };
  }, []);

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
    <AuthFrame title="로그인">
      {!!notice && <View style={styles.notice}><Text style={styles.noticeText}>{notice}</Text></View>}
      {/* 서버에서 켜진 소셜 로그인만 보여 준다 (꺼진 것을 누르면 "provider is not enabled" 오류) */}
      {(providers.google || providers.kakao) && <>
        <View style={styles.socials}>
          {providers.google && <AuthButton kind="google" logo={<GoogleLogo />} label="Google로 계속하기" onPress={() => social('Google')} />}
          {providers.kakao && <AuthButton kind="kakao" logo={<KakaoLogo />} label="카카오로 계속하기" onPress={() => social('카카오')} />}
        </View>
        <View style={styles.orRow}>
          <View style={styles.line} /><Text style={styles.or}>또는 이메일로</Text><View style={styles.line} />
        </View>
      </>}
      <AuthField label="이메일" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="example@email.com" />
      <AuthField label="비밀번호" value={password} onChangeText={setPassword} secure placeholder="비밀번호" />
      <View style={styles.optionRow}>
        <Pressable accessibilityRole="button" onPress={onForgot} hitSlop={8}>
          <Text style={styles.linkText}>비밀번호 찾기</Text>
        </Pressable>
      </View>
      <AuthButton label="로그인" onPress={submit} busy={busy} disabled={!email.trim() || !password} />

      <View style={styles.signup}>
        <Text style={styles.signupHint}>계정이 없으신가요?</Text><Pressable accessibilityRole="button" accessibilityLabel="계정 만들기" onPress={onSignup} style={{minHeight:44,justifyContent:"center"}}><Text style={styles.signupLink}>계정 만들기</Text></Pressable>
      </View>
      <AuthDialog dialog={dialog} onConfirm={() => setDialog(null)} />
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  notice: { padding: spacing.lg, borderRadius: 4, backgroundColor: colors.mintSoft },
  noticeText: { fontSize: font.body, fontWeight: '500', color: colors.mintDark, lineHeight: 20 },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: -8 },
  linkText: { fontSize: 12, color: colors.muted, fontWeight: '400' },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  line: { flex: 1, height: 1, backgroundColor: colors.line },
  or: { fontSize: font.caption, color: colors.muted },
  socials: { gap: spacing.sm },
  signup:{flexDirection:'row',justifyContent:'center',alignItems:'center',gap:8,marginTop:8},
  signupHint:{fontSize:13,color:colors.muted},
  signupLink:{fontSize:13,color:colors.ink,fontWeight:'500'},
});
