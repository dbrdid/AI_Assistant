// =====================================================================
// 초대 메일 (Edge Function `invite-mail`) — 요청 처리 로직 (#35)
//   POST /functions/v1/invite-mail/send
//        body: { code, email? }   code = 초대를 만들 때 받은 코드 (createInvite / createProjectInvite 결과)
//                                 email = 공간 초대일 때 받는 주소 (프로젝트 메일 초대는 초대에 적힌 주소로 감)
//        200 { ok, email, kind }  메일 보냄
//        503 MAIL_NOT_CONFIGURED  서버에 SMTP_PASSWORD가 아직 없음 → 앱은 공유 문구로 보내기
//        409 MAIL_TOO_SOON (10분 안에 같은 주소) · 429 MAIL_LIMIT (하루 한도) · 403 FORBIDDEN (초대한 사람 아님)
//        400 INVITE_* · INVALID_EMAIL · 502 MAIL_FAILED (SMTP 오류, 다시 시도 가능)
//   확인·한도·기록은 DB(invite_mail_prepare / invite_mail_result), 메일은 Gmail SMTP 465 (index.ts)
// =====================================================================

export type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

export interface MailMessage { to: string; subject: string; text: string; html: string }

export interface Deps {
  getUserId(token: string): Promise<string | null>;
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
  /** null = SMTP 설정 없음 */
  sendMail: ((m: MailMessage) => Promise<void>) | null;
  /** 앱으로 바로 여는 링크 앞부분 (기본 stella://invite) */
  inviteUrlBase?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface MailInfo {
  mail_id: string; email: string; kind: "WORKSPACE" | "PROJECT";
  workspace_name: string | null; project_name: string | null; inviter_name: string;
  role: string; expires_at: string; code: string;
}

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const STATUS: Record<string, number> = {
  INVALID_REQUEST: 400, INVALID_EMAIL: 400, INVITE_INVALID: 400, INVITE_EXPIRED: 400, INVITE_REVOKED: 400, INVITE_USED_UP: 400,
  FORBIDDEN: 403, MAIL_TOO_SOON: 409, MAIL_LIMIT: 429,
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
const fail = (status: number, code: string, message: string) => reply(status, { ok: false, code, message });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** 서울 시각 "11월 22일 오후 3:05" */
export function koreanDateTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  const h = d.getUTCHours();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${ampm} ${h12}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** 메일 내용 (제목·글·HTML) */
export function buildInviteMail(info: MailInfo, urlBase = "stella://invite"): MailMessage {
  const ws = info.workspace_name ?? "공간";
  const where = info.kind === "PROJECT" && info.project_name ? `'${ws}' 공간의 '${info.project_name}' 프로젝트` : `'${ws}' 공간`;
  const subject = `[Stella] ${info.inviter_name}님이 ${where}에 초대했어요`;
  const url = `${urlBase}?code=${encodeURIComponent(info.code)}`;
  const until = koreanDateTime(info.expires_at);
  const text = [
    `${info.inviter_name}님이 Stella의 ${where}에 초대했어요.`,
    "",
    `Stella 앱에서 [공간 참여]를 누르고 아래 코드를 입력하세요.`,
    `초대 코드: ${info.code}`,
    `${until}까지 쓸 수 있어요.`,
    "",
    `앱이 설치된 휴대폰에서는 이 링크로 바로 열 수 있어요: ${url}`,
    "",
    "이 메일은 보내기 전용이에요. 모르는 초대라면 무시해 주세요.",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#222;line-height:1.6">
<p><b>${esc(info.inviter_name)}</b>님이 Stella의 ${esc(where)}에 초대했어요.</p>
<p>Stella 앱에서 <b>[공간 참여]</b>를 누르고 아래 코드를 입력하세요.</p>
<p style="font-size:24px;letter-spacing:2px;font-weight:700;margin:16px 0">${esc(info.code)}</p>
<p>${esc(until)}까지 쓸 수 있어요.</p>
<p><a href="${esc(url)}">앱에서 바로 열기</a> (앱이 설치된 휴대폰에서)</p>
<p style="color:#888;font-size:12px">이 메일은 보내기 전용이에요. 모르는 초대라면 무시해 주세요.</p>
</body></html>`;
  return { to: info.email, subject, text, html };
}

async function send(deps: Deps, userId: string, body: Record<string, unknown>): Promise<Response> {
  if (typeof body.code !== "string" || !body.code.trim()) return fail(400, "INVALID_REQUEST", "code가 필요합니다");
  if (body.email !== undefined && body.email !== null && typeof body.email !== "string") return fail(400, "INVALID_EMAIL", "email은 문자열");
  if (!deps.sendMail) return fail(503, "MAIL_NOT_CONFIGURED", "메일 발송이 아직 설정되지 않았어요. 공유하기로 보내 주세요");

  const prep = await deps.rpc("invite_mail_prepare", { p_account_id: userId, p_code: body.code, p_email: body.email ?? null });
  if (prep.error) {
    const m = /^([A-Z_]+): (.*)$/s.exec(prep.error.message ?? "");
    if (m && STATUS[m[1]]) return fail(STATUS[m[1]], m[1], m[2]);
    deps.log?.("prepare failed", { message: prep.error.message });
    return fail(500, "SERVER_ERROR", "서버 오류입니다. 잠시 후 다시 시도해 주세요");
  }
  const info = prep.data as MailInfo;
  try {
    await deps.sendMail(buildInviteMail(info, deps.inviteUrlBase));
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    deps.log?.("smtp failed", { message: msg });
    await deps.rpc("invite_mail_result", { p_mail_id: info.mail_id, p_ok: false, p_error: msg.slice(0, 200) });
    return fail(502, "MAIL_FAILED", "메일을 보내지 못했어요. 잠시 뒤 다시 시도하거나 공유하기로 보내 주세요");
  }
  const res = await deps.rpc("invite_mail_result", { p_mail_id: info.mail_id, p_ok: true });
  if (res.error) deps.log?.("result failed", { message: res.error.message });   // 메일은 이미 감
  return reply(200, { ok: true, email: info.email, kind: info.kind });
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST만 지원합니다");
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = token ? await deps.getUserId(token).catch(() => null) : null;
    if (!userId) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다");
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (!path.endsWith("/send")) return fail(404, "NOT_FOUND", "지원하지 않는 경로입니다 (현재: /send)");
    const text = await req.text();
    let body: unknown;
    try { body = JSON.parse(text || "{}"); } catch { return fail(400, "INVALID_REQUEST", "JSON 형식이 아닙니다"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || text.length > 4096) return fail(400, "INVALID_REQUEST", "JSON 객체가 필요합니다");
    try {
      return await send(deps, userId, body as Record<string, unknown>);
    } catch (e) {
      deps.log?.("unexpected", { message: (e as Error)?.message });
      return fail(500, "SERVER_ERROR", "서버 오류입니다. 잠시 후 다시 시도해 주세요");
    }
  };
}
