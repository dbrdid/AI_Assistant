// =====================================================================
// stt-cleanup : 녹음 임시 보관함 정리 (매시간 pg_cron → pg_net이 부름, 녹음 취소 때도 바로 부름)
//   - 보관 기한(3일)이 지난 녹음, 변환은 끝났는데 못 지운 녹음, 기록 없이 3일 넘게 남은 녹음을 Storage API로 삭제
//   - 버킷 두 곳: stt-uploads(짧은 녹음 /transcribe), stt-recordings(긴 녹음 구간, 취소·최종 실패·업로드 만료 포함)
//   - SQL로 storage.objects를 지우면 실제 파일이 남아서 반드시 Storage API로 지움
//   - 호출 확인: 헤더 x-cleanup-secret = Vault의 stt_cleanup_secret (사람이 다룰 일 없음)
//   - 로그인 사용자용이 아니라서 verify_jwt=false로 배포. 비밀값이 틀리면 아무것도 안 함
// =====================================================================

export interface CleanupDeps {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
  /** Storage API로 삭제 (없는 경로는 무시) */
  remove: (bucket: string, paths: string[]) => Promise<void>;
  batchSize?: number;
  maxBatches?: number;
}

// 정리할 곳: 짧은 녹음 보관함(stt-uploads) + 긴 녹음 구간(stt-recordings)
const SOURCES = [
  { bucket: "stt-uploads", expired: "stt_upload_expired", mark: "stt_upload_mark_deleted" },
  { bucket: "stt-recordings", expired: "stt_recording_expired", mark: "stt_recording_mark_deleted" },
] as const;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export function createCleanupHandler(deps: CleanupDeps) {
  const batch = deps.batchSize ?? 100;
  const maxBatches = deps.maxBatches ?? 10;

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    const secret = req.headers.get("x-cleanup-secret") ?? "";
    const { data: okSecret, error: secErr } = await deps.rpc("stt_cleanup_check", { p_secret: secret });
    if (secErr) { console.error("stt_cleanup_check failed", secErr.message); return json(500, { ok: false, code: "INTERNAL" }); }
    if (okSecret !== true) return json(401, { ok: false, code: "UNAUTHORIZED" });

    let deleted = 0;
    for (const src of SOURCES) {
      for (let i = 0; i < maxBatches; i++) {
        const { data, error } = await deps.rpc(src.expired, { p_limit: batch });
        if (error) { console.error(`${src.expired} failed`, error.message); return json(500, { ok: false, code: "INTERNAL", deleted }); }
        const paths = ((data ?? []) as ({ object_path: string } | string)[])
          .map((r) => (typeof r === "string" ? r : r?.object_path)).filter((p): p is string => typeof p === "string" && p.length > 0);
        if (paths.length === 0) break;
        try {
          await deps.remove(src.bucket, paths);
        } catch (e) {
          console.error("storage remove failed", src.bucket, (e as Error)?.message);
          return json(502, { ok: false, code: "STORAGE_ERROR", deleted });
        }
        const { error: markErr } = await deps.rpc(src.mark, { p_paths: paths });
        if (markErr) { console.error(`${src.mark} failed`, markErr.message); return json(500, { ok: false, code: "INTERNAL", deleted }); }
        deleted += paths.length;
        if (paths.length < batch) break;
      }
    }
    console.log(`stt-cleanup deleted ${deleted}`);
    return json(200, { ok: true, deleted });
  };
}
