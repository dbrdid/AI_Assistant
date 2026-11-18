import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

export function registerInternal(app, config, fetchImpl = fetch, capacity = { active: 0 }) {
  if (!config.gatewaySecret) return;
  const expected = createHash('sha256').update(config.gatewaySecret).digest();
  app.post('/internal/generate', { bodyLimit: 262144 }, async (request, reply) => {
    const value = request.headers.authorization ?? '';
    const actual = createHash('sha256').update(value.startsWith('Bearer ') ? value.slice(7) : '').digest();
    if (!timingSafeEqual(expected, actual)) throw new ApiError(401, 'UNAUTHORIZED');
    const b = request.body;
    if (!b || typeof b !== 'object' || Object.keys(b).some(k => !['instructions', 'input', 'schema', 'maxOutputTokens', 'timeoutMs'].includes(k))
      || typeof b.instructions !== 'string' || !b.instructions || b.instructions.length > 20000
      || typeof b.input !== 'string' || !b.input.trim() || b.input.length > config.internalMaxInputChars
      || !b.schema || typeof b.schema !== 'object' || Array.isArray(b.schema)
      || !Number.isSafeInteger(b.maxOutputTokens) || b.maxOutputTokens < 1 || b.maxOutputTokens > 16384
      || !Number.isSafeInteger(b.timeoutMs) || b.timeoutMs < 1 || b.timeoutMs > 120000) throw new ApiError(400, 'INVALID_REQUEST');
    // The host refuses oversized work rather than silently truncating it. Token fit remains a model acceptance gate.
    if (capacity.active >= config.maxConcurrent) throw new ApiError(429, 'SERVER_BUSY');
    capacity.active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(b.timeoutMs, config.modelTimeoutMs));
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    request.raw.on('aborted', disconnect); reply.raw.on('close', disconnect);
    try {
      const res = await fetchImpl(`${config.ollamaBaseUrl}/api/chat`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, stream: false, think: false, format: b.schema,
          options: { temperature: 0, num_ctx: config.contextTokens, num_predict: Math.min(b.maxOutputTokens, config.outputTokens) },
          messages: [{ role: 'system', content: b.instructions }, { role: 'user', content: b.input }] }),
      });
      if (!res.ok || !res.body) { await res.body?.cancel(); throw new ApiError(502, 'MODEL_UNAVAILABLE'); }
      const reader = res.body.getReader(); const chunks = []; let size = 0;
      try {
        while (true) {
          const r = await reader.read(); if (r.done) break;
          size += r.value.byteLength;
          if (size > 262144) { await reader.cancel(); throw new ApiError(502, 'INVALID_MODEL_OUTPUT'); }
          chunks.push(r.value);
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (controller.signal.aborted || data.done !== true || data.done_reason === 'length'
        || typeof data.message?.content !== 'string') throw new ApiError(502, 'INVALID_MODEL_OUTPUT');
      const output = JSON.parse(data.message.content);
      if (!output || typeof output !== 'object' || Array.isArray(output)
        || !Number.isSafeInteger(data.prompt_eval_count) || data.prompt_eval_count < 0
        || !Number.isSafeInteger(data.eval_count) || data.eval_count < 0) throw new ApiError(502, 'INVALID_MODEL_OUTPUT');
      return { done: true, model: config.model, output,
        usage: { input: data.prompt_eval_count, output: data.eval_count } };
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError(504, 'MODEL_TIMEOUT');
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'INVALID_MODEL_OUTPUT');
    } finally {
      clearTimeout(timer); request.raw.off('aborted', disconnect); reply.raw.off('close', disconnect); capacity.active--;
    }
  });
}
