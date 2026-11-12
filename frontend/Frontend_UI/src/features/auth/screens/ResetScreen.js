// ============================================================
// ResetScreen.js — 비밀번호 재설정
// ============================================================

import React, { useState } from 'react';
import { precheckReset, sendCode } from '../../../services/auth/AuthApi';
import { AuthButton, AuthDialog, AuthField, AuthFrame } from '../components/AuthUi';

export default function ResetScreen({ prefillEmail = '', onBack, onVerify }) {
  const [form, setForm] = useState({ email: prefillEmail, password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const r = await precheckReset(form);
    if (!r.ok) {
      setBusy(false);
      setDialog({ icon: '⚠', title: r.error.title, message: r.error.message });
      return;
    }
    const sent = await sendCode(form.email);
    setBusy(false);
    onVerify({ purpose: 'reset', email: form.email.trim(), payload: form, sent });
  };

  return (
    <AuthFrame title="비밀번호 재설정" subtitle="이메일 인증 후 새 비밀번호로 바뀌어요" onBack={onBack}>
      <AuthField label="이메일" value={form.email} onChangeText={set('email')} keyboardType="email-address" placeholder="example@email.com" />
      <AuthField label="새 비밀번호" value={form.password} onChangeText={set('password')} secure hint="영문 + 숫자 + 특수문자를 포함해 8자 이상" />
      <AuthField label="비밀번호 확인" value={form.confirm} onChangeText={set('confirm')} secure hint="영문 + 숫자 + 특수문자" />
      <AuthButton label="이메일 인증" onPress={submit} busy={busy} />
      <AuthDialog dialog={dialog} onConfirm={() => setDialog(null)} />
    </AuthFrame>
  );
}
