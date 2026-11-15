import * as api from '../../lib/stella/auth';
import { supabase } from '../../lib/stella/supabase';
import { checkPasswordRule as passwordRule } from '../../lib/stella/login-rules';
export const CODE_SECONDS = 180;
export const normEmail = value => String(value ?? '').trim().toLowerCase();
export const isEmailFormat = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const checkPasswordRule = passwordRule;
const flows = new Map();
const fail = e => ({ ok: false, error: { type: e?.code === 'login_locked' ? 'locked' : 'fail', title: '인증 요청 실패', message: api.authErrorMessage(e) } });
export async function login({ email, password }) {
  try { const session = await api.signInWithEmail(email, password); return { ok: true, user: session.user }; } catch (e) { return fail(e); }
}
export async function socialLogin(name) {
  const provider = name === '카카오' ? 'kakao' : name === 'Google' ? 'google' : null;
  if (!provider) return fail(new Error('지원하지 않는 로그인 방식입니다'));
  try { const session = await api.signInWithProvider(provider); return session ? { ok: true, user: session.user } : { ok: false, reason: 'cancelled' }; } catch (e) { return fail(e); }
}
export async function precheckSignup(p) {
  if (!isEmailFormat(p.email) || !p.name?.trim() || !checkPasswordRule(p.password) || p.password !== p.confirm || !p.requiredTerms) return fail({ code: 'weak_password' });
  try {
    await api.signUpWithEmail(p.email, p.password, { displayName: p.name, affiliation: p.affiliation });
    flows.set(normEmail(p.email), { kind: 'signup', sent: true }); return { ok: true };
  } catch (e) { return fail(e); }
}
export async function precheckReset(p) {
  if (!isEmailFormat(p.email) || !checkPasswordRule(p.password) || p.password !== p.confirm) return fail({ code: 'weak_password' });
  try { await api.sendPasswordReset(p.email); flows.set(normEmail(p.email), { kind: 'reset', sent: true }); return { ok: true }; } catch (e) { return fail(e); }
}
export async function sendCode(email) {
  const flow = flows.get(normEmail(email));
  if (!flow) return fail(new Error('인증 흐름을 다시 시작해 주세요'));
  try {
    if (!flow.sent) { if (flow.kind === 'signup') await api.resendSignUpCode(email); else await api.sendPasswordReset(email); }
    flow.sent = false;
    return { ok: true, expiresAt: Date.now() + CODE_SECONDS * 1000 };
  } catch (e) { return fail(e); }
}
export async function verifyCode(email, code) {
  const flow = flows.get(normEmail(email));
  if (!flow) return fail(new Error('인증 흐름이 만료됐습니다'));
  try { if (flow.kind === 'signup') await api.verifyEmailCode(email, code); else await api.verifyPasswordResetCode(email, code); return { ok: true }; } catch (e) { return fail(e); }
}
export async function completeSignup({ email }) { flows.delete(normEmail(email)); return { ok: true }; }
export async function completeReset({ email, password }) {
  try { await api.updatePassword(password); flows.delete(normEmail(email)); await supabase.auth.signOut(); return { ok: true }; } catch (e) { return fail(e); }
}
export const removeAccount = async () => fail(new Error('탈퇴 확인 흐름이 필요합니다'));
export async function getAccount() { const { data } = await supabase.auth.getUser(); return data.user; }
