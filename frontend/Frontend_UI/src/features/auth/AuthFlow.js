// ============================================================
// AuthFlow.js — 로그인 전 화면들(로그인 · 회원가입 · 이메일 인증 · 비밀번호 재설정)의 이동을 관리
// ============================================================
// 이동: 로그인 ⇄ 회원가입 → 이메일 인증 → (가입 완료) 로그인
//       로그인 → 비밀번호 재설정 → 이메일 인증 → (변경 완료) 로그인
// 안드로이드 뒤로가기 버튼도 한 단계씩 뒤로 가요.

import React, { useEffect, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { colors } from '../../shared/theme/theme';
import { completeReset, completeSignup } from '../../services/auth/AuthApi';
import LoginScreen from './screens/LoginScreen';
import ResetScreen from './screens/ResetScreen';
import SignupScreen from './screens/SignupScreen';
import VerifyScreen from './screens/VerifyScreen';
import { AuthDialog } from './components/AuthUi';

export default function AuthFlow() {
  const [view, setView] = useState({ name: 'login', prefill: '', notice: '' });
  const [errDialog, setErrDialog] = useState(null);

  const toLogin = (prefill = '', notice = '') => setView({ name: 'login', prefill, notice, k: Date.now() });

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (view.name === 'login') return false;
      if (view.name === 'verify') setView({ name: view.purpose === 'signup' ? 'signup' : 'reset', email: view.email });
      else toLogin(view.prefill);
      return true;
    });
    return () => sub.remove();
  }, [view]);

  let body = null;
  if (view.name === 'login') {
    body = (
      <LoginScreen
        key={view.k || 'login'}
        prefillEmail={view.prefill}
        notice={view.notice}
        onSignup={() => setView({ name: 'signup' })}
        onForgot={() => setView({ name: 'reset' })}
      />
    );
  } else if (view.name === 'signup') {
    body = (
      <SignupScreen
        onBack={() => toLogin()}
        onVerify={(v) => setView({ name: 'verify', ...v })}
      />
    );
  } else if (view.name === 'reset') {
    body = (
      <ResetScreen
        prefillEmail={view.email || ''}
        onBack={() => toLogin()}
        onVerify={(v) => setView({ name: 'verify', ...v })}
      />
    );
  } else if (view.name === 'verify') {
    const { purpose, email, payload, sent } = view;
    body = (
      <VerifyScreen
        email={email}
        initial={sent}
        onBack={() => setView({ name: purpose === 'signup' ? 'signup' : 'reset', email })}
        onExpired={() => setView({ name: purpose === 'signup' ? 'signup' : 'reset', email })}
        onVerified={async () => {
          const r = purpose === 'signup' ? await completeSignup(payload) : await completeReset({ email, password: payload.password });
          if (!r.ok) {
            setErrDialog({ icon: '⚠', title: r.error.title, message: r.error.message });
            return;
          }
          toLogin(email, purpose === 'signup' ? '가입이 완료되었어요. 로그인해 주세요.' : '비밀번호가 변경되었어요. 새 비밀번호로 로그인해 주세요.');
        }}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.cream }}>
      {body}
      <AuthDialog dialog={errDialog} onConfirm={() => { setErrDialog(null); toLogin(); }} />
    </View>
  );
}
