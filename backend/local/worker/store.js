/** Inject a privileged executor-only atomic RPC transport; never expose it to a client. */
export function createWorkerStore(rpc) {
  const fence = job => ({ p_job_id: job.id, p_fencing_token: job.fencing_token });
  return {
    claim: leaseSeconds => rpc('ai_claim_job', { p_lease_seconds: leaseSeconds }),
    beginDispatch: job => rpc('ai_begin_dispatch', fence(job)),
    failBeforeDispatch: job => rpc('ai_fail_before_dispatch', fence(job)),
    markUnknown: job => rpc('ai_mark_unknown', fence(job)),
    settle: (job, value) => rpc('ai_settle_job', { ...fence(job), p_provider_event_id: value.provider_event_id, p_cost_microusd: value.cost_microusd, p_outcome: 'succeeded', p_result_ref: value.result_ref }),
  };
}
