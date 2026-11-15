// Edge Function `assets` 요청 처리 테스트 (Deno)
//   진짜 handler.ts + 로컬 Postgres(DB 함수, service_role) + 가짜 Storage(메모리)
//   실행: ./reset.sh ../migrations/*.sql && deno test -A assets_function.test.ts
import nodeAssert from "node:assert/strict";
const assert = (v: unknown, msg?: string) => nodeAssert.ok(v, msg);
const assertEquals = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepStrictEqual(a, b, msg);
import pg from "npm:pg@8";
import { createHandler, sha256Hex, type Deps } from "../functions/assets/handler.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const enc = new TextEncoder();

async function admin() {
  const c = new pg.Client(PG);
  await c.connect();
  return c;
}

// --- 가짜 Storage: 서명 업로드 URL은 token만 기억, 업로드는 테스트가 put으로 흉내
function fakeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; mime: string | null }>();
  const tokens = new Map<string, string>();
  let failDownload = false;
  return {
    objects, tokens,
    setFailDownload(v: boolean) { failDownload = v; },
    put(bucket: string, path: string, token: string, bytes: Uint8Array, mime: string) {
      if (tokens.get(token) !== `${bucket}/${path}`) throw new Error("bad token");
      objects.set(`${bucket}/${path}`, { bytes, mime });
    },
    deps: {
      async createSignedUploadUrl(bucket: string, path: string) {
        const token = crypto.randomUUID();
        tokens.set(token, `${bucket}/${path}`);
        return { signedUrl: `https://storage.test/upload/sign/${bucket}/${path}?token=${token}`, token, path };
      },
      async download(bucket: string, path: string) {
        if (failDownload) throw new Error("connection reset");
        return objects.get(`${bucket}/${path}`) ?? null;
      },
      async remove(bucket: string, path: string) { objects.delete(`${bucket}/${path}`); },
    },
  };
}

async function setup() {
  const db = await admin();
  const svc = await admin();
  await svc.query("set role service_role");
  const owner = crypto.randomUUID(), alice = crypto.randomUUID(), xout = crypto.randomUUID();
  for (const [id, n] of [[owner, "O"], [alice, "A"], [xout, "X"]]) {
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, jsonb_build_object('name', $3::text))`, [id, `${id}@t.dev`, n]);
  }
  const as = async (uid: string, sql: string, params: unknown[] = []) => {
    const c = await admin();
    await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set role authenticated");
    const r = await c.query(sql, params);
    await c.end();
    return r.rows[0]?.r;
  };
  const ws = await as(owner, "select public.create_workspace('함수 테스트') as r");
  const inv = await as(owner, "select public.create_invite($1, 'EDITOR', 1, 1) as r", [ws]);
  await as(alice, "select public.accept_invite($1) as r", [inv.code]);

  const st = fakeStorage();
  const logs: string[] = [];
  let rpcCalls = 0;
  const deps: Deps = {
    getUserId: async (token) => (token.startsWith("user:") ? token.slice(5) : null),
    rpc: async (name, args) => {
      rpcCalls++;
      const keys = Object.keys(args);
      try {
        const r = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
    storage: st.deps,
    log: (m) => logs.push(m),
  };
  const handle = createHandler(deps);
  const post = async (path: string, uid: string | null, body: unknown) => {
    const res = await handle(new Request(`https://x.test/functions/v1/assets/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(uid ? { Authorization: `Bearer user:${uid}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
  };
  return {
    db, svc, st, ws, owner, alice, xout, post, handle, logs, rpcCalls: () => rpcCalls,
    async close() { await db.end(); await svc.end(); },
  };
}

Deno.test("assets 함수: 준비 → 업로드 → 확인 → 삭제, 실패·권한·형식", async (t) => {
  const s = await setup();
  try {
    const bytes = enc.encode("안녕하세요 첨부 파일");
    const sha = await sha256Hex(bytes);
    const a1 = crypto.randomUUID();
    const prep = { asset_id: a1, purpose: "ATTACHMENT", workspace_id: s.ws, original_name: "memo.txt", mime_type: "text/plain", size_bytes: bytes.byteLength, sha256: sha };

    await t.step("로그인 없으면 401, GET은 405, OPTIONS는 CORS, 없는 경로 404", async () => {
      assertEquals((await s.post("prepare", null, prep)).status, 401);
      assertEquals((await s.handle(new Request("https://x.test/functions/v1/assets/prepare"))).status, 405);
      const o = await s.handle(new Request("https://x.test/functions/v1/assets/prepare", { method: "OPTIONS" }));
      assertEquals(o.headers.get("Access-Control-Allow-Origin"), "*");
      assertEquals((await s.post("nope", s.alice, {})).body.code, "NOT_FOUND");
    });

    await t.step("잘못된 요청은 DB까지 안 감", async () => {
      const before = s.rpcCalls();
      for (const bad of [{ ...prep, asset_id: "x" }, { ...prep, size_bytes: "10" }, { ...prep, mime_type: "" }, { ...prep, purpose: "OTHER" }, { ...prep, original_name: 3 }]) {
        const r = await s.post("prepare", s.alice, bad);
        assertEquals(r.status, 400, JSON.stringify(bad));
        assertEquals(r.body.code, "INVALID_REQUEST");
      }
      assertEquals((await s.post("prepare", s.alice, "{not json")).body.code, "INVALID_REQUEST");
      assertEquals((await s.post("prepare", s.alice, "x".repeat(9000))).status, 413);
      assertEquals(s.rpcCalls(), before);
    });

    let token = "";
    await t.step("준비 → PENDING + 서명 업로드 URL", async () => {
      const r = await s.post("prepare", s.alice, prep);
      assertEquals(r.status, 200);
      assertEquals(r.body.status, "PENDING");
      assertEquals(r.body.bucket, "attachments");
      assertEquals(r.body.path, `${s.ws}/${a1}`);
      assert(r.body.signed_url.includes(r.body.token));
      token = r.body.token;
    });

    await t.step("올리기 전에 확인 → 409 NOT_UPLOADED", async () => {
      const r = await s.post("complete", s.alice, { asset_id: a1 });
      assertEquals([r.status, r.body.code], [409, "NOT_UPLOADED"]);
    });

    await t.step("업로드 후 확인 → AVAILABLE, 다시 확인해도 같은 결과", async () => {
      s.st.put("attachments", `${s.ws}/${a1}`, token, bytes, "text/plain;charset=UTF-8");
      const r = await s.post("complete", s.alice, { asset_id: a1 });
      assertEquals(r.status, 200, JSON.stringify(r.body));
      assertEquals(r.body.asset.status, "AVAILABLE");
      assertEquals(Number(r.body.asset.actual_size_bytes), bytes.byteLength);
      const again = await s.post("complete", s.alice, { asset_id: a1 });
      assertEquals([again.status, again.body.replayed], [200, true]);
      const p2 = await s.post("prepare", s.alice, prep);
      assertEquals([p2.body.status, p2.body.signed_url], ["AVAILABLE", undefined]);
    });

    await t.step("내용이 다르면 422 HASH_MISMATCH + 객체 삭제, 같은 id 재준비는 ASSET_FAILED", async () => {
      const a2 = crypto.randomUUID();
      const p = await s.post("prepare", s.alice, { ...prep, asset_id: a2 });
      // 크기·형식은 같고 내용만 다른 파일
      s.st.put("attachments", p.body.path, p.body.token, new Uint8Array(bytes.byteLength).fill(65), "text/plain");
      const r = await s.post("complete", s.alice, { asset_id: a2 });
      assertEquals([r.status, r.body.code], [422, "HASH_MISMATCH"]);
      assertEquals(s.st.objects.has(`attachments/${p.body.path}`), false);
      assertEquals((await s.post("prepare", s.alice, { ...prep, asset_id: a2 })).body.code, "ASSET_FAILED");
      assertEquals((await s.post("complete", s.alice, { asset_id: a2 })).status, 422);
    });

    await t.step("크기·형식이 다르면 SIZE_MISMATCH / TYPE_MISMATCH", async () => {
      const a3 = crypto.randomUUID();
      const p3 = await s.post("prepare", s.alice, { ...prep, asset_id: a3 });
      s.st.put("attachments", p3.body.path, p3.body.token, enc.encode("짧음"), "text/plain");
      assertEquals((await s.post("complete", s.alice, { asset_id: a3 })).body.code, "SIZE_MISMATCH");
      const a4 = crypto.randomUUID();
      const p4 = await s.post("prepare", s.alice, { ...prep, asset_id: a4 });
      s.st.put("attachments", p4.body.path, p4.body.token, bytes, "text/html");
      assertEquals((await s.post("complete", s.alice, { asset_id: a4 })).body.code, "TYPE_MISMATCH");
    });

    await t.step("권한·형식·크기 오류는 DB 판단을 그대로 HTTP로", async () => {
      const r1 = await s.post("prepare", s.xout, { ...prep, asset_id: crypto.randomUUID() });
      assertEquals([r1.status, r1.body.code], [403, "FORBIDDEN"]);
      const r2 = await s.post("prepare", s.alice, { ...prep, asset_id: crypto.randomUUID(), mime_type: "application/x-msdownload" });
      assertEquals([r2.status, r2.body.code], [415, "UNSUPPORTED_TYPE"]);
      const r3 = await s.post("prepare", s.alice, { ...prep, asset_id: crypto.randomUUID(), size_bytes: 52428801 });
      assertEquals([r3.status, r3.body.code], [413, "TOO_LARGE"]);
      const r4 = await s.post("prepare", s.owner, prep);
      assertEquals([r4.status, r4.body.code], [409, "ASSET_ID_TAKEN"]);
      const r5 = await s.post("complete", s.owner, { asset_id: a1 });
      assertEquals([r5.status, r5.body.code], [404, "NOT_FOUND"]);
    });

    await t.step("Storage 장애는 502, 상태는 PENDING 유지", async () => {
      const a5 = crypto.randomUUID();
      const p = await s.post("prepare", s.alice, { ...prep, asset_id: a5 });
      s.st.put("attachments", p.body.path, p.body.token, bytes, "text/plain");
      s.st.setFailDownload(true);
      const r = await s.post("complete", s.alice, { asset_id: a5 });
      s.st.setFailDownload(false);
      assertEquals([r.status, r.body.code], [502, "STORAGE_ERROR"]);
      const row = await s.db.query("select status from public.assets where id = $1", [a5]);
      assertEquals(row.rows[0].status, "PENDING");
      assertEquals((await s.post("complete", s.alice, { asset_id: a5 })).body.status, "AVAILABLE");
    });

    await t.step("예상 못 한 DB 오류는 내용을 숨기고 500", async () => {
      await s.db.query("alter function public.asset_delete(uuid, uuid) rename to asset_delete_off");
      const r = await s.post("delete", s.alice, { asset_id: a1 });
      await s.db.query("alter function public.asset_delete_off(uuid, uuid) rename to asset_delete");
      assertEquals([r.status, r.body.code], [500, "SERVER_ERROR"]);
      assert(!JSON.stringify(r.body).includes("asset_delete"));
      assert(s.logs.some((l) => l.includes("asset_delete failed")));
    });

    await t.step("삭제 → DELETED + 객체 삭제, 다시 삭제해도 성공, 삭제 후 확인은 410", async () => {
      assert(s.st.objects.has(`attachments/${s.ws}/${a1}`));
      const r = await s.post("delete", s.alice, { asset_id: a1 });
      assertEquals([r.status, r.body.status], [200, "DELETED"]);
      assertEquals(s.st.objects.has(`attachments/${s.ws}/${a1}`), false);
      assertEquals((await s.post("delete", s.alice, { asset_id: a1 })).body.replayed, true);
      assertEquals((await s.post("complete", s.alice, { asset_id: a1 })).status, 410);
    });

    await t.step("백업: 본인 경로, 다른 사람은 확인·삭제 못 함", async () => {
      const b = enc.encode("encrypted-backup-bytes");
      const bid = crypto.randomUUID();
      const p = await s.post("prepare", s.xout, { asset_id: bid, purpose: "BACKUP", mime_type: "application/octet-stream", size_bytes: b.byteLength, sha256: await sha256Hex(b) });
      assertEquals([p.body.bucket, p.body.path], ["backups", `${s.xout}/${bid}`]);
      s.st.put("backups", p.body.path, p.body.token, b, "application/octet-stream");
      assertEquals((await s.post("complete", s.alice, { asset_id: bid })).status, 404);
      assertEquals((await s.post("complete", s.xout, { asset_id: bid })).body.status, "AVAILABLE");
      assertEquals((await s.post("delete", s.alice, { asset_id: bid })).status, 404);
      assertEquals((await s.post("delete", s.xout, { asset_id: bid })).body.status, "DELETED");
    });
  } finally {
    await s.close();
  }
});
