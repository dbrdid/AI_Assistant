import { serverError } from '../contracts/errors.js';
import { UUID } from './auth.js';
import { RequestError, check, exact, uuid, bounded, routeRegistry, readJson, consentInput } from './validation.js';
const response = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
// Retryable failures: SQLSTATE classes 08 (connection) and 53 (resources), shutdown, query cancel or timeout,
// serialization failure, deadlock, lock not available, and Node socket or temporary DNS errors.
const TRANSIENT = new Set(['57P01', '57P02', '57P03', '57014', '40001', '40P01', '55P03',
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']);
const transientCode = code => typeof code === 'string' && (/^(08|53)[0-9A-Z]{3}$/.test(code) || TRANSIENT.has(code));
// fetch-based adapters wrap the socket error in a TypeError whose cause carries the code; one level is checked.
const transient = error => transientCode(error?.code) || transientCode(error?.cause?.code);
/** Contract errors keep their status and reason; nothing else is reflected, since DB/provider diagnostics can be sensitive. Never log them. */
function storeFailure(error) {
  const known = serverError(error?.code, error?.message);
  // The gateway verified the subject already, so a store 'unauthenticated' means the adapter dropped it: a server
  // fault. Telling the client to sign in again would loop.
  if (known && known.kind !== 'auth') return response(known.status, { error: known.reason });
  return transient(error) ? response(503, { error: 'temporarily_unavailable' }) : response(500, { error: 'internal_error' });
}
/** store must be a privileged server adapter enforcing current access in every transaction. */
export function createGateway({ verifyJwt, store, routes = [], now = Date.now }) {
  if (typeof verifyJwt !== 'function' || !store) throw new Error('Verified JWT and privileged store required');
  const registry = routeRegistry(routes);
  return async request => {
    try {
      const authorization = request.headers.get('authorization') || '';
      if (!/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) || authorization.length > 8192) throw new RequestError(401, 'unauthorized');
      let actor;
      try { actor = await verifyJwt(authorization.slice(7)); }
      // An unavailable key source says nothing about the token, so the client retries instead of signing in again.
      catch (error) { throw error?.code === 'AUTH_UNAVAILABLE' ? new RequestError(503, 'auth_unavailable') : new RequestError(401, 'unauthorized'); }
      if (!actor || !UUID.test(actor.id)) throw new RequestError(401, 'unauthorized');
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path === '/v1/ai/consents') {
        const input = consentInput(await readJson(request), registry, now());
        return response(201, await store.createConsent(actor.id, input));
      }
      if (request.method === 'POST' && path === '/v1/ai/jobs') {
        const input = await readJson(request); exact(input, ['consent_id','job_id','input_ref','payload_sha256','route_id']);
        uuid(input.consent_id); uuid(input.job_id); bounded(input.input_ref, 256);
        // Only opaque ciphertext references, never arbitrary URLs or embedded plaintext.
        check(/^[A-Za-z0-9_-]{1,200}$/.test(input.input_ref));
        check(typeof input.payload_sha256 === 'string' && /^[a-f0-9]{64}$/.test(input.payload_sha256));
        check(registry.has(input.route_id), 'route_not_allowed');
        return response(202, await store.enqueue(actor.id, input));
      }
      let match = path.match(/^\/v1\/ai\/jobs\/([^/]+)$/);
      if (match && request.method === 'GET') return response(200, await store.getJob(actor.id, uuid(match[1])));
      match = path.match(/^\/v1\/ai\/jobs\/([^/]+)\/cancel$/);
      if (match && request.method === 'POST') return response(200, await store.cancelJob(actor.id, uuid(match[1])));
      match = path.match(/^\/v1\/ai\/consents\/([^/]+)\/revoke$/);
      if (match && request.method === 'POST') return response(200, await store.revokeConsent(actor.id, uuid(match[1])));
      return response(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof RequestError) return response(error.status, { error: error.code });
      return storeFailure(error);
    }
  };
}
