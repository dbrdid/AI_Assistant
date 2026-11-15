// Edge Function `account` (회원 탈퇴) 테스트 (Deno)
//   진짜 handler.ts + 로컬 Postgres(DB 함수, service_role) + 가짜 Storage·Auth
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check account_function.test.ts
import nodeAssert from "node:assert/strict";
const assert = (v: unknown, msg?: string) => nodeAssert.ok(v, msg);
const assertEquals = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepStrictEqual(a, b, msg);
import pg from "npm:pg@8";
import { createHandler, type Deps } from "../functions/account/handler.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
async function client() { const c = new pg.Client(PG); await c.connect(); return c; }

async function setup() {
  const db = await client();
  const svc = await client();
  await svc.query("set role service_role");
  const me = crypto.randomUUID(), other = crypto.randomUUID();
  for (const [id, n] of [[me, "탈퇴자"], [other, "남는 사람"]]) {
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
  // 공유 공간(내가 OWNER, 다른 사람 편집자) + 혼자 공간(첨부 있음) + 백업
  const shared = await as(me, "select public.create_workspace('같이 쓰는 공간') as r");
  const inv = await as(me, "select public.create_invite($1, 'EDITOR', 1, 1) as r", [shared]);
  await as(other, "select public.accept_invite($1) as r", [inv.code]);
  const solo = await as(me, "select public.create_workspace('혼자 공간') as r");
  const h = "a".repeat(64);
  const fSolo = crypto.randomUUID(), fShared = crypto.randomUUID(), bk = crypto.randomUUID();
  await db.query("select public.asset_prepare($1, $2, 'ATTACHMENT', $3, 'a.pdf', 'application/pdf', 5, $4)", [me, fSolo, solo, h]);
  await db.query("select public.asset_complete($1, $2, 5, $3)", [me, fSolo, h]);
  await db.query("select public.asset_prepare($1, $2, 'ATTACHMENT', $3, 'b.pdf', 'application/pdf', 5, $4)", [me, fShared, shared, h]);
  await db.query("select public.asset_complete($1, $2, 5, $3)", [me, fShared, h]);
  await db.query("select public.asset_prepare($1, $2, 'BACKUP', null, 'stella-backup', 'application/octet-stream', 100, $3)", [me, bk, h]);
  await db.query("select public.asset_complete($1, $2, 100, $3)", [me, bk, h]);
  const paths = Object.fromEntries((await db.query("select id, bucket_id || '/' || object_path as p from public.assets where id = any($1)", [[fSolo, fShared, bk]])).rows.map((r: any) => [r.id, r.p]));

  // 가짜 Storage·Auth
  const objects = new Set<string>(Object.values(paths) as string[]);
  let failStorage = 0, failAuth = 0;
  const removed: string[] = [];
  const deps: Deps = {
    getUserId: async (token) => (token.startsWith("user:") ? token.slice(5) : null),
    rpc: async (name, args) => {
      const keys = Object.keys(args);
      try {
        const r = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
    async removeObjects(bucket, ps) {
      if (failStorage > 0) { failStorage--; throw new Error("storage down"); }
      for (const p of ps) { objects.delete(`${bucket}/${p}`); removed.push(`${bucket}/${p}`); }
    },
    async deleteAuthUser(uid) {
      if (failAuth > 0) { failAuth--; throw new Error("auth down"); }
      await db.query("delete from auth.users where id = $1", [uid]);
    },
  };
  const handle = createHandler(deps);
  const post = async (path: string, uid: string | null, body: unknown) => {
    const res = await handle(new Request(`https://x.test/functions/v1/account/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(uid ? { Authorization: `Bearer user:${uid}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
  };
  return {
    db, me, other, shared, solo, paths, fSolo, fShared, bk, objects, removed, post, handle,
    failStorageOnce() { failStorage = 1; }, failAuthOnce() { failAuth = 1; },
    async close() { await db.end(); await svc.end(); },
  };
}

Deno.test("account 함수: 회원 탈퇴 (확인·실패 뒤 재시도·파일·공간 정리)", async (t) => {
  const s = await setup();
  try {
    await t.step("로그인 없으면 401, 확인 문구 없으면 400, 없는 경로 404, GET 405", async () => {
      assertEquals((await s.post("delete", null, { confirm: "DELETE" })).status, 401);
      const r = await s.post("delete", s.me, {});
      assertEquals([r.status, r.body.code], [400, "CONFIRM_REQUIRED"]);
      assertEquals((await s.post("delete", s.me, "not json")).status, 400);
      assertEquals((await s.post("nope", s.me, { confirm: "DELETE" })).status, 404);
      assertEquals((await s.handle(new Request("https://x.test/functions/v1/account/delete"))).status, 405);
      assert((await s.db.query("select 1 from public.accounts where id = $1", [s.me])).rowCount === 1, "아무것도 안 바뀜");
    });

    await t.step("파일 삭제가 실패하면 502, 계정은 아직 있음 (공간 정리는 끝남)", async () => {
      s.failStorageOnce();
      const r = await s.post("delete", s.me, { confirm: "DELETE" });
      assertEquals([r.status, r.body.code], [502, "STORAGE_FAILED"]);
      assert((await s.db.query("select 1 from public.accounts where id = $1", [s.me])).rowCount === 1);
      const owner = (await s.db.query("select account_id from public.workspace_members where workspace_id = $1 and role = 'OWNER' and status = 'ACTIVE'", [s.shared])).rows;
      assertEquals(owner.map((x: any) => x.account_id), [s.other], "OWNER가 남는 사람에게");
    });

    await t.step("로그인 계정 삭제가 실패하면 502 → 다시 부르면 마무리", async () => {
      s.failAuthOnce();
      const r1 = await s.post("delete", s.me, { confirm: "DELETE" });
      assertEquals([r1.status, r1.body.code], [502, "AUTH_DELETE_FAILED"]);
      assert((await s.db.query("select 1 from public.accounts where id = $1", [s.me])).rowCount === 0, "계정 행은 이미 지움");
      const r2 = await s.post("delete", s.me, { confirm: "DELETE" });
      assertEquals(r2.status, 200, JSON.stringify(r2.body));
      assert((await s.db.query("select 1 from auth.users where id = $1", [s.me])).rowCount === 0, "로그인 계정 삭제");
    });

    await t.step("파일: 혼자 공간 첨부·백업은 지우고, 공유 공간 첨부는 남김", () => {
      assert(!s.objects.has(s.paths[s.fSolo]) && !s.objects.has(s.paths[s.bk]), JSON.stringify(s.removed));
      assert(s.objects.has(s.paths[s.fShared]), "공유 첨부는 남음");
    });

    await t.step("DB: 혼자 공간 삭제, 공유 공간·첨부는 남고 작성자 null", async () => {
      assertEquals((await s.db.query("select 1 from public.workspaces where id = $1", [s.solo])).rowCount, 0);
      const a = (await s.db.query("select owner_account_id, status from public.assets where id = $1", [s.fShared])).rows[0];
      assertEquals([a.owner_account_id, a.status], [null, "AVAILABLE"]);
      assertEquals((await s.db.query("select created_by from public.workspaces where id = $1", [s.shared])).rows[0].created_by, null);
    });
  } finally {
    await s.close();
  }
});
