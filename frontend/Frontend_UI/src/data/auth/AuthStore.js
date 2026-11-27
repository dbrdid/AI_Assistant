import { useSyncExternalStore } from 'react';
import { supabase } from '../../lib/stella/supabase';
import { forgetRememberedKeys } from '../../integration/rememberedKeys';
import { openSession, closeSession, flushSessionDrafts, maybeRuntime, wipeSessionData } from '../../integration/runtime';
import { getWithdrawPreview, withdrawAccount, withdrawErrorMessage } from '../../lib/stella/withdraw';
import { Linking, Platform } from 'react-native';
import { completeSignInFromUrl, completeWebSignIn } from '../../lib/stella/auth';
import { initializeProfile } from '../settings/SettingsStore';
import { unregisterPush } from '../../services/notify/PushRegister';
import { LOCAL_PREVIEW, PREVIEW_USER } from '../../integration/mode';
let state = { status: 'loading', user: null, error: null };
const listeners = new Set();
const publish = next => { state = next; for (const f of listeners) f(); };
let queue = Promise.resolve();
async function apply(user) {
  if (!user) { publish({ status: 'loading', user: null, error: null }); await closeSession(false); publish({ status: 'out', user: null, error: null }); return; }
  try {
    if (maybeRuntime()?.session.id !== user.id) publish({ status: 'loading', user: null, error: null });
    await openSession(user);
    initializeProfile(user);
    publish({ status: 'in', user: { ...user, name: user.user_metadata?.display_name ?? user.email, affiliation: user.user_metadata?.affiliation ?? '' }, error: null });
  } catch (error) {
    console.error('[auth] 기기 저장소를 열지 못했습니다', error);
    publish({ status: 'storage-error', user, error: error.message });
  }
}
const enqueue = user => (queue = queue.catch(() => undefined).then(() => apply(user)));
if (!LOCAL_PREVIEW) supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') return; // Finish the reset UI before entering the application.
  setTimeout(() => { void enqueue(session?.user ?? null); }, 0);
});
// 웹에서 Google·Kakao 로그인 페이지를 거쳐 돌아왔다면 먼저 로그인을 마무리 (실패하면 로그인 화면에 이유를 보여 줌)
if (LOCAL_PREVIEW) void enqueue(PREVIEW_USER);
else completeWebSignIn()
  .catch(error => ({ failed: error?.message || '소셜 로그인을 마치지 못했어요. 다시 시도해 주세요' }))
  .then(r => supabase.auth.getSession().then(({ data, error }) => {
    if (r?.failed) return publish({ status: 'out', user: null, error: r.failed });
    return error ? publish({ status: 'out', user: null, error: error.message }) : enqueue(data.session?.user ?? null);
  }));
// 휴대폰: 가입 인증 메일의 링크를 누르면 앱이 auth/callback 주소로 열림 → 그 주소로 로그인 마무리.
// (무료 요금제 기본 메일은 템플릿을 바꿀 수 없어 코드 대신 링크만 옴)
if (!LOCAL_PREVIEW && Platform.OS !== 'web') {
  const handle = url => {
    if (!url || !url.includes('auth/callback')) return;
    // 이미 로그인한 상태면 잘못된 링크라도 화면을 바꾸지 않는다
    completeSignInFromUrl(url).catch(error => { if (state.status !== 'in') publish({ status: 'out', user: null, error: error?.message || '인증 링크로 로그인하지 못했어요. 이메일과 비밀번호로 로그인해 주세요' }); });
  };
  Linking.getInitialURL().then(handle).catch(() => undefined);
  Linking.addEventListener('url', ({ url }) => handle(url));
}
export const useAuth = () => useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state);
export const retrySession = () => enqueue(state.user);
export async function startSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error('서버 로그인이 필요합니다');
  await enqueue(data.session.user);
  if (state.status !== 'in') throw new Error(state.error ?? '기기 저장소를 열지 못했습니다');
}
export function signOut() {
  const job = queue.catch(() => undefined).then(async () => {
    if (state.status === 'out') return { ok: true };
    try {
      flushSessionDrafts();
      await unregisterPush();
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    } catch (error) {
      return { ok: false, message: error.message };
    }
    try {
      await forgetRememberedKeys();
      // Close the account database while keeping its on-device records and sync queue.
      await apply(null);
    } catch (error) {
      console.error('[auth] 로그아웃 후 기기 저장소를 닫지 못했습니다', error);
      publish({ status: 'out', user: null, error: '로그아웃 후 기기 저장소를 닫지 못했습니다. 앱을 다시 시작해 주세요.' });
    }
    return { ok: true };
  });
  queue = job;
  return job;
}
export const loadWithdrawPreview = () => getWithdrawPreview(supabase);
// Runs inside the auth queue so the SIGNED_OUT event from withdrawAccount waits until the device data is erased.
export function deleteAccount() {
  const job = queue.catch(() => undefined).then(async () => {
    try {
      await withdrawAccount(supabase);
    } catch (error) {
      return { ok: false, message: withdrawErrorMessage(error) };
    }
    try { await wipeSessionData(); } catch (error) { console.error('[auth] 기기 데이터를 지우지 못했습니다', error); }
    publish({ status: 'out', user: null, error: null });
    return { ok: true };
  });
  queue = job;
  return job;
}
