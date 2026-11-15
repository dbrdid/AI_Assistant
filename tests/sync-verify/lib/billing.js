"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serverPlan = exports.planId = exports.subscribePro = void 0;
exports.getSubscription = getSubscription;
exports.subscribe = subscribe;
exports.cancelSubscription = cancelSubscription;
exports.changePlan = changePlan;
exports.listPayments = listPayments;
exports.koreanDate = koreanDate;
exports.nextPaymentText = nextPaymentText;
exports.storageText = storageText;
exports.planOptionText = planOptionText;
exports.billingErrorMessage = billingErrorMessage;
const errors_1 = require("./errors");
/** 내 구독 (기간이 지났으면 서버가 먼저 정리한 뒤 돌려줌) */
async function getSubscription(client) {
    const { data, error } = await client.rpc('get_my_subscription');
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return data;
}
/** 유료 요금제 구독·변경 (가짜 결제). 같은 요금제 해지 예약 중이면 결제 없이 해지 취소, PRO ↔ TEAM은 바로 변경 */
async function subscribe(client, plan, opts) {
    if (!opts.requestId)
        throw new errors_1.SyncError('INVALID_REQUEST', 'requestId가 필요합니다 (newId())');
    if (plan !== 'PRO' && plan !== 'TEAM')
        throw new errors_1.SyncError('INVALID_REQUEST', '요금제는 PRO 또는 TEAM');
    const { data, error } = await client.rpc('subscription_checkout', {
        p_plan: plan,
        p_client_request_id: opts.requestId,
        p_simulate: opts.simulateDecline ? 'DECLINE' : null,
    });
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return data;
}
/** PRO 구독 (예전 이름 그대로) */
const subscribePro = (client, opts) => subscribe(client, 'PRO', opts);
exports.subscribePro = subscribePro;
/** 구독 해지: 다음 결제일까지 지금 요금제, 그 뒤 FREE. 여러 번 눌러도 같은 결과 */
async function cancelSubscription(client) {
    const { data, error } = await client.rpc('subscription_cancel');
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return data.subscription;
}
/**
 * 요금제 선택 화면에서 고른 요금제로
 *   pro·team → subscribe (FREE면 결제, 다른 유료 요금제면 바로 변경, 해지 예약이면 해지 취소, 이미 그 요금제면 그대로)
 *   free     → cancelSubscription (이미 무료·해지 예약이면 그대로)
 */
async function changePlan(client, target, opts) {
    if (target === 'pro')
        return subscribe(client, 'PRO', opts);
    if (target === 'team')
        return subscribe(client, 'TEAM', opts);
    if (target !== 'free')
        throw new errors_1.SyncError('INVALID_REQUEST', `알 수 없는 요금제: ${String(target)}`);
    const cur = await getSubscription(client);
    if (cur.plan === 'FREE')
        return { ok: true, action: 'ALREADY_FREE', subscription: cur };
    const sub = await cancelSubscription(client);
    return { ok: true, action: 'CANCEL_SCHEDULED', subscription: sub };
}
/** 결제 내역 (최근 순, 본인 것만) */
async function listPayments(client, limit = 20) {
    const { data, error } = await client
        .from('payments')
        .select('id, kind, plan, amount_krw, status, failure_code, period_start, period_end, payment_ref, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return (data ?? []);
}
// ---------------------------------------------------------------------
// 화면 문구
// ---------------------------------------------------------------------
const planId = (s) => (s.plan === 'TEAM' ? 'team' : s.plan === 'PRO' ? 'pro' : 'free');
exports.planId = planId;
/** 화면 PLANS 키 → 서버 요금제 */
const serverPlan = (id) => (id === 'team' ? 'TEAM' : id === 'pro' ? 'PRO' : 'FREE');
exports.serverPlan = serverPlan;
// 앱(Hermes)에서도 같은 결과가 나오게 Intl 없이 천 단위 쉼표
const won = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
/** "2026년 12월 15일" (한국 시간) */
function koreanDate(iso) {
    const d = new Date(Date.parse(iso) + 9 * 3600_000);
    return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}
/** 구독 관리 화면의 "다음 결제일" 자리 */
function nextPaymentText(s) {
    if (s.state === 'FREE')
        return '-  (무료 요금제는 결제가 없어요)';
    if (s.state === 'CANCELING' && s.current_period_end)
        return `${koreanDate(s.current_period_end)}부터 무료 요금제로 바뀌어요`;
    if (s.next_payment_at)
        return `${koreanDate(s.next_payment_at)} · ${won(s.next_payment_krw ?? s.price_krw[s.plan] ?? 0)}`;
    return '-';
}
/** 524288000 → "500MB", 10737418240 → "10GB" */
function storageText(bytes) {
    const GB = 1073741824;
    return bytes % GB === 0 ? `${bytes / GB}GB` : `${Math.round(bytes / 1048576)}MB`;
}
/** 요금제 선택 목록의 한 줄: "월 9,900원 · 초대 월 200회 · 공간 첨부 10GB" (무료는 "무료 · …") */
function planOptionText(s, id) {
    const p = s.plans?.[(0, exports.serverPlan)(id)];
    if (!p)
        return '';
    const price = p.price_krw > 0 ? `월 ${won(p.price_krw)}` : '무료';
    return `${price} · 초대 월 ${p.project_invites_per_month}회 · 공간 첨부 ${storageText(p.workspace_storage_bytes)}`;
}
/** 결제·구독 오류 → 화면 문구 */
function billingErrorMessage(err) {
    const code = err?.code ?? '';
    const text = {
        PAYMENT_DECLINED: '결제가 승인되지 않았어요. 결제 수단을 확인해 주세요',
        NOT_SUBSCRIBED: '이용 중인 유료 요금제가 없어요',
        AUTH_REQUIRED: '로그인이 필요해요',
    };
    return text[code] ?? '결제를 처리하지 못했어요. 잠시 후 다시 시도해 주세요';
}
