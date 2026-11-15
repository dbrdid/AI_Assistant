// Edge Function `invite-mail` 테스트 (Deno)
//   진짜 handler.ts + 로컬 Postgres(invite_mail_prepare/result, service_role) + 가짜 SMTP
//   + nodemailer(index.ts와 같은 패키지)로 실제 메일 원문을 만들어 한글 제목·본문이 깨지지 않는지
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check invite_mail.test.ts
import nodeAssert from "node:assert/strict";
const assert = (v: unknown, msg?: string) => nodeAssert.ok(v, msg);
const assertEquals = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepStrictEqual(a, b, msg);
import pg from "npm:pg@8";
import nodemailer from "npm:nodemailer@6.9.16";
import { buildInviteMail, createHandler, koreanDateTime, type MailMessage } from "../functions/invite-mail/handler.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
async function client() { const c = new pg.Client(PG); await c.connect(); return c; }

Deno.test("invite-mail: 확인 → 보내기 → 기록, 설정 없음·실패·한도·권한", async (t) => {
  const db = await client();
  const svc = await client();
  await svc.query("set role service_role");
  try {
    const own = crypto.randomUUID(), other = crypto.randomUUID();
    for (const [id, n] of [[own, "보내는 사람"], [other, "다른 사람"]]) {
      await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, jsonb_build_object('name', $3::text))`, [id, `${id}@t.dev`, n]);
    }
    const as = async (uid: string, sql: string, params: unknown[] = []) => {
      const c = await client();
      await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await c.query("set role authenticated");
      const r = await c.query(sql, params);
      await c.end();
      return r.rows[0]?.r;
    };
    const ws = await as(own, "select public.create_workspace('메일 시험 공간') as r");
    const inv = await as(own, "select public.create_invite($1, 'EDITOR', 48, 1) as r", [ws]);

    const sent: MailMessage[] = [];
    let smtp: "ok" | "down" = "ok";
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      try {
        const r = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    };
    const make = (configured: boolean) => createHandler({
      getUserId: async (tk) => (tk.startsWith("user:") ? tk.slice(5) : null),
      rpc,
      sendMail: configured ? async (m) => { if (smtp === "down") throw new Error("535 auth failed"); sent.push(m); } : null,
      inviteUrlBase: "stella://invite",
    });
    const post = async (h: (r: Request) => Promise<Response>, uid: string | null, body: unknown, path = "send") => {
      const res = await h(new Request(`https://x.test/functions/v1/invite-mail/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(uid ? { Authorization: `Bearer user:${uid}` } : {}) },
        body: JSON.stringify(body),
      }));
      return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
    };
    const h = make(true);

    await t.step("로그인 401 · 경로 404 · code 없음 400 · 설정 없음 503(기록도 안 남김)", async () => {
      assertEquals((await post(h, null, { code: inv.code })).status, 401);
      assertEquals((await post(h, own, { code: inv.code }, "nope")).status, 404);
      assertEquals((await post(h, own, {})).body.code, "INVALID_REQUEST");
      const r = await post(make(false), own, { code: inv.code, email: "a@example.com" });
      assertEquals([r.status, r.body.code], [503, "MAIL_NOT_CONFIGURED"]);
      assertEquals((await db.query("select count(*)::int as n from private.invite_mails")).rows[0].n, 0);
    });

    await t.step("다른 사람 403 · 주소 형식 400", async () => {
      assertEquals((await post(h, other, { code: inv.code, email: "a@example.com" })).body.code, "FORBIDDEN");
      assertEquals((await post(h, own, { code: inv.code, email: "nope" })).status, 400);
    });

    await t.step("보내기 → 200, 메일 내용(제목·코드·만료·링크), 기록 SENT", async () => {
      const r = await post(h, own, { code: inv.code, email: "Friend@Example.com" });
      assertEquals([r.status, r.body.email, r.body.kind], [200, "friend@example.com", "WORKSPACE"]);
      const m = sent.at(-1)!;
      assertEquals(m.to, "friend@example.com");
      assertEquals(m.subject, "[Stella] 보내는 사람님이 '메일 시험 공간' 공간에 초대했어요");
      assert(m.text.includes(`초대 코드: ${inv.code}`) && m.text.includes(koreanDateTime(inv.expires_at)), m.text);
      assert(m.html.includes(`stella://invite?code=${encodeURIComponent(inv.code)}`), "앱 링크");
      const row = (await db.query("select status from private.invite_mails order by created_at desc limit 1")).rows[0];
      assertEquals(row.status, "SENT");
    });

    await t.step("10분 안 같은 주소 409 · SMTP 실패 502 → 기록 FAILED, 다시 보내면 됨", async () => {
      assertEquals((await post(h, own, { code: inv.code, email: "friend@example.com" })).status, 409);
      smtp = "down";
      const r = await post(h, own, { code: inv.code, email: "second@example.com" });
      assertEquals([r.status, r.body.code], [502, "MAIL_FAILED"]);
      const row = (await db.query("select status, error from private.invite_mails where email = 'second@example.com'")).rows[0];
      assertEquals([row.status, row.error], ["FAILED", "535 auth failed"]);
      smtp = "ok";
      assertEquals((await post(h, own, { code: inv.code, email: "second@example.com" })).status, 200);
    });

    await t.step("HTML 이스케이프 (이름·공간에 꺾쇠가 있어도)", () => {
      const m = buildInviteMail({ mail_id: "x", email: "a@b.co", kind: "PROJECT", workspace_name: "<b>팀</b>", project_name: "A&B",
        inviter_name: "<script>", role: "EDITOR", expires_at: "2026-11-20T06:05:00Z", code: "ABCDE-FGHJK" });
      assert(!m.html.includes("<script>") && m.html.includes("&lt;script&gt;") && m.html.includes("A&amp;B"), m.html);
      assertEquals(m.subject, "[Stella] <script>님이 '<b>팀</b>' 공간의 'A&B' 프로젝트에 초대했어요");
      assert(m.text.includes("11월 20일 오후 3:05"), "서울 시각");
    });

    await t.step("nodemailer로 실제 메일 원문 만들기 (index.ts와 같은 패키지, 한글 깨짐 없음)", async () => {
      const tr = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
      const m = sent[0];
      const info = await tr.sendMail({ from: '"Stella" <stella.app.noreply@gmail.com>', to: m.to, subject: m.subject, text: m.text, html: m.html });
      const raw = new TextDecoder().decode(info.message as Uint8Array);
      assert(/^Subject: =\?UTF-8\?/m.test(raw), "제목은 UTF-8 인코딩");
      assert(raw.includes("Content-Type: text/plain; charset=utf-8") && raw.includes("Content-Type: text/html; charset=utf-8"), "글·HTML 둘 다");
      assertEquals(info.envelope.to, ["friend@example.com"]);
    });
  } finally {
    await db.end(); await svc.end();
  }
});
