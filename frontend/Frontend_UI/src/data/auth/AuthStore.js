import { useSyncExternalStore } from 'react';
import { supabase } from '../../lib/stella/supabase';
import { openSession, closeSession, maybeRuntime } from '../../integration/runtime';
import { initializeProfile } from '../settings/SettingsStore';
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
  } catch (error) { publish({ status: 'out', user: null, error: error.message }); }
}
const enqueue = user => (queue = queue.catch(() => undefined).then(() => apply(user)));
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') return; // Finish the reset UI before entering the application.
  setTimeout(() => { void enqueue(session?.user ?? null); }, 0);
});
supabase.auth.getSession().then(({ data, error }) => error ? publish({ status: 'out', user: null, error: error.message }) : enqueue(data.session?.user ?? null));
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
  try { await closeSession(true); const { error } = await supabase.auth.signOut({ scope: 'local' }); if (error) throw error; await enqueue(null); return { ok: true }; }
  catch (error) { publish(maybeRuntime() ? before : { status: 'out', user: null, error: error.message }); return { ok: false, message: error.message }; }
}
export async function deleteAccount() { throw new Error('계정 삭제는 서버 미리보기와 삭제 확인 화면 연결 후 사용할 수 있습니다'); }
