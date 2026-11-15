// =====================================================================
// 긴 녹음 구간 전사 워커 (Supabase Edge Function `stt-worker`, verify_jwt=false)
//   규칙 설명은 handler.ts 맨 위. 매분 cron(stt-worker-tick)과 업로드 확인(stt_segment_confirm)이 깨움
//   환경변수: OPENAI_API_KEY(필수), OPENAI_STT_MODEL(기본 gpt-transcribe), OPENAI_BASE_URL(테스트용),
//            STT_WORKER_CONCURRENCY(기본 2)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { createWorker } from "./handler.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
const OPENAI_API_KEY = env("OPENAI_API_KEY");
const OPENAI_BASE_URL = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, "");

const admin = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const isNotFound = (e: any) => e?.status === 404 || String(e?.statusCode ?? "") === "404" || /not.?found/i.test(e?.message ?? "");

Deno.serve((req: Request) => {
  const secret = req.headers.get("x-cleanup-secret") ?? "";
  return createWorker({
    rpc: async (name, args) => {
      const { data, error } = await admin.rpc(name, args);
      return { data, error: error ? { message: error.message } : null };
    },
    openai: (form, signal) => fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
      method: "POST", headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` }, body: form, signal,
    }),
    storage: {
      async download(bucket, path) {
        const { data, error } = await admin.storage.from(bucket).download(path);
        if (error) { if (isNotFound(error)) return null; throw error; }
        return new Uint8Array(await data.arrayBuffer());
      },
      async remove(bucket, paths) {
        const { error } = await admin.storage.from(bucket).remove(paths);
        if (error && !isNotFound(error)) throw error;
      },
    },
    configured: OPENAI_API_KEY.length > 0,
    model: env("OPENAI_STT_MODEL", "gpt-transcribe"),
    maxConcurrent: Math.min(4, Math.max(1, Number(env("STT_WORKER_CONCURRENCY", "2")) || 2)),
    // 남은 구간이 있으면 바로 다음 호출 (cron을 1분 기다리지 않게)
    continueLater: () => {
      const next = fetch(`${SUPABASE_URL}/functions/v1/stt-worker`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-cleanup-secret": secret }, body: "{}",
      }).then((r) => r.body?.cancel()).catch((e) => console.error("continue failed", e?.message));
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil?.(next);
    },
  })(req);
});
