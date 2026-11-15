// =====================================================================
// 초대 메일 (Supabase Edge Function `invite-mail`) — #35
//   규칙 설명은 handler.ts 맨 위
//   환경변수 (Edge Functions → Secrets):
//     SMTP_PASSWORD (필수, Gmail 앱 비밀번호 — 병욱이 직접 등록. 없으면 503 MAIL_NOT_CONFIGURED)
//     SMTP_USER (기본 stella.app.noreply@gmail.com), SMTP_HOST (기본 smtp.gmail.com), SMTP_PORT (기본 465, SSL)
//     MAIL_FROM_NAME (기본 Stella), INVITE_URL_BASE (기본 stella://invite — app.json scheme을 정하면 맞추기)
//   Edge Function은 SMTP 25·587 포트를 막아서 465(SSL)를 씀
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";
import { createHandler } from "./handler.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SMTP_PASSWORD = env("SMTP_PASSWORD");
const SMTP_USER = env("SMTP_USER", "stella.app.noreply@gmail.com");
const transport = SMTP_PASSWORD
  ? nodemailer.createTransport({
      host: env("SMTP_HOST", "smtp.gmail.com"), port: Number(env("SMTP_PORT", "465")), secure: true,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    })
  : null;
const FROM = `"${env("MAIL_FROM_NAME", "Stella")}" <${SMTP_USER}>`;

Deno.serve(createHandler({
  async getUserId(token) {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  rpc: async (name, args) => {
    const { data, error } = await admin.rpc(name, args);
    return { data, error: error ? { message: error.message, code: error.code } : null };
  },
  sendMail: transport
    ? async (m) => { await transport.sendMail({ from: FROM, to: m.to, subject: m.subject, text: m.text, html: m.html }); }
    : null,
  inviteUrlBase: env("INVITE_URL_BASE", "stella://invite"),
  log: (msg, extra) => console.error(`[invite-mail] ${msg}`, extra ?? {}),
}));
