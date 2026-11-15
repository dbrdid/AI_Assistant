import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIService } from '../../frontend/Frontend_UI/src/integration/ai-service.js';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { requireTransmission, requireRoute } from '../../shared/contracts/ai-policy.js';

function world() {
  const t = setup();
  const source = t.store.addMemo({ title: 'CANARY_TITLE', body: 'CANARY_BODY' });
  let session = { id: 'account', generation: 1 };
  let policy = { route: 'self_hosted', allowedProviders: ['self_hosted'], consent: { self_hosted: true }, excluded: false };
  const calls = [];
  let response = async () => ({ ok: true, request_id: 'fixture', draft: { summary: '검토할 요약', tasks: [], events: [] } });
  const service = createAIService({ store: t.store, newId: () => 'request', getSession: () => session,
    getPolicy: () => policy, gateway: async (...args) => { calls.push(args); return response(...args); } });
  return { ...t, source, service, calls, policy: value => { policy = value; }, session: value => { session = value; }, response: value => { response = value; } };
}

test('manual summary preview calls the same policy boundary without saving proposals or editing the source', async () => {
  const t = world();
  const result = await t.service.analyzeMemo(t.source.id, { preview: true });
  assert.deepEqual(result, { summary: '검토할 요약', sourceId: t.source.id, sourceRevision: t.source.revision });
  assert.equal(t.calls.length, 1);
  assert.equal(t.store.getProposals().length, 0);
  assert.equal(t.store.getMemo(t.source.id).body, 'CANARY_BODY');
});

test('caller cancellation prevents a late manual summary preview even if the transport ignores abort', async () => {
  const t = world(); const controller = new AbortController();
  t.response(async () => {
    controller.abort();
    return { ok: true, draft: { summary: 'must not display', tasks: [], events: [] } };
  });
  await assert.rejects(t.service.analyzeMemo(t.source.id, { preview: true, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(t.store.getProposals().length, 0);
});

test('policy intersection refuses off-device data before any transport, including title canaries', async () => {
  const t = world();
  t.policy({ route: 'self_hosted', allowedProviders: [], consent: { self_hosted: true } });
  await assert.rejects(t.service.analyzeMemo(t.source.id), { code: 'TRANSMISSION_DENIED' });
  assert.deepEqual(t.calls, []);
  t.policy({ route: 'external', allowedProviders: ['external'], consent: {} });
  await assert.rejects(t.service.analyzeMemo(t.source.id), { code: 'CONSENT_REQUIRED' });
  assert.deepEqual(t.calls, []);
});

test('source exclusion and forged provider fail closed', async () => {
  const t = world();
  t.policy({ route: 'self_hosted', allowedProviders: ['self_hosted'], consent: { self_hosted: true }, excluded: true });
  await assert.rejects(t.service.analyzeMemo(t.source.id), { code: 'TRANSMISSION_DENIED' });
  assert.throws(() => requireRoute('https://attacker.invalid'), { code: 'INVALID_AI_ROUTE' });
  assert.throws(() => requireTransmission('self_hosted', [{ allowedProviders: ['external'] }], { self_hosted: true }));
  assert.equal(t.calls.length, 0);
});

test('real local store + cloud-shaped response yields only pending proposals and preserves request revision', async () => {
  const t = world(); await t.service.analyzeMemo(t.source.id);
  assert.equal(t.calls[0][2].route, 'self_hosted');
  assert.equal(t.calls[0][1].text, 'CANARY_BODY');
  assert.equal(t.store.getMemos().length, 1);
  const proposal = t.store.getProposals()[0];
  assert.equal(proposal.sourceRevision, t.source.revision);
  assert.equal(proposal.status, 'pending');
  t.store.approveProposal(proposal.id);
  assert.equal(t.store.getMemos().length, 2);
});

test('source edit while awaiting provider rejects even an otherwise valid response', async () => {
  const t = world();
  t.response(async () => { t.store.updateMemo(t.source.id, { body: 'new source' }); return { ok: true, draft: { summary: 'old summary', tasks: [], events: [] } }; });
  await assert.rejects(t.service.analyzeMemo(t.source.id), { code: 'SOURCE_CHANGED' });
  assert.equal(t.store.getProposals().length, 0);
});

test('account replacement, cancellation, and consent withdrawal cannot save a late result', async () => {
  for (const change of ['account', 'cancel', 'consent']) {
    const t = world();
    t.response(async () => {
      if (change === 'account') t.session({ id: 'other', generation: 2 });
      if (change === 'cancel') t.service.cancel();
      if (change === 'consent') t.policy({ route: 'self_hosted', allowedProviders: [], consent: { self_hosted: false } });
      return { ok: true, draft: { summary: 'late', tasks: [], events: [] } };
    });
    await assert.rejects(t.service.analyzeMemo(t.source.id));
    assert.equal(t.store.getProposals().length, 0);
  }
});

test('service forwards caller cancellation signal and never falls back after a self-hosted error', async () => {
  const t = world(); t.response(async () => { throw new Error('SELF_HOSTED_UNAVAILABLE'); });
  await assert.rejects(t.service.analyzeMemo(t.source.id));
  assert.equal(t.calls.length, 1);
  assert.ok(t.calls[0][2].signal instanceof AbortSignal);
  assert.equal(t.calls[0][2].route, 'self_hosted');
});
