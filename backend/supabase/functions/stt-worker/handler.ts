// =====================================================================
// stt-worker : 긴 녹음의 구간을 서버에서 전사 (verify_jwt=false, 매분 cron·업로드 확인 때 DB가 깨움)
//
//   1. 호출 확인: 헤더 x-cleanup-secret = Vault 비밀값 (stt-cleanup과 같은 값)
//   2. stt_segment_claim으로 대기 구간을 가져옴 (전체 동시 처리 최대 2개, 4분 넘게 멈춘 처리는 다시 대기로)
//   3. 구간마다: 음성 꺼내기 → ai_begin_request(분 단위 한도 예약) → gpt-transcribe
//      → 성공: 전사문 저장(stt_segment_succeed) → 저장이 확인된 뒤에만 음성 삭제 → 정산(실제 길이)
//      → 실패: 정산(실패는 차감 없음, 시간 초과는 예약만큼) → stt_segment_fail (일시 오류면 30초·60초 뒤 자동 재시도)
//   4. 시간 예산 안에서 반복. 남은 구간은 다음 호출이 이어서 처리
//   전사문은 앱이 받아 저장(ack)할 때까지 DB에 임시 보관. 요약(Terra)은 앱이 전사문을 확인·수정한 뒤 따로 요청
// =====================================================================
import { type SttAttempt, transcribeOnce } from "./openai_stt.ts";

export type RpcResult = { data: any; error: { message: string } | null };

export interface WorkerDeps {
  rpc: (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
  openai: (form: FormData, signal: AbortSignal) => Promise<Response>;
  storage: {
    /** 없으면 null */
    download(bucket: string, path: string): Promise<Uint8Array | null>;
    remove(bucket: string, paths: string[]): Promise<void>;
  };
  /** OPENAI_API_KEY가 있는지. 없으면 구간을 건드리지 않고 503 */
  configured: boolean;
  model: string;
  /** 전체 동시 처리 수 (기본 2) */
  maxConcurrent?: number;
  /** 이 호출에서 쓸 시간(ms). 새 구간은 budget - callTimeout 전까지만 가져옴 (기본 140초) */
  budgetMs?: number;
  /** OpenAI 호출 1회 제한(ms, 기본 90초) */
  callTimeoutMs?: number;
  /** 할 일이 남았으면 다음 호출 예약 (선택) */
  continueLater?: () => void;
}

type Claimed = {
  segment_id: string; lease_id: string; recording_id: string; seq: number; account_id: string; workspace_id: string | null;
  bucket: string; path: string; ext: string; duration_seconds: number | string;
  languages: string[] | null; keywords: string[] | null; prompt: string | null;
};

export const MAX_SEGMENT_BYTES = 25 * 1024 * 1024;
const COST_MICROS_PER_SECOND = 75;   // $0.0045 / 60초
const NO_RETRY_BEGIN = new Set(["QUOTA_EXCEEDED", "CONSENT_REQUIRED", "FORBIDDEN", "REQUEST_ID_REUSED"]);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createWorker(deps: WorkerDeps) {
  const maxConcurrent = deps.maxConcurrent ?? 2;
  const budgetMs = deps.budgetMs ?? 140_000;
  const callTimeoutMs = deps.callTimeoutMs ?? 90_000;

  const rpcRetry = async (name: string, args: Record<string, unknown>): Promise<RpcResult> => {
    let last: RpcResult = { data: null, error: { message: "not called" } };
    for (let i = 1; i <= 3; i++) {
      last = await deps.rpc(name, args);
      if (!last.error) return last;
      console.error(`${name} failed (attempt ${i})`, last.error.message);
      if (i < 3) await new Promise((r) => setTimeout(r, 200 * i));
    }
    return last;
  };

  async function process(s: Claimed): Promise<"done" | "failed" | "retry" | "canceled" | "lost"> {
    const fail = async (code: string, retryable: boolean) => {
      const { data } = await rpcRetry("stt_segment_fail", { p_segment_id: s.segment_id, p_lease_id: s.lease_id, p_code: code, p_retryable: retryable });
      return data?.status === "QUEUED" ? "retry" as const : data?.ok === false ? "lost" as const : "failed" as const;
    };

    let bytes: Uint8Array | null;
    try {
      bytes = await deps.storage.download(s.bucket, s.path);
    } catch (e) {
      console.error("download failed", s.path, (e as Error)?.message);
      return fail("STORAGE_ERROR", true);
    }
    if (!bytes || bytes.byteLength === 0) return fail("AUDIO_MISSING", false);
    if (bytes.byteLength > MAX_SEGMENT_BYTES) return fail("TOO_LARGE", false);

    const duration = Number(s.duration_seconds);
    const units = Math.max(1, Math.ceil(duration / 60));
    const languages = (s.languages ?? []).slice(0, 5);
    const keywords = (s.keywords ?? []).slice(0, 50);
    const prompt = s.prompt?.trim() ? s.prompt.trim().slice(-1000) : null;
    const inputHash = await sha256Hex(["stt-segment", s.segment_id, await sha256Hex(bytes), languages.join(","), keywords.join("\n"), prompt ?? ""].join("\n"));

    const { data: begin, error: beginErr } = await deps.rpc("ai_begin_request", {
      p_account_id: s.account_id, p_client_request_id: crypto.randomUUID(), p_endpoint: "stt",
      p_workspace_id: s.workspace_id, p_input_hash: inputHash, p_provider: "openai", p_model: deps.model, p_units: units,
    });
    if (beginErr) { console.error("ai_begin_request failed", beginErr.message); return fail("INTERNAL", true); }
    if (!begin?.ok) return fail(begin?.code ?? "REJECTED", !NO_RETRY_BEGIN.has(begin?.code));
    const requestId: string = begin.request_id;

    const result: SttAttempt = await transcribeOnce(deps.openai, deps.model, { bytes, ext: s.ext, languages, keywords, prompt }, callTimeoutMs);

    if (result.kind === "ok") {
      const seconds = result.seconds ?? duration;
      const charged = Math.min(1000, Math.max(1, Math.ceil(seconds / 60)));
      // 1) 전사문 저장 (이 처리의 lease가 맞을 때만)
      const saved = await rpcRetry("stt_segment_succeed", {
        p_segment_id: s.segment_id, p_lease_id: s.lease_id, p_text: result.text, p_languages: result.languages,
        p_seconds: seconds, p_charged_minutes: charged,
      });
      // 2) 정산: OpenAI가 처리했으므로 결과 저장 여부와 관계없이 실제 길이만큼
      await rpcRetry("ai_finish_request", {
        p_request_id: requestId, p_status: "SUCCEEDED", p_provider_request_id: result.providerId, p_model: deps.model,
        p_attempts: 1, p_cost_usd_micros: Math.round(seconds * COST_MICROS_PER_SECOND), p_charged_units: charged,
      });
      const ok = saved.data?.ok === true;
      const canceled = saved.data?.code === "CANCELED";
      // 3) 전사문이 저장됐거나(또는 취소됐으면) 음성 삭제. 저장 못 했으면 음성은 남겨 둠(다시 처리)
      if (ok || canceled) {
        try {
          await deps.storage.remove(s.bucket, [s.path]);
          await rpcRetry("stt_recording_mark_deleted", { p_paths: [s.path] });
        } catch (e) {
          console.error("remove after transcript failed (cleanup will retry)", s.path, (e as Error)?.message);
        }
      }
      return ok ? "done" : canceled ? "canceled" : "lost";
    }

    if (result.kind === "timeout") {
      await rpcRetry("ai_finish_request", {
        p_request_id: requestId, p_status: "UNKNOWN", p_error_code: "PROVIDER_TIMEOUT", p_model: deps.model,
        p_attempts: 1, p_cost_usd_micros: Math.round(duration * COST_MICROS_PER_SECOND),
      });
      return fail("PROVIDER_TIMEOUT", true);
    }
    await rpcRetry("ai_finish_request", {
      p_request_id: requestId, p_status: "FAILED", p_provider_request_id: result.providerId, p_error_code: result.code,
      p_model: deps.model, p_attempts: 1, p_cost_usd_micros: 0,
    });
    return fail(result.code, result.retry);
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    const { data: okSecret, error: secErr } = await deps.rpc("stt_cleanup_check", { p_secret: req.headers.get("x-cleanup-secret") ?? "" });
    if (secErr) { console.error("stt_cleanup_check failed", secErr.message); return json(500, { ok: false, code: "INTERNAL" }); }
    if (okSecret !== true) return json(401, { ok: false, code: "UNAUTHORIZED" });
    if (!deps.configured) return json(503, { ok: false, code: "NOT_CONFIGURED", message: "서버에 OPENAI_API_KEY가 없어 구간을 그대로 둡니다" });

    const started = Date.now();
    const tally = { done: 0, failed: 0, retry: 0, canceled: 0, lost: 0 };
    const running = new Set<Promise<void>>();
    let moreWork = false;

    for (;;) {
      const free = maxConcurrent - running.size;
      const canStart = Date.now() - started < budgetMs - callTimeoutMs;
      let claimed: Claimed[] = [];
      if (free > 0 && canStart) {
        const { data, error } = await deps.rpc("stt_segment_claim", { p_limit: free, p_max_processing: maxConcurrent });
        if (error) console.error("stt_segment_claim failed", error.message);
        claimed = Array.isArray(data) ? data as Claimed[] : [];
        moreWork = claimed.length === free;
      }
      for (const s of claimed) {
        const p: Promise<void> = process(s)
          .then((r) => { tally[r]++; })
          .catch((e) => { tally.lost++; console.error("segment crashed", s.segment_id, (e as Error)?.message); })
          .finally(() => { running.delete(p); });
        running.add(p);
      }
      if (running.size === 0) break;
      await Promise.race(running);
    }

    if (Date.now() - started >= budgetMs - callTimeoutMs) moreWork = true;   // 시간 때문에 멈춤 → 남았을 수 있음
    if (moreWork && deps.continueLater) deps.continueLater();
    console.log(`stt-worker done=${tally.done} failed=${tally.failed} retry=${tally.retry} canceled=${tally.canceled} lost=${tally.lost}`);
    return json(200, { ok: true, ...tally, more: moreWork });
  };
}
