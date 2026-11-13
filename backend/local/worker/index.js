import { createHash } from 'node:crypto';
import { serverError } from '../contracts/errors.js';
import { routeRegistry } from '../gateway/validation.js';
const refPattern = /^[A-Za-z0-9_-]{1,200}$/;
export const sha256 = input => createHash('sha256').update(input, 'utf8').digest('hex');
// A contract error is raised inside the RPC's transaction, which rolls back: nothing was dispatched.
// Any other failure (transport, unknown SQLSTATE) may have committed, so the outcome is unknown.
// Precondition: the store makes exactly ONE attempt per ai_begin_dispatch / ai_fail_before_dispatch call. A transport
// that retries internally could turn a lost commit into a contract error (not_claimed) on its retry, and this would
// then report not_dispatched for a job SQL already marked dispatched; such a transport must report non-contract errors.
function preDispatchFailure(job, error) {
  const known = serverError(error?.code, error?.message);
  return known ? { id: job.id, state: 'not_dispatched', reason: known.reason } : { id: job.id, state: 'reconciliation_required' };
}
function validateDraft(value, input) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > 262144) throw new Error('Draft too large');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['summary','action_items','citations'].includes(k))) throw new Error('Invalid draft');
  if (typeof value.summary !== 'string' || !value.summary.length || value.summary.length > 16000 || !Array.isArray(value.action_items) || value.action_items.length > 100 || value.action_items.some(v => typeof v !== 'string' || !v.length || v.length > 2000)) throw new Error('Invalid draft');
  if (!Array.isArray(value.citations) || value.citations.length > 100 || value.citations.some(v => !v || Object.keys(v).some(k => !['start','end','quote'].includes(k)) || !Number.isSafeInteger(v.start) || !Number.isSafeInteger(v.end) || v.start < 0 || v.end <= v.start || v.end > input.length || typeof v.quote !== 'string' || input.slice(v.start, v.end) !== v.quote)) throw new Error('Invalid citations');
  return value;
}
/** Execute at most ONE provider call. No production payload/key/provider adapters supplied.
 * loadInput must decrypt authorized ciphertext without persistent plaintext.
 * saveDraft must encrypt at rest and return an opaque reference; it must never edit source.
 * Provider adapter must enforce hard total cost/token bounds and disable HTTP retries.
 */
export function createWorker({ store, loadInput, saveDraft, deleteDraft, routes = [], providers = {}, timeoutMs = 30000, maxInputBytes = 262144, leaseSeconds = 60 }) {
  if (!store || typeof loadInput !== 'function' || typeof saveDraft !== 'function') throw new Error('Encrypted input and result storage adapters required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || timeoutMs >= leaseSeconds * 1000) throw new Error('Timeout must fit lease');
  const registry = routeRegistry(routes);
  return async function runOnce() {
    const job = await store.claim(leaseSeconds);
    if (!job) return { state: 'idle' };
    let input, route, provider;
    try {
      route = registry.get(job.route_id); provider = route && providers[route.provider];
      if (!route || !provider || typeof provider.complete !== 'function' || provider.noRetries !== true || typeof provider.maximumCostMicrousd !== 'function' || route.provider !== job.provider_id || route.model !== job.model_id || route.retention_version !== job.retention_version || job.purpose !== 'summary') throw new Error('Unavailable route');
      if (!Number.isSafeInteger(job.max_output_tokens) || job.max_output_tokens < 1 || job.max_output_tokens > route.max_output_tokens || !refPattern.test(job.input_ref)) throw new Error('Invalid job');
      input = await loadInput(job);
      if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > maxInputBytes || sha256(input) !== job.payload_sha256) throw new Error('Input mismatch');
      const bound = provider.maximumCostMicrousd({ model: route.model, input, maxOutputTokens: job.max_output_tokens });
      if (typeof bound !== 'string' || !/^(0|[1-9][0-9]*)$/.test(bound) || BigInt(bound) > BigInt(job.reserved_microusd) || BigInt(bound) > BigInt(job.max_cost_microusd) || BigInt(bound) > BigInt(route.max_cost_microusd)) throw new Error('Cost bound unavailable');
    } catch {
      try { const stopped = await store.failBeforeDispatch(job); return { id: job.id, state: stopped.state }; }
      catch (error) { return preDispatchFailure(job, error); }
    }
    // The DB holds workspace/access locks and verifies consent, revision, cancel,
    // current access and live fencing lease immediately before this transition.
    let dispatched;
    try { dispatched = await store.beginDispatch(job); }
    catch (error) { return preDispatchFailure(job, error); }
    if (dispatched.state !== 'dispatched') return { id: job.id, state: dispatched.state };
    const controller = new AbortController(); let timer;
    try {
      const output = await Promise.race([
        // Promise.then also catches synchronous adapter exceptions. Exactly one invocation.
        Promise.resolve().then(() => provider.complete({ model: route.model, input, maxOutputTokens: job.max_output_tokens, maxCostMicrousd: job.reserved_microusd, signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Timeout')); }, timeoutMs); }),
      ]);
      clearTimeout(timer);
      const draft = validateDraft(output?.draft, input);
      if (typeof output.cost_microusd !== 'string' || !/^(0|[1-9][0-9]*)$/.test(output.cost_microusd) || BigInt(output.cost_microusd) > BigInt(job.reserved_microusd) || typeof output.provider_event_id !== 'string' || !refPattern.test(output.provider_event_id)) throw new Error('Invalid usage');
      const resultRef = await saveDraft({ job, draft, kind: 'ai_draft', source_revision: job.source_revision });
      if (typeof resultRef !== 'string' || !refPattern.test(resultRef)) throw new Error('Invalid encrypted reference');
      const result = await store.settle(job, { provider_event_id: output.provider_event_id, cost_microusd: output.cost_microusd, result_ref: resultRef });
      if (result.state !== 'succeeded') {
        // Settlement is already authoritative. Cleanup must never turn into another
        // provider call or mark a settled cancellation as financially unknown.
        if (typeof deleteDraft !== 'function') return { id: job.id, state: 'cleanup_required', job_state: result.state };
        try { await deleteDraft(resultRef); }
        catch { return { id: job.id, state: 'cleanup_required', job_state: result.state }; }
      }
      return { id: job.id, state: result.state, ...(result.source_stale === true ? { source_stale: true } : {}) };
    } catch {
      // Includes malformed responses, late storage/settlement failures and timeout:
      // submission may have been billed, so retain the hold and never retry.
      try { const result = await store.markUnknown(job); return { id: job.id, state: result.state }; }
      catch { return { id: job.id, state: 'reconciliation_required' }; }
    } finally { clearTimeout(timer); controller.abort(); input = undefined; }
  };
}
