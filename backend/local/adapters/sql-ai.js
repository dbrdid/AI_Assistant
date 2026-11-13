/** Server-only parameterized PostgreSQL bridge. A real deployment must provide a
 * DB login permitted to SET ROLE authenticated and ai_executor, after review.
 * This module never creates credentials, grants role membership or opens a connection.
 */
const userMethods = {
  ai_grant_consent: { p_request: 'jsonb' },
  ai_revoke_consent: { p_consent_id: 'uuid' },
  ai_cancel_job: { p_job_id: 'uuid' },
  ai_job_status: { p_job_id: 'uuid' },
};
const executorMethods = {
  ai_set_budget: { p_workspace_id: 'uuid', p_actor_id: 'uuid', p_period: 'text', p_limit_microusd: 'bigint' },
  ai_set_route: { p_request: 'jsonb' },
  ai_admit_job: { p_actor_id: 'uuid', p_request: 'jsonb' },
  ai_claim_job: { p_lease_seconds: 'integer' },
  ai_begin_dispatch: { p_job_id: 'uuid', p_fencing_token: 'bigint' },
  ai_fail_before_dispatch: { p_job_id: 'uuid', p_fencing_token: 'bigint' },
  ai_mark_unknown: { p_job_id: 'uuid', p_fencing_token: 'bigint' },
  ai_settle_job: { p_job_id: 'uuid', p_fencing_token: 'bigint', p_provider_event_id: 'text', p_cost_microusd: 'bigint', p_outcome: 'text', p_result_ref: 'text' },
  ai_reap_jobs: {},
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function statement(methods, name, args) {
  const spec = Object.hasOwn(methods, name) && methods[name];
  if (!spec || !args || typeof args !== 'object' || Object.keys(args).some(key => !Object.hasOwn(spec, key)) || Object.keys(spec).some(key => !Object.hasOwn(args, key))) throw new Error('RPC not allowed');
  const names = Object.keys(spec);
  return {
    text: `select public.${name}(${names.map((key, i) => `${key} => $${i + 1}::${spec[key]}`).join(',')}) as result`,
    values: names.map(key => spec[key] === 'jsonb' ? JSON.stringify(args[key]) : args[key]),
  };
}
export function createSqlAiBridge({ transaction }) {
  if (typeof transaction !== 'function') throw new Error('Transaction runner required');
  const call = (role, actor, methods, name, args) => {
    const query = statement(methods, name, args);
    return transaction(async db => {
      // Both values are fixed by this module, never supplied by HTTP callers.
      await db.query(role === 'authenticated' ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE ai_executor');
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [actor || '']);
      return (await db.query(query.text, query.values)).rows[0].result;
    });
  };
  return Object.freeze({
    userRpc(actor, name, args) {
      if (typeof actor !== 'string' || !UUID.test(actor)) throw new Error('Verified actor required');
      return call('authenticated', actor, userMethods, name, args);
    },
    privilegedRpc(name, args) { return call('ai_executor', null, executorMethods, name, args); },
  });
}
/** Accepts a pg-compatible pool; the caller owns pool creation and shutdown. */
export function createTransactionRunner(pool) {
  if (typeof pool?.connect !== 'function') throw new Error('PostgreSQL pool required');
  return async callback => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      try { const result = await callback(db); await db.query('COMMIT'); return result; }
      catch (error) { await db.query('ROLLBACK'); throw error; }
    } finally { db.release(); }
  };
}
