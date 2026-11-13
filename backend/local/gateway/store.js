/** Injection boundary, no credentials, client creation, or network enabled here.
 * userRpc MUST execute under the cryptographically verified actor's JWT context;
 * privilegedRpc MUST be unavailable to mobile clients. Each call must be atomic.
 * The production auth-context bridge is deliberately not implemented.
 */
export function createGatewayStore({ userRpc, privilegedRpc }) {
  if (typeof userRpc !== 'function' || typeof privilegedRpc !== 'function') throw new Error('RPC adapters required');
  return {
    createConsent: (actor, input) => {
      return userRpc(actor, 'ai_grant_consent', { p_request: input });
    },
    enqueue: (actor, request) => privilegedRpc('ai_admit_job', { p_actor_id: actor, p_request: request }),
    getJob: (actor, id) => userRpc(actor, 'ai_job_status', { p_job_id: id }),
    revokeConsent: (actor, id) => userRpc(actor, 'ai_revoke_consent', { p_consent_id: id }),
    cancelJob: (actor, id) => userRpc(actor, 'ai_cancel_job', { p_job_id: id }),
  };
}
