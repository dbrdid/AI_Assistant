// ============================================================
// SignupScreen.js — 회원가입 (스토리보드 5~9장)
// ============================================================
// 이메일 · 이름 · 비밀번호(영문+숫자+특수문자) · 비밀번호 확인 · 소속 · 필수/선택 약관 → [이메일 인증]
// 문제가 있으면 오류 창: 이미 가입된 이메일 / 이메일 확인 실패 / 비밀번호 불일치 / 보안 규칙 위반
// 문제가 없으면 인증번호를 보내고 이메일 인증 화면으로 이동해요.

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { precheckSignup, sendCode } from '../../../services/auth/AuthApi';
import { AuthButton, AuthDialog, AuthField, AuthFrame } from '../components/AuthUi';

const TERMS = {
  required: {
    title: '필수 약관',
    body: '[서비스 이용약관 · 개인정보 수집·이용 동의]\n\n(임시 문구) 서비스 이용에 필요한 이메일·이름·소속 정보를 수집하고, 계정 관리와 서비스 제공에만 사용합니다. 정식 약관은 서비스 출시 전에 이곳에 넣어 주세요.',
  },
  optional: {
    title: '선택 약관',
    body: '[마케팅 정보 수신 동의]\n\n(임시 문구) 새 기능과 이벤트 소식을 받아보는 데 동의합니다. 동의하지 않아도 서비스를 이용할 수 있어요.',
  },
};

export default function SignupScreen({ onBack, onVerify }) {
  const [form, setForm] = useState({ email: '', name: '', password: '', confirm: '', affiliation: '' });
  const [reqTerms, setReqTerms] = useState(false);
  const [optTerms, setOptTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [viewing, setViewing] = useState(null); // 'required' | 'optional'
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const r = await precheckSignup({ ...form, requiredTerms: reqTerms });
    if (!r.ok) {
      setBusy(false);
      setDialog({ icon: '⚠', title: r.error.title, message: r.error.message });
      return;
    }
    const sent = await sendCode(form.email);
    setBusy(false);
    onVerify({ purpose: 'signup', email: form.email.trim(), payload: { ...form, optionalTerms: optTerms }, sent });
  };

  const Terms = ({ id, label, value, onChange }) => (
    <View style={styles.termRow}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={styles.termMain}>
        <Text style={[styles.box, value && { color: colors.mintDark }]}>{value ? '☑' : '☐'}</Text>
        <Text style={styles.termText}>{label}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label} 내용 보기`} onPress={() => setViewing(id)} hitSlop={8}>
        <Text style={styles.view}>보기</Text>
      </Pressable>
    </View>
  );

  return (
    <AuthFrame title="계정 만들기" onBack={onBack}>
      <AuthField label="이메일" value={form.email} onChangeText={set('email')} keyboardType="email-address" placeholder="example@email.com" />
      <AuthField label="이름" value={form.name} onChangeText={set('name')} autoCapitalize="words" placeholder="홍길동" />
      <AuthField label="비밀번호" value={form.password} onChangeText={set('password')} secure hint="영문 + 숫자 + 특수문자를 포함해 8자 이상" />
      <AuthField label="비밀번호 확인" value={form.confirm} onChangeText={set('confirm')} secure hint="영문 + 숫자 + 특수문자" />
      <AuthField label="소속 (선택)" value={form.affiliation} onChangeText={set('affiliation')} autoCapitalize="words" placeholder="대학교 / 회사" />
      <Terms id="required" label="[필수] 이용약관 및 개인정보 수집 동의" value={reqTerms} onChange={setReqTerms} />
      <Terms id="optional" label="[선택] 마케팅 정보 수신 동의" value={optTerms} onChange={setOptTerms} />
      <AuthButton label="이메일 인증" onPress={submit} busy={busy} />

      <AuthDialog dialog={dialog} onConfirm={() => setDialog(null)} />
      <Modal transparent visible={!!viewing} animationType="fade" onRequestClose={() => setViewing(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>{viewing ? TERMS[viewing].title : ''}</Text>
            <ScrollView style={{ maxHeight: 260 }}><Text style={styles.sheetBody}>{viewing ? TERMS[viewing].body : ''}</Text></ScrollView>
            <AuthButton label="닫기" onPress={() => setViewing(null)} />
          </View>
        </View>
      </Modal>
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  termRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  termMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  box: { fontSize: 24, color: colors.muted },
  termText: { fontSize: font.body, color: colors.ink, fontWeight: '600', flexShrink: 1 },
  view: { fontSize: font.body, color: colors.mintDark, fontWeight: '800', paddingHorizontal: spacing.sm },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  sheet: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  sheetTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  sheetBody: { fontSize: font.body, color: colors.ink, lineHeight: 22 },
});
