// OpenAI 받아쓰기 1회 호출 (gpt-transcribe). ai-gateway/transcribe.ts의 callOnce와 같은 규칙
//   - 파일 이름은 "audio.<확장자>"만 보냄 (원래 이름·경로는 안 보냄)
//   - 응답의 usage(duration, 초)로 실제 길이를 받음
//   - Edge Function은 함수마다 따로 배포돼서 같은 코드를 여기에 둠

export type SttAttempt =
  | { kind: "ok"; text: string; languages: string[]; seconds: number | null; providerId: string | null }
  | { kind: "error"; code: string; retry: boolean; providerId: string | null }
  | { kind: "timeout" };

export type SttJob = { bytes: Uint8Array; ext: string; languages: string[]; keywords: string[]; prompt: string | null };

export const EXT_TO_MIME: Record<string, string> = {
  m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", mpeg: "audio/mpeg", mpga: "audio/mpeg",
  wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg", flac: "audio/flac",
};

export async function transcribeOnce(
  openai: (form: FormData, signal: AbortSignal) => Promise<Response>, model: string, j: SttJob, budgetMs: number,
): Promise<SttAttempt> {
  const form = new FormData();
  form.append("file", new Blob([j.bytes as Uint8Array<ArrayBuffer>], { type: EXT_TO_MIME[j.ext] ?? "application/octet-stream" }), `audio.${j.ext}`);
  form.append("model", model);
  form.append("response_format", "json");
  for (const l of j.languages) form.append("languages[]", l);
  for (const k of j.keywords) form.append("keywords[]", k);
  if (j.prompt) form.append("prompt", j.prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, budgetMs));
  let res: Response;
  let data: Record<string, any> | null;
  try {
    res = await openai(form, controller.signal);
    data = await res.json().catch(() => null);
  } catch (e) {
    if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return { kind: "timeout" };
    return { kind: "error", code: "PROVIDER_UNREACHABLE", retry: true, providerId: null };
  } finally {
    clearTimeout(timer);
  }
  const providerId = res.headers.get("x-request-id");
  if (!res.ok) {
    console.error("openai stt error", res.status, data?.error?.code, data?.error?.message);
    if (res.status === 429) return { kind: "error", code: "PROVIDER_RATE_LIMITED", retry: true, providerId };
    if (res.status === 401 || res.status === 403) return { kind: "error", code: "PROVIDER_AUTH_FAILED", retry: false, providerId };
    if (res.status === 413) return { kind: "error", code: "TOO_LARGE", retry: false, providerId };
    if (res.status === 400) return { kind: "error", code: "AUDIO_REJECTED", retry: false, providerId };
    if (res.status === 404) return { kind: "error", code: "PROVIDER_BAD_REQUEST", retry: false, providerId };
    return { kind: "error", code: "PROVIDER_ERROR", retry: res.status >= 500, providerId };
  }
  if (!data || typeof data.text !== "string") return { kind: "error", code: "PROVIDER_BAD_RESPONSE", retry: true, providerId };
  const languages = Array.isArray(data.languages)
    ? data.languages.map((l: any) => (typeof l === "string" ? l : l?.code)).filter((c: unknown): c is string => typeof c === "string")
    : typeof data.language === "string" ? [data.language] : [];
  const seconds = data.usage?.type === "duration" && Number(data.usage.seconds) > 0 ? Number(data.usage.seconds)
    : Number(data.duration) > 0 ? Number(data.duration) : null;
  return { kind: "ok", text: data.text.trim(), languages, seconds, providerId };
}
