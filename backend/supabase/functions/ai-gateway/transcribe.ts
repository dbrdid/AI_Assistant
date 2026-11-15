// =====================================================================
// 녹음 → 글자 초안 (OpenAI gpt-transcribe, 분당 $0.0045) — 노션 모바일 방식 임시 보관
//
//   ① POST /functions/v1/ai-gateway/transcribe/prepare   (JSON)
//        { upload_id, mime_type, size_bytes, file_name? }
//        → 비공개 버킷 stt-uploads에 올릴 서명 URL { upload_id, bucket, path, token, signed_url, expires_at }
//        앱은 이 URL로 녹음을 올림 (Storage에 직접 쓸 권한은 없음)
//   ② POST /functions/v1/ai-gateway/transcribe            (JSON)
//        { client_request_id, upload_id, duration_seconds, workspace_id?, languages?, keywords?, prompt? }
//        → 서버가 올라간 녹음을 꺼내 OpenAI로 변환
//        → 성공: 녹음을 바로 삭제하고 { ok, request_id, endpoint:'stt', model, draft:{ text, languages },
//                 duration_seconds, charged_minutes, remaining_minutes, input_hash, upload_deleted }
//        → 실패: 녹음은 3일 보관 → 같은 upload_id로 다시 변환 가능(다시 올릴 필요 없음)
//   올리고 변환하지 않은 녹음, 실패한 녹음은 3일 뒤 stt-cleanup(매시간 cron)이 삭제
//
//   원칙 (organize·analyze와 같음)
//   - 전사 글은 서버(DB·Storage)에도 OpenAI에도 남기지 않음. 녹음은 위 규칙대로만 잠깐 보관
//   - 결과는 초안. 사용자가 확인한 뒤 앱이 원문(input_sources·source_text_versions)으로 저장
//   - 한도는 분 단위: 예약은 앱이 보낸 길이로, 차감은 OpenAI가 알려 준 실제 길이로 (올림)
//   - 함수 하나가 150초 안에 끝나야 해서(무료 플랜) OpenAI 호출은 최대 120초. 긴 녹음은 10분 단위로 나눠 보내기 권장
// =====================================================================

export type RpcResult = { data: any; error: { message: string } | null };

export interface TranscribeStorage {
  createSignedUploadUrl(bucket: string, path: string): Promise<{ signedUrl: string; token: string; path: string }>;
  /** 없으면 null */
  download(bucket: string, path: string): Promise<Uint8Array | null>;
  remove(bucket: string, paths: string[]): Promise<void>;
}

export interface TranscribeDeps {
  rpc: (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
  /** POST {OPENAI_BASE_URL}/audio/transcriptions */
  openai: (form: FormData, signal: AbortSignal) => Promise<Response>;
  storage: TranscribeStorage;
  model: string;
  /** 한 번에 받는 최대 녹음 길이(초) */
  maxSeconds: number;
  /** OpenAI 호출 전체 시간 예산(ms). 재시도 포함 */
  timeoutMs: number;
  /** 재시도 전 대기(ms). 테스트에서 0 */
  retryDelayMs?: number;
}

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const COST_MICROS_PER_SECOND = 75;                     // $0.0045 / 60초 = 0.000075 USD
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_RE = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

// OpenAI는 파일 이름의 확장자로 형식을 판단 → "audio.<확장자>"로 보냄 (원래 파일 이름은 안 보냄)
const EXTENSIONS = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);
const MIME_TO_EXT: Record<string, string> = {
  "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac-mp4": "m4a",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mpga": "mpga",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/vnd.wave": "wav",
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/opus": "ogg", "audio/flac": "flac", "audio/x-flac": "flac",
  "video/mp4": "mp4", "video/webm": "webm", "video/mpeg": "mpeg",
};
const EXT_TO_MIME: Record<string, string> = {
  m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", mpeg: "audio/mpeg", mpga: "audio/mpeg",
  wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg", flac: "audio/flac",
};

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  reply(status, { ok: false, code, message, ...extra });

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 파일 → OpenAI에 보낼 확장자 (모르면 null) */
export function audioExtension(name: string | null | undefined, mime: string | null | undefined): string | null {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(name ?? "")?.[1]?.toLowerCase();
  if (fromName && EXTENSIONS.has(fromName)) {
    // 이름은 오디오인데 형식이 오디오·영상이 아니면(예: image/png) 거절
    if (m && m !== "application/octet-stream" && !/^(audio|video)\//.test(m)) return null;
    return fromName;
  }
  return MIME_TO_EXT[m] ?? null;
}

async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_JSON_BYTES) {
    return fail(413, "INVALID_REQUEST", "요청이 너무 큽니다. 녹음은 /transcribe/prepare로 받은 주소에 올려 주세요");
  }
  try {
    const text = await req.text();
    if (text.length > MAX_JSON_BYTES) return fail(413, "INVALID_REQUEST", "요청이 너무 큽니다");
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not object");
    return body as Record<string, unknown>;
  } catch {
    return fail(400, "INVALID_REQUEST", "JSON 본문이 필요합니다");
  }
}

const strArray = (v: unknown): string[] | null =>
  v === undefined || v === null ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

// ---------------------------------------------------------------------
// 오류 코드 → HTTP
// ---------------------------------------------------------------------
const PREPARE_ERRORS: Record<string, [number, string]> = {
  CONSENT_REQUIRED: [403, "외부 AI 전송 동의가 필요합니다"],
  UPLOAD_ID_TAKEN: [409, "다른 사람이 쓴 upload_id입니다. 새 id로 시도하세요"],
  UPLOAD_GONE: [410, "이미 변환이 끝나 지운 녹음입니다. 새 upload_id로 올려 주세요"],
  TOO_MANY_PENDING: [429, "변환을 기다리는 녹음이 너무 많습니다(10개). 먼저 변환하거나 잠시 후 다시 시도하세요"],
  TOO_LARGE: [413, "녹음 파일은 25MB까지 올릴 수 있습니다"],
  UNSUPPORTED_TYPE: [415, "지원하지 않는 녹음 형식입니다 (m4a·mp3·wav·webm·ogg·flac·mp4)"],
};
const BEGIN_ERRORS: Record<string, [number, string]> = {
  FORBIDDEN: [403, "이 공간의 기록을 보낼 권한이 없습니다"],
  CONSENT_REQUIRED: [403, "외부 AI 전송 동의가 필요합니다"],
  IN_PROGRESS: [409, "같은 요청을 처리하고 있습니다. 잠시 후 다시 확인하세요"],
  RESULT_UNKNOWN: [409, "이전 요청의 결과를 확인하지 못했습니다(사용량에 포함됨). 같은 upload_id와 새 client_request_id로 다시 요청하세요"],
  ALREADY_DONE: [409, "이미 처리된 요청입니다"],
  REQUEST_ID_REUSED: [409, "같은 client_request_id에 다른 녹음이 왔습니다"],
  QUOTA_EXCEEDED: [429, "이번 달 녹음 변환 한도를 넘습니다"],
};

type Attempt =
  | { kind: "ok"; text: string; languages: string[]; seconds: number | null; providerId: string | null }
  | { kind: "error"; code: string; status: number; retry: boolean; providerId: string | null }
  | { kind: "timeout" };

type Job = {
  bytes: Uint8Array; ext: string; languages: string[]; keywords: string[]; prompt: string | null;
};

async function callOnce(deps: TranscribeDeps, j: Job, budgetMs: number): Promise<Attempt> {
  const form = new FormData();
  form.append("file", new Blob([j.bytes as Uint8Array<ArrayBuffer>], { type: EXT_TO_MIME[j.ext] }), `audio.${j.ext}`);
  form.append("model", deps.model);
  form.append("response_format", "json");
  for (const l of j.languages) form.append("languages[]", l);
  for (const k of j.keywords) form.append("keywords[]", k);
  if (j.prompt) form.append("prompt", j.prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let res: Response;
  let data: Record<string, any> | null;
  try {
    res = await deps.openai(form, controller.signal);
    data = await res.json().catch(() => null);
  } catch (e) {
    if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return { kind: "timeout" };
    return { kind: "error", code: "PROVIDER_UNREACHABLE", status: 502, retry: true, providerId: null };
  } finally {
    clearTimeout(timer);
  }
  const providerId = res.headers.get("x-request-id");

  if (!res.ok) {
    console.error("openai stt error", res.status, data?.error?.code, data?.error?.message);
    if (res.status === 429) return { kind: "error", code: "PROVIDER_RATE_LIMITED", status: 503, retry: true, providerId };
    if (res.status === 401 || res.status === 403) return { kind: "error", code: "PROVIDER_AUTH_FAILED", status: 502, retry: false, providerId };
    if (res.status === 413) return { kind: "error", code: "TOO_LARGE", status: 413, retry: false, providerId };
    if (res.status === 400) return { kind: "error", code: "AUDIO_REJECTED", status: 422, retry: false, providerId };
    if (res.status === 404) return { kind: "error", code: "PROVIDER_BAD_REQUEST", status: 502, retry: false, providerId };  // 모델 이름·권한
    return { kind: "error", code: "PROVIDER_ERROR", status: 502, retry: res.status >= 500, providerId };
  }
  if (!data || typeof data.text !== "string") {
    return { kind: "error", code: "PROVIDER_BAD_RESPONSE", status: 502, retry: false, providerId };
  }
  const languages = Array.isArray(data.languages)
    ? data.languages.map((l: any) => (typeof l === "string" ? l : l?.code)).filter((c: unknown): c is string => typeof c === "string")
    : typeof data.language === "string" ? [data.language] : [];
  const seconds = data.usage?.type === "duration" && Number.isFinite(Number(data.usage.seconds)) && Number(data.usage.seconds) > 0
    ? Number(data.usage.seconds)
    : Number.isFinite(Number(data.duration)) && Number(data.duration) > 0 ? Number(data.duration) : null;
  return { kind: "ok", text: data.text.trim(), languages, seconds, providerId };
}

export function createTranscribeHandlers(deps: TranscribeDeps) {
  const retryRpc = async (name: string, params: Record<string, unknown>) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await deps.rpc(name, params);
      if (!error) return true;
      console.error(`${name} failed (attempt ${attempt})`, error.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
    }
    return false;  // ai_requests가 RESERVED로 남으면 10분 뒤 정리, 보관함은 기한(3일) 뒤 정리
  };

  // ① 올릴 주소 받기
  async function prepare(req: Request, userId: string): Promise<Response> {
    const body = await readJson(req);
    if (body instanceof Response) return body;
    const uploadId = body.upload_id;
    if (typeof uploadId !== "string" || !UUID_RE.test(uploadId)) return fail(400, "INVALID_REQUEST", "upload_id(UUID)가 필요합니다");
    const size = Number(body.size_bytes);
    if (!Number.isInteger(size) || size <= 0) return fail(400, "INVALID_REQUEST", "size_bytes(파일 크기)가 필요합니다");
    if (size > MAX_AUDIO_BYTES) return fail(413, "TOO_LARGE", "녹음 파일은 25MB까지 올릴 수 있습니다", { max_bytes: MAX_AUDIO_BYTES });
    const mime = typeof body.mime_type === "string" ? body.mime_type.toLowerCase().slice(0, 100) : "";
    const ext = audioExtension(typeof body.file_name === "string" ? body.file_name : null, mime);
    if (!ext) return fail(415, "UNSUPPORTED_TYPE", PREPARE_ERRORS.UNSUPPORTED_TYPE[1], { mime_type: mime || null });

    const { data, error } = await deps.rpc("stt_upload_prepare", {
      p_account_id: userId, p_upload_id: uploadId, p_ext: ext, p_mime: mime || EXT_TO_MIME[ext], p_size: size,
    });
    if (error) { console.error("stt_upload_prepare failed", error.message); return fail(500, "INTERNAL", "준비하지 못했습니다"); }
    if (!data?.ok) {
      const [status, message] = PREPARE_ERRORS[data?.code] ?? [400, "준비할 수 없습니다"];
      return fail(status, data?.code ?? "REJECTED", message);
    }
    try {
      const signed = await deps.storage.createSignedUploadUrl(data.bucket, data.path);
      return reply(200, {
        ok: true, upload_id: uploadId, bucket: data.bucket, path: signed.path ?? data.path,
        token: signed.token, signed_url: signed.signedUrl, expires_at: data.expires_at,
      });
    } catch (e) {
      console.error("createSignedUploadUrl failed", (e as Error)?.message);
      return fail(502, "STORAGE_ERROR", "올릴 주소를 만들지 못했습니다. 잠시 후 다시 시도하세요");
    }
  }

  // ② 올린 녹음 변환
  async function transcribe(req: Request, userId: string): Promise<Response> {
    const body = await readJson(req);
    if (body instanceof Response) return body;

    const clientRequestId = body.client_request_id;
    if (typeof clientRequestId !== "string" || !UUID_RE.test(clientRequestId)) return fail(400, "INVALID_REQUEST", "client_request_id(UUID)가 필요합니다");
    const uploadId = body.upload_id;
    if (typeof uploadId !== "string" || !UUID_RE.test(uploadId)) return fail(400, "INVALID_REQUEST", "upload_id(UUID)가 필요합니다. 먼저 /transcribe/prepare로 녹음을 올리세요");
    const workspaceId = body.workspace_id ?? null;
    if (workspaceId !== null && (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId))) return fail(400, "INVALID_REQUEST", "workspace_id 형식이 잘못됐습니다");
    const durationSeconds = Number(body.duration_seconds);
    if (body.duration_seconds === null || body.duration_seconds === undefined || body.duration_seconds === "" ||
        !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return fail(400, "INVALID_REQUEST", "duration_seconds(녹음 길이, 초)가 필요합니다");
    }
    if (durationSeconds > deps.maxSeconds) {
      return fail(413, "DURATION_TOO_LONG", `한 번에 ${Math.floor(deps.maxSeconds / 60)}분까지 보낼 수 있습니다. 녹음을 나눠서 보내 주세요`,
        { max_seconds: deps.maxSeconds });
    }
    const langsRaw = strArray(body.languages);
    const languages = [...new Set((langsRaw ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))];
    if (!langsRaw || languages.length > 5 || languages.some((l) => !LANG_RE.test(l))) {
      return fail(400, "INVALID_REQUEST", "languages는 ko, en 같은 언어 코드로 5개까지 보낼 수 있습니다");
    }
    const kwRaw = strArray(body.keywords);
    const keywords = [...new Set((kwRaw ?? []).map((s) => s.trim()).filter(Boolean))];
    if (!kwRaw || keywords.length > 50 || keywords.some((k) => k.length > 60 || /[<>\r\n]/.test(k))) {
      return fail(400, "INVALID_REQUEST", "keywords는 50개까지, 각 60자 이하이고 < > 줄바꿈은 쓸 수 없습니다");
    }
    if (body.prompt !== undefined && body.prompt !== null && typeof body.prompt !== "string") return fail(400, "INVALID_REQUEST", "prompt는 글이어야 합니다");
    const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null;
    if (prompt && prompt.length > 1000) return fail(400, "INVALID_REQUEST", "prompt는 1000자까지 보낼 수 있습니다");

    // 올린 녹음 꺼내기
    const { data: up, error: upErr } = await deps.rpc("stt_upload_get", { p_account_id: userId, p_upload_id: uploadId });
    if (upErr) { console.error("stt_upload_get failed", upErr.message); return fail(500, "INTERNAL", "녹음을 찾지 못했습니다"); }
    if (!up?.ok) {
      return up?.code === "UPLOAD_GONE"
        ? fail(410, "UPLOAD_GONE", "이미 변환이 끝났거나 보관 기간(3일)이 지나 지운 녹음입니다. 다시 올려 주세요")
        : fail(404, "NOT_FOUND", "준비한 녹음이 없습니다. 먼저 /transcribe/prepare로 올리세요");
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await deps.storage.download(up.bucket, up.path);
    } catch (e) {
      console.error("download failed", (e as Error)?.message);
      return fail(502, "STORAGE_ERROR", "녹음을 꺼내지 못했습니다. 잠시 후 같은 요청으로 다시 시도하세요");
    }
    if (!bytes || bytes.byteLength === 0) {
      return fail(409, "NOT_UPLOADED", "녹음이 아직 올라오지 않았습니다. 받은 주소로 올린 뒤 다시 요청하세요");
    }
    if (bytes.byteLength > MAX_AUDIO_BYTES) return fail(413, "TOO_LARGE", "녹음 파일은 25MB까지 보낼 수 있습니다", { max_bytes: MAX_AUDIO_BYTES });

    const units = Math.max(1, Math.ceil(durationSeconds / 60));
    const audioHash = await sha256Hex(bytes);
    const inputHash = await sha256Hex(
      ["stt", audioHash, durationSeconds, languages.join(","), keywords.join("\n"), prompt ?? ""].join("\n"));

    // 권한·동의·멱등성·분 한도 예약
    const { data: begin, error: beginErr } = await deps.rpc("ai_begin_request", {
      p_account_id: userId, p_client_request_id: clientRequestId, p_endpoint: "stt",
      p_workspace_id: workspaceId, p_input_hash: inputHash, p_provider: "openai", p_model: deps.model, p_units: units,
    });
    if (beginErr) { console.error("ai_begin_request failed", beginErr.message); return fail(500, "INTERNAL", "요청을 시작하지 못했습니다"); }
    if (!begin?.ok) {
      const [status, message] = BEGIN_ERRORS[begin?.code] ?? [400, "요청을 처리할 수 없습니다"];
      return fail(status, begin?.code ?? "REJECTED", message, begin?.code === "QUOTA_EXCEEDED"
        ? { plan: begin.plan, limit_minutes: begin.limit, remaining_minutes: begin.remaining, requested_minutes: begin.requested }
        : {});
    }
    const requestId: string = begin.request_id;

    // OpenAI 호출. 일시 오류(429·5xx·연결)면 시간이 넉넉할 때만 한 번 더
    const job: Job = { bytes, ext: up.ext, languages, keywords, prompt };
    const started = Date.now();
    let result: Attempt = { kind: "timeout" };
    let attempts = 0;
    for (;;) {
      attempts++;
      result = await callOnce(deps, job, deps.timeoutMs - (Date.now() - started));
      if (result.kind !== "error" || !result.retry || attempts >= 2) break;
      if (deps.timeoutMs - (Date.now() - started) < deps.timeoutMs / 2) break;
      await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 1000));
    }

    if (result.kind === "ok") {
      // 성공: 녹음 바로 삭제 (못 지우면 보관함에 남아 stt-cleanup이 다음 정리 때 지움)
      let deleted = false;
      try { await deps.storage.remove(up.bucket, [up.path]); deleted = true; }
      catch (e) { console.error("remove after success failed", (e as Error)?.message); }
      await retryRpc("stt_upload_finish", { p_account_id: userId, p_upload_id: uploadId, p_success: true, p_object_deleted: deleted });

      const seconds = result.seconds ?? durationSeconds;
      const charged = Math.max(1, Math.ceil(seconds / 60));
      await retryRpc("ai_finish_request", {
        p_request_id: requestId, p_status: "SUCCEEDED", p_provider_request_id: result.providerId,
        p_model: deps.model, p_attempts: attempts, p_cost_usd_micros: Math.round(seconds * COST_MICROS_PER_SECOND),
        p_charged_units: Math.min(charged, 1000),
      });
      return reply(200, {
        ok: true,
        request_id: requestId,
        endpoint: "stt",
        model: deps.model,
        draft: { text: result.text, languages: result.languages },  // 초안: 사용자가 확인하기 전에는 어디에도 저장 안 됨
        duration_seconds: seconds,
        charged_minutes: charged,
        remaining_minutes: Math.max(0, Number(begin.remaining) + units - charged),
        input_hash: inputHash,
        upload_deleted: deleted,
      });
    }

    // 실패·시간 초과: 녹음은 3일 보관 → 같은 upload_id로 다시 변환 가능
    await retryRpc("stt_upload_finish", { p_account_id: userId, p_upload_id: uploadId, p_success: false });
    if (result.kind === "timeout") {
      await retryRpc("ai_finish_request", {
        p_request_id: requestId, p_status: "UNKNOWN", p_error_code: "PROVIDER_TIMEOUT", p_model: deps.model,
        p_attempts: attempts, p_cost_usd_micros: Math.round(durationSeconds * COST_MICROS_PER_SECOND),
      });
      return fail(504, "PROVIDER_TIMEOUT",
        "변환이 늦어 결과를 확인하지 못했습니다(이번 녹음 길이만큼 사용량에 포함). 녹음은 3일 보관되니 같은 upload_id와 새 client_request_id로 다시 요청하거나, 더 짧게 나눠 주세요",
        { upload_kept_days: 3 });
    }
    await retryRpc("ai_finish_request", {
      p_request_id: requestId, p_status: "FAILED", p_provider_request_id: result.providerId,
      p_error_code: result.code, p_model: deps.model, p_attempts: attempts, p_cost_usd_micros: 0,
    });
    const message = result.code === "AUDIO_REJECTED"
      ? "녹음 파일을 읽지 못했습니다(형식이나 내용 확인). 사용량에 포함되지 않았습니다"
      : "녹음 변환에 실패했습니다(사용량에 포함되지 않음). 녹음은 3일 보관되니 잠시 후 같은 요청으로 다시 시도하세요";
    return fail(result.status, result.code, message, { upload_kept_days: 3 });
  }

  return { prepare, transcribe };
}
