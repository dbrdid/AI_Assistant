// =====================================================================
// 첨부·백업 업로드 API (Supabase Edge Function `assets`)
//   경로·규칙 설명은 handler.ts 맨 위에 있음
//   service_role 키는 Edge Function 기본 환경변수(SUPABASE_SERVICE_ROLE_KEY). 앱에는 없음
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { createHandler } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: string | number; message?: string } | null;
  return e?.status === 404 || String(e?.statusCode ?? "") === "404" || /not.?found/i.test(e?.message ?? "");
}

Deno.serve(createHandler({
  async getUserId(token) {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  rpc: async (name, args) => {
    const { data, error } = await admin.rpc(name, args);
    return { data, error: error ? { message: error.message, code: error.code } : null };
  },
  storage: {
    async createSignedUploadUrl(bucket, path) {
      // upsert: 업로드가 끊겨 다시 올릴 때 같은 경로에 덮어쓸 수 있게
      const { data, error } = await admin.storage.from(bucket).createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw error ?? new Error("no data");
      return data;
    },
    async download(bucket, path) {
      const { data, error } = await admin.storage.from(bucket).download(path);
      if (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      return { bytes: new Uint8Array(await data.arrayBuffer()), mime: data.type || null };
    },
    async remove(bucket, path) {
      const { error } = await admin.storage.from(bucket).remove([path]);
      if (error && !isNotFound(error)) throw error;
    },
  },
  log: (msg, extra) => console.error(`[assets] ${msg}`, extra ?? {}),
}));
