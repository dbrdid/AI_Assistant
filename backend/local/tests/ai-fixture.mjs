import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createBackend } from '../rpc/index.js';
import { createSqliteAiBridge } from '../adapters/sqlite-ai.js';
import { createEncryptedVault } from '../adapters/encrypted-vault.js';
import { createJwtVerifier } from '../gateway/auth.js';
import { createGatewayStore } from '../gateway/store.js';
import { createGateway } from '../gateway/index.js';
import { createWorkerStore } from '../worker/store.js';
import { createWorker, sha256 } from '../worker/index.js';
import { uuid, cipher } from './harness.mjs';
export async function aiFixture({ persistent = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-gateway-test-'));
  const path = persistent ? join(directory, 'backend.sqlite') : ':memory:';
  let backend = createBackend({ path });
  const actor = uuid(1), workspace = uuid(10), document = uuid(20);
  const route = { id: 'synthetic-summary-v1', provider: 'synthetic', model: 'synthetic-summary', retention_version: 'local-test-only-v1', max_cost_microusd: '100', max_output_tokens: 128 };
  // The bridge resolves the current backend on every call, so it survives reopen().
  const bridge = createSqliteAiBridge({ call: (...args) => backend.call(...args) });
  const as = (user, name, args) => backend.call({ role: 'authenticated', uid: user }, name, args);
  backend.createUser(actor);
  as(actor, 'create_workspace', [workspace, 'Synthetic AI tests']);
  // AI is off in a new workspace (F29 minimum); the actor owns this one and turns it on.
  as(actor, 'set_ai_enabled', [workspace, true]);
  as(actor, 'create_document', [workspace, document, null, 'note', cipher(workspace, document)]);
  await bridge.privilegedRpc('ai_set_route', { p_request: { route_id: route.id, provider_id: route.provider, model_id: route.model, retention_version: route.retention_version, max_cost_microusd: route.max_cost_microusd, max_output_tokens: route.max_output_tokens } });
  const period = new Date().toISOString().slice(0, 7);
  for (const who of [null, actor]) await bridge.privilegedRpc('ai_set_budget', { p_workspace_id: workspace, p_actor_id: who, p_period: period, p_limit_microusd: '200' });
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'ephemeral-test';
  const issuer = 'https://issuer.synthetic.invalid';
  const sign = sub => new SignJWT({ sub }).setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).setIssuer(issuer).setAudience('authenticated').setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const token = await sign(actor);
  const verifyJwt = createJwtVerifier({ issuer, audience: 'authenticated', jwks: { keys: [jwk] } });
  const gateway = createGateway({ verifyJwt, store: createGatewayStore(bridge), routes: [route] });
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const vault = await createEncryptedVault({ directory: join(directory, 'vault'), key });
  const send = (bearer, path, body, method) => gateway(new Request(`https://gateway.synthetic.invalid${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const request = (path, body, method = 'POST') => send(token, path, body, method);
  // Same gateway and signing key, another verified subject.
  const requestAs = async (user, path, body, method = 'POST') => send(await sign(user), path, body, method);
  async function enqueue(text = '합성 회의 기록입니다. 다음 주 안건을 준비합니다.') {
    const consent = { approved: true, consent_id: randomUUID(), workspace_id: workspace, document_id: document, source_revision: '1', payload_sha256: sha256(text), purpose: 'summary', route_id: route.id, retention_version: route.retention_version, max_cost_microusd: '100', max_output_tokens: 64, expires_at: new Date(Date.now() + 3600000).toISOString() };
    const response = await request('/v1/ai/consents', consent);
    if (response.status !== 201) throw new Error(`Consent failed: ${response.status} ${await response.text()}`);
    const context = { ...consent, actor_id: actor };
    const input_ref = await vault.putInput(context, text);
    const admission = { job_id: randomUUID(), consent_id: consent.consent_id, input_ref, payload_sha256: consent.payload_sha256, route_id: route.id };
    const accepted = await request('/v1/ai/jobs', admission);
    if (accepted.status !== 202) throw new Error(`Admission failed: ${accepted.status} ${await accepted.text()}`);
    return { consent, admission, job: await accepted.json(), text };
  }
  let calls = 0;
  const provider = {
    noRetries: true, maximumCostMicrousd: () => '20',
    complete: async ({ input }) => { calls++; return { draft: { summary: '합성 결과: 사용자 검토가 필요한 초안', action_items: ['다음 회의 안건 검토'], citations: [{ start: 0, end: 2, quote: input.slice(0, 2) }] }, cost_microusd: '20', provider_event_id: randomUUID() }; },
  };
  const worker = overrides => createWorker({ store: createWorkerStore(bridge.privilegedRpc), loadInput: vault.loadInput, saveDraft: vault.saveDraft, deleteDraft: vault.remove, routes: [route], providers: { synthetic: provider }, ...overrides });
  return {
    directory, actor, workspace, document, route, bridge, vault, request, requestAs, enqueue, worker, provider, as, calls: () => calls,
    get backend() { return backend; }, get db() { return backend.db; },
    status: async id => (await request(`/v1/ai/jobs/${id}`, undefined, 'GET')).json(),
    balances: async () => backend.db.prepare('select cast(held_microusd as text) held,cast(spent_microusd as text) spent from ai_budgets order by scope').all().map(r => ({ ...r })),
    async reopen() { if (!persistent) throw new Error('Persistent fixture required'); backend.close(); backend = createBackend({ path }); },
    async close() { backend.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
