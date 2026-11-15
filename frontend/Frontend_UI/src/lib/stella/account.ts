// 내 프로필 · 설정 · 동의 · AI 사용량
//   계정·프로필·설정 행은 회원가입 때 서버가 자동으로 만듭니다 (앱이 insert하지 않음).
import { AI_MONTHLY_LIMITS, DEFAULT_TIMEZONE, POLICY_VERSION } from './config';
import { requireUserId, supabase } from './supabase';
import { toSyncError } from './errors';
import type { Json } from './database.types';
import type { ConsentType, Plan, Row } from './types';

// ---------------------------------------------------------------------
// 프로필 (이름·소속·사진 경로만 수정 가능)
// ---------------------------------------------------------------------
export async function getMyProfile(): Promise<Row<'profiles'>> {
  const uid = await requireUserId();
  const { data, error } = await supabase.from('profiles').select('*').eq('account_id', uid).single();
  if (error) throw toSyncError(error);
  return data;
}

export async function updateMyProfile(patch: { display_name?: string; affiliation?: string | null; avatar_path?: string | null }) {
  const uid = await requireUserId();
  const { data, error } = await supabase.from('profiles').update(patch).eq('account_id', uid).select('*').single();
  if (error) throw toSyncError(error);
  return data;
}

// ---------------------------------------------------------------------
// 설정 (시간대·언어·온보딩 완료·약관 동의 시각·기타 preferences)
// ---------------------------------------------------------------------
export async function getMySettings(): Promise<Row<'user_settings'>> {
  const uid = await requireUserId();
  const { data, error } = await supabase.from('user_settings').select('*').eq('account_id', uid).single();
  if (error) throw toSyncError(error);
  return data;
}

export async function updateMySettings(patch: {
  timezone?: string;
  locale?: string;
  onboarding_completed_at?: string | null;
  terms_agreed_at?: string | null;
  preferences?: Json;
}) {
  const uid = await requireUserId();
  const { data, error } = await supabase.from('user_settings').update(patch).eq('account_id', uid).select('*').single();
  if (error) throw toSyncError(error);
  return data;
}

export async function getMyTimezone(): Promise<string> {
  try {
    return (await getMySettings()).timezone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

// ---------------------------------------------------------------------
// 동의: EXTERNAL_AI가 없으면 AI Gateway가 CONSENT_REQUIRED로 거절합니다
// ---------------------------------------------------------------------
export async function getActiveConsents(): Promise<Row<'consents'>[]> {
  const uid = await requireUserId();
  const { data, error } = await supabase
    .from('consents').select('*')
    .eq('account_id', uid).is('revoked_at', null)
    .order('granted_at', { ascending: false });
  if (error) throw toSyncError(error);
  return data;
}

export async function hasConsent(type: ConsentType): Promise<boolean> {
  return (await getActiveConsents()).some((c) => c.consent_type === type);
}

/** 동의 기록. scope 예: { provider: 'openai', features: ['organize', 'analyze'] } */
export async function grantConsent(type: ConsentType, scope: Json = {}, policyVersion = POLICY_VERSION) {
  const uid = await requireUserId();
  const { data, error } = await supabase
    .from('consents')
    .insert({ account_id: uid, consent_type: type, scope, policy_version: policyVersion })
    .select('*').single();
  if (error) throw toSyncError(error);
  return data;
}

/** 동의 철회 (해당 종류의 유효한 동의 전부) */
export async function revokeConsent(type: ConsentType) {
  const uid = await requireUserId();
  const { error } = await supabase
    .from('consents')
    .update({ revoked_at: new Date().toISOString() })
    .eq('account_id', uid).eq('consent_type', type).is('revoked_at', null);
  if (error) throw toSyncError(error);
}

// ---------------------------------------------------------------------
// 요금제 · 이번 달 AI 사용량 (화면에 "남은 횟수" 표시용)
// ---------------------------------------------------------------------
export type AiEndpoint = keyof (typeof AI_MONTHLY_LIMITS)['FREE'];

export async function getMyPlan(): Promise<Plan> {
  const uid = await requireUserId();
  const { data } = await supabase.from('subscriptions').select('plan, status').eq('account_id', uid).maybeSingle();
  return data?.status === 'ACTIVE' && data.plan === 'PRO' ? 'PRO' : 'FREE';
}

export async function getAiUsage(): Promise<Record<AiEndpoint, { used: number; reserved: number; limit: number; remaining: number }>> {
  const uid = await requireUserId();
  const plan = await getMyPlan();
  const month = monthStartSeoul();
  const { data, error } = await supabase
    .from('usage_counters').select('metric, used, reserved')
    .eq('account_id', uid).eq('period_start', month);
  if (error) throw toSyncError(error);

  const limits = AI_MONTHLY_LIMITS[plan];
  const out = {} as Record<AiEndpoint, { used: number; reserved: number; limit: number; remaining: number }>;
  for (const ep of Object.keys(limits) as AiEndpoint[]) {
    const row = data.find((r) => r.metric === `AI_${ep.toUpperCase()}`);
    const used = Number(row?.used ?? 0);
    const reserved = Number(row?.reserved ?? 0);
    out[ep] = { used, reserved, limit: limits[ep], remaining: Math.max(0, limits[ep] - used - reserved) };
  }
  return out;
}

// 서버는 한국 시간 기준 월 1일로 사용량을 묶습니다
function monthStartSeoul(): string {
  const seoul = new Date(Date.now() + 9 * 3600_000);
  return `${seoul.getUTCFullYear()}-${String(seoul.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
