import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto, createHash } from 'node:crypto';
import { createEncryptedVault } from '../adapters/encrypted-vault.js';
import { createSqlAiBridge, createTransactionRunner } from '../adapters/sql-ai.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('encrypted vault binds actor/document/consent and rejects tampering and path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-vault-test-')); try {
    const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const vault = await createEncryptedVault({ directory: root, key });
    const text = '합성 개인 기록'; const context = { actor_id: id(1), workspace_id: id(2), document_id: id(3), consent_id: id(4), source_revision: '1', payload_sha256: createHash('sha256').update(text).digest('hex') };
    const input_ref = await vault.putInput(context, text); assert.equal(await vault.loadInput({ ...context, input_ref }), text);
    await assert.rejects(vault.loadInput({ ...context, actor_id: id(5), input_ref }));
    await assert.rejects(vault.loadInput({ ...context, consent_id: id(5), input_ref }));
    await assert.rejects(vault.loadInput({ ...context, input_ref: '../escape' }));
    await assert.rejects(vault.putInput(context, 'different payload'));
    const path = join(root, `${input_ref}.json`); const envelope = JSON.parse(await readFile(path, 'utf8'));
    const data = Buffer.from(envelope.ciphertext, 'base64'); data[0] ^= 1; envelope.ciphertext = data.toString('base64');
    await writeFile(path, JSON.stringify(envelope)); await assert.rejects(vault.loadInput({ ...context, input_ref }));
    assert.equal((await readdir(root)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('SQL bridge rejects arbitrary methods/parameters and isolates role per transaction', async () => {
  const queries = [];
  const bridge = createSqlAiBridge({ transaction: async callback => callback({ query: async (text, values) => { queries.push({ text, values }); return { rows: [{ result: { state: 'queued' } }] }; } }) });
  await bridge.userRpc(id(1), 'ai_job_status', { p_job_id: id(2) });
  assert.equal(queries[0].text, 'SET LOCAL ROLE authenticated'); assert.equal(queries[1].values[0], id(1));
  assert.match(queries[2].text, /p_job_id => \$1::uuid/);
  assert.throws(() => bridge.userRpc(id(1), 'ai_set_budget', {}));
  assert.throws(() => bridge.privilegedRpc('ai_claim_job; DROP TABLE users', {}));
  assert.throws(() => bridge.privilegedRpc('ai_claim_job', { p_lease_seconds: 60, malicious: 'x' }));
});
test('PostgreSQL pool adapter always rolls back and releases on failure', async () => {
  const calls = [];
  const runner = createTransactionRunner({ connect: async () => ({ query: async text => calls.push(text), release: () => calls.push('release') }) });
  await assert.rejects(runner(async () => { throw Error('synthetic failure'); }));
  assert.deepEqual(calls, ['BEGIN', 'ROLLBACK', 'release']);
});
