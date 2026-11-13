import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SERVER_ERRORS } from '../contracts/errors.js';
import { asUser, rpc, uuid, cipher, enableAi } from '../supabase/tests/ai-harness.mjs';
import { join as joinWorkspace, deleteUserAsAuthAdmin } from '../supabase/tests/harness.mjs';
import { sha256 } from '../worker/index.js';
import { aiFixture } from './ai-fixture.mjs';

// A contract rejection through the gateway: the reason's HTTP status from shared/contracts/errors.js and body {error: reason}.
async function expectRejection(response, reason) {
  assert.ok(Object.hasOwn(SERVER_ERRORS, reason), `not a contract reason: ${reason}`);
  assert.equal(response.status, SERVER_ERRORS[reason].status); assert.deepEqual(await response.json(), { error: reason });
}
// Grants a consent through the gateway and returns an admission for it. No worker runs, so input_ref is never resolved.
async function grant(t, { workspace = t.workspace, document = t.document, max_cost_microusd = '100' } = {}) {
  const payload_sha256 = sha256('합성 입력');
  const consent = { approved: true, consent_id: randomUUID(), workspace_id: workspace, document_id: document, source_revision: '1', payload_sha256, purpose: 'summary', route_id: t.route.id, retention_version: t.route.retention_version, max_cost_microusd, max_output_tokens: 64, expires_at: new Date(Date.now() + 3600000).toISOString() };
  assert.equal((await t.request('/v1/ai/consents', consent)).status, 201);
  return { job_id: randomUUID(), consent_id: consent.consent_id, input_ref: 'opaque_input', payload_sha256, route_id: t.route.id };
}
const jobCount = async t => (await t.db.query('select count(*)::int n from app.ai_jobs')).rows[0].n;

test('signed JWT -> consent -> encrypted input -> durable job -> reviewed draft and settled budgets', async () => {
  const t = await aiFixture(); try {
    const { job, text } = await t.enqueue();
    assert.deepEqual(await t.balances(), [{ held: '100', spent: '0' }, { held: '100', spent: '0' }]);
    const done = await t.worker()(); assert.equal(done.state, 'succeeded'); assert.equal(t.calls(), 1);
    const status = await t.status(job.id); assert.ok(status.result_ref); assert.equal(status.source_stale, false);
    const draft = await t.vault.readDraft(status); assert.match(draft.summary, /초안/);
    assert.deepEqual(await t.balances(), [{ held: '0', spent: '20' }, { held: '0', spent: '20' }]);
    assert.equal((await t.db.query('select revision::text r from app.documents where id=$1', [t.document])).rows[0].r, '1');
    for (const file of await readdir(join(t.directory, 'vault'))) {
      const encrypted = await readFile(join(t.directory, 'vault', file), 'utf8');
      assert.equal(encrypted.includes(text), false); assert.equal(encrypted.includes(draft.summary), false);
    }
    assert.equal((await t.worker()()).state, 'idle');
  } finally { await t.close(); }
});
test('one consent cannot authorize a second billed job; same admission is idempotent', async () => {
  const t = await aiFixture(); try {
    const { job, admission } = await t.enqueue();
    assert.equal((await t.request('/v1/ai/jobs', admission)).status, 202);
    await expectRejection(await t.request('/v1/ai/jobs', { ...admission, job_id: '99999999-9999-4999-8999-999999999999' }), 'consent_already_used');
    assert.deepEqual(await t.balances(), [{ held: '100', spent: '0' }, { held: '100', spent: '0' }]);
    assert.equal((await t.request(`/v1/ai/jobs/${job.id}/cancel`, {})).status, 200);
    assert.equal((await t.worker()()).state, 'idle'); assert.equal(t.calls(), 0);
    assert.deepEqual(await t.balances(), [{ held: '0', spent: '0' }, { held: '0', spent: '0' }]);
  } finally { await t.close(); }
});
test('timeout after dispatch keeps reservation and never automatically retries', async () => {
  const t = await aiFixture(); let called = 0; try {
    const { job } = await t.enqueue();
    const run = t.worker({ timeoutMs: 10, leaseSeconds: 1, providers: { synthetic: { noRetries: true, maximumCostMicrousd: () => '20', complete: async () => { called++; return new Promise(() => {}); } } } });
    assert.equal((await run()).state, 'outcome_unknown'); assert.equal((await t.status(job.id)).state, 'outcome_unknown');
    assert.equal((await run()).state, 'idle'); assert.equal(called, 1);
    assert.deepEqual(await t.balances(), [{ held: '100', spent: '0' }, { held: '100', spent: '0' }]);
  } finally { await t.close(); }
});
test('known pre-dispatch cost bound failure releases without invoking provider', async () => {
  const t = await aiFixture(); let called = 0; try {
    const { job } = await t.enqueue();
    const run = t.worker({ providers: { synthetic: { noRetries: true, maximumCostMicrousd: () => '101', complete: async () => { called++; } } } });
    assert.equal((await run()).state, 'failed'); assert.equal((await t.status(job.id)).state, 'failed'); assert.equal(called, 0);
    assert.deepEqual(await t.balances(), [{ held: '0', spent: '0' }, { held: '0', spent: '0' }]);
  } finally { await t.close(); }
});
test('cancel after submission settles real usage but suppresses and removes late draft', async () => {
  const t = await aiFixture(); try {
    const { job } = await t.enqueue();
    const run = t.worker({ providers: { synthetic: { ...t.provider, complete: async args => {
      await t.request(`/v1/ai/jobs/${job.id}/cancel`, {});
      return t.provider.complete(args);
    } } } });
    assert.equal((await run()).state, 'cancelled'); const status = await t.status(job.id);
    assert.equal(status.result_ref, null); assert.equal(status.cancel_requested, true);
    assert.deepEqual(await t.balances(), [{ held: '0', spent: '20' }, { held: '0', spent: '20' }]);
    assert.equal((await readdir(join(t.directory, 'vault'))).length, 1);
  } finally { await t.close(); }
});
test('queued jobs and held budgets survive PostgreSQL close/reopen', async () => {
  const t = await aiFixture({ persistent: true }); try {
    const { job } = await t.enqueue(); await t.reopen();
    assert.equal((await t.status(job.id)).state, 'queued');
    assert.deepEqual(await t.balances(), [{ held: '100', spent: '0' }, { held: '100', spent: '0' }]);
    assert.equal((await t.worker()()).state, 'succeeded'); assert.equal(t.calls(), 1);
    await t.reopen(); assert.equal((await t.status(job.id)).state, 'succeeded');
    assert.deepEqual(await t.balances(), [{ held: '0', spent: '20' }, { held: '0', spent: '20' }]);
  } finally { await t.close(); }
});

test('source changing during generation marks draft stale and never overwrites current source', async () => {
  const t = await aiFixture(); try {
    const { job } = await t.enqueue();
    const run = t.worker({ providers: { synthetic: { ...t.provider, complete: async args => {
      // Fixture-only simulated concurrent source edit; the worker has no source-write API.
      await t.db.query('update app.documents set revision=2 where id=$1', [t.document]);
      return t.provider.complete(args);
    } } } });
    const result = await run(); assert.equal(result.state, 'succeeded'); assert.equal(result.source_stale, true);
    const status = await t.status(job.id); assert.equal(status.source_revision, '1'); assert.equal(status.source_stale, true);
    assert.equal((await t.db.query('select revision::text r from app.documents where id=$1', [t.document])).rows[0].r, '2');
  } finally { await t.close(); }
});

// Contract errors end to end: signed JWT -> gateway -> SQL bridge -> SQL raise -> HTTP status and reason.
test('a fourth active job is rate_limited (429) and reserves nothing until an active job ends', async () => {
  const t = await aiFixture(); try {
    // Four caps of 50 fit the limits of 200, so only the active-job limit (3) stops the fourth.
    const admissions = [];
    for (let i = 0; i < 4; i++) admissions.push(await grant(t, { max_cost_microusd: '50' }));
    for (const admission of admissions.slice(0, 3)) assert.equal((await t.request('/v1/ai/jobs', admission)).status, 202);
    await expectRejection(await t.request('/v1/ai/jobs', admissions[3]), 'rate_limited');
    assert.equal(await jobCount(t), 3);
    assert.deepEqual(await t.balances(), [{ held: '150', spent: '0' }, { held: '150', spent: '0' }]);
    // Control: after one job is cancelled, the same admission is accepted.
    assert.equal((await t.request(`/v1/ai/jobs/${admissions[0].job_id}/cancel`, {})).status, 200);
    assert.equal((await t.request('/v1/ai/jobs', admissions[3])).status, 202);
    assert.deepEqual(await t.balances(), [{ held: '150', spent: '0' }, { held: '150', spent: '0' }]);
  } finally { await t.close(); }
});
test('an admission beyond the remaining budget is budget_exceeded (402) and reserves nothing', async () => {
  const t = await aiFixture(); try {
    // Caps of 100 against limits of 200: the third has no room, while the active-job limit (3) still allows it.
    const admissions = [await grant(t), await grant(t), await grant(t)];
    for (const admission of admissions.slice(0, 2)) assert.equal((await t.request('/v1/ai/jobs', admission)).status, 202);
    await expectRejection(await t.request('/v1/ai/jobs', admissions[2]), 'budget_exceeded');
    assert.equal(await jobCount(t), 2);
    assert.deepEqual(await t.balances(), [{ held: '200', spent: '0' }, { held: '200', spent: '0' }]);
    // Control: cancelling one job releases its hold, and the same admission is accepted.
    assert.equal((await t.request(`/v1/ai/jobs/${admissions[0].job_id}/cancel`, {})).status, 200);
    assert.equal((await t.request('/v1/ai/jobs', admissions[2])).status, 202);
    assert.deepEqual(await t.balances(), [{ held: '200', spent: '0' }, { held: '200', spent: '0' }]);
  } finally { await t.close(); }
});
test('an admission in a workspace without budgets for the month is budget_not_configured (402)', async () => {
  const t = await aiFixture(); try {
    // A second workspace of the same actor, with no budget rows.
    const workspace = uuid(11), document = uuid(21);
    await asUser(t.db, t.actor, () => rpc(t.db, 'create_workspace', [workspace, 'Synthetic unbudgeted']));
    await enableAi(t.db, t.actor, workspace);
    await asUser(t.db, t.actor, () => rpc(t.db, 'create_document', [workspace, document, null, 'note', cipher(workspace, document)]));
    const admission = await grant(t, { workspace, document });
    await expectRejection(await t.request('/v1/ai/jobs', admission), 'budget_not_configured');
    assert.equal(await jobCount(t), 0);
    assert.deepEqual(await t.balances(), [{ held: '0', spent: '0' }, { held: '0', spent: '0' }]);
    // Control: with both budget rows for this UTC month, the same admission is accepted.
    const period = new Date().toISOString().slice(0, 7);
    for (const who of [null, t.actor]) await t.bridge.privilegedRpc('ai_set_budget', { p_workspace_id: workspace, p_actor_id: who, p_period: period, p_limit_microusd: '200' });
    assert.equal((await t.request('/v1/ai/jobs', admission)).status, 202);
  } finally { await t.close(); }
});
test("another user's job status or cancel is forbidden (403), the same as for a job that does not exist", async () => {
  const t = await aiFixture(); try {
    const { job } = await t.enqueue();
    const outsider = uuid(2); await t.db.query('insert into auth.users values($1)', [outsider]);
    await expectRejection(await t.requestAs(outsider, `/v1/ai/jobs/${job.id}`, undefined, 'GET'), 'forbidden');
    await expectRejection(await t.requestAs(outsider, `/v1/ai/jobs/${job.id}/cancel`, {}), 'forbidden');
    // A job ID that does not exist gets the same answer, so the outsider cannot tell whether a job exists.
    await expectRejection(await t.requestAs(outsider, `/v1/ai/jobs/${randomUUID()}`, undefined, 'GET'), 'forbidden');
    // Controls: the owner reads the job, still queued with its hold, so the outsider's cancel changed nothing.
    const own = await t.request(`/v1/ai/jobs/${job.id}`, undefined, 'GET');
    assert.equal(own.status, 200); assert.equal((await own.json()).state, 'queued');
    assert.deepEqual(await t.balances(), [{ held: '100', spent: '0' }, { held: '100', spent: '0' }]);
  } finally { await t.close(); }
});
test('with AI off in the workspace, consent and admission are ai_disabled (403) and nothing is reserved', async () => {
  const t = await aiFixture(); try {
    const setAi = enabled => asUser(t.db, t.actor, () => rpc(t.db, 'set_ai_enabled', [t.workspace, enabled]));
    await setAi(false);
    const consent = { approved: true, consent_id: randomUUID(), workspace_id: t.workspace, document_id: t.document, source_revision: '1', payload_sha256: sha256('합성 입력'), purpose: 'summary', route_id: t.route.id, retention_version: t.route.retention_version, max_cost_microusd: '100', max_output_tokens: 64, expires_at: new Date(Date.now() + 3600000).toISOString() };
    await expectRejection(await t.request('/v1/ai/consents', consent), 'ai_disabled');
    // A consent granted while AI was on admits nothing once the owner turns it off.
    await setAi(true); const admission = await grant(t); await setAi(false);
    await expectRejection(await t.request('/v1/ai/jobs', admission), 'ai_disabled');
    assert.equal(await jobCount(t), 0);
    assert.deepEqual(await t.balances(), [{ held: '0', spent: '0' }, { held: '0', spent: '0' }]);
    // Control: with AI on again, the same admission is accepted.
    await setAi(true);
    assert.equal((await t.request('/v1/ai/jobs', admission)).status, 202);
  } finally { await t.close(); }
});
test("a deleted member's queued job never reaches the provider and releases only the workspace hold", async () => {
  const t = await aiFixture(); try {
    // A second member with its own budget row; the fixture's actor owns the workspace.
    const member = uuid(2); await t.db.query('insert into auth.users values($1)', [member]);
    await joinWorkspace(t.db, t.actor, t.workspace, member, 'editor');
    await t.bridge.privilegedRpc('ai_set_budget', { p_workspace_id: t.workspace, p_actor_id: member, p_period: new Date().toISOString().slice(0, 7), p_limit_microusd: '200' });
    const text = '합성 회의 기록입니다.';
    const consent = { approved: true, consent_id: randomUUID(), workspace_id: t.workspace, document_id: t.document, source_revision: '1', payload_sha256: sha256(text), purpose: 'summary', route_id: t.route.id, retention_version: t.route.retention_version, max_cost_microusd: '100', max_output_tokens: 64, expires_at: new Date(Date.now() + 3600000).toISOString() };
    assert.equal((await t.requestAs(member, '/v1/ai/consents', consent)).status, 201);
    const input_ref = await t.vault.putInput({ ...consent, actor_id: member }, text);
    const admission = { job_id: randomUUID(), consent_id: consent.consent_id, input_ref, payload_sha256: consent.payload_sha256, route_id: t.route.id };
    assert.equal((await t.requestAs(member, '/v1/ai/jobs', admission)).status, 202);
    // Budget rows by scope: the workspace, the owner, the member.
    assert.deepEqual(await t.balances(), [{ held: '100', spent: '0' }, { held: '0', spent: '0' }, { held: '100', spent: '0' }]);
    assert.equal(await deleteUserAsAuthAdmin(t.db, member), 1);
    // The job stays with the workspace, unlinked; the member's budget row went with the account.
    assert.deepEqual((await t.db.query('select actor_id, state from app.ai_jobs where id = $1', [admission.job_id])).rows, [{ actor_id: null, state: 'queued' }]);
    assert.deepEqual(await t.balances(), [{ held: '100', spent: '0' }, { held: '0', spent: '0' }]);
    // The vault cannot rebuild the input's binding without the actor, so the worker stops before dispatch.
    assert.deepEqual(await t.worker()(), { id: admission.job_id, state: 'failed' });
    assert.equal(t.calls(), 0);
    assert.deepEqual(await t.balances(), [{ held: '0', spent: '0' }, { held: '0', spent: '0' }]);
  } finally { await t.close(); }
});
