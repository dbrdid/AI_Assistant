// 앱 모듈 attachments.ts ↔ Edge Function handler.ts 연결 테스트 (Deno)
//   가짜 Supabase 클라이언트: functions.invoke → 진짜 handler, storage → 메모리, 다운로드 권한 → 로컬 DB 정책 함수
//   실행: deno test -A --no-check --config deno.test.json attachments_lib.test.ts
//   앱 모듈 경로(아래 import)는 저장소에 둔 위치에 맞게 고치세요 (지금: ../../../frontend/Frontend_UI/src/lib/stella)
import nodeAssert from "node:assert/strict";
import pg from "npm:pg@8";
import { FunctionsHttpError } from "npm:@supabase/supabase-js@2";
import { createHandler, type Deps } from "../functions/assets/handler.ts";
import * as F from "../../../frontend/Frontend_UI/src/lib/stella/attachments.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);

async function client() { const c = new pg.Client(PG); await c.connect(); return c; }

Deno.test("attachments.ts: 올리기·다시 올리기·받기·주소·삭제·오류", async () => {
  const db = await client();
  const svc = await client(); await svc.query("set role service_role");
  const owner = crypto.randomUUID(), bob = crypto.randomUUID();
  for (const id of [owner, bob]) await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@t.dev`]);
  const asUser = async (uid: string, sql: string, params: unknown[] = []) => {
    const c = await client();
    await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set role authenticated");
    try { return (await c.query(sql, params)).rows[0]?.r; } finally { await c.end(); }
  };
  const ws = await asUser(owner, "select public.create_workspace('lib') as r");

  const objects = new Map<string, { bytes: Uint8Array; mime: string | null }>();
  const tokens = new Map<string, string>();
  let uploads = 0;
  const deps: Deps = {
    getUserId: async (t) => t.replace(/^user:/, "") || null,
    rpc: async (name, args) => {
      const keys = Object.keys(args);
      try {
        const r = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
        return { data: r.rows[0].r, error: null };
      } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    },
    storage: {
      async createSignedUploadUrl(b, p) { const token = crypto.randomUUID(); tokens.set(token, `${b}/${p}`); return { signedUrl: `x?token=${token}`, token, path: p }; },
      async download(b, p) { return objects.get(`${b}/${p}`) ?? null; },
      async remove(b, p) { objects.delete(`${b}/${p}`); },
    },
  };
  const handle = createHandler(deps);

  const fakeClient = (uid: string) => ({
    functions: {
      async invoke(path: string, { body }: { body: unknown }) {
        const res = await handle(new Request(`https://x/functions/v1/${path}`, {
          method: "POST", headers: { Authorization: `Bearer user:${uid}` }, body: JSON.stringify(body) }));
        return res.ok ? { data: await res.json(), error: null } : { data: null, error: new FunctionsHttpError(res) };
      },
    },
    storage: {
      from(bucket: string) {
        return {
          async uploadToSignedUrl(path: string, token: string, bytes: Uint8Array, o: { contentType: string }) {
            if (tokens.get(token) !== `${bucket}/${path}`) return { data: null, error: { message: "bad token" } };
            uploads++; objects.set(`${bucket}/${path}`, { bytes: new Uint8Array(bytes), mime: o.contentType }); return { data: { path }, error: null };
          },
          async createSignedUrl(path: string) {
            const ok = await asUser(uid, "select private.can_read_asset_object($1, $2) as r", [bucket, path]);
            return ok ? { data: { signedUrl: `https://dl/${bucket}/${path}` }, error: null } : { data: null, error: { message: "Object not found" } };
          },
          async download(path: string) {
            const ok = await asUser(uid, "select private.can_read_asset_object($1, $2) as r", [bucket, path]);
            const o = objects.get(`${bucket}/${path}`);
            return ok && o ? { data: new Blob([o.bytes]), error: null } : { data: null, error: { message: "Object not found" } };
          },
        };
      },
    },
  }) as any;

  try {
    const A = fakeClient(owner), B = fakeClient(bob);
    const bytes = new TextEncoder().encode("사진 대신 텍스트 파일".repeat(10));
    const id1 = crypto.randomUUID();

    const a = await F.uploadAttachment(A, { workspaceId: ws, assetId: id1, bytes, mimeType: "TEXT/PLAIN", name: "a.txt" });
    eq([a.id, a.status, a.mime_type, Number(a.actual_size_bytes)], [id1, "AVAILABLE", "text/plain", bytes.byteLength]);
    eq(uploads, 1);

    const again = await F.uploadAttachment(A, { workspaceId: ws, assetId: id1, bytes, mimeType: "text/plain" });
    eq([again.id, uploads], [id1, 1], "같은 id는 다시 안 올림");

    nodeAssert.ok((await F.getAttachmentUrl(A, a)).includes(a.object_path));
    eq(await F.sha256Hex(await F.downloadAttachment(A, a)), await F.sha256Hex(bytes));

    const err = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as F.AttachmentError).code; } };
    eq(await err(F.getAttachmentUrl(B, a)), "NOT_FOUND", "멤버 아님 → 주소 못 받음");
    eq(await err(F.uploadAttachment(B, { workspaceId: ws, assetId: crypto.randomUUID(), bytes, mimeType: "text/plain" })), "FORBIDDEN");
    eq(await err(F.uploadAttachment(A, { workspaceId: ws, assetId: crypto.randomUUID(), bytes, mimeType: "application/x-msdownload" })), "UNSUPPORTED_TYPE");
    eq(await err(F.uploadAttachment(A, { workspaceId: ws, assetId: crypto.randomUUID(), bytes: new Uint8Array(0), mimeType: "text/plain" })), "INVALID_REQUEST");
    eq(await err(F.uploadAttachment(A, { workspaceId: ws, assetId: crypto.randomUUID(), bytes: new Uint8Array(50 * 1024 * 1024 + 1), mimeType: "text/plain" })), "TOO_LARGE");
    eq(await err(F.uploadAttachment(A, { workspaceId: ws, assetId: id1, bytes: new Uint8Array(bytes).fill(66), mimeType: "text/plain" })), "ASSET_ID_TAKEN");
    eq(F.attachmentErrorMessage({ code: "QUOTA_EXCEEDED" }).startsWith("공간의 첨부 용량(500MB)이 가득 찼어요"), true, "문구에 용량이 없으면 FREE 기준");
    eq(F.attachmentErrorMessage({ code: "QUOTA_EXCEEDED", message: "QUOTA_EXCEEDED: 이 공간의 첨부 용량(10GB)을 넘습니다" }).startsWith("공간의 첨부 용량(10GB)이 가득 찼어요"), true, "서버가 준 요금제 용량");
    eq(F.attachmentErrorMessage({ code: "QUOTA_EXCEEDED", message: "QUOTA_EXCEEDED: 백업 용량(1GB)을 넘습니다" }).startsWith("백업 용량(1GB)이 가득 찼어요"), true, "백업 문구");
    eq([F.canRetryUpload("NETWORK"), F.canRetryUpload("HASH_MISMATCH")], [true, false]);

    await F.deleteAttachment(A, id1);
    eq(await err(F.getAttachmentUrl(A, a)), "NOT_FOUND", "삭제 후 주소 못 받음");
    eq(objects.has(`attachments/${a.object_path}`), false, "객체도 지움");
    eq(await err(F.deleteAttachment(B, id1)), "NOT_FOUND");
    console.log("attachments.ts ↔ handler 12개 확인 통과");
  } finally {
    await db.end(); await svc.end();
  }
});
