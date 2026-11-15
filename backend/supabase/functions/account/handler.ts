// =====================================================================
// 계정 API (Edge Function `account`) — 요청 처리 로직
//   index.ts가 Supabase 클라이언트로 deps를 만들어 넘김. 테스트는 가짜 Storage·Auth로 같은 코드를 돌림
//
//   POST /functions/v1/account/delete   회원 탈퇴 (#33)
//        body: { confirm: 'DELETE' }   (실수로 부르지 않게. 앱은 그 전에 비밀번호를 다시 확인)
//        200 { ok, deleted_workspaces, owner_moved, left }
//        502 STORAGE_FAILED | AUTH_DELETE_FAILED → 다시 부르면 이어서 함 (이미 한 단계는 건너뜀)
//
//   순서: ① DB 정리(account_withdraw_prepare: 혼자인 공간 삭제·OWNER 넘기기·나가기) → 지울 파일 목록
//         ② Storage 파일 삭제 ③ 계정 삭제(account_withdraw_finish) ④ 로그인 계정(Auth) 삭제
//   공유 기록은 남고 작성자 칸은 null → 앱에서 '탈퇴한 사용자'
// =====================================================================

export type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

export interface Deps {
  /** 로그인 토큰 → 사용자 id (아니면 null) */
  getUserId(token: string): Promise<string | null>;
  /** service_role로 DB 함수 호출 */
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
  /** Storage 파일 여러 개 삭제 (없는 파일은 성공으로) */
  removeObjects(bucket: string, paths: string[]): Promise<void>;
  /** Auth 사용자 삭제 (이미 없으면 성공으로) */
  deleteAuthUser(userId: string): Promise<void>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BODY = 4 * 1024;
const BATCH = 100;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
const fail = (status: number, code: string, message: string) => reply(status, { ok: false, code, message });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const b = JSON.parse(text || "{}");
    return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function withdraw(deps: Deps, userId: string): Promise<Response> {
  // ① DB 정리 (이미 계정이 지워졌으면 NOT_FOUND → ④만 남은 재시도)
  const prep = await deps.rpc("account_withdraw_prepare", { p_account_id: userId });
  let summary: Record<string, unknown> = { deleted_workspaces: [], owner_moved: [], left: [] };
  if (prep.error) {
    if (!/^NOT_FOUND/.test(prep.error.message)) {
      deps.log?.("prepare failed", { message: prep.error.message });
      return fail(500, "SERVER_ERROR", "탈퇴를 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요");
    }
  } else {
    const r = prep.data as { objects?: { bucket: string; path: string }[] } & Record<string, unknown>;
    summary = { deleted_workspaces: r.deleted_workspaces ?? [], owner_moved: r.owner_moved ?? [], left: r.left ?? [] };

    // ② 파일 삭제 (버킷별로 100개씩)
    const byBucket = new Map<string, string[]>();
    for (const o of r.objects ?? []) {
      if (!o?.bucket || !o?.path) continue;
      byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.path]);
    }
    try {
      for (const [bucket, paths] of byBucket) {
        for (let i = 0; i < paths.length; i += BATCH) await deps.removeObjects(bucket, paths.slice(i, i + BATCH));
      }
    } catch (e) {
      deps.log?.("storage remove failed", { message: (e as Error).message });
      return fail(502, "STORAGE_FAILED", "파일을 지우지 못했어요. 잠시 뒤 다시 시도해 주세요 (공간 정리는 끝났어요)");
    }

    // ③ 계정 삭제
    const fin = await deps.rpc("account_withdraw_finish", { p_account_id: userId });
    if (fin.error) {
      deps.log?.("finish failed", { message: fin.error.message });
      return fail(500, "SERVER_ERROR", "탈퇴를 마무리하지 못했어요. 잠시 뒤 다시 시도해 주세요");
    }
  }

  // ④ 로그인 계정 삭제
  try {
    await deps.deleteAuthUser(userId);
  } catch (e) {
    deps.log?.("auth delete failed", { message: (e as Error).message });
    return fail(502, "AUTH_DELETE_FAILED", "로그인 계정을 지우지 못했어요. 잠시 뒤 다시 시도해 주세요");
  }
  return reply(200, { ok: true, ...summary });
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST만 지원합니다");

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = token ? await deps.getUserId(token).catch(() => null) : null;
    if (!userId) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다");

    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    try {
      if (path.endsWith("/delete")) {
        const b = await readBody(req);
        if (!b) return fail(400, "INVALID_REQUEST", "JSON 객체가 필요합니다");
        if (b.confirm !== "DELETE") return fail(400, "CONFIRM_REQUIRED", "탈퇴하려면 confirm: 'DELETE'를 보내 주세요");
        return await withdraw(deps, userId);
      }
      return fail(404, "NOT_FOUND", "지원하지 않는 경로입니다 (현재: /delete)");
    } catch (e) {
      deps.log?.("unexpected", { message: (e as Error)?.message });
      return fail(500, "SERVER_ERROR", "서버 오류입니다. 잠시 후 다시 시도해 주세요");
    }
  };
}
