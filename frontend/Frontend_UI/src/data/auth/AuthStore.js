import { useSyncExternalStore } from 'react';
import { supabase } from '../../lib/stella/supabase';
import { openSession, closeSession, maybeRuntime, wipeSessionData } from '../../integration/runtime';
import { getWithdrawPreview, withdrawAccount, withdrawErrorMessage } from '../../lib/stella/withdraw';
import { completeWebSignIn } from '../../lib/stella/auth';
import { initializeProfile } from '../settings/SettingsStore';
import { unregisterPush } from '../../services/notify/PushRegister';
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
    publish({ status: 'out', user: null, error: error.message });
  }
}
const enqueue = user => (queue = queue.catch(() => undefined).then(() => apply(user)));
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') return; // Finish the reset UI before entering the application.
  setTimeout(() => { void enqueue(session?.user ?? null); }, 0);
});
// 웹에서 Google·Kakao 로그인 페이지를 거쳐 돌아왔다면 먼저 로그인을 마무리 (실패하면 로그인 화면에 이유를 보여 줌)
completeWebSignIn()
  .catch(error => ({ failed: error?.message || '소셜 로그인을 마치지 못했어요. 다시 시도해 주세요' }))
  .then(r => supabase.auth.getSession().then(({ data, error }) => {
    if (r?.failed) return publish({ status: 'out', user: null, error: r.failed });
    return error ? publish({ status: 'out', user: null, error: error.message }) : enqueue(data.session?.user ?? null);
  }));
export const useAuth = () => useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state);
export async function startSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error('서버 로그인이 필요합니다');
  await enqueue(data.session.user);
  if (state.status !== 'in') throw new Error(state.error ?? '기기 저장소를 열지 못했습니다');
}
export async function signOut() {
  const before = state;
  publish({ status: 'loading', user: null, error: null });
  // 로그아웃한 계정의 서버 알림이 이 기기로 오지 않게 (로그인 상태일 때 해야 서버가 받아 줌)
  try { await unregisterPush(); await closeSession(true); const { error } = await supabase.auth.signOut({ scope: 'local' }); if (error) throw error; await enqueue(null); return { ok: true }; }
  catch (error) { publish(maybeRuntime() ? before : { status: 'out', user: null, error: error.message }); return { ok: false, message: error.message }; }
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
