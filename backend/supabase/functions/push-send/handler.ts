// =====================================================================
// 푸시 알림 발송 (Edge Function `push-send`, verify_jwt=false) — 요청 처리 로직 (#34)
//   깨우는 곳: 매분 cron(push-tick)이 보낼 알림이 있을 때 pg_net으로 부름
//   1. 호출 확인: 헤더 x-cleanup-secret = Vault 비밀값 (stt-worker와 같은 값, stt_cleanup_check)
//   2. push_claim(100) → 알림 + 그 사람의 Expo 토큰들 (기기가 없는 알림은 DB가 SKIPPED로 정리)
//   3. Expo Push API에 100개씩 보냄 → 표(ticket)마다 성공·실패, DeviceNotRegistered는 잘못된 토큰
//   4. push_report → 성공 SENT / 실패는 1분 뒤 다시(3번까지) / 잘못된 토큰은 기기에서 뺌
//   시간 예산 안에서 보낼 것이 없을 때까지 반복
// =====================================================================

export type RpcResult = { data: unknown; error: { message: string } | null };

export interface Deps {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
  /** Expo Push API 호출 (messages ≤ 100개) */
  expo(messages: ExpoMessage[]): Promise<Response>;
  budgetMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ExpoMessage {
  to: string;
  title?: string | null;
  body?: string | null;
  data?: Record<string, unknown>;
  sound?: "default";
  priority?: "high" | "default";
  channelId?: string;
}

interface Claimed { id: string; kind: string; tokens: string[]; title: string | null; body: string | null; data: Record<string, unknown> }
type Ticket = { status: "ok"; id?: string } | { status: "error"; message?: string; details?: { error?: string } };

export const EXPO_BATCH = 100;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/** 한 묶음(≤100 메시지) 보내기 → 메시지마다 결과 */
async function sendBatch(deps: Deps, msgs: ExpoMessage[]): Promise<Ticket[]> {
  let res: Response;
  try {
    res = await deps.expo(msgs);
  } catch (e) {
    return msgs.map(() => ({ status: "error", message: `NETWORK: ${(e as Error).message}` }));
  }
  let payload: { data?: Ticket[]; errors?: { code?: string; message?: string }[] } | null = null;
  try { payload = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok || !Array.isArray(payload?.data) || payload!.data!.length !== msgs.length) {
    const why = payload?.errors?.[0]?.code ?? `HTTP_${res.status}`;
    return msgs.map(() => ({ status: "error", message: why }));
  }
  return payload!.data!;
}

export function createSender(deps: Deps) {
  const budget = deps.budgetMs ?? 25_000;
  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    const { data: okSecret, error: secErr } = await deps.rpc("stt_cleanup_check", { p_secret: req.headers.get("x-cleanup-secret") ?? "" });
    if (secErr) { deps.log?.("secret check failed", { message: secErr.message }); return json(500, { ok: false, code: "INTERNAL" }); }
    if (okSecret !== true) return json(401, { ok: false, code: "UNAUTHORIZED" });

    const started = Date.now();
    const tally = { notifications: 0, sent: 0, failed: 0, tokens_removed: 0, batches: 0 };
    while (Date.now() - started < budget) {
      const { data, error } = await deps.rpc("push_claim", { p_limit: 100 });
      if (error) { deps.log?.("push_claim failed", { message: error.message }); break; }
      const claimed = (Array.isArray(data) ? data : []) as Claimed[];
      if (claimed.length === 0) break;
      tally.notifications += claimed.length;

      // 토큰마다 메시지 하나 (한 사람이 기기 여러 대)
      const msgs: { n: Claimed; token: string; msg: ExpoMessage }[] = [];
      for (const n of claimed) {
        for (const token of n.tokens ?? []) {
          msgs.push({ n, token, msg: { to: token, title: n.title, body: n.body, data: n.data ?? {}, sound: "default", priority: "high", channelId: "default" } });
        }
      }
      const outcome = new Map<string, { ok: boolean; error?: string; bad: string[] }>();
      for (const n of claimed) outcome.set(n.id, { ok: false, bad: [] });
      for (let i = 0; i < msgs.length; i += EXPO_BATCH) {
        const chunk = msgs.slice(i, i + EXPO_BATCH);
        tally.batches++;
        const tickets = await sendBatch(deps, chunk.map((m) => m.msg));
        chunk.forEach((m, k) => {
          const o = outcome.get(m.n.id)!;
          const t = tickets[k];
          if (t?.status === "ok") o.ok = true;
          else {
            const code = (t as { details?: { error?: string } })?.details?.error ?? (t as { message?: string })?.message ?? "UNKNOWN";
            o.error = o.error ?? code;
            if (code === "DeviceNotRegistered") o.bad.push(m.token);
          }
        });
      }
      const results = [...outcome].map(([id, o]) => ({
        id, ok: o.ok, ...(o.ok ? {} : { error: o.error ?? "UNKNOWN" }), ...(o.bad.length ? { bad_tokens: o.bad } : {}),
      }));
      const { data: rep, error: repErr } = await deps.rpc("push_report", { p_results: results });
      if (repErr) { deps.log?.("push_report failed", { message: repErr.message }); break; }
      const r = rep as { sent?: number; failed?: number; tokens_removed?: number };
      tally.sent += r.sent ?? 0; tally.failed += r.failed ?? 0; tally.tokens_removed += r.tokens_removed ?? 0;
      if (claimed.length < 100) break;
    }
    return json(200, { ok: true, ...tally });
  };
}
