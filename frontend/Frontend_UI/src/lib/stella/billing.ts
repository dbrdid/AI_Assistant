// 구독 관리 · 가짜 결제 (시연용, 실제 결제사 연동 없음) — React Native 의존 없음
//   서버: migration #24 fake_billing + #28 team_plan (get_my_subscription · subscription_checkout · subscription_cancel · payments)
//
//   요금제 (월, 가짜 결제): FREE 0원 · PRO 4,900원 · TEAM 9,900원
//     TEAM = PRO의 AI 한도 + 이번 달 프로젝트 초대 200회(PRO 50, FREE 10) + 내가 관리자인 공간의 첨부 용량 10GB(PRO 2GB, FREE 500MB)
//     백업 용량 PRO·TEAM 1GB(FREE 200MB). 공간 인원 한도는 없음. 숫자는 sub.plans에 서버 값 그대로 와요
//
//   [구독 관리 화면]
//     const sub = await getSubscription(supabase);          // 현재 요금제 · 다음 결제일
//     planId(sub) → 'free' | 'pro' | 'team'  (화면 PLANS 키)
//     nextPaymentText(sub)          → "2026년 12월 15일 · 9,900원" / "12월 15일부터 무료 요금제로 바뀌어요" / "-  (무료 요금제는 결제가 없어요)"
//   [요금제 변경 → 선택]
//     const r = await changePlan(supabase, 'team', { requestId });  // requestId = 버튼을 누를 때 한 번 newId() (재시도 때 같은 값)
//     r.ok === false (PAYMENT_DECLINED) → PaymentFailedDialog
//     r.action: SUBSCRIBED(무료 → 유료) · CHANGED(PRO ↔ TEAM, 바로 바뀌고 오늘부터 새 1개월, 일할 계산 없음)
//               RESUMED(해지 예약 중 같은 요금제 → 해지 취소) · ALREADY_ACTIVE
//     'free' 선택 = 구독 해지와 같음 (다음 결제일부터 무료)
//   [구독 해지] await cancelSubscription(supabase)  → 다음 결제일까지 지금 요금제 유지
//   [결제 실패 시연] changePlan(supabase, 'pro', { requestId, simulateDecline: true })
//   [요금제 선택 목록] planOptionText(sub, 'team') → "월 9,900원 · 초대 월 200회 · 공간 첨부 10GB"
//   요금제가 바뀌면 AI 한도·초대 횟수·첨부 용량도 바로 바뀜 (서버가 subscriptions를 읽음). 이용량 화면을 다시 불러오세요
import type { SupabaseClient } from '@supabase/supabase-js';
import { SyncError, toSyncError } from './errors';

export type SubscriptionState = 'FREE' | 'ACTIVE' | 'CANCELING';
export type ServerPlan = 'FREE' | 'PRO' | 'TEAM';
export type PaidPlan = 'PRO' | 'TEAM';
/** 요금제별 혜택 (서버 private.plan_catalog) */
export interface PlanBenefits {
  price_krw: number;
  project_invites_per_month: number;
  workspace_storage_bytes: number;   // 내가 관리자인 공간 하나의 첨부 합계
  backup_storage_bytes: number;
  ai: { organize: number; analyze: number; query: number; agenda: number; ocr: number; stt_minutes: number };
}
export interface Subscription {
  plan: ServerPlan;
  state: SubscriptionState;          // CANCELING = 해지 예약 (current_period_end까지 지금 요금제)
  current_period_start: string | null;
  current_period_end: string | null;
  next_payment_at: string | null;    // 다음 결제일 (해지 예약·무료면 null)
  next_payment_krw: number | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  price_krw: Record<ServerPlan, number>;
  plans: Record<ServerPlan, PlanBenefits>;
}
export interface PaymentSummary {
  payment_ref: string;
  plan: PaidPlan;
  amount_krw: number;
  status: 'PAID' | 'FAILED';
  period_start?: string;
  period_end?: string;
}
export type CheckoutResult =
  | { ok: true; action: 'SUBSCRIBED'; payment: PaymentSummary; subscription: Subscription; replayed?: true }
  | { ok: true; action: 'CHANGED'; previous_plan: PaidPlan; payment: PaymentSummary; subscription: Subscription; replayed?: true }
  | { ok: true; action: 'RESUMED' | 'ALREADY_ACTIVE'; subscription: Subscription; replayed?: true }
  | { ok: false; code: 'PAYMENT_DECLINED'; message: string; payment: PaymentSummary; subscription: Subscription; replayed?: true };
export interface PaymentRow {
  id: string;
  kind: 'CHECKOUT' | 'RENEWAL';
  plan: PaidPlan;
  amount_krw: number;
  status: 'PAID' | 'FAILED';
  failure_code: string | null;
  period_start: string | null;
  period_end: string | null;
  payment_ref: string;
  created_at: string;
}
/** 화면 PLANS 키 */
export type AppPlanId = 'free' | 'pro' | 'team';

/** 내 구독 (기간이 지났으면 서버가 먼저 정리한 뒤 돌려줌) */
export async function getSubscription(client: SupabaseClient): Promise<Subscription> {
  const { data, error } = await client.rpc('get_my_subscription');
  if (error) throw toSyncError(error);
  return data as Subscription;
}

/** 유료 요금제 구독·변경 (가짜 결제). 같은 요금제 해지 예약 중이면 결제 없이 해지 취소, PRO ↔ TEAM은 바로 변경 */
export async function subscribe(
  client: SupabaseClient,
  plan: PaidPlan,
  opts: { requestId: string; simulateDecline?: boolean },
): Promise<CheckoutResult> {
  if (!opts.requestId) throw new SyncError('INVALID_REQUEST', 'requestId가 필요합니다 (newId())');
  if (plan !== 'PRO' && plan !== 'TEAM') throw new SyncError('INVALID_REQUEST', '요금제는 PRO 또는 TEAM');
  const { data, error } = await client.rpc('subscription_checkout', {
    p_plan: plan,
    p_client_request_id: opts.requestId,
    p_simulate: opts.simulateDecline ? 'DECLINE' : null,
  });
  if (error) throw toSyncError(error);
  return data as CheckoutResult;
}

/** PRO 구독 (예전 이름 그대로) */
export const subscribePro = (client: SupabaseClient, opts: { requestId: string; simulateDecline?: boolean }) => subscribe(client, 'PRO', opts);

/** 구독 해지: 다음 결제일까지 지금 요금제, 그 뒤 FREE. 여러 번 눌러도 같은 결과 */
export async function cancelSubscription(client: SupabaseClient): Promise<Subscription> {
  const { data, error } = await client.rpc('subscription_cancel');
  if (error) throw toSyncError(error);
  return (data as { subscription: Subscription }).subscription;
}

/**
 * 요금제 선택 화면에서 고른 요금제로
 *   pro·team → subscribe (FREE면 결제, 다른 유료 요금제면 바로 변경, 해지 예약이면 해지 취소, 이미 그 요금제면 그대로)
 *   free     → cancelSubscription (이미 무료·해지 예약이면 그대로)
 */
export async function changePlan(
  client: SupabaseClient,
  target: AppPlanId,
  opts: { requestId: string; simulateDecline?: boolean },
): Promise<CheckoutResult | { ok: true; action: 'CANCEL_SCHEDULED' | 'ALREADY_FREE'; subscription: Subscription }> {
  if (target === 'pro') return subscribe(client, 'PRO', opts);
  if (target === 'team') return subscribe(client, 'TEAM', opts);
  if (target !== 'free') throw new SyncError('INVALID_REQUEST', `알 수 없는 요금제: ${String(target)}`);
  const cur = await getSubscription(client);
  if (cur.plan === 'FREE') return { ok: true, action: 'ALREADY_FREE', subscription: cur };
  const sub = await cancelSubscription(client);
  return { ok: true, action: 'CANCEL_SCHEDULED', subscription: sub };
}

/** 결제 내역 (최근 순, 본인 것만) */
export async function listPayments(client: SupabaseClient, limit = 20): Promise<PaymentRow[]> {
  const { data, error } = await client
    .from('payments')
    .select('id, kind, plan, amount_krw, status, failure_code, period_start, period_end, payment_ref, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw toSyncError(error);
  return (data ?? []) as PaymentRow[];
}

// ---------------------------------------------------------------------
// 화면 문구
// ---------------------------------------------------------------------
export const planId = (s: Pick<Subscription, 'plan'>): AppPlanId => (s.plan === 'TEAM' ? 'team' : s.plan === 'PRO' ? 'pro' : 'free');
/** 화면 PLANS 키 → 서버 요금제 */
export const serverPlan = (id: AppPlanId): ServerPlan => (id === 'team' ? 'TEAM' : id === 'pro' ? 'PRO' : 'FREE');

// 앱(Hermes)에서도 같은 결과가 나오게 Intl 없이 천 단위 쉼표
const won = (n: number) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
/** "2026년 12월 15일" (한국 시간) */
export function koreanDate(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}
/** 구독 관리 화면의 "다음 결제일" 자리 */
export function nextPaymentText(s: Subscription): string {
  if (s.state === 'FREE') return '-  (무료 요금제는 결제가 없어요)';
  if (s.state === 'CANCELING' && s.current_period_end) return `${koreanDate(s.current_period_end)}부터 무료 요금제로 바뀌어요`;
  if (s.next_payment_at) return `${koreanDate(s.next_payment_at)} · ${won(s.next_payment_krw ?? s.price_krw[s.plan] ?? 0)}`;
  return '-';
}

/** 524288000 → "500MB", 10737418240 → "10GB" */
export function storageText(bytes: number): string {
  const GB = 1073741824;
  return bytes % GB === 0 ? `${bytes / GB}GB` : `${Math.round(bytes / 1048576)}MB`;
}

/** 요금제 선택 목록의 한 줄: "월 9,900원 · 초대 월 200회 · 공간 첨부 10GB" (무료는 "무료 · …") */
export function planOptionText(s: Pick<Subscription, 'plans'>, id: AppPlanId): string {
  const p = s.plans?.[serverPlan(id)];
  if (!p) return '';
  const price = p.price_krw > 0 ? `월 ${won(p.price_krw)}` : '무료';
  return `${price} · 초대 월 ${p.project_invites_per_month}회 · 공간 첨부 ${storageText(p.workspace_storage_bytes)}`;
}

/** 결제·구독 오류 → 화면 문구 */
export function billingErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  const text: Record<string, string> = {
    PAYMENT_DECLINED: '결제가 승인되지 않았어요. 결제 수단을 확인해 주세요',
    NOT_SUBSCRIBED: '이용 중인 유료 요금제가 없어요',
    AUTH_REQUIRED: '로그인이 필요해요',
  };
  return text[code] ?? '결제를 처리하지 못했어요. 잠시 후 다시 시도해 주세요';
}
