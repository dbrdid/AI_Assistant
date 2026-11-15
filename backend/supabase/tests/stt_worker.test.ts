// stt-worker 테스트 (Deno): 진짜 handler.ts + 로컬 Postgres(마이그레이션 전부) + 가짜 Storage·OpenAI
//   앱 쪽 동작(등록·업로드·확인·취소)은 로그인 사용자 역할로 SQL 함수를 직접 부름
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check stt_worker.test.ts
import nodeAssert from "node:assert/strict";
import pg from "npm:pg@8";
import { createWorker, type WorkerDeps } from "../functions/stt-worker/handler.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
async function client() { const c = new pg.Client(PG); await c.connect(); return c; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("stt-worker: 구간 전사·전사문 저장 후 삭제·실패 처리·취소·한도", async (t) => {
  const db = await client();
  const svc = await client(); await svc.query("set role service_role");
  const users = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const u of users) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [u, `${u}@t.dev`]);
    await db.query(`insert into public.consents (account_id, consent_type, policy_version) values ($1, 'EXTERNAL_AI', 'v1')`, [u]);
  }
  const secret = (await db.query(`select decrypted_secret from vault.decrypted_secrets where name = 'stt_cleanup_secret'`)).rows[0].decrypted_secret;

  // 로그인 사용자로 SQL 함수 호출 (앱이 supabase.rpc로 하는 일)
  const asUser = async <T = any>(uid: string, sql: string, params: unknown[] = []): Promise<T> => {
    const c = await client();
    try {
      await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await c.query("set role authenticated");
      return (await c.query(sql, params)).rows[0]?.r as T;
    } finally { await c.end(); }
  };

  // 가짜 Storage (경로 → 내용)
  const files = new Map<string, Uint8Array>();
  const removeLog: { path: string; transcriptSaved: boolean }[] = [];
  let downloadThrows = new Set<string>();
  const storage: WorkerDeps["storage"] = {
    async download(bucket, path) {
      eq(bucket, "stt-recordings");
      if (downloadThrows.has(path)) throw new Error("storage down");
      return files.get(path) ?? null;
    },
    async remove(bucket, paths) {
      for (const p of paths) {
        const saved = (await db.query(`select transcript is not null or status = 'CANCELED' as s from private.stt_segments where object_path = $1`, [p])).rows[0]?.s;
        removeLog.push({ path: p, transcriptSaved: saved === true });
        files.delete(p);
        await db.query(`delete from storage.objects where bucket_id = $1 and name = $2`, [bucket, p]);
      }
    },
  };

  // 가짜 OpenAI: 파일 첫 바이트(= 구간 표시)로 동작을 고름
  type Behave = (signal: AbortSignal) => Promise<Response>;
  const behaviors = new Map<number, Behave>();
  let inflight = 0, maxInflight = 0, calls = 0;
  const forms: FormData[] = [];
  const openai: WorkerDeps["openai"] = async (form, signal) => {
    calls++; forms.push(form);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    try {
      const tag = new Uint8Array(await (form.get("file") as Blob).arrayBuffer())[0];
      const b = behaviors.get(tag);
      if (!b) return new Response("{}", { status: 500 });
      return await b(signal);
    } finally { inflight--; }
  };
  const ok = (text: string, seconds: number, delay = 20): Behave => async () => {
    await sleep(delay);
    return new Response(JSON.stringify({ text, languages: [{ code: "ko" }], usage: { type: "duration", seconds } }), { status: 200, headers: { "x-request-id": "req_" + text.length } });
  };
  const status = (s: number): Behave => async () => new Response(JSON.stringify({ error: { message: "x" } }), { status: s });
  const hang: Behave = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

  const rpc: WorkerDeps["rpc"] = async (name, args) => {
    const keys = Object.keys(args);
    try {
      const r = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
      return { data: r.rows[0].r, error: null };
    } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  };
  const worker = (over: Partial<WorkerDeps> = {}) => createWorker({
    rpc, openai, storage, configured: true, model: "gpt-transcribe", maxConcurrent: 2, budgetMs: 10_000, callTimeoutMs: 300, ...over,
  });
  const call = async (h: (r: Request) => Promise<Response>, sec: string | null = secret) => {
    const res = await h(new Request("https://x/stt-worker", { method: "POST", headers: sec === null ? {} : { "x-cleanup-secret": sec } }));
    return { status: res.status, body: await res.json() };
  };

  // 녹음 등록 → 구간마다 업로드(정책 통과) → 확인. tag = 구간 내용의 첫 바이트
  let tagSeq = 1;
  const record = async (uid: string, n: number, sec = 300) => {
    const rec = crypto.randomUUID();
    const tags = Array.from({ length: n }, () => tagSeq++);
    const segs = tags.map((_, i) => ({ seq: i, duration_seconds: sec, size_bytes: 2000, mime_type: "audio/mp4" }));
    const created = await asUser(uid, `select public.stt_recording_create($1, $2::jsonb) as r`, [rec, JSON.stringify(segs)]);
    nodeAssert.ok(created?.ok, JSON.stringify(created));
    for (const s of created.segments) {
      await asUser(uid, `insert into storage.objects (bucket_id, name, metadata) values ('stt-recordings', $1, '{"size":2000}') returning 1 as r`, [s.path]);
      files.set(s.path, new Uint8Array(2000).fill(tags[s.seq]));
      const cf = await asUser(uid, `select public.stt_segment_confirm($1, $2) as r`, [rec, s.seq]);
      nodeAssert.ok(cf?.ok, JSON.stringify(cf));
    }
    return { rec, tags, paths: created.segments.map((s: any) => s.path as string) };
  };
  const segRows = async (rec: string) => (await db.query(
    `select seq, status, error_code, transcript, object_deleted, charged_minutes, retain_until, next_attempt_at > now() as later
       from private.stt_segments where recording_id = $1 order by seq`, [rec])).rows;
  const usage = async (uid: string) => Number((await db.query(
    `select coalesce(sum(used), 0) as u from public.usage_counters where account_id = $1 and metric = 'AI_STT'`, [uid])).rows[0].u);

  try {
    await t.step("1. 비밀값 틀리면 401, 키가 없으면 구간을 건드리지 않고 503", async () => {
      const { rec } = await record(users[0], 1);
      eq((await call(worker(), null)).status, 401);
      eq((await call(worker(), "0".repeat(64))).status, 401);
      const r = await call(worker({ configured: false }));
      eq([r.status, r.body.code], [503, "NOT_CONFIGURED"]);
      eq((await segRows(rec))[0].status, "QUEUED", "키 등록 전에는 대기 그대로");
      await asUser(users[0], `select public.stt_recording_cancel($1) as r`, [rec]);
      await db.query(`delete from private.stt_recordings where id = $1`, [rec]);
    });

    await t.step("2. 3구간 전사: 동시 2개, 전사문 저장 뒤에 음성 삭제, 실제 길이로 차감", async () => {
      const { rec, tags, paths } = await record(users[0], 3);
      tags.forEach((tag, i) => behaviors.set(tag, ok(`구간 ${i} 전사문`, 299.2, 30)));
      maxInflight = 0;
      const r = await call(worker());
      eq([r.status, r.body.done, r.body.failed], [200, 3, 0], JSON.stringify(r.body));
      eq(maxInflight, 2, "동시에 2개까지");
      const rows = await segRows(rec);
      eq(rows.map((x) => [x.status, x.transcript, x.object_deleted, x.charged_minutes]),
         [0, 1, 2].map((i) => ["DONE", `구간 ${i} 전사문`, true, 5]));
      eq(paths.every((p: string) => !files.has(p)), true, "음성 삭제");
      eq(removeLog.filter((x) => paths.includes(x.path)).every((x) => x.transcriptSaved), true, "전사문 저장이 먼저");
      eq(await usage(users[0]), 15, "5분 × 3 차감");
      const reqs = (await db.query(`select status, charged_units from public.ai_requests where account_id = $1 and endpoint = 'stt' order by created_at`, [users[0]])).rows;
      eq(reqs.map((x) => [x.status, x.charged_units]), [["SUCCEEDED", 5], ["SUCCEEDED", 5], ["SUCCEEDED", 5]]);
      const f = forms.at(-1)!;
      eq([f.get("model"), f.getAll("languages[]"), (f.get("file") as File).name], ["gpt-transcribe", ["ko", "en"], "audio.m4a"], "원래 경로·이름은 안 보냄");
      const st = await asUser(users[0], `select public.stt_recording_status($1) as r`, [rec]);
      eq([st.state, st.counts.done, st.charged_minutes], ["DONE", 3, 15]);
    });

    await t.step("3. 실패: 일시 오류(500)·시간 초과는 자동 재시도 대기, 400은 바로 실패. 음성은 남김", async () => {
      const before = await usage(users[0]);
      const { rec, tags, paths } = await record(users[0], 3);
      behaviors.set(tags[0], status(500));
      behaviors.set(tags[1], status(400));
      behaviors.set(tags[2], hang);
      const r = await call(worker());
      eq([r.body.retry, r.body.failed], [2, 1], JSON.stringify(r.body));
      const rows = await segRows(rec);
      eq(rows.map((x) => [x.status, x.error_code, x.object_deleted, x.later]),
         [["QUEUED", "PROVIDER_ERROR", false, true], ["FAILED", "AUDIO_REJECTED", false, false], ["QUEUED", "PROVIDER_TIMEOUT", false, true]]);
      eq(rows.every((x) => x.retain_until !== null), true, "최초 실패부터 보관 기한");
      eq(paths.every((p: string) => files.has(p)), true, "실패한 구간 음성은 보관");
      eq(await usage(users[0]) - before, 5, "실패는 차감 없음, 시간 초과(결과 불명)는 예약만큼(5분)");
      // 다음 시도: 일시 오류였던 구간이 성공
      behaviors.set(tags[0], ok("다시 해서 성공", 300));
      behaviors.set(tags[2], ok("세 번째도 성공", 300));
      await db.query(`update private.stt_segments set next_attempt_at = now() where recording_id = $1`, [rec]);
      const r2 = await call(worker());
      eq(r2.body.done, 2, JSON.stringify(r2.body));
      const st = await asUser(users[0], `select public.stt_recording_status($1) as r`, [rec]);
      eq([st.state, st.counts.done, st.counts.failed], ["NEEDS_RETRY", 2, 1]);
      const tr = await asUser(users[0], `select public.stt_recording_transcript($1) as r`, [rec]);
      eq(tr.segments.map((s: any) => s.text), ["다시 해서 성공", null, "세 번째도 성공"], "실패 구간은 글 없음");
      eq((await asUser(users[0], `select public.stt_recording_ack($1) as r`, [rec])).cleared, 2);
    });

    await t.step("4. 처리 중 취소: 결과는 저장 안 하고 음성 삭제 (OpenAI 비용은 차감)", async () => {
      const { rec, tags, paths } = await record(users[1], 1);
      behaviors.set(tags[0], async () => {
        await asUser(users[1], `select public.stt_recording_cancel($1) as r`, [rec]);
        return ok("취소됐는데 도착", 300)(new AbortController().signal);
      });
      const r = await call(worker());
      eq(r.body.canceled, 1, JSON.stringify(r.body));
      const rows = await segRows(rec);
      eq([rows[0].status, rows[0].transcript, files.has(paths[0])], ["CANCELED", null, false]);
      eq(await usage(users[1]), 5);
    });

    await t.step("5. 한도 초과(FREE 60분): OpenAI에 안 보내고 실패, 다시 시도 안 함", async () => {
      await db.query(`insert into public.usage_counters (account_id, metric, period_start, used, reserved)
                      values ($1, 'AI_STT', date_trunc('month', now() at time zone 'Asia/Seoul')::date, 58, 0)`, [users[2]]);
      const n = calls;
      const { rec } = await record(users[2], 1);
      const r = await call(worker());
      eq([r.body.failed, calls - n], [1, 0], JSON.stringify(r.body));
      eq((await segRows(rec))[0].error_code, "QUOTA_EXCEEDED");
      eq((await segRows(rec))[0].status, "FAILED");
    });

    await t.step("6. 음성을 못 꺼냄: Storage 오류는 재시도, 파일이 없으면 실패", async () => {
      await db.query(`update public.usage_counters set used = 0 where account_id = $1`, [users[2]]);
      const { rec, paths } = await record(users[2], 2, 60);
      downloadThrows = new Set([paths[0]]);
      files.delete(paths[1]);
      const n = calls;
      const r = await call(worker());
      downloadThrows = new Set();
      eq([r.body.retry, r.body.failed, calls - n], [1, 1, 0], JSON.stringify(r.body));
      eq((await segRows(rec)).map((x) => [x.status, x.error_code]), [["QUEUED", "STORAGE_ERROR"], ["FAILED", "AUDIO_MISSING"]]);
    });

    await t.step("7. 시간 예산: 새 구간은 예산 안에서만 가져오고, 남았으면 다음 호출 예약", async () => {
      const { rec, tags } = await record(users[1], 3, 60);
      tags.forEach((tag) => behaviors.set(tag, ok("x", 60, 150)));
      let continued = 0;
      const r = await call(worker({ budgetMs: 400, callTimeoutMs: 300, continueLater: () => { continued++; } }));
      eq([r.body.done, r.body.more, continued], [2, true, 1], JSON.stringify(r.body));
      eq((await segRows(rec)).map((x) => x.status), ["DONE", "DONE", "QUEUED"], "남은 구간은 대기 그대로");
    });
    await t.step("8. 처리 도중 다른 워커에게 넘어감(lease 바뀜): 늦은 결과는 버리고 음성도 지우지 않음", async () => {
      const { rec, tags, paths } = await record(users[2], 1, 60);
      behaviors.set(tags[0], async () => {
        await db.query(`update private.stt_segments set lease_id = gen_random_uuid() where recording_id = $1`, [rec]);
        return ok("늦은 결과", 60)(new AbortController().signal);
      });
      const r = await call(worker());
      eq(r.body.lost, 1, JSON.stringify(r.body));
      eq([(await segRows(rec))[0].transcript, files.has(paths[0])], [null, true], "전사문 저장 안 됐으면 음성 유지");
    });
    console.log("stt-worker 확인 통과");
  } finally {
    await db.end(); await svc.end();
  }
});
