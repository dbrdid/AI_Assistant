// 로그인: 이메일 6자리 코드 · 이메일+비밀번호 · Google · Kakao
//   이메일 코드 방식은 앱 안에서 코드를 입력하므로 딥링크·Redirect URL이 필요 없음
//   준비(Google·Kakao): app.json의 "scheme"(예: "stella")을 정하고, 아래 redirectTo 값을
//         Supabase 대시보드 → Authentication → URL Configuration → Redirect URLs에 등록해야 합니다.
//         Expo Go(exp://...)와 개발/배포 빌드(stella://...)는 주소가 달라서 둘 다 등록하세요.
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { supabase } from './supabase';
import { PASSWORD_RULE_MESSAGE, checkPasswordRule, createLoginGuard, loginLockedError, normEmail } from './login-rules';

/** 비밀번호 5회 실패 잠금 (이 기기 안에서만, 프론트 결정 2026-11-15) */
export const loginGuard = createLoginGuard(AsyncStorage);

function weakPasswordError(): Error & { code: 'weak_password' } {
  return Object.assign(new Error(PASSWORD_RULE_MESSAGE), { code: 'weak_password' as const });
}

WebBrowser.maybeCompleteAuthSession();

/** 로그인 후 앱으로 돌아올 주소. 개발 중 console.log로 찍어서 Supabase에 등록하세요 */
export const redirectTo = makeRedirectUri({ path: 'auth/callback' });

export type OAuthProvider = 'google' | 'kakao';

/**
 * Google·Kakao 로그인. 사용자가 취소하면 null
 *   웹: 팝업 대신 지금 창을 로그인 페이지로 보냈다가 돌아옴 (null을 돌려주고 페이지가 이동함).
 *       Kakao·Google 로그인 페이지가 팝업과 앱 창의 연결(window.opener)을 끊어서, 팝업 방식은 결과가 앱으로 돌아오지 않음.
 *       돌아온 뒤에는 completeWebSignIn()이 주소의 code로 로그인을 마무리함 (AuthStore가 시작할 때 부름)
 */
export async function signInWithProvider(provider: OAuthProvider): Promise<Session | null> {
  if (Platform.OS === 'web') {
    const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });
    if (error) throw error;
    return null;
  }
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') return null;
  return completeSignInFromUrl(result.url);
}

// ---------------------------------------------------------------------
// (선택) 비밀번호 없이 6자리 코드로만 로그인 — 지금 앱 UI에서는 안 씀. verifyEmailCode는 가입 인증에도 씀
//   ① sendEmailCode(email) → 메일로 6자리 코드 발송 (처음 쓰는 주소면 계정도 만듦)
//   ② verifyEmailCode(email, code) → 로그인 완료 (Session)
//   메일 템플릿(Magic Link, Confirm signup)에 {{ .Token }}이 있어야 링크 대신 코드가 감
//   같은 주소로 다시 보내기는 60초 뒤부터 (서버 제한)
// ---------------------------------------------------------------------

/** 로그인 코드 보내기. createUser=false면 이미 가입한 주소에만 보냄 (없으면 오류) */
export async function sendEmailCode(
  email: string,
  opts: { createUser?: boolean; displayName?: string } = {},
): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: {
      shouldCreateUser: opts.createUser ?? true,
      // 처음 가입할 때만 쓰임 → 서버가 이 이름으로 프로필을 만듦
      data: opts.displayName ? { display_name: opts.displayName } : undefined,
    },
  });
  if (error) throw error;
}

/** 메일로 받은 6자리 코드 확인 → 로그인. 가입 인증 코드(signUpWithEmail 후)도 이걸로 확인 */
export async function verifyEmailCode(email: string, code: string): Promise<Session> {
  const { data, error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: code.replace(/\D/g, ''),
    type: 'email',
  });
  if (error) throw error;
  if (!data.session) throw new Error('로그인 세션을 받지 못했습니다');
  return data.session;
}

/** 가입 인증 코드 다시 보내기 (signUpWithEmail로 가입했는데 코드를 못 받았을 때) */
export async function resendSignUpCode(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
  if (error) throw error;
}

/** 이메일·코드 로그인 오류 → 화면 문구 */
export function authErrorMessage(err: unknown): string {
  const e = err as { code?: string; status?: number; message?: string } | null;
  const code = e?.code ?? '';
  const msg = e?.message ?? '';
  if (code === 'otp_expired' || (/expired|invalid/i.test(msg) && /token|otp/i.test(msg))) return '코드가 틀렸거나 만료됐어요. 새 코드를 받아 주세요';
  if (code === 'over_email_send_rate_limit' || e?.status === 429) return '잠시 후 다시 시도해 주세요 (코드는 60초에 한 번 보낼 수 있어요)';
  if (code === 'otp_disabled' || code === 'signup_disabled' || /signups not allowed/i.test(msg)) return '가입되지 않은 이메일이에요';
  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(msg)) return '이메일 주소를 확인해 주세요';
  if (code === 'invalid_credentials') return '이메일 또는 비밀번호가 맞지 않아요';
  if (code === 'email_not_confirmed') return '이메일 인증이 아직 안 됐어요. 인증번호를 다시 보내 드릴게요';
  if (code === 'user_already_exists' || code === 'email_exists') return '이미 가입된 이메일이에요. 로그인해 주세요';
  if (code === 'weak_password') return PASSWORD_RULE_MESSAGE;
  if (code === 'login_locked') return '비밀번호 5회 불일치. 10분 후 다시 시도해주세요';
  if (code === 'same_password') return '이전과 다른 비밀번호를 입력해 주세요';
  return '로그인하지 못했어요. 잠시 후 다시 시도해 주세요';
}

// ---------------------------------------------------------------------
// 이메일 + 비밀번호 (기본 방식) — 가입 인증·비밀번호 재설정은 메일의 6자리 코드
//   가입:   signUpWithEmail → (인증번호 화면) verifyEmailCode → 로그인 완료
//           코드 재전송: resendSignUpCode (60초에 한 번)
//   로그인: signInWithEmail. 인증 전이면 needsEmailVerification(err) → 인증번호 화면
//           같은 이메일로 5번 틀리면 10분 잠금(이 기기 안에서만) → err.code === 'login_locked'
//   재설정: sendPasswordReset → verifyPasswordResetCode → updatePassword (재설정하면 잠금도 풀림)
//   비밀번호 규칙: checkPasswordRule (영문+숫자+특수문자, 8자 이상). 가입·재설정 때 서버에 보내기 전에 검사
// ---------------------------------------------------------------------

/** 이메일 회원가입. Confirm email이 켜져 있으면 메일의 6자리 코드를 verifyEmailCode로 확인 */
export async function signUpWithEmail(
  email: string,
  password: string,
  profile?: { displayName?: string; affiliation?: string },
): Promise<{ needsVerification: boolean; session: Session | null }> {
  if (!checkPasswordRule(password)) throw weakPasswordError();
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      emailRedirectTo: redirectTo,
      // 서버가 가입 때 이 값으로 프로필을 만듦 (이름 50자, 소속 100자까지)
      data: { display_name: profile?.displayName ?? '', affiliation: profile?.affiliation ?? null },
    },
  });
  if (error) throw error;
  // Confirm email이 켜져 있으면 이미 인증된 이메일이어도 오류 없이 성공처럼 옴 → identities가 빈 배열이면 이미 가입된 것
  if (data.user && (data.user.identities?.length ?? 0) === 0) {
    throw Object.assign(new Error('이미 가입된 이메일입니다'), { code: 'user_already_exists' });
  }
  // needsVerification이면 인증번호 화면으로 → verifyEmailCode(email, code)
  return { needsVerification: !data.session, session: data.session };
}

/** 로그인 오류가 "이메일 인증 전"인지 → 인증번호 화면으로 보내고 resendSignUpCode */
export function needsEmailVerification(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'email_not_confirmed';
}

/** 이메일 로그인. 5번 틀리면 10분 잠금 → err.code === 'login_locked' (err.lockedUntil = 풀리는 시각 ms) */
export async function signInWithEmail(email: string, password: string): Promise<Session> {
  const key = normEmail(email);
  const until = await loginGuard.lockedUntil(key);
  if (until) throw loginLockedError(until);
  const { data, error } = await supabase.auth.signInWithPassword({ email: key, password });
  if (error) {
    if (error.code === 'invalid_credentials') {
      const r = await loginGuard.recordFailure(key);
      if (r.lockedUntil) throw loginLockedError(r.lockedUntil);
    }
    throw error;
  }
  await loginGuard.clear(key);
  return data.session;
}

/**
 * 비밀번호 재설정: ① sendPasswordReset(email) → 6자리 코드 메일
 *                 ② verifyPasswordResetCode(email, code) → 임시 로그인
 *                 ③ updatePassword(새 비밀번호)
 */
export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
  if (error) throw error;
}

export async function verifyPasswordResetCode(email: string, code: string): Promise<Session> {
  const { data, error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: code.replace(/\D/g, ''),
    type: 'recovery',
  });
  if (error) throw error;
  if (!data.session) throw new Error('재설정 세션을 받지 못했습니다');
  return data.session;
}

/** 새 비밀번호 저장 (재설정 코드 확인 후, 또는 설정 화면). 저장되면 그 이메일의 로그인 잠금도 풀림 */
export async function updatePassword(newPassword: string): Promise<void> {
  if (!checkPasswordRule(newPassword)) throw weakPasswordError();
  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
  if (data.user?.email) await loginGuard.clear(data.user.email);
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * (웹) Google·Kakao 로그인에서 돌아온 주소면 로그인을 마무리하고 주소에서 code를 지움. 아니면 null.
 * 앱이 시작할 때 한 번 부름. 성공하면 onAuthStateChange(SIGNED_IN)로 앱이 열림
 */
export async function completeWebSignIn(): Promise<Session | null> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const url = window.location.href;
  const parsed = new URL(url);
  const hash = parsed.hash.replace(/^#/, '');
  const hasResult = ['code', 'error_description'].some((k) => parsed.searchParams.has(k)) || /(^|&)(access_token|error_description)=/.test(hash);
  if (!hasResult) return null;
  // 새로 고침해도 같은 code를 다시 쓰지 않게 먼저 주소를 정리 (code는 한 번만 쓸 수 있음)
  window.history.replaceState(null, '', '/');
  return completeSignInFromUrl(url);
}

/**
 * 딥링크로 돌아온 주소에서 로그인 완료
 *   - OAuth 브라우저 로그인: signInWithProvider가 알아서 호출
 *   - 이메일 인증·비밀번호 재설정 링크: 앱 최상단에서 expo-linking의 Linking.useURL() 값이 바뀌면 호출
 */
export async function completeSignInFromUrl(url: string): Promise<Session | null> {
  const parsed = new URL(url);
  const query = parsed.searchParams;
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));

  const errorDescription = query.get('error_description') ?? hash.get('error_description');
  if (errorDescription) throw new Error(errorDescription);

  const code = query.get('code');
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return data.session;
  }

  // 예전 방식(토큰이 # 뒤에 오는 경우) 대비
  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) throw error;
    return data.session;
  }
  return null;
}

/** 로그인 상태 변화 구독 (반환값을 호출하면 구독 해제) */
export function onAuthChange(cb: (session: Session | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}
