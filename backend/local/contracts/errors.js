/**
 * Error contract v1, shared by the SQL RPCs, PostgREST clients, the AI Gateway and the AI worker.
 *
 * SQL raises every business error as `raise exception '<reason>' using errcode='PT<status>'`.
 * PostgREST turns SQLSTATE PTxyz into HTTP status xyz with the body {code, message, details, hint},
 * so `message` carries the stable reason and `code` repeats the status. Any other SQLSTATE that reaches
 * a caller (42501 permission denied, 23505, 22P02, ...) is a server fault or misconfiguration, never a
 * business decision: callers treat it as unavailable and retry later without changing local state.
 *
 * Kinds tell callers what to do:
 *   auth       the request has no usable subject; sign in again
 *   access     the subject may not do this now (membership, ACL, consent); retry after access changes
 *   not_found  the target does not exist for this caller
 *   conflict   the request contradicts current state or an earlier request with the same id
 *   invalid    the request is malformed or unsupported; sending it unchanged always fails
 *   throttled  quota or budget; retry later
 */
const entry = (status, kind) => Object.freeze({ status, sqlstate: `PT${status}`, kind });

export const SERVER_ERRORS = Object.freeze({
  unauthenticated: entry(401, 'auth'),

  forbidden: entry(403, 'access'),
  invalid_consent: entry(403, 'access'),
  ai_disabled: entry(403, 'access'),

  folder_not_found: entry(404, 'not_found'),
  document_not_found: entry(404, 'not_found'),
  member_not_found: entry(404, 'not_found'),
  workspace_not_found: entry(404, 'not_found'),
  job_not_found: entry(404, 'not_found'),

  op_id_reused: entry(409, 'conflict'),
  id_conflict: entry(409, 'conflict'),
  invalid_key_epoch: entry(409, 'conflict'),
  cursor_ahead: entry(409, 'conflict'),
  already_member: entry(409, 'conflict'),
  owner_must_transfer: entry(409, 'conflict'),
  acl_version_mismatch: entry(409, 'conflict'),
  restore_expired: entry(409, 'conflict'),
  consent_id_reused: entry(409, 'conflict'),
  consent_already_used: entry(409, 'conflict'),
  job_id_reused: entry(409, 'conflict'),
  route_immutable: entry(409, 'conflict'),
  budget_immutable: entry(409, 'conflict'),
  stale_fence: entry(409, 'conflict'),
  not_claimed: entry(409, 'conflict'),
  not_dispatched: entry(409, 'conflict'),
  settlement_conflict: entry(409, 'conflict'),
  event_id_reused: entry(409, 'conflict'),

  invalid_request: entry(400, 'invalid'),
  invalid_acl: entry(400, 'invalid'),
  invalid_role: entry(400, 'invalid'),
  owner_change_not_supported: entry(400, 'invalid'),
  invalid_ciphertext: entry(400, 'invalid'),
  invalid_push: entry(400, 'invalid'),
  invalid_cursor: entry(400, 'invalid'),
  invalid_limit: entry(400, 'invalid'),
  invalid_route: entry(400, 'invalid'),
  invalid_lease: entry(400, 'invalid'),
  invalid_cost: entry(400, 'invalid'),
  invalid_outcome: entry(400, 'invalid'),
  actor_not_member: entry(400, 'invalid'),

  rate_limited: entry(429, 'throttled'),
  budget_exceeded: entry(402, 'throttled'),
  budget_not_configured: entry(402, 'throttled'),
});

/** Kinds that reject one request permanently: a queued operation with such a reason is set aside, not retried. */
export const REJECTION_KINDS = Object.freeze(['invalid', 'conflict', 'not_found']);

/** The contract entry when both the SQLSTATE and the message match the table exactly; otherwise null. */
export function serverError(code, message) {
  if (typeof code !== 'string' || typeof message !== 'string' || !Object.hasOwn(SERVER_ERRORS, message)) return null;
  const known = SERVER_ERRORS[message];
  return known.sqlstate === code ? Object.freeze({ reason: message, ...known }) : null;
}

/** True when `reason` is a contract reason that permanently rejects a single request. */
export function isRejectionReason(reason) {
  return typeof reason === 'string' && Object.hasOwn(SERVER_ERRORS, reason) && REJECTION_KINDS.includes(SERVER_ERRORS[reason].kind);
}

/**
 * Classifies a failed PostgREST RPC from its HTTP status and parsed body ({code, message} or null).
 * Only allowlisted reasons are returned, so untrusted body text never reaches errors or logs.
 *   AUTH_REQUIRED     sign in again (any 401)
 *   ACCESS_DENIED     a business access denial, never an infrastructure 42501
 *   REQUEST_REJECTED  this request keeps failing unchanged (invalid, conflict or not found); reason is set
 *   RATE_LIMITED      quota or budget; retry later
 *   RPC_FAILED        anything else, including permission misconfiguration and server faults; retry later
 */
export function classifyRpcFailure(status, body) {
  const known = body && typeof body === 'object' ? serverError(body.code, body.message) : null;
  if (status === 401) return Object.freeze({ code: 'AUTH_REQUIRED', reason: known?.status === 401 ? known.reason : null });
  if (!known || known.status !== status) return Object.freeze({ code: 'RPC_FAILED', reason: null });
  const code = known.kind === 'access' ? 'ACCESS_DENIED' : known.kind === 'throttled' ? 'RATE_LIMITED' : 'REQUEST_REJECTED';
  return Object.freeze({ code, reason: known.reason });
}
