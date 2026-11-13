import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto, createHash } from 'node:crypto';
import { createEncryptedVault } from '../adapters/encrypted-vault.js';
import { createSqliteAiBridge } from '../adapters/sqlite-ai.js';
import { openDatabase, transaction } from '../db/database.js';
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
test('SQLite bridge rejects arbitrary methods/parameters and keeps the user and executor roles apart', async () => {
  const calls = [];
  const bridge = createSqliteAiBridge({ call: (identity, name, args) => { calls.push({ identity, name, args }); return { state: 'queued' }; } });
  assert.deepEqual(await bridge.userRpc(id(1), 'ai_job_status', { p_job_id: id(2) }), { state: 'queued' });
  assert.deepEqual(calls[0], { identity: { role: 'authenticated', uid: id(1) }, name: 'ai_job_status', args: { p_job_id: id(2) } });
  await bridge.privilegedRpc('ai_reap_jobs', {});
  assert.deepEqual(calls[1].identity, { role: 'ai_executor' });
  assert.throws(() => bridge.userRpc(id(1), 'ai_set_budget', {}));
  assert.throws(() => bridge.userRpc('not-a-uuid', 'ai_job_status', { p_job_id: id(2) }));
  assert.throws(() => bridge.privilegedRpc('ai_claim_job; DROP TABLE users', {}));
  assert.throws(() => bridge.privilegedRpc('ai_claim_job', { p_lease_seconds: 60, malicious: 'x' }));
  assert.throws(() => bridge.privilegedRpc('ai_claim_job', {}));
  assert.throws(() => bridge.privilegedRpc('ai_job_status', { p_job_id: id(2) }));
  assert.equal(calls.length, 2);
  // A backend failure arrives as a rejected promise, never a synchronous throw.
  const failing = createSqliteAiBridge({ call: () => { throw Object.assign(new Error('forbidden'), { code: 'PT403' }); } });
  await assert.rejects(failing.userRpc(id(1), 'ai_job_status', { p_job_id: id(2) }), { code: 'PT403' });
});
test('SQLite transactions always roll back on failure and refuse async callbacks and nesting', () => {
  const db = openDatabase();
  try {
    db.exec('create table t(x)');
    assert.throws(() => transaction(db, () => { db.exec('insert into t values(1)'); throw Error('synthetic failure'); }), /synthetic failure/);
    assert.throws(() => transaction(db, async () => { db.exec('insert into t values(2)'); }), /synchronous/);
    assert.throws(() => transaction(db, () => transaction(db, () => 1)), /Nested/);
    assert.equal(db.prepare('select count(*) n from t').get().n, 0);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('pragma foreign_keys').get().foreign_keys, 1);
  } finally { db.close(); }
});
