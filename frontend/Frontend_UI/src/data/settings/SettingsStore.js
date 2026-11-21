import { runtime, runtimeSubscribe, useValue, readPreference, writePreference } from '../hooks';
import { grantConsent, hasConsent, revokeConsent, updateMyProfile } from '../../lib/stella/account';
import { getSubscription } from '../../lib/stella/billing';
import { supabase } from '../../lib/stella/supabase';
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
// 로컬(자체 호스팅) AI를 사용하려면 SERVER_AI 동의 마이그레이션, ai-gateway v15, 접속 가능한 모델 서버가 필요합니다.
// 배포가 완료되기 전까지 채팅은 전송 오류를 내는 대신 "준비 중"으로 표시합니다.
export const LOCAL_AI_AVAILABLE = false;
export const AI_ROUTE_LABEL = { external: '클라우드 AI', self_hosted: '로컬 AI' };

// 선택한 AI 경로로 보내기를 켜거나 끕니다. 먼저 서버에 동의를 기록하고, 서버가 승인한 뒤에만 기기 설정을
// 켭니다(동의를 취소하기 전에는 먼저 끄므로 실패하더라도 설정이 켜진 채로 남지 않습니다).
export async function setAiTransmission(route, enabled) {
  const own = runtime();
  const type = route === 'self_hosted' ? 'SERVER_AI' : 'EXTERNAL_AI';
  const denied = { route, transmissionDisabled: true, allowedProviders: [], consent: {} };
  updateSettings('ai', denied);
  // 경로를 여러 번 전환해도 서버에 중복 동의 행이 쌓이지 않아야 합니다.
  if (enabled) { if (!(await hasConsent(type))) await grantConsent(type, { provider: route }); } else await revokeConsent(type);
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다');
  return updateSettings('ai', { route, transmissionDisabled: !enabled, allowedProviders: enabled ? [route] : [], consent: { [route]: enabled } });
}
// 이번 달 AI 사용량입니다. 한도는 요금제 카탈로그(FREE/PRO/TEAM)에서, 횟수는 usage_counters(사용량 + 진행 중 요청 예약량)에서 가져옵니다.
// 기기 카운터(getUsage)는 표시 전용입니다.
const USAGE_ITEMS = [
  { key: 'query', metric: 'AI_QUERY', label: 'AI 채팅 질문' },
  { key: 'ocr', metric: 'AI_OCR', label: '사진 글자 인식' },
  { key: 'analyze', metric: 'AI_ANALYZE', label: '일정·할 일 추출' },
  { key: 'organize', metric: 'AI_ORGANIZE', label: '메모 정리' },
];
export async function loadAiUsage() {
  const own = runtime();
  const sub = await getSubscription(supabase);
  const seoul = new Date(Date.now() + 9 * 3600_000);
  const month = `${seoul.getUTCFullYear()}-${String(seoul.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const { data, error } = await supabase.from('usage_counters').select('metric, used, reserved')
    .eq('account_id', own.session.id).eq('period_start', month);
  if (error) throw error;
  const limits = sub.plans?.[sub.plan]?.ai ?? {};
  return {
    plan: sub.plan === 'TEAM' ? 'team' : sub.plan === 'PRO' ? 'pro' : 'free',
    items: USAGE_ITEMS.map(({ key, metric, label }) => {
      const row = data.find(r => r.metric === metric);
      const used = Number(row?.used ?? 0) + Number(row?.reserved ?? 0);
      const limit = Number(limits[key] ?? 0);
      return { key, label, used, limit, remaining: Math.max(0, limit - used) };
    }),
  };
}

// 경로를 바꾸면 항상 전송을 끕니다. 동의는 경로별로 관리되므로 다시 받아야 합니다.
export const setAiRoute = route => updateSettings('ai', { route, transmissionDisabled: true, allowedProviders: [], consent: {} });

// 서버 구독 정보(get_my_subscription)를 표시용으로 복사합니다. 한도 판정의 기준은 계속 서버입니다.
export function setServerPlan(plan) {
  if (!PLANS[plan]) throw new Error(`알 수 없는 요금제: ${plan}`);
  const s = getSettings();
  return s.plan === plan ? s : writePreference('settings', { ...s, plan });
}
export const getUsage =() => readPreference('usage-display', { question: 0, summary: 0, record: 0 });
// 표시용 카운터는 실제 할당량의 기준이 아닙니다. 실제 사용량은 게이트웨이와 DB에서 제한합니다.
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
