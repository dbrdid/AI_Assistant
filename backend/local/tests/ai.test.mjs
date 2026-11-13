import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup, uuid, cipher, rejects, rejectsUnchanged, join, setAcl, enableAi } from './harness.mjs';

const [A, B, C] = [uuid(1), uuid(2), uuid(3)];
const W = uuid(10), W2 = uuid(11), D = uuid(20), D2 = uuid(21);
const HASH = createHash('sha256').update('synthetic').digest('hex');
const ROUTE = { route_id: 'r1', provider_id: 'synthetic', model_id: 'm1', retention_version: 'v1', max_cost_microusd: '100', max_output_tokens: 128 };
const period = t => new Date(Math.floor(t.clock.t / 1000)).toISOString().slice(0, 7);

function world({ users = [1, 2, 3] } = {}) {
  const t = setup({ users });
  t.as(A, 'create_workspace', [W, 'AI']);
  enableAi(t, A, W);
  t.as(A, 'create_document', [W, D, null, 'note', cipher(W, D)]);
  t.exec('ai_set_route', [ROUTE]);
  t.exec('ai_set_budget', [W, null, period(t), '1000']);
  t.exec('ai_set_budget', [W, A, period(t), '1000']);
  return t;
}
let seq = 0;
function consent(t, user = A, overrides = {}) {
  const request = { approved: true, consent_id: uuid(5000 + ++seq), workspace_id: W, document_id: D, source_revision: '1', payload_sha256: HASH,
    purpose: 'summary', route_id: 'r1', provider_id: 'synthetic', model_id: 'm1', retention_version: 'v1', max_cost_microusd: '100',
    max_output_tokens: 64, expires_at: new Date(t.clock.t / 1000 + 3600000).toISOString(), ...overrides };
  return { request, granted: t.as(user, 'ai_grant_consent', [request]) };
}
function admit(t, user = A, overrides = {}) {
  const { request } = consent(t, user);
  const admission = { job_id: uuid(7000 + ++seq), consent_id: request.consent_id, input_ref: 'opaque_ref', payload_sha256: HASH, route_id: 'r1', ...overrides };
  return { admission, job: t.exec('ai_admit_job', [user, admission]) };
}
const budgets = t => t.rows('select scope,held_microusd held,spent_microusd spent from ai_budgets order by scope').map(b => [b.scope, b.held, b.spent]);

test('routes and budgets are write-once; executor RPCs are not reachable as a user and user RPCs need a subject', () => {
  const t = world();
  try {
    assert.deepEqual(t.exec('ai_set_route', [ROUTE]), ROUTE);
    rejects(() => t.exec('ai_set_route', [{ ...ROUTE, model_id: 'm2' }]), 'route_immutable');
    for (const bad of [null, [], { ...ROUTE, extra: 1 }, { ...ROUTE, max_cost_microusd: 'x' }, { ...ROUTE, max_cost_microusd: 0 },
      { ...ROUTE, max_output_tokens: 1000001 }, { ...ROUTE, route_id: '' }, { ...ROUTE, provider_id: undefined }]) {
      rejects(() => t.exec('ai_set_route', [bad]), 'invalid_route');
    }
    assert.deepEqual(t.exec('ai_set_budget', [W, null, period(t), '1000']),
      { workspace_id: W, scope: '', period: period(t), limit_microusd: '1000', held_microusd: '0', spent_microusd: '0' });
    rejects(() => t.exec('ai_set_budget', [W, null, period(t), '999']), 'budget_immutable');
    rejects(() => t.exec('ai_set_budget', [W, null, '2026-13', '1']), 'invalid_request');
    rejects(() => t.exec('ai_set_budget', [W, null, period(t), '-1']), 'invalid_request');
    rejects(() => t.exec('ai_set_budget', [uuid(404), null, period(t), '1']), 'workspace_not_found');
    rejects(() => t.exec('ai_set_budget', [W, C, period(t), '1']), 'actor_not_member');
    for (const name of ['ai_set_route', 'ai_admit_job', 'ai_claim_job', 'ai_reap_jobs']) assert.throws(() => t.as(A, name, {}), e => e.code === '42501');
    assert.throws(() => t.exec('ai_job_status', [uuid(1)]), e => e.code === '42501');
    for (const name of ['ai_grant_consent', 'ai_job_status', 'ai_cancel_job', 'ai_revoke_consent']) rejects(() => t.as('', name, [null]), 'unauthenticated');
  } finally { t.close(); }
});

test('consent: strict request shape, a matching route, membership before the AI switch, and edit access to the current revision', () => {
  const t = world();
  try {
    const { request, granted } = consent(t);
    assert.deepEqual(Object.keys(granted).sort(), ['actor_id', 'document_id', 'expires_at', 'id', 'max_cost_microusd', 'max_output_tokens', 'payload_sha256',
      'purpose', 'retention_version', 'revoked_at', 'route_id', 'source_revision', 'workspace_id']);
    assert.deepEqual([granted.actor_id, granted.source_revision, granted.max_cost_microusd, granted.revoked_at], [A, '1', '100', null]);
    // The same grant again is idempotent; the same id with other content is consent_id_reused.
    assert.deepEqual(t.as(A, 'ai_grant_consent', [request]), granted);
    rejects(() => t.as(A, 'ai_grant_consent', [{ ...request, max_output_tokens: 32 }]), 'consent_id_reused');
    const invalid = [{ approved: false }, { approved: 'true' }, { extra: 1 }, { consent_id: 'x' }, { source_revision: 1 }, { source_revision: '01' },
      { source_revision: '9223372036854775808' }, { max_cost_microusd: 100 }, { max_cost_microusd: '0' }, { max_output_tokens: '64' }, { max_output_tokens: 1.5 },
      { payload_sha256: HASH.toUpperCase() }, { purpose: 'translate' }, { retention_version: '' }, { expires_at: 'tomorrow' },
      { expires_at: new Date(t.clock.t / 1000 + 25 * 3600000).toISOString() }];
    for (const overrides of invalid) rejects(() => consent(t, A, overrides), 'invalid_request');
    for (const overrides of [{ route_id: 'nope' }, { provider_id: 'other' }, { retention_version: 'v2' }, { max_cost_microusd: '101' }, { max_output_tokens: 129 }]) {
      rejects(() => consent(t, A, overrides), 'invalid_route');
    }
    // A non-member learns nothing about the workspace or its switch.
    rejectsUnchanged(t, () => consent(t, C), 'invalid_consent');
    rejects(() => consent(t, C, { workspace_id: uuid(404) }), 'invalid_consent');
    // A viewer is a member but may not edit; a stale revision or a past expiry is no consent either.
    join(t, A, W, B, 'viewer');
    rejects(() => consent(t, B), 'invalid_consent');
    rejects(() => consent(t, A, { source_revision: '2' }), 'invalid_consent');
    rejects(() => consent(t, A, { expires_at: new Date(t.clock.t / 1000 - 1000).toISOString() }), 'invalid_consent');
    // A restricting ACL counts too.
    setAcl(t, A, 'document', W, D, { [B]: 'editor' });
    rejects(() => consent(t, A), 'invalid_consent');
    setAcl(t, A, 'document', W, D, null);
    t.as(A, 'set_ai_enabled', [W, false]);
    rejects(() => consent(t, A), 'ai_disabled');
  } finally { t.close(); }
});

test('admission: one job per consent, replay by the same request, budgets held atomically with the queue row', () => {
  const t = world();
  try {
    const { admission, job } = admit(t);
    assert.equal(job.state, 'queued'); assert.equal(job.reserved_microusd, '100'); assert.equal(job.fencing_token, '0'); assert.equal(job.source_stale, false);
    assert.deepEqual(budgets(t), [['', 100, 0], [A, 100, 0]]);
    assert.deepEqual(t.exec('ai_admit_job', [A, admission]), job);
    rejects(() => t.exec('ai_admit_job', [A, { ...admission, input_ref: 'other_ref' }]), 'job_id_reused');
    rejects(() => t.exec('ai_admit_job', [A, { ...admission, job_id: uuid(8888) }]), 'consent_already_used');
    rejects(() => t.exec('ai_admit_job', [B, admission]), 'invalid_consent');
    for (const overrides of [{ input_ref: '../x' }, { job_id: 'x' }, { extra: 1 }, { route_id: 5 }]) rejects(() => t.exec('ai_admit_job', [A, { ...admission, ...overrides }]), 'invalid_request');
    const { request } = consent(t);
    rejects(() => t.exec('ai_admit_job', [A, { job_id: uuid(8889), consent_id: request.consent_id, input_ref: 'r', payload_sha256: 'f'.repeat(64), route_id: 'r1' }]), 'invalid_consent');
    // Budgets are per UTC month: without both rows for the month nothing is admitted; with too little room neither.
    const next = { job_id: uuid(8890), consent_id: request.consent_id, input_ref: 'r', payload_sha256: HASH, route_id: 'r1' };
    t.clock.t = Date.parse('2000-01-15T00:00:00Z') * 1000;
    t.exec('ai_set_budget', [W, null, '2000-01', '1000']);
    rejectsUnchanged(t, () => t.exec('ai_admit_job', [A, next]), 'budget_not_configured');
    t.exec('ai_set_budget', [W, A, '2000-01', '99']);
    rejectsUnchanged(t, () => t.exec('ai_admit_job', [A, next]), 'budget_exceeded');
  } finally { t.close(); }
});

test('worker path: claim fences, dispatch re-checks access, settlement is exact and idempotent, leases expire', () => {
  const t = world();
  try {
    assert.equal(t.exec('ai_claim_job', [60]), null);
    rejects(() => t.exec('ai_claim_job', [0]), 'invalid_lease');
    rejects(() => t.exec('ai_claim_job', [901]), 'invalid_lease');
    const { job } = admit(t);
    const claimed = t.exec('ai_claim_job', [60]);
    assert.deepEqual([claimed.id, claimed.state, claimed.fencing_token], [job.id, 'claimed', '1']);
    assert.equal(t.exec('ai_claim_job', [60]), null);
    rejects(() => t.exec('ai_begin_dispatch', [job.id, '0']), 'stale_fence');
    rejects(() => t.exec('ai_begin_dispatch', [uuid(1), '1']), 'job_not_found');
    rejects(() => t.exec('ai_mark_unknown', [job.id, '1']), 'not_dispatched');
    // The lease ends: the reaper puts the claim back and the old fence goes stale.
    t.advance(61 / 3600);
    rejects(() => t.exec('ai_begin_dispatch', [job.id, '1']), 'not_claimed');
    assert.deepEqual(t.exec('ai_reap_jobs', []), { reaped: 1 });
    const again = t.exec('ai_claim_job', [60]);
    assert.equal(again.fencing_token, '2');
    rejects(() => t.exec('ai_begin_dispatch', [job.id, '1']), 'stale_fence');
    assert.equal(t.exec('ai_begin_dispatch', [job.id, '2']).state, 'dispatched');
    assert.equal(t.row('select fencing_token from ai_attempts where job_id=?', job.id).fencing_token, 2);
    rejects(() => t.exec('ai_settle_job', [job.id, '2', 'evt-1', '101', 'succeeded', 'draft_ref']), 'invalid_cost');
    rejects(() => t.exec('ai_settle_job', [job.id, '2', 'evt-1', '20', 'succeeded', null]), 'invalid_outcome');
    rejects(() => t.exec('ai_settle_job', [job.id, '2', 'evt-1', '20', 'failed', 'draft_ref']), 'invalid_outcome');
    rejects(() => t.exec('ai_settle_job', [job.id, '2', '', '20', 'succeeded', 'draft_ref']), 'invalid_request');
    const settled = t.exec('ai_settle_job', [job.id, '2', 'evt-1', '20', 'succeeded', 'draft_ref']);
    assert.deepEqual([settled.state, settled.result_ref, settled.hold_released], ['succeeded', 'draft_ref', true]);
    assert.deepEqual(budgets(t), [['', 0, 20], [A, 0, 20]]);
    assert.deepEqual(t.exec('ai_settle_job', [job.id, '2', 'evt-1', '20', 'succeeded', 'draft_ref']), settled);
    rejects(() => t.exec('ai_settle_job', [job.id, '2', 'evt-1', '21', 'succeeded', 'draft_ref']), 'settlement_conflict');
    // A provider event settles one job only.
    const second = admit(t).job;
    t.exec('ai_claim_job', [60]);
    t.exec('ai_begin_dispatch', [second.id, '1']);
    rejects(() => t.exec('ai_settle_job', [second.id, '1', 'evt-1', '5', 'failed', null]), 'event_id_reused');
    // Dispatched past its lease: the reaper marks it unknown and keeps the hold (never retried).
    t.advance(1);
    assert.deepEqual(t.exec('ai_reap_jobs', []), { reaped: 1 });
    assert.equal(t.as(A, 'ai_job_status', [second.id]).state, 'outcome_unknown');
    assert.deepEqual(budgets(t), [['', 100, 20], [A, 100, 20]]);
    assert.equal(t.exec('ai_settle_job', [second.id, '1', 'evt-2', '5', 'failed', null]).state, 'failed');
    assert.deepEqual(budgets(t), [['', 0, 25], [A, 0, 25]]);
  } finally { t.close(); }
});

test('cancel and revoke release only what was never dispatched; dispatch cancels when access went away', () => {
  const t = world();
  try {
    join(t, A, W, B, 'editor');
    t.exec('ai_set_budget', [W, B, period(t), '1000']);
    const queued = admit(t).job;
    assert.equal(t.as(A, 'ai_cancel_job', [queued.id]).state, 'cancelled');
    rejects(() => t.as(B, 'ai_cancel_job', [queued.id]), 'forbidden');
    rejects(() => t.as(A, 'ai_job_status', [uuid(4040)]), 'forbidden');
    const { request } = consent(t);
    const admission = { job_id: uuid(9100), consent_id: request.consent_id, input_ref: 'r', payload_sha256: HASH, route_id: 'r1' };
    const job = t.exec('ai_admit_job', [A, admission]);
    t.exec('ai_claim_job', [60]);
    t.exec('ai_begin_dispatch', [job.id, '1']);
    const revoked = t.as(A, 'ai_revoke_consent', [request.consent_id]);
    assert.equal(revoked.consent_id, request.consent_id);
    assert.deepEqual(t.as(A, 'ai_revoke_consent', [request.consent_id]), revoked);
    rejects(() => t.as(B, 'ai_revoke_consent', [request.consent_id]), 'forbidden');
    const status = t.as(A, 'ai_job_status', [job.id]);
    assert.deepEqual([status.state, status.cancel_requested], ['dispatched', true]);
    // A late settlement is billed but the result is suppressed.
    const settled = t.exec('ai_settle_job', [job.id, '1', 'evt-9', '7', 'succeeded', 'late_ref']);
    assert.deepEqual([settled.state, settled.result_ref], ['cancelled', null]);
    assert.deepEqual(budgets(t), [['', 0, 7], [A, 0, 7], [B, 0, 0]]);
    // B's job: B loses edit access before dispatch, so it is cancelled and released without dispatching.
    const bJob = admit(t, B).job;
    setAcl(t, A, 'document', W, D, { [A]: 'editor', [B]: 'viewer' });
    t.exec('ai_claim_job', [60]);
    const stopped = t.exec('ai_begin_dispatch', [bJob.id, '1']);
    assert.deepEqual([stopped.state, stopped.cancel_requested], ['cancelled', true]);
    assert.equal(t.row('select count(*) n from ai_attempts where job_id=?', bJob.id).n, 0);
    // Status of a job whose document B no longer sees hides the draft fields.
    setAcl(t, A, 'document', W, D, { [A]: 'editor' });
    assert.deepEqual(t.as(B, 'ai_job_status', [bJob.id]), { id: bJob.id, state: 'cancelled', cancel_requested: true });
    // Source edits make a queued job's result stale; the document itself is never touched by AI RPCs.
    const fresh = admit(t).job;
    t.as(A, 'push_document', [W, D, uuid(9200), '1', cipher(W, D, 1, 'n')]);
    assert.equal(t.as(A, 'ai_job_status', [fresh.id]).source_stale, true);
  } finally { t.close(); }
});

test('rate limits: three active jobs, ten admissions a minute', () => {
  const t = world();
  try {
    t.exec('ai_set_budget', [W, null, '2099-01', '1']);
    const jobs = [admit(t).job, admit(t).job, admit(t).job];
    rejects(() => admit(t), 'rate_limited');
    for (const job of jobs) t.as(A, 'ai_cancel_job', [job.id]);
    for (let i = 0; i < 7; i++) t.as(A, 'ai_cancel_job', [admit(t).job.id]);
    rejects(() => admit(t), 'rate_limited');
    t.advance(1 / 60 + 1e-6);
    assert.equal(admit(t).job.state, 'queued');
  } finally { t.close(); }
});

test('account deletion (F24) with AI rows: shared workspaces keep them unlinked, a solo workspace takes them along', () => {
  const t = world();
  try {
    join(t, A, W, B, 'editor');
    t.exec('ai_set_budget', [W, B, period(t), '1000']);
    const shared = admit(t, B).job;
    // B's own workspace with AI rows.
    t.as(B, 'create_workspace', [W2, 'Solo']);
    enableAi(t, B, W2);
    t.as(B, 'create_document', [W2, D2, null, 'note', cipher(W2, D2)]);
    t.exec('ai_set_budget', [W2, null, period(t), '1000']);
    t.exec('ai_set_budget', [W2, B, period(t), '1000']);
    const { request } = consent(t, B, { workspace_id: W2, document_id: D2 });
    t.exec('ai_admit_job', [B, { job_id: uuid(9300), consent_id: request.consent_id, input_ref: 'r', payload_sha256: HASH, route_id: 'r1' }]);
    const oldHash = Buffer.from(t.row('select request_hash h from ai_jobs where id=?', shared.id).h).toString('hex');
    assert.equal(t.b.deleteUser(B), 1);
    for (const table of ['ai_consents', 'ai_jobs', 'ai_budgets']) assert.equal(t.row(`select count(*) n from ${table} where workspace_id=?`, W2).n, 0, table);
    const row = t.row('select actor_id,actor_scope,state,request_hash h from ai_jobs where id=?', shared.id);
    assert.deepEqual([row.actor_id, row.actor_scope, row.state], [null, null, 'queued']);
    assert.notEqual(Buffer.from(row.h).toString('hex'), oldHash);
    assert.equal(t.row('select count(*) n from ai_consents where actor_id is null').n, 1);
    assert.deepEqual(budgets(t), [['', 100, 0], [A, 0, 0]]);
    assert.deepEqual(t.rows('pragma foreign_key_check'), []);
    // The orphaned job is never dispatched; failing it releases only the workspace hold.
    const claimed = t.exec('ai_claim_job', [60]);
    assert.equal(t.exec('ai_begin_dispatch', [claimed.id, claimed.fencing_token]).state, 'cancelled');
    assert.deepEqual(budgets(t), [['', 0, 0], [A, 0, 0]]);
  } finally { t.close(); }
});
