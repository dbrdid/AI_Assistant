export type AIRoute = 'external' | 'self_hosted';

export function readUsage(raw: unknown) {
  const u = raw as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null;
  const input = u?.input_tokens; const output = u?.output_tokens; const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isSafeInteger(input) || input < 0
    || !Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(cached) || cached < 0 || cached > input) return undefined;
  return { input, output, cached };
}

export function selectRoute(value: string | null): AIRoute {
  if (value === null || value === 'external') return 'external';
  if (value === 'self_hosted') return value;
  throw new Error('INVALID_AI_ROUTE');
}

/** Internal endpoint comes from deployment settings, never from the request. */
export async function callSelfHosted(p: {
  origin: string; secret: string; instructions: string; input: string | unknown[];
  schema: unknown; maxOutputTokens: number; timeoutMs: number; fetchImpl?: typeof fetch;
}) {
  if (!p.origin || p.secret.length < 32) return { kind: 'error' as const, status: 503, code: 'SELF_HOSTED_NOT_CONFIGURED' };
  let url: URL;
  try {
    url = new URL(p.origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    // Plain HTTP is only for a local development host, not a remote deployment.
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
  } catch { return { kind: 'error' as const, status: 503, code: 'SELF_HOSTED_NOT_CONFIGURED' }; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs);
  try {
    const res = await (p.fetchImpl ?? fetch)(new URL('/internal/generate', url), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.secret}` },
      body: JSON.stringify({ instructions: p.instructions, input: p.input, schema: p.schema,
        maxOutputTokens: p.maxOutputTokens, timeoutMs: p.timeoutMs }),
    });
    if (!res.ok) { await res.body?.cancel(); return { kind: 'error' as const, status: res.status === 429 ? 503 : 502, code: 'SELF_HOSTED_UNAVAILABLE' }; }
    if (!res.body) return { kind: 'error' as const, status: 502, code: 'PROVIDER_BAD_RESPONSE' };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const r = await reader.read(); if (r.done) break;
        bytes += r.value.length;
        if (bytes > 262144) { await reader.cancel(); throw new Error('PROVIDER_BAD_RESPONSE'); }
        chunks.push(r.value);
      }
    } finally { reader.releaseLock(); }
    const all = new Uint8Array(bytes); let pos = 0;
    for (const chunk of chunks) { all.set(chunk, pos); pos += chunk.length; }
    const data = JSON.parse(new TextDecoder().decode(all));
    if (!data || data.done !== true || typeof data.model !== 'string' || !data.output || typeof data.output !== 'object') throw new Error();
    const usage = data.usage;
    if (!usage || !Number.isSafeInteger(usage.input) || usage.input < 0 || !Number.isSafeInteger(usage.output) || usage.output < 0) throw new Error();
    return { kind: 'ok' as const, json: data.output, model: data.model, responseId: '',
      usage: { input: usage.input, cached: 0, output: usage.output } };
  } catch {
    if (controller.signal.aborted) return { kind: 'timeout' as const };
    return { kind: 'error' as const, status: 502, code: 'SELF_HOSTED_UNAVAILABLE' };
  } finally { clearTimeout(timer); }
}
