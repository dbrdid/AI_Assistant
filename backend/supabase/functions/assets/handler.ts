// =====================================================================
// 첨부·백업 업로드 API (Edge Function `assets`) — 요청 처리 로직
//   index.ts가 Supabase 클라이언트로 deps를 만들어 넘김. 테스트는 가짜 Storage로 같은 코드를 돌림
//
//   POST /functions/v1/assets/prepare   업로드 준비 → 서명 업로드 URL
//        body: { asset_id, purpose: 'ATTACHMENT'|'BACKUP', workspace_id?, original_name?, mime_type, size_bytes, sha256 }
//        200 { ok, status:'PENDING', asset_id, bucket, path, token, signed_url }   → 앱이 uploadToSignedUrl로 올림
//        200 { ok, status:'AVAILABLE', asset }                                  → 이미 끝난 업로드 (다시 올릴 필요 없음)
//   POST /functions/v1/assets/complete  업로드 확인 (실제 객체의 크기·SHA-256·형식을 서버가 직접 계산)
//        body: { asset_id }
//        200 { ok, status:'AVAILABLE', asset }   409 NOT_UPLOADED (다시 올리고 다시 complete)
//        422 HASH_MISMATCH | SIZE_MISMATCH | TYPE_MISMATCH | FORBIDDEN (객체는 지움, 새 asset_id로 다시)
//   POST /functions/v1/assets/delete    삭제 (공유 첨부: 올린 사람 또는 OWNER, 백업: 본인)
//        body: { asset_id }   200 { ok, status:'DELETED' }
//
//   다운로드는 이 함수가 아니라 앱이 Storage 서명 URL을 직접 받음 (storage.objects 정책이 권한 확인)
//   권한·한도·같은 id 재요청 규칙은 DB 함수(asset_prepare/complete/delete)가 판단
// =====================================================================

export type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

export interface StorageDeps {
  createSignedUploadUrl(bucket: string, path: string): Promise<{ signedUrl: string; token: string; path: string }>;
  /** 객체 내용. 없으면 null */
  download(bucket: string, path: string): Promise<{ bytes: Uint8Array; mime: string | null } | null>;
  remove(bucket: string, path: string): Promise<void>;
}

export interface Deps {
  /** 로그인 토큰 → 사용자 id (아니면 null) */
  getUserId(token: string): Promise<string | null>;
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
  storage: StorageDeps;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 8 * 1024;

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// DB 함수 오류 코드 → HTTP 상태
const STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  UNSUPPORTED_TYPE: 415,
  TOO_LARGE: 413,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  QUOTA_EXCEEDED: 409,
  TOO_MANY_PENDING: 429,
  ASSET_ID_TAKEN: 409,
  ASSET_FAILED: 409,
  ASSET_DELETED: 410,
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return reply(status, { ok: false, code, message, ...extra });
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** DB 함수가 낸 'CODE: 메시지' 오류만 앱에 그대로 알림. 그 밖의 오류 내용은 숨김 */
function rpcError(err: { message: string }): HttpError {
  const m = /^([A-Z_]+): (.*)$/s.exec(err.message ?? "");
  if (m && STATUS[m[1]]) return new HttpError(STATUS[m[1]], m[1], m[2]);
  return new HttpError(500, "SERVER_ERROR", "서버 오류입니다. 잠시 후 다시 시도해 주세요");
}

async function call(deps: Deps, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await deps.rpc(name, args);
  if (error) {
    const e = rpcError(error);
    if (e.status === 500) deps.log?.(`${name} failed`, { message: error.message, code: error.code });
    throw e;
  }
  return data as Record<string, unknown>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "INVALID_REQUEST", "요청이 너무 큽니다");
  let body: unknown;
  try { body = JSON.parse(text || "{}"); } catch { throw new HttpError(400, "INVALID_REQUEST", "JSON 형식이 아닙니다"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "INVALID_REQUEST", "JSON 객체가 필요합니다");
  return body as Record<string, unknown>;
}

function uuidField(b: Record<string, unknown>, key: string, optional = false): string | null {
  const v = b[key];
  if ((v === undefined || v === null) && optional) return null;
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new HttpError(400, "INVALID_REQUEST", `${key}는 uuid여야 합니다`);
  return v.toLowerCase();
}

// ---------------------------------------------------------------------
async function prepare(deps: Deps, userId: string, b: Record<string, unknown>): Promise<Response> {
  const assetId = uuidField(b, "asset_id")!;
  const workspaceId = uuidField(b, "workspace_id", true);
  const purpose = b.purpose ?? "ATTACHMENT";
  const size = b.size_bytes;
  if (purpose !== "ATTACHMENT" && purpose !== "BACKUP") throw new HttpError(400, "INVALID_REQUEST", "purpose는 ATTACHMENT 또는 BACKUP");
  if (typeof b.mime_type !== "string" || !b.mime_type) throw new HttpError(400, "INVALID_REQUEST", "mime_type이 필요합니다");
  if (typeof size !== "number" || !Number.isSafeInteger(size)) throw new HttpError(400, "INVALID_REQUEST", "size_bytes는 정수여야 합니다");
  if (typeof b.sha256 !== "string") throw new HttpError(400, "INVALID_REQUEST", "sha256이 필요합니다");
  if (b.original_name !== undefined && b.original_name !== null && typeof b.original_name !== "string") {
    throw new HttpError(400, "INVALID_REQUEST", "original_name은 문자열이어야 합니다");
  }

  const r = await call(deps, "asset_prepare", {
    p_account_id: userId, p_asset_id: assetId, p_purpose: purpose, p_workspace_id: workspaceId,
    p_original_name: (b.original_name as string | undefined) ?? null, p_mime_type: b.mime_type,
    p_size_bytes: size, p_sha256: b.sha256,
  });
  if (r.status === "AVAILABLE") return reply(200, { ok: true, status: "AVAILABLE", asset: r.asset });

  let signed: { signedUrl: string; token: string; path: string };
  try {
    signed = await deps.storage.createSignedUploadUrl(r.bucket as string, r.path as string);
  } catch (e) {
    deps.log?.("createSignedUploadUrl failed", { message: (e as Error).message });
    throw new HttpError(502, "STORAGE_ERROR", "업로드 주소를 만들지 못했습니다. 잠시 후 다시 시도해 주세요");
  }
  return reply(200, {
    ok: true, status: "PENDING", asset_id: assetId, bucket: r.bucket, path: r.path,
    token: signed.token, signed_url: signed.signedUrl, reused: r.reused === true,
  });
}

async function complete(deps: Deps, userId: string, b: Record<string, unknown>): Promise<Response> {
  const assetId = uuidField(b, "asset_id")!;
  // 1) 현재 상태와 경로 (끝난 업로드면 그대로 돌려줌)
  const cur = await call(deps, "asset_complete", { p_account_id: userId, p_asset_id: assetId, p_actual_size: null, p_actual_sha256: null });
  if (cur.status === "AVAILABLE") return reply(200, { ok: true, status: "AVAILABLE", asset: cur.asset, replayed: true });
  if (cur.status === "FAILED" || cur.status === "DELETED") {
    await removeQuietly(deps, cur.bucket as string, cur.path as string);
    return fail(cur.status === "DELETED" ? 410 : 422, String(cur.reason ?? cur.status), "확인에 실패한 업로드입니다. 새로 올려 주세요");
  }

  // 2) 실제 객체를 받아서 직접 잰다
  let obj: { bytes: Uint8Array; mime: string | null } | null;
  try {
    obj = await deps.storage.download(cur.bucket as string, cur.path as string);
  } catch (e) {
    deps.log?.("download failed", { message: (e as Error).message });
    throw new HttpError(502, "STORAGE_ERROR", "파일을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요");
  }
  if (!obj) return fail(409, "NOT_UPLOADED", "아직 파일이 올라가지 않았습니다. 업로드한 뒤 다시 확인해 주세요");

  const done = await call(deps, "asset_complete", {
    p_account_id: userId, p_asset_id: assetId,
    p_actual_size: obj.bytes.byteLength, p_actual_sha256: await sha256Hex(obj.bytes), p_actual_mime: obj.mime,
  });
  if (done.status === "AVAILABLE") return reply(200, { ok: true, status: "AVAILABLE", asset: done.asset });
  if (done.status === "FAILED") {
    await removeQuietly(deps, done.bucket as string, done.path as string);
    return fail(422, String(done.reason), FAIL_TEXT[String(done.reason)] ?? "파일 확인에 실패했습니다");
  }
  return fail(409, "NOT_UPLOADED", "아직 파일이 올라가지 않았습니다");
}

const FAIL_TEXT: Record<string, string> = {
  HASH_MISMATCH: "올린 파일 내용이 준비할 때와 다릅니다. 새로 올려 주세요",
  SIZE_MISMATCH: "올린 파일 크기가 준비할 때와 다릅니다. 새로 올려 주세요",
  TYPE_MISMATCH: "올린 파일 형식이 준비할 때와 다릅니다. 새로 올려 주세요",
  FORBIDDEN: "이 공간에 파일을 올릴 권한이 없어졌습니다",
};

async function remove(deps: Deps, userId: string, b: Record<string, unknown>): Promise<Response> {
  const assetId = uuidField(b, "asset_id")!;
  const r = await call(deps, "asset_delete", { p_account_id: userId, p_asset_id: assetId });
  await removeQuietly(deps, r.bucket as string, r.path as string);
  return reply(200, { ok: true, status: "DELETED", asset_id: assetId, replayed: r.replayed === true });
}

/** 객체 삭제 실패는 사용자 결과에 영향 없음 (DB는 이미 FAILED/DELETED라 아무도 못 받음) */
async function removeQuietly(deps: Deps, bucket: string, path: string): Promise<void> {
  if (!bucket || !path) return;
  try { await deps.storage.remove(bucket, path); } catch (e) { deps.log?.("remove failed", { message: (e as Error).message }); }
}

// ---------------------------------------------------------------------
export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "POST만 지원합니다");

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = token ? await deps.getUserId(token).catch(() => null) : null;
    if (!userId) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다");

    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    try {
      if (path.endsWith("/prepare")) return await prepare(deps, userId, await readBody(req));
      if (path.endsWith("/complete")) return await complete(deps, userId, await readBody(req));
      if (path.endsWith("/delete")) return await remove(deps, userId, await readBody(req));
      return fail(404, "NOT_FOUND", "지원하지 않는 경로입니다 (현재: /prepare, /complete, /delete)");
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.code, e.message);
      deps.log?.("unexpected", { message: (e as Error)?.message });
      return fail(500, "SERVER_ERROR", "서버 오류입니다. 잠시 후 다시 시도해 주세요");
    }
  };
}
