import { runtime, runtimeSubscribe, useValue, readPreference, writePreference } from '../hooks';
import { updateMyProfile } from '../../lib/stella/account';
export const WEEKDAY_NAMES = ['월요일','화요일','수요일','목요일','금요일','토요일','일요일'];
export const PLANS = { free: { name: 'Free', price: 0 }, pro: { name: 'Pro', price: 4900 }, team: { name: 'Team', price: 9900 } };
export const USAGE_LABELS = { question: '질문', summary: '요약', record: '녹음' };
const DEFAULTS = Object.freeze({ plan: 'free', profile: { name: '', email: '', affiliation: '' }, setup: { purpose: '', timezone: 'Asia/Seoul' },
  ai: { autoAnalyze: false, confirmMode: 'confirm', route: 'external', allowedProviders: [], consent: {}, transmissionDisabled: true,
    targets: { schedule: true, task: true, person: true, place: true }, autoSummary: true,
    daily: { on: false, time: '09:00' }, weekly: { on: false, day: '월요일', time: '09:00' } },
  notify: { schedule: true, due: true, aiConfirm: true, briefing: false, dndOn: false, dndStart: '22:00', dndEnd: '08:00' },
  brief: { items: { schedule: true, task: true, due: true, note: true }, contextual: true, channels: { app: true, voice: false, external: false } },
  security: { lock: false, biometric: false, autoLock: '즉시' }, backup: { auto: false, keep: 10 } });
export const getSettings = () => readPreference('settings', DEFAULTS);
export const useSettings = () => useValue(getSettings);
export const subscribeSettings = runtimeSubscribe;
export function updateSettings(section, patch) {
  if (section === 'plan') throw new Error('요금제는 서버 구독 API에서만 변경할 수 있습니다');
  if (section === 'ai' && patch.confirmMode === 'auto') throw new Error('통합 버전은 사용자 확인 후 저장만 지원합니다');
  const s = getSettings();
  return writePreference('settings', { ...s, [section]: { ...s[section], ...patch } });
}
export const getUsage = () => readPreference('usage-display', { question: 0, summary: 0, record: 0 });
// Display counters are not quota authority. Gateway and DB enforce real usage.
export const addUsage = key => writePreference('usage-display', { ...getUsage(), [key]: (getUsage()[key] ?? 0) + 1 });
export const limitOf = () => null;
export const changePassword = async () => ({ ok: false, reason: 'reset-flow-required' });
export async function saveProfile(patch) {
  const own = runtime();
  const profile = await updateMyProfile({ display_name: patch.name, affiliation: patch.affiliation || null });
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다');
  return updateSettings('profile', { name: profile.display_name, affiliation: profile.affiliation ?? '' });
}
export function initializeProfile(user) {
  const s = getSettings();
  writePreference('settings', { ...DEFAULTS, ...s, profile: {
    affiliation: user.user_metadata?.affiliation ?? '', ...s.profile,
    name: s.profile?.name || user.user_metadata?.display_name || user.email || '', email: user.email ?? '' } });
}
