/** Server-only bridge from the AI gateway and worker to the SQLite backend (rpc/index.js).
 * userRpc runs as the verified actor (role authenticated); privilegedRpc as ai_executor and MUST never be reachable
 * from a mobile client. Method names and argument names are allowlisted here, before the backend checks them again.
 */
const userMethods = {
  ai_grant_consent: ['p_request'],
  ai_revoke_consent: ['p_consent_id'],
  ai_cancel_job: ['p_job_id'],
  ai_job_status: ['p_job_id'],
};
const executorMethods = {
  ai_set_budget: ['p_workspace_id', 'p_actor_id', 'p_period', 'p_limit_microusd'],
  ai_set_route: ['p_request'],
  ai_admit_job: ['p_actor_id', 'p_request'],
  ai_claim_job: ['p_lease_seconds'],
  ai_begin_dispatch: ['p_job_id', 'p_fencing_token'],
  ai_fail_before_dispatch: ['p_job_id', 'p_fencing_token'],
  ai_mark_unknown: ['p_job_id', 'p_fencing_token'],
  ai_settle_job: ['p_job_id', 'p_fencing_token', 'p_provider_event_id', 'p_cost_microusd', 'p_outcome', 'p_result_ref'],
  ai_reap_jobs: [],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checked(methods, name, args) {
  const keys = Object.hasOwn(methods, name) && methods[name];
  if (!keys || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(args, key))) throw new Error('RPC not allowed');
  return args;
}
// A rejected promise rather than a synchronous throw once the call is allowed, as the PostgreSQL bridge behaved.
function settle(fn) { try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); } }

export function createSqliteAiBridge(backend) {
  if (typeof backend?.call !== 'function') throw new Error('SQLite backend required');
  return Object.freeze({
    userRpc(actor, name, args) {
      if (typeof actor !== 'string' || !UUID.test(actor)) throw new Error('Verified actor required');
      const input = checked(userMethods, name, args);
      return settle(() => backend.call({ role: 'authenticated', uid: actor }, name, input));
    },
    privilegedRpc(name, args) {
      const input = checked(executorMethods, name, args);
      return settle(() => backend.call({ role: 'ai_executor' }, name, input));
    },
  });
}
