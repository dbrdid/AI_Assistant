import { UUID } from './auth.js';
export class RequestError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
export function check(ok, code = 'invalid_request') { if (!ok) throw new RequestError(400, code); }
export function exact(value, keys) { check(value && typeof value === 'object' && !Array.isArray(value)); check(Object.keys(value).every(k => keys.includes(k))); }
export function uuid(value) { check(typeof value === 'string' && UUID.test(value)); return value; }
export function bounded(value, max = 128) { check(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)); return value; }
export function micros(value) { check(typeof value === 'string' && /^(0|[1-9][0-9]{0,11})$/.test(value)); return BigInt(value); }
export function routeRegistry(routes) {
  const map = new Map();
  for (const route of routes) {
    bounded(route.id); bounded(route.provider); bounded(route.model); bounded(route.retention_version);
    check(Number.isSafeInteger(route.max_output_tokens) && route.max_output_tokens > 0 && route.max_output_tokens <= 32768);
    micros(route.max_cost_microusd);
    check(!map.has(route.id)); map.set(route.id, Object.freeze({ ...route }));
  }
  return map;
}
export async function readJson(request, maxBytes = 16384) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new RequestError(415, 'json_required');
  const reader = request.body?.getReader(); if (!reader) throw new RequestError(400, 'invalid_request');
  let size = 0; const chunks = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new RequestError(413, 'body_too_large'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new RequestError(400, 'invalid_json'); }
}
export function consentInput(input, routes, now = Date.now()) {
  exact(input, ['approved','consent_id','workspace_id','document_id','source_revision','payload_sha256','purpose','route_id','retention_version','max_cost_microusd','max_output_tokens','expires_at']);
  check(input.approved === true, 'explicit_consent_required'); uuid(input.consent_id); uuid(input.workspace_id); uuid(input.document_id);
  check(typeof input.source_revision === 'string' && /^[1-9][0-9]{0,18}$/.test(input.source_revision) && BigInt(input.source_revision) <= 9223372036854775807n);
  check(typeof input.payload_sha256 === 'string' && /^[a-f0-9]{64}$/.test(input.payload_sha256));
  check(input.purpose === 'summary');
  const route = routes.get(input.route_id); check(!!route, 'route_not_allowed');
  check(input.retention_version === route.retention_version, 'retention_mismatch');
  check(micros(input.max_cost_microusd) > 0n && micros(input.max_cost_microusd) <= micros(route.max_cost_microusd));
  check(Number.isSafeInteger(input.max_output_tokens) && input.max_output_tokens > 0 && input.max_output_tokens <= route.max_output_tokens);
  const expiry = typeof input.expires_at === 'string' ? Date.parse(input.expires_at) : NaN;
  check(Number.isFinite(expiry) && expiry > now && expiry <= now + 86400000);
  return { ...input, provider_id: route.provider, model_id: route.model };
}
