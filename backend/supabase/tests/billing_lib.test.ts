// 앱 모듈 billing.ts ↔ 가짜 결제 RPC (로컬 DB, RLS 그대로) 연결 테스트 (Deno)
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check --config deno.test.json billing_lib.test.ts
//   가짜 Supabase 클라이언트: rpc·from('payments')를 로그인 사용자 권한(authenticated + JWT)으로 로컬 DB에 그대로 보냄
import nodeAssert from "node:assert/strict";
import pg from "npm:pg@8";
import * as B from "../../../frontend/Frontend_UI/src/lib/stella/billing.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => nodeAssert.ok(v, m);

async function asUser(uid: string) {
  const c = new pg.Client(PG);
  await c.connect();
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
  await c.query("set role authenticated");
  return c;
}

// supabase-js처럼 { data, error }를 돌려주는 최소 클라이언트
function fakeClient(c: pg.Client) {
  return {
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args);
      try {
        const r = await c.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
    from(table: string) {
      eq(table, "payments");
      let cols = "*", order = "", lim = "";
      const q = {
        select(s: string) { cols = s; return q; },
        order(col: string, o: { ascending: boolean }) { order = ` order by ${col} ${o.ascending ? "asc" : "desc"}`; return q; },
        limit(n: number) { lim = ` limit ${n}`; return q; },
        then(res: (v: unknown) => void, rej: (e: unknown) => void) {
          c.query(`select ${cols} from public.payments${order}${lim}`)
            .then((r) => res({ data: r.rows.map((x) => ({ ...x, created_at: x.created_at?.toISOString?.() ?? x.created_at })), error: null }), rej);
        },
      };
      return q;
    },
  };
}

Deno.test("billing.ts: 구독 → 해지 예약 → 해지 취소 → 무료로 변경 → 기간 끝 → 결제 실패 시연", async () => {
  const admin = new pg.Client(PG); await admin.connect();
  const me = crypto.randomUUID(), other = crypto.randomUUID();
  for (const id of [me, other]) await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@t.dev`]);
  const c = await asUser(me);
  const sb = fakeClient(c) as never;

  // 처음: FREE
  const s0 = await B.getSubscription(sb);
  eq([s0.plan, s0.state, B.planId(s0)], ["FREE", "FREE", "free"]);
  eq(B.nextPaymentText(s0), "-  (무료 요금제는 결제가 없어요)");
  eq(s0.price_krw.PRO, 4900);
  const f0 = await B.changePlan(sb, "free", { requestId: crypto.randomUUID() });
  eq(f0.ok && "action" in f0 && f0.action, "ALREADY_FREE", "무료에서 무료 선택 → 그대로");

  // 요금제 선택 목록 문구 (서버 plans 값)
  eq(s0.price_krw.TEAM, 9900);
  eq(B.planOptionText(s0, "free"), "무료 · 초대 월 10회 · 공간 첨부 500MB");
  eq(B.planOptionText(s0, "pro"), "월 4,900원 · 초대 월 50회 · 공간 첨부 2GB");
  eq(B.planOptionText(s0, "team"), "월 9,900원 · 초대 월 200회 · 공간 첨부 10GB");
  eq(s0.plans.TEAM.ai.query, s0.plans.PRO.ai.query, "TEAM AI 한도 = PRO");
  await nodeAssert.rejects(() => B.changePlan(sb, "gold" as never, { requestId: crypto.randomUUID() }), (e: Error & { code?: string }) => e.code === "INVALID_REQUEST");

  // 결제 실패 시연 → PaymentFailedDialog
  const rid0 = crypto.randomUUID();
  const d = await B.changePlan(sb, "pro", { requestId: rid0, simulateDecline: true });
  ok(!d.ok && "code" in d && d.code === "PAYMENT_DECLINED", JSON.stringify(d));
  eq(B.billingErrorMessage(d), "결제가 승인되지 않았어요. 결제 수단을 확인해 주세요");
  eq((await B.getSubscription(sb)).plan, "FREE", "실패하면 요금제 그대로");

  // 구독: 같은 requestId로 두 번 눌러도 결제 1번
  const rid = crypto.randomUUID();
  const r1 = await B.changePlan(sb, "pro", { requestId: rid });
  const r2 = await B.subscribePro(sb, { requestId: rid });
  ok(r1.ok && r1.action === "SUBSCRIBED", JSON.stringify(r1));
  ok(r2.ok && r2.action === "SUBSCRIBED" && r2.replayed, "재시도는 처음 결과");
  const s1 = await B.getSubscription(sb);
  eq([s1.plan, s1.state, B.planId(s1)], ["PRO", "ACTIVE", "pro"]);
  ok(/^\d{4}년 \d{1,2}월 \d{1,2}일 · 4,900원$/.test(B.nextPaymentText(s1)), B.nextPaymentText(s1));
  const pays = await B.listPayments(sb);
  eq(pays.map((p) => [p.kind, p.status]), [["CHECKOUT", "PAID"], ["CHECKOUT", "FAILED"]], "결제 내역: 최근 순, 실패도 남음");

  // 무료 선택 = 해지 예약 (다음 결제일까지 PRO)
  const x = await B.changePlan(sb, "free", { requestId: crypto.randomUUID() });
  ok(x.ok && "action" in x && x.action === "CANCEL_SCHEDULED");
  const s2 = await B.getSubscription(sb);
  eq([s2.plan, s2.state, s2.next_payment_at], ["PRO", "CANCELING", null]);
  ok(B.nextPaymentText(s2).endsWith("부터 무료 요금제로 바뀌어요"), B.nextPaymentText(s2));
  eq((await B.cancelSubscription(sb)).state, "CANCELING", "해지 두 번 → 그대로");

  // 해지 예약 중 PRO → 결제 없이 해지 취소
  const r3 = await B.changePlan(sb, "pro", { requestId: crypto.randomUUID() });
  ok(r3.ok && r3.action === "RESUMED", JSON.stringify(r3));
  eq((await B.listPayments(sb)).length, 2, "해지 취소는 결제 없음");

  // 해지 → 기간 끝 → 조회하면 FREE
  await B.cancelSubscription(sb);
  await admin.query(`update public.subscriptions set current_period_start = now() - interval '1 month', current_period_end = now() - interval '1 minute' where account_id = $1`, [me]);
  const s3 = await B.getSubscription(sb);
  eq([s3.plan, s3.state], ["FREE", "FREE"], "기간이 끝나면 조회 때 FREE로");
  await nodeAssert.rejects(() => B.cancelSubscription(sb), (e: Error & { code?: string }) => {
    eq(e.code, "NOT_SUBSCRIBED"); eq(B.billingErrorMessage(e), "이용 중인 유료 요금제가 없어요"); return true;
  });

  // 다른 사람은 내 결제 내역을 못 봄
  const o = await asUser(other);
  eq((await B.listPayments(fakeClient(o) as never)).length, 0);
  await nodeAssert.rejects(() => B.subscribePro(sb, { requestId: "" }), (e: Error & { code?: string }) => e.code === "INVALID_REQUEST");

  await c.end(); await o.end(); await admin.end();
});

Deno.test("billing.ts: Team 요금제 — 구독 · PRO로 바꾸기 · 다시 TEAM · 해지 · 결제 실패", async () => {
  const admin = new pg.Client(PG); await admin.connect();
  const me = crypto.randomUUID();
  await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [me, `${me}@t.dev`]);
  const c = await asUser(me);
  const sb = fakeClient(c) as never;

  const d = await B.changePlan(sb, "team", { requestId: crypto.randomUUID(), simulateDecline: true });
  ok(!d.ok && d.code === "PAYMENT_DECLINED" && d.payment.plan === "TEAM" && d.payment.amount_krw === 9900, JSON.stringify(d));

  const rid = crypto.randomUUID();
  const t1 = await B.changePlan(sb, "team", { requestId: rid });
  const t1b = await B.subscribe(sb, "TEAM", { requestId: rid });
  ok(t1.ok && t1.action === "SUBSCRIBED" && t1.payment.plan === "TEAM" && t1.payment.amount_krw === 9900, JSON.stringify(t1));
  ok(t1b.ok && t1b.replayed, "같은 요청 재시도 → 처음 결과");
  const s1 = await B.getSubscription(sb);
  eq([s1.plan, B.planId(s1)], ["TEAM", "team"]);
  ok(/^\d{4}년 \d{1,2}월 \d{1,2}일 · 9,900원$/.test(B.nextPaymentText(s1)), B.nextPaymentText(s1));
  const inv = await c.query(`select public.get_project_invite_quota() as q`);
  eq(inv.rows[0].q.limit, 200, "TEAM 이번 달 초대 200회");

  const p1 = await B.changePlan(sb, "pro", { requestId: crypto.randomUUID() });
  ok(p1.ok && p1.action === "CHANGED" && p1.previous_plan === "TEAM" && p1.payment.amount_krw === 4900, JSON.stringify(p1));
  eq(B.planId(p1.subscription), "pro");
  const t2 = await B.changePlan(sb, "team", { requestId: crypto.randomUUID() });
  ok(t2.ok && t2.action === "CHANGED" && t2.previous_plan === "PRO", JSON.stringify(t2));

  const x = await B.changePlan(sb, "free", { requestId: crypto.randomUUID() });
  ok(x.ok && "action" in x && x.action === "CANCEL_SCHEDULED" && x.subscription.plan === "TEAM" && x.subscription.state === "CANCELING");
  const t3 = await B.changePlan(sb, "team", { requestId: crypto.randomUUID() });
  ok(t3.ok && t3.action === "RESUMED", "해지 예약 중 TEAM → 해지 취소");

  const pays = await B.listPayments(sb);
  eq(pays.map((p) => [p.plan, p.amount_krw, p.status]),
    [["TEAM", 9900, "PAID"], ["PRO", 4900, "PAID"], ["TEAM", 9900, "PAID"], ["TEAM", 9900, "FAILED"]], "결제 내역: 요금제·금액");
  await c.end(); await admin.end();
});

Deno.test("billing.ts: 화면 문구 (한국 시간 날짜)", () => {
  eq(B.koreanDate("2026-12-14T15:30:00Z"), "2026년 12월 15일", "UTC 15:30 = 한국 다음날 0:30");
  const plans = {} as B.Subscription["plans"];
  const base = { plan: "PRO", current_period_start: null, canceled_at: null, price_krw: { FREE: 0, PRO: 4900, TEAM: 9900 }, plans } as const;
  eq(B.nextPaymentText({ ...base, state: "ACTIVE", current_period_end: "2026-12-15T03:00:00Z", next_payment_at: "2026-12-15T03:00:00Z", next_payment_krw: 4900, cancel_at_period_end: false }),
    "2026년 12월 15일 · 4,900원");
  eq(B.nextPaymentText({ ...base, state: "CANCELING", current_period_end: "2026-12-15T03:00:00Z", next_payment_at: null, next_payment_krw: null, cancel_at_period_end: true }),
    "2026년 12월 15일부터 무료 요금제로 바뀌어요");
  eq(B.nextPaymentText({ ...base, plan: "TEAM", state: "ACTIVE", current_period_end: "2026-12-15T03:00:00Z", next_payment_at: "2026-12-15T03:00:00Z", next_payment_krw: null, cancel_at_period_end: false }),
    "2026년 12월 15일 · 9,900원", "금액이 없으면 그 요금제 가격");
  eq([B.storageText(524288000), B.storageText(2147483648), B.storageText(10737418240), B.storageText(1073741824)], ["500MB", "2GB", "10GB", "1GB"]);
  eq([B.serverPlan("team"), B.serverPlan("pro"), B.serverPlan("free")], ["TEAM", "PRO", "FREE"]);
  eq(B.planOptionText({ plans }, "team"), "", "표가 없으면 빈 문구");
});
