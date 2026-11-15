// =====================================================================
// 푸시 알림 발송 (Supabase Edge Function `push-send`, verify_jwt=false) — #34
//   규칙 설명은 handler.ts 맨 위. 매분 cron(push-tick)이 보낼 알림이 있을 때 깨움
//   환경변수: EXPO_ACCESS_TOKEN(선택: Expo 계정에서 "push 보안"을 켰을 때만), EXPO_PUSH_URL(테스트용)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { createSender } from "./handler.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const EXPO_URL = env("EXPO_PUSH_URL", "https://exp.host/--/api/v2/push/send");
const EXPO_TOKEN = env("EXPO_ACCESS_TOKEN");

const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createSender({
  rpc: async (name, args) => {
    const { data, error } = await admin.rpc(name, args);
    return { data, error: error ? { message: error.message } : null };
  },
  expo: (messages) => fetch(EXPO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "Accept": "application/json", "Accept-Encoding": "gzip, deflate",
      ...(EXPO_TOKEN ? { "Authorization": `Bearer ${EXPO_TOKEN}` } : {}),
    },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(15_000),
  }),
  log: (msg, extra) => console.error(`[push-send] ${msg}`, extra ?? {}),
}));
