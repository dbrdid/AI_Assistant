// ai-gateway 녹음 → 글자 처리 테스트 (Deno): 올리기 준비 → 올리기 → 변환 → 성공하면 삭제 / 실패하면 보관
//   진짜 transcribe.ts + 로컬 Postgres(보관함·한도 함수, service_role) + 가짜 Storage(메모리) + 가짜 OpenAI
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check transcribe_function.test.ts
import nodeAssert from "node:assert/strict";
import pg from "npm:pg@8";
import { audioExtension, createTranscribeHandlers, MAX_AUDIO_BYTES, type TranscribeDeps } from "../functions/ai-gateway/transcribe.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => nodeAssert.ok(v, m);
async function client() { const c = new pg.Client(PG); await c.connect(); return c; }

type Sent = { model: string; fileName: string; fileType: string; bytes: Uint8Array; languages: string[]; keywords: string[]; prompt: string | null };
type Fake = (sent: Sent, signal: AbortSignal) => Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

Deno.test("transcribe: 올리기 → 변환 → 성공하면 삭제, 실패하면 3일 보관, 분 단위 한도", async (t) => {
  const db = await client();
  const svc = await client(); await svc.query("set role service_role");
  const me = crypto.randomUUID(), noConsent = crypto.randomUUID(), other = crypto.randomUUID();
  for (const id of [me, noConsent, other]) await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@t.dev`]);
  for (const id of [me, other]) await db.query(`insert into public.consents (account_id, consent_type, policy_version) values ($1, 'EXTERNAL_AI', 'v1')`, [id]);
  const oc = await client();
  await oc.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: other, role: "authenticated" })]);
  await oc.query("set role authenticated");
  const ws = (await oc.query("select public.create_workspace('남의 공간') as r")).rows[0].r;
  await oc.end();

  // 가짜 Storage
  const objects = new Map<string, Uint8Array>();
  const tokens = new Map<string, string>();
  const st = { failDownload: false, failRemove: false, removed: [] as string[] };
  const storage: TranscribeDeps["storage"] = {
    async createSignedUploadUrl(b, p) { const token = crypto.randomUUID(); tokens.set(token, `${b}/${p}`); return { signedUrl: `https://s/${b}/${p}?token=${token}`, token, path: p }; },
    async download(b, p) { if (st.failDownload) throw new Error("connection reset"); return objects.get(`${b}/${p}`) ?? null; },
    async remove(b, ps) { if (st.failRemove) throw new Error("storage down"); for (const p of ps) { objects.delete(`${b}/${p}`); st.removed.push(p); } },
  };
  const put = (prep: any, bytes: Uint8Array) => {   // 앱이 서명 URL로 올리는 것 흉내
    nodeAssert.equal(tokens.get(prep.token), `${prep.bucket}/${prep.path}`, "서명 토큰");
    objects.set(`${prep.bucket}/${prep.path}`, bytes);
  };

  const rpc: TranscribeDeps["rpc"] = async (name, args) => {
    const keys = Object.keys(args);
    try {
      const r = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
      return { data: r.rows[0].r, error: null };
    } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  };
  const sent: Sent[] = [];
  let queue: Fake[] = [];
  const openai: TranscribeDeps["openai"] = async (form, signal) => {
    const f = form.get("file") as File;
    const s: Sent = { model: String(form.get("model")), fileName: f.name, fileType: f.type, bytes: new Uint8Array(await f.arrayBuffer()),
      languages: form.getAll("languages[]").map(String), keywords: form.getAll("keywords[]").map(String), prompt: form.get("prompt") as string | null };
    sent.push(s);
    const next = queue.shift();
    if (!next) throw new Error("가짜 OpenAI 응답이 준비되지 않음");
    return await next(s, signal);
  };
  const make = (over: Partial<TranscribeDeps> = {}) =>
    createTranscribeHandlers({ rpc, openai, storage, model: "gpt-transcribe", maxSeconds: 1800, timeoutMs: 5000, retryDelayMs: 0, ...over });
  const h = make();

  const post = async (fn: (r: Request, u: string) => Promise<Response>, uid: string, body: unknown) => {
    const res = await fn(new Request("https://x/t", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), uid);
    return { status: res.status, body: await res.json() };
  };
  const audio = (n = 3000, fill = 7) => new Uint8Array(n).fill(fill);
  const prepareAndPut = async (uid = me, bytes = audio(), mime = "audio/m4a", fileName = "회의 녹음.m4a") => {
    const uploadId = crypto.randomUUID();
    const p = await post(h.prepare, uid, { upload_id: uploadId, mime_type: mime, size_bytes: bytes.byteLength, file_name: fileName });
    eq(p.status, 200, JSON.stringify(p.body));
    put(p.body, bytes);
    return { uploadId, prep: p.body };
  };
  const usage = async (uid: string) =>
    (await db.query(`select used || '/' || reserved as u from public.usage_counters where account_id = $1 and metric = 'AI_STT'`, [uid])).rows[0]?.u ?? "none";
  const row = async (uploadId: string) => (await db.query(`select status, object_deleted, attempts, expires_at > now() + interval '71 hours' as kept3d from private.stt_uploads where id = $1`, [uploadId])).rows[0];

  try {
    await t.step("1. 올리기 준비 → 비공개 버킷 서명 URL → 변환 성공 → 녹음 바로 삭제", async () => {
      const { uploadId, prep } = await prepareAndPut();
      eq([prep.bucket, prep.path, typeof prep.signed_url], ["stt-uploads", `${me}/${uploadId}`, "string"]);
      queue = [async () => json(200, { text: "  다음 주 금요일까지 발표 자료 정리하기  ", languages: [{ code: "ko" }], usage: { type: "duration", seconds: 115 } }, { "x-request-id": "req_abc" })];
      const r = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 130.4,
        languages: ["ko", "EN"], keywords: ["Stella", "손주원"], prompt: "팀 회의" });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(r.body.draft, { text: "다음 주 금요일까지 발표 자료 정리하기", languages: ["ko"] });
      eq([r.body.duration_seconds, r.body.charged_minutes, r.body.remaining_minutes, r.body.upload_deleted], [115, 2, 58, true]);
      const s = sent.at(-1)!;
      eq([s.model, s.fileName, s.fileType, s.languages, s.keywords, s.prompt], ["gpt-transcribe", "audio.m4a", "audio/mp4", ["ko", "en"], ["Stella", "손주원"], "팀 회의"]);
      eq(s.bytes, audio(), "올린 녹음 그대로");
      eq(objects.has(`stt-uploads/${me}/${uploadId}`), false, "성공하면 녹음 삭제");
      eq((await row(uploadId)).status, "DONE");
      eq((await row(uploadId)).object_deleted, true);
      eq(await usage(me), "2/0");
      const led = (await db.query(`select row_to_json(r)::text as raw, status from public.ai_requests r where id = $1`, [r.body.request_id])).rows[0];
      ok(led.status === "SUCCEEDED" && !led.raw.includes("발표 자료") && !led.raw.includes("팀 회의"), "원장에 전사 글 없음");

      const again = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 130 });
      eq([again.status, again.body.code], [410, "UPLOAD_GONE"], "지운 녹음은 다시 못 씀");
      const reprep = await post(h.prepare, me, { upload_id: uploadId, mime_type: "audio/mp4", size_bytes: 10 });
      eq([reprep.status, reprep.body.code], [410, "UPLOAD_GONE"], "끝난 업로드 id 재사용 불가");
    });

    await t.step("2. 변환 실패(400) → 녹음은 남고 3일 보관 → 다시 올리지 않고 새 요청으로 성공", async () => {
      const { uploadId } = await prepareAndPut();
      queue = [async () => json(400, { error: { message: "Invalid file format" } })];
      const a = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 50 });
      eq([a.status, a.body.code, a.body.upload_kept_days], [422, "AUDIO_REJECTED", 3]);
      eq(objects.has(`stt-uploads/${me}/${uploadId}`), true, "실패하면 녹음 보관");
      const rw = await row(uploadId);
      eq([rw.status, rw.object_deleted, rw.attempts, rw.kept3d], ["FAILED", false, 1, true]);
      eq(await usage(me), "2/0", "실패는 차감 없음");
      queue = [async () => json(200, { text: "다시 성공", usage: { type: "duration", seconds: 50 } })];
      const b = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 50 });
      eq([b.status, b.body.draft.text, objects.has(`stt-uploads/${me}/${uploadId}`)], [200, "다시 성공", false]);
      eq(await usage(me), "3/0");
    });

    await t.step("3. 시간 초과 → 504 (예약한 분 차감), 녹음 보관 → 새 요청으로 다시", async () => {
      const slow = make({ timeoutMs: 300 });
      const { uploadId } = await prepareAndPut();
      queue = [(_s, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))];
      const a = await post(slow.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 61 });
      eq([a.status, a.body.code], [504, "PROVIDER_TIMEOUT"]);
      eq([objects.has(`stt-uploads/${me}/${uploadId}`), await usage(me)], [true, "5/0"], "61초 → 2분 차감, 녹음은 남음");
      queue = [async () => json(200, { text: "두 번째엔 성공", usage: { type: "duration", seconds: 61 } })];
      const b = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 61 });
      eq([b.status, b.body.upload_deleted], [200, true]);
      eq(await usage(me), "7/0");
    });

    await t.step("4. 준비 단계 거절: 동의 없음·형식·크기·남의 id (Storage·OpenAI 안 씀)", async () => {
      const n = sent.length;
      const a = await post(h.prepare, noConsent, { upload_id: crypto.randomUUID(), mime_type: "audio/mp4", size_bytes: 10 });
      eq([a.status, a.body.code], [403, "CONSENT_REQUIRED"], "녹음을 올리기 전에 동의부터");
      const b = await post(h.prepare, me, { upload_id: crypto.randomUUID(), mime_type: "image/png", size_bytes: 10, file_name: "a.png" });
      eq([b.status, b.body.code], [415, "UNSUPPORTED_TYPE"]);
      const c = await post(h.prepare, me, { upload_id: crypto.randomUUID(), mime_type: "audio/mp4", size_bytes: MAX_AUDIO_BYTES + 1 });
      eq([c.status, c.body.code], [413, "TOO_LARGE"]);
      const { uploadId } = await prepareAndPut();
      const d = await post(h.prepare, other, { upload_id: uploadId, mime_type: "audio/mp4", size_bytes: 10 });
      eq([d.status, d.body.code], [409, "UPLOAD_ID_TAKEN"]);
      const e = await post(h.prepare, me, { upload_id: "x", mime_type: "audio/mp4", size_bytes: 10 });
      eq(e.status, 400);
      eq(sent.length, n);
      eq([audioExtension("rec", "audio/x-m4a"), audioExtension("a.m4a", "image/png"), audioExtension("a.aac", "audio/aac")], ["m4a", null, null]);
    });

    await t.step("5. 변환 단계 거절: 없는 업로드·아직 안 올림·남의 업로드·남의 공간·길이·입력 (차감 없음)", async () => {
      const n = sent.length; const before = await usage(me);
      const tr = (uid: string, body: Record<string, unknown>) => post(h.transcribe, uid, { client_request_id: crypto.randomUUID(), duration_seconds: 30, ...body });
      eq((await tr(me, { upload_id: crypto.randomUUID() })).body.code, "NOT_FOUND");
      const notUp = crypto.randomUUID();
      await post(h.prepare, me, { upload_id: notUp, mime_type: "audio/mp4", size_bytes: 10 });
      const nu = await tr(me, { upload_id: notUp });
      eq([nu.status, nu.body.code], [409, "NOT_UPLOADED"], "준비만 하고 안 올림");
      const { uploadId } = await prepareAndPut();
      eq((await tr(other, { upload_id: uploadId })).body.code, "NOT_FOUND", "남의 업로드는 안 보임");
      const f = await tr(me, { upload_id: uploadId, workspace_id: ws });
      eq([f.status, f.body.code], [403, "FORBIDDEN"]);
      const long = await tr(me, { upload_id: uploadId, duration_seconds: 1801 });
      eq([long.status, long.body.code, long.body.max_seconds], [413, "DURATION_TOO_LONG", 1800]);
      for (const bad of [{ duration_seconds: 0 }, { duration_seconds: "abc" }, { duration_seconds: null }, { languages: ["korean"] }, { languages: "ko" },
                         { keywords: ["a<b"] }, { keywords: ["가".repeat(61)] }, { prompt: "가".repeat(1001) }, { prompt: 3 }, { workspace_id: "nope" },
                         { client_request_id: "x" }, { upload_id: "x" }]) {
        const r = await tr(me, { upload_id: uploadId, ...bad });
        eq(r.status, 400, JSON.stringify(bad));
      }
      const huge = await h.transcribe(new Request("https://x/t", { method: "POST", headers: { "content-length": String(20 * 1024) }, body: "{}" }), me);
      eq(huge.status, 413, "큰 JSON 본문은 거절 (녹음은 Storage로)");
      eq([sent.length, await usage(me)], [n, before]);
      eq(objects.has(`stt-uploads/${me}/${uploadId}`), true, "거절돼도 녹음은 그대로 (기한 뒤 정리)");
    });

    await t.step("6. 한도: 남은 분보다 길면 429, 녹음은 남음", async () => {
      await db.query(`update public.usage_counters set used = 55 where account_id = $1 and metric = 'AI_STT'`, [me]);
      const { uploadId } = await prepareAndPut();
      const r = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 360 });
      eq([r.status, r.body.code, r.body.remaining_minutes, r.body.requested_minutes], [429, "QUOTA_EXCEEDED", 5, 6]);
      eq(objects.has(`stt-uploads/${me}/${uploadId}`), true);
      await db.query(`update public.usage_counters set used = 7 where account_id = $1 and metric = 'AI_STT'`, [me]);
    });

    await t.step("7. 일시 오류 재시도: 500 → 성공(2번), 429 계속 → 503(2번), 401 → 다시 안 함", async () => {
      let up = await prepareAndPut();
      queue = [async () => json(500, {}), async () => json(200, { text: "두 번째", usage: { type: "duration", seconds: 30 } })];
      const a = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: up.uploadId, duration_seconds: 30 });
      eq([a.status, a.body.draft?.text], [200, "두 번째"]);
      up = await prepareAndPut();
      let n = sent.length;
      queue = [async () => json(429, {}), async () => json(429, {}), async () => json(200, { text: "안 불려야 함" })];
      const b = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: up.uploadId, duration_seconds: 30 });
      eq([b.status, b.body.code, sent.length - n], [503, "PROVIDER_RATE_LIMITED", 2]);
      n = sent.length;
      queue = [async () => json(401, {}), async () => json(200, { text: "안 불려야 함" })];
      const c = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: up.uploadId, duration_seconds: 30 });
      eq([c.status, c.body.code, sent.length - n], [502, "PROVIDER_AUTH_FAILED", 1]);
      queue = [];
    });

    await t.step("8. 성공했는데 녹음 삭제 실패 → 결과는 주고, 정리 대상에 바로 올라감", async () => {
      const { uploadId } = await prepareAndPut();
      st.failRemove = true;
      queue = [async () => json(200, { text: "결과는 받음", usage: { type: "duration", seconds: 10 } })];
      const r = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 10 });
      st.failRemove = false;
      eq([r.status, r.body.draft.text, r.body.upload_deleted], [200, "결과는 받음", false]);
      const exp = (await svc.query(`select array_agg(object_path) as p from public.stt_upload_expired(100)`)).rows[0].p ?? [];
      ok(exp.includes(`${me}/${uploadId}`), "다음 정리 때 지움");
    });

    await t.step("9. 녹음을 못 꺼냄 → 502, 차감 없음 / 응답에 길이가 없으면 앱이 보낸 길이로", async () => {
      const { uploadId } = await prepareAndPut();
      const before = await usage(me);
      st.failDownload = true;
      const a = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 90 });
      st.failDownload = false;
      eq([a.status, a.body.code, await usage(me)], [502, "STORAGE_ERROR", before]);
      queue = [async () => json(200, { text: "", usage: { type: "tokens", input_tokens: 100 } })];
      const b = await post(h.transcribe, me, { client_request_id: crypto.randomUUID(), upload_id: uploadId, duration_seconds: 90 });
      eq([b.status, b.body.draft.text, b.body.charged_minutes], [200, "", 2]);
    });
    console.log("transcribe 9단계 통과");
  } finally {
    await db.end(); await svc.end();
  }
});
