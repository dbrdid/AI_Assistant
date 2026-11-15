// 앱 모듈 transcribe.ts ↔ ai-gateway transcribe.ts 연결 테스트 (Deno)
//   가짜 Supabase 클라이언트: functions.invoke → 진짜 handler, storage(서명 URL 업로드) → 메모리, usage_counters → 로컬 DB(RLS)
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check --config deno.test.json transcribe_lib.test.ts
//   앱 모듈 경로(아래 import)는 저장소에 둔 위치에 맞게 고치세요 (지금: ../../../frontend/Frontend_UI/src/lib/stella)
import nodeAssert from "node:assert/strict";
import pg from "npm:pg@8";
import { FunctionsHttpError } from "npm:@supabase/supabase-js@2";
import { createTranscribeHandlers, type TranscribeDeps } from "../functions/ai-gateway/transcribe.ts";
import * as T from "../../../frontend/Frontend_UI/src/lib/stella/transcribe.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
async function client() { const c = new pg.Client(PG); await c.connect(); return c; }

Deno.test("transcribe.ts: 올리기·변환·실패 후 다시 변환·오류·사용량", async () => {
  const db = await client();
  const svc = await client(); await svc.query("set role service_role");
  const me = crypto.randomUUID(), nc = crypto.randomUUID();
  for (const id of [me, nc]) await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@t.dev`]);
  await db.query(`insert into public.consents (account_id, consent_type, policy_version) values ($1, 'EXTERNAL_AI', 'v1')`, [me]);

  const objects = new Map<string, Uint8Array>();
  const tokens = new Map<string, string>();
  let uploads = 0;
  const seen: { languages: string[]; keywords: string[]; prompt: string | null }[] = [];
  let queue: (() => Response)[] = [];
  const ok = (text: string, seconds: number) => () => new Response(JSON.stringify({ text, languages: [{ code: "ko" }], usage: { type: "duration", seconds } }), { status: 200 });
  const h = createTranscribeHandlers({
    rpc: async (name, args) => {
      const keys = Object.keys(args);
      try {
        const r = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
        return { data: r.rows[0].r, error: null };
      } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    },
    openai: async (form) => {
      seen.push({ languages: form.getAll("languages[]").map(String), keywords: form.getAll("keywords[]").map(String), prompt: form.get("prompt") as string | null });
      const next = queue.shift();
      return next ? next() : new Response("{}", { status: 500 });
    },
    storage: {
      async createSignedUploadUrl(b, p) { const token = crypto.randomUUID(); tokens.set(token, `${b}/${p}`); return { signedUrl: `x?token=${token}`, token, path: p }; },
      async download(b, p) { return objects.get(`${b}/${p}`) ?? null; },
      async remove(b, ps) { for (const p of ps) objects.delete(`${b}/${p}`); },
    },
    model: "gpt-transcribe", maxSeconds: 1800, timeoutMs: 5000, retryDelayMs: 0,
  } satisfies TranscribeDeps);
  let invokes = 0;

  const fakeClient = (uid: string) => ({
    functions: {
      async invoke(path: string, { body }: { body: unknown }) {
        invokes++;
        const fn = path === "ai-gateway/transcribe/prepare" ? h.prepare : path === "ai-gateway/transcribe" ? h.transcribe : null;
        nodeAssert.ok(fn, path);
        const res = await fn!(new Request(`https://x/functions/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), uid);
        return res.ok ? { data: await res.json(), error: null } : { data: null, error: new FunctionsHttpError(res) };
      },
    },
    storage: {
      from(bucket: string) {
        return {
          async uploadToSignedUrl(path: string, token: string, body: Uint8Array, o: { contentType: string; upsert: boolean }) {
            if (tokens.get(token) !== `${bucket}/${path}` || !o.upsert) return { data: null, error: { message: "bad token" } };
            uploads++; objects.set(`${bucket}/${path}`, new Uint8Array(body)); return { data: { path }, error: null };
          },
        };
      },
    },
    from(table: string) {
      const f: Record<string, string> = {};
      const q = {
        select() { return q; },
        eq(c: string, v: string) { f[c] = v; return q; },
        async maybeSingle() {
          nodeAssert.equal(table, "usage_counters");
          const c = await client();
          await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
          await c.query("set role authenticated");
          const r = await c.query(`select used, reserved from public.usage_counters where metric = $1 and period_start = $2`, [f.metric, f.period_start]);
          await c.end();
          return { data: r.rows[0] ?? null, error: null };
        },
      };
      return q;
    },
  }) as any;
  const err = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as T.TranscribeError).code; } };

  try {
    const A = fakeClient(me);
    const bytes = new Uint8Array(2000).fill(3);

    // 한 번에: 올리기 → 변환 → 서버가 녹음 삭제
    const up1 = crypto.randomUUID();
    queue = [ok("회의 시작하겠습니다.", 95)];
    const r = await T.transcribeAudio(A, { uploadId: up1, clientRequestId: crypto.randomUUID(), bytes, durationSeconds: 96.04,
      keywords: ["Stella", "a<b\nc"], prompt: "가".repeat(1200) });
    eq([r.text, r.chargedMinutes, r.remainingMinutes, r.uploadDeleted, uploads, objects.size], ["회의 시작하겠습니다.", 2, 58, true, 1, 0]);
    eq(seen.at(-1), { languages: ["ko", "en"], keywords: ["Stella", "a b c"], prompt: "가".repeat(1000) });
    eq(await T.getSttUsage(A), { usedMinutes: 2, reservedMinutes: 0 });

    // 실패 → 녹음은 남음 → 다시 올리지 않고 같은 uploadId로 다시 변환
    const up2 = crypto.randomUUID();
    queue = [() => new Response("{}", { status: 500 }), () => new Response("{}", { status: 500 })];
    const failed = await (async () => { try { await T.transcribeAudio(A, { uploadId: up2, clientRequestId: crypto.randomUUID(), bytes, durationSeconds: 30 }); }
                                         catch (e) { return e as T.TranscribeError; } })();
    eq([failed?.code, T.retryPlan(failed!.code), objects.size], ["PROVIDER_ERROR", "same_request", 1], "실패하면 녹음 보관");
    queue = [ok("두 번째엔 성공", 30)];
    const before = uploads;
    const r2 = await T.transcribeUploaded(A, { uploadId: up2, clientRequestId: crypto.randomUUID(), durationSeconds: 30 });
    eq([r2.text, uploads - before, objects.size], ["두 번째엔 성공", 0, 0], "다시 올리지 않음, 성공 뒤 삭제");
    eq(T.retryPlan(await err(T.transcribeUploaded(A, { uploadId: up2, clientRequestId: crypto.randomUUID(), durationSeconds: 30 }))), "reupload", "지운 녹음 → 다시 올리기");

    // 앱에서 걸러지는 오류는 서버에 안 보냄
    const n = invokes;
    eq(await err(T.transcribeAudio(A, { uploadId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), bytes, durationSeconds: 1801 })), "DURATION_TOO_LONG");
    eq(await err(T.transcribeAudio(A, { uploadId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), bytes, durationSeconds: 0 })), "INVALID_REQUEST");
    eq(await err(T.uploadRecording(A, { uploadId: crypto.randomUUID(), bytes: new Uint8Array(0) })), "INVALID_REQUEST");
    eq(await err(T.uploadRecording(A, { uploadId: crypto.randomUUID(), bytes: new Uint8Array(T.STT_MAX_BYTES + 1) })), "TOO_LARGE");
    eq(invokes, n);

    // 서버 오류 코드
    eq(await err(T.uploadRecording(fakeClient(nc), { uploadId: crypto.randomUUID(), bytes })), "CONSENT_REQUIRED", "올리기 전에 동의 확인");
    eq(await err(T.uploadRecording(A, { uploadId: crypto.randomUUID(), bytes, mimeType: "image/png", fileName: "a.png" })), "UNSUPPORTED_TYPE");
    eq(await err(T.transcribeUploaded(A, { uploadId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), durationSeconds: 5 })), "NOT_FOUND");
    eq(await err(T.transcribeUploaded(A, { uploadId: up1, clientRequestId: crypto.randomUUID(), durationSeconds: 5, languages: ["korean"] })), "INVALID_REQUEST");

    eq([T.retryPlan("NETWORK"), T.retryPlan("PROVIDER_TIMEOUT"), T.retryPlan("NOT_UPLOADED"), T.retryPlan("QUOTA_EXCEEDED"), T.retryPlan("AUDIO_REJECTED")],
       ["same_request", "new_request_same_upload", "reupload", "stop", "stop"]);
    eq([T.canRetryTranscribe("NETWORK"), T.canRetryTranscribe("PROVIDER_TIMEOUT")], [true, false]);
    eq(T.transcribeErrorMessage({ code: "UPLOAD_GONE" }).includes("다시 올려"), true);
    eq(T.continuationPrompt("짧은 글."), "짧은 글.");
    console.log("transcribe.ts ↔ handler 확인 통과");
  } finally {
    await db.end(); await svc.end();
  }
});
