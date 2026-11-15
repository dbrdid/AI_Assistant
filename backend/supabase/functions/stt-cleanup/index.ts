// =====================================================================
// 녹음 임시 보관함 정리 (Supabase Edge Function `stt-cleanup`, verify_jwt=false)
//   규칙 설명은 handler.ts 맨 위. 매시간 cron(stt-uploads-cleanup)이 부름
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { createCleanupHandler } from "./handler.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createCleanupHandler({
  rpc: async (name, args) => {
    const { data, error } = await admin.rpc(name, args);
    return { data, error: error ? { message: error.message } : null };
  },
  async remove(bucket, paths) {
    const { error } = await admin.storage.from(bucket).remove(paths);
    if (error) throw error;
  },
}));
