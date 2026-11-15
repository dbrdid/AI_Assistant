// =====================================================================
// 계정 API (Supabase Edge Function `account`) — 회원 탈퇴
//   경로·순서 설명은 handler.ts 맨 위에 있음
//   service_role 키는 Edge Function 기본 환경변수(SUPABASE_SERVICE_ROLE_KEY). 앱에는 없음
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { createHandler } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const notFound = (e: { status?: number; message?: string } | null) =>
  e?.status === 404 || /not.?found/i.test(e?.message ?? "");

Deno.serve(createHandler({
  async getUserId(token) {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  rpc: async (name, args) => {
    const { data, error } = await admin.rpc(name, args);
    return { data, error: error ? { message: error.message, code: error.code } : null };
  },
  async removeObjects(bucket, paths) {
    const { error } = await admin.storage.from(bucket).remove(paths);   // 없는 파일은 오류 없이 건너뜀
    if (error && !notFound(error)) throw error;
  },
  async deleteAuthUser(userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error && !notFound(error)) throw error;
  },
  log: (msg, extra) => console.error(`[account] ${msg}`, extra ?? {}),
}));
