// Edge Function `push-send` 테스트 (Deno)
//   진짜 handler.ts + 로컬 Postgres(push_claim·push_report, service_role) + 가짜 Expo Push API
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check push_send.test.ts
import nodeAssert from "node:assert/strict";
const assert = (v: unknown, msg?: string) => nodeAssert.ok(v, msg);
const assertEquals = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepStrictEqual(a, b, msg);
import pg from "npm:pg@8";
import { createSender, type ExpoMessage } from "../functions/push-send/handler.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
async function client() { const c = new pg.Client(PG); await c.connect(); return c; }
const tok = (s: string) => `ExponentPushToken[${s.padEnd(22, "x")}]`;

Deno.test("push-send: 비밀값 확인 · Expo 묶음 발송 · 결과·잘못된 토큰 정리 · 재시도", async (t) => {
  const db = await client();
  const svc = await client();
  await svc.query("set role service_role");
  try {
    const secret = (await db.query(`select decrypted_secret from vault.decrypted_secrets where name = 'stt_cleanup_secret'`)).rows[0].decrypted_secret;
    // 사람 3명: u1 기기 2대(하나는 등록 해제된 토큰), u2 기기 1대, u3 기기 없음
    const [u1, u2, u3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const u of [u1, u2, u3]) await db.query(`insert into auth.users (id, email) values ($1, $2)`, [u, `${u}@t.dev`]);
    const dev = async (u: string, i: string, token: string) =>
      db.query(`insert into public.devices (account_id, installation_id, platform, app_version, push_provider, push_token) values ($1, $2, 'ios', '1', 'EXPO', $3)`, [u, i, token]);
    await dev(u1, "a", tok("good1")); await dev(u1, "b", tok("gone1")); await dev(u2, "c", tok("good2"));
    const note = async (u: string, k: string) =>
      (await db.query(`select private.notify($1, null, 'SYSTEM', '제목', '본문', '{"type":"test"}', $2) as r`, [u, k])).rows[0].r;
    // 130개 (u1 70 · u2 60) → 메시지 200개 = Expo 2묶음 이상 + push_claim 2번
    for (let i = 0; i < 70; i++) await note(u1, `t1-${i}`);
    for (let i = 0; i < 60; i++) await note(u2, `t2-${i}`);
    await note(u3, "t3-0");

    const calls: ExpoMessage[][] = [];
    let mode: "ok" | "down" = "ok";
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      try {
        const r = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
          keys.map((k) => (typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])));
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    };
    const handle = createSender({
      rpc,
      expo: async (messages) => {
        calls.push(messages);
        if (mode === "down") return new Response("bad gateway", { status: 502 });
        return Response.json({
          data: messages.map((m) => m.to === tok("gone1")
            ? { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }
            : { status: "ok", id: crypto.randomUUID() }),
        });
      },
    });
    const call = (s: string | null) => handle(new Request("https://x.test/functions/v1/push-send", {
      method: "POST", headers: s == null ? {} : { "x-cleanup-secret": s }, body: "{}",
    }));

    await t.step("비밀값이 없거나 틀리면 401, 아무것도 안 보냄", async () => {
      assertEquals((await call(null)).status, 401);
      assertEquals((await call("wrong")).status, 401);
      assertEquals(calls.length, 0);
    });

    await t.step("보내기: 묶음은 100개 이하, 사람마다 기기 수만큼", async () => {
      const res = await call(secret);
      const body = await res.json();
      assertEquals(res.status, 200);
      assert(calls.every((c) => c.length <= 100), "묶음 ≤ 100");
      const total = calls.reduce((s, c) => s + c.length, 0);
      assertEquals(total, 70 * 2 + 60, "u1 기기 2대 × 70 + u2 60");
      assertEquals([body.sent, body.notifications], [130, 130], JSON.stringify(body));
      const m = calls[0][0];
      assertEquals([m.title, m.body, m.sound, (m.data as Record<string, unknown>).type], ["제목", "본문", "default", "test"]);
      assert((m.data as Record<string, unknown>).notification_id, "열었을 때 알림 id");
    });

    await t.step("결과: 전부 SENT, 기기 없는 사람은 SKIPPED, 등록 해제 토큰은 기기에서 뺌", async () => {
      const st = (await db.query(`select account_id, status, count(*)::int as n from public.notifications group by 1, 2`)).rows;
      const n = (u: string, s: string) => st.find((r: any) => r.account_id === u && r.status === s)?.n ?? 0;
      assertEquals([n(u1, "SENT"), n(u2, "SENT"), n(u3, "SKIPPED")], [70, 60, 1]);
      const gone = (await db.query(`select push_token from public.devices where installation_id = 'b' and account_id = $1`, [u1])).rows[0];
      assertEquals(gone.push_token, null);
    });

    await t.step("Expo가 실패하면 1분 뒤 다시 (PENDING), 보낼 것이 없으면 Expo를 안 부름", async () => {
      await note(u2, "late-1");
      mode = "down";
      const before = calls.length;
      const body = await (await call(secret)).json();
      assertEquals([body.sent, body.failed], [0, 1]);
      const row = (await db.query(`select status, last_error, scheduled_for > now() as later from public.notifications where dedupe_key = 'late-1'`)).rows[0];
      assertEquals([row.status, row.last_error, row.later], ["PENDING", "HTTP_502", true]);
      assertEquals(calls.length, before + 1);
      mode = "ok";
      await call(secret);
      assertEquals(calls.length, before + 1, "아직 1분이 안 지나서 보낼 것 없음");
      await db.query(`update public.notifications set scheduled_for = now() - interval '1 second' where dedupe_key = 'late-1'`);
      const b2 = await (await call(secret)).json();
      assertEquals(b2.sent, 1);
    });
  } finally {
    await db.end(); await svc.end();
  }
});
