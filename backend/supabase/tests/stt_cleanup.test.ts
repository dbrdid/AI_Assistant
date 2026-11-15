// stt-cleanup 테스트 (Deno): 비밀값 확인 → 기한 지난 녹음을 Storage API로 지우고 표시
//   진짜 functions/stt-cleanup/handler.ts + 로컬 Postgres + 가짜 Storage
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check stt_cleanup.test.ts
import nodeAssert from "node:assert/strict";
import pg from "npm:pg@8";
import { createCleanupHandler, type CleanupDeps } from "../functions/stt-cleanup/handler.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
async function client() { const c = new pg.Client(PG); await c.connect(); return c; }

Deno.test("stt-cleanup: 비밀값, 기한 지난 녹음 삭제, Storage 오류", async () => {
  const db = await client();
  const svc = await client(); await svc.query("set role service_role");
  const me = crypto.randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [me, `${me}@t.dev`]);
  await db.query(`insert into public.consents (account_id, consent_type, policy_version) values ($1, 'EXTERNAL_AI', 'v1')`, [me]);
  const secret = (await db.query(`select decrypted_secret from vault.decrypted_secrets where name = 'stt_cleanup_secret'`)).rows[0].decrypted_secret;

  const rpc: CleanupDeps["rpc"] = async (name, args) => {
    const keys = Object.keys(args);
    try {
      const fn = name === "stt_upload_expired" || name === "stt_recording_expired" ? `select coalesce(json_agg(json_build_object('object_path', e.object_path)), '[]') as r from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) e`   // PostgREST처럼 [{object_path}]
                                               : `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
      const r = await svc.query(fn, keys.map((k) => args[k]));
      return { data: r.rows[0].r, error: null };
    } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  };
  const removed: string[][] = [];
  let failRemove = false;
  const h = createCleanupHandler({
    rpc, batchSize: 2,
    async remove(bucket, paths) {
      if (failRemove) throw new Error("storage down");
      nodeAssert.ok(bucket === "stt-uploads" || bucket === "stt-recordings", bucket);
      removed.push(paths);
      await db.query(`delete from storage.objects where bucket_id = $1 and name = any($2)`, [bucket, paths]);   // Storage API가 하는 일
    },
  });
  const call = async (sec?: string, method = "POST") => {
    const res = await h(new Request("https://x/stt-cleanup", { method, headers: sec === undefined ? {} : { "x-cleanup-secret": sec } }));
    return { status: res.status, body: await res.json() };
  };

  try {
    // 녹음 3개: 기한 지남 2, 아직 1 + 기록 없이 4일 된 파일 1
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) await svc.query(`select public.stt_upload_prepare($1, $2, 'm4a', 'audio/mp4', 10)`, [me, id]);
    await db.query(`update private.stt_uploads set expires_at = now() - interval '1 minute' where id = any($1)`, [ids.slice(0, 2)]);
    await db.query(`insert into storage.objects (bucket_id, name, created_at) select 'stt-uploads', object_path, now() from private.stt_uploads where id = any($1)`, [ids]);
    await db.query(`insert into storage.objects (bucket_id, name, created_at) values ('stt-uploads', 'gone-account/old', now() - interval '4 days')`);

    eq((await call()).status, 401, "비밀값 없으면 거절");
    eq((await call("x".repeat(64))).status, 401, "틀린 비밀값");
    eq((await call(secret, "GET")).status, 405);
    eq(removed.length, 0, "거절되면 아무것도 안 지움");

    failRemove = true;
    const bad = await call(secret);
    failRemove = false;
    eq([bad.status, bad.body.code], [502, "STORAGE_ERROR"]);
    eq((await db.query(`select count(*)::int as n from private.stt_uploads where object_deleted`)).rows[0].n, 0, "못 지웠으면 지운 표시도 안 함");

    const okRes = await call(secret);
    eq([okRes.status, okRes.body.deleted], [200, 3]);
    eq(removed.flat().sort(), [`${me}/${ids[0]}`, `${me}/${ids[1]}`, "gone-account/old"].sort());
    eq(removed.length, 2, "2개씩 나눠서");
    const rows = (await db.query(`select id, object_deleted from private.stt_uploads where id = any($1)`, [ids])).rows;
    eq(Object.fromEntries(rows.map((r) => [r.id, r.object_deleted])), { [ids[0]]: true, [ids[1]]: true, [ids[2]]: false }, "기한 남은 녹음은 그대로");

    const again = await call(secret);
    eq([again.status, again.body.deleted], [200, 0], "두 번째는 지울 것 없음");
    console.log("stt-cleanup 확인 통과");
  } finally {
    await db.end(); await svc.end();
  }
});

Deno.test("stt-cleanup: 긴 녹음 구간 (전사 끝난 구간·기한 지난 실패 구간 삭제, 기한 남은 실패 구간은 보관)", async () => {
  const db = await client();
  const svc = await client(); await svc.query("set role service_role");
  const me = crypto.randomUUID(), rec = crypto.randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [me, `${me}@t.dev`]);
  const secret = (await db.query(`select decrypted_secret from vault.decrypted_secrets where name = 'stt_cleanup_secret'`)).rows[0].decrypted_secret;
  await db.query(`insert into private.stt_recordings (id, account_id, segment_count, total_seconds) values ($1, $2, 3, 900)`, [rec, me]);
  const path = (i: number) => `${me}/${rec}/00${i}.m4a`;
  await db.query(`insert into private.stt_segments (recording_id, seq, account_id, object_path, ext, mime_type, declared_size_bytes, start_seconds, duration_seconds, status, retain_until)
                  values ($1, 0, $2, $3, 'm4a', 'audio/mp4', 10, 0, 300, 'DONE', null),
                         ($1, 1, $2, $4, 'm4a', 'audio/mp4', 10, 300, 300, 'FAILED', now() + interval '1 day'),
                         ($1, 2, $2, $5, 'm4a', 'audio/mp4', 10, 600, 300, 'FAILED', now() - interval '1 minute')`, [rec, me, path(0), path(1), path(2)]);
  await db.query(`insert into storage.objects (bucket_id, name, metadata) select 'stt-recordings', p, '{"size":10}' from unnest($1::text[]) p`, [[path(0), path(1), path(2)]]);

  const removed: [string, string[]][] = [];
  const h = createCleanupHandler({
    rpc: async (name, args) => {
      const keys = Object.keys(args);
      const call = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
      const sql = name.endsWith("_expired") ? `select coalesce(json_agg(json_build_object('object_path', e.object_path)), '[]') as r from ${call} e` : `select ${call} as r`;
      try { return { data: (await svc.query(sql, keys.map((k) => args[k]))).rows[0].r, error: null }; }
      catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    },
    async remove(bucket, paths) {
      removed.push([bucket, paths]);
      await db.query(`delete from storage.objects where bucket_id = $1 and name = any($2)`, [bucket, paths]);
    },
  });
  try {
    const res = await h(new Request("https://x/stt-cleanup", { method: "POST", headers: { "x-cleanup-secret": secret } }));
    const body = await res.json();
    const recRemoved = removed.filter(([b]) => b === "stt-recordings").flatMap(([, p]) => p).sort();
    eq([res.status, recRemoved], [200, [path(0), path(2)]], `deleted=${body.deleted}`);
    const rows = (await db.query(`select seq, status, object_deleted from private.stt_segments where recording_id = $1 order by seq`, [rec])).rows;
    eq(rows.map((r) => [r.seq, r.status, r.object_deleted]), [[0, "DONE", true], [1, "FAILED", false], [2, "GAVE_UP", true]],
       "전사 끝난 구간·기한 지난 실패 구간만 삭제, 기한 지난 실패는 최종 실패");
    console.log("stt-cleanup 긴 녹음 확인 통과");
  } finally {
    await db.end(); await svc.end();
  }
});
