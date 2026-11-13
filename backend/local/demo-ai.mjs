/** Offline-capable, synthetic-only demonstration. No HTTP server or real provider. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aiFixture } from './tests/ai-fixture.mjs';
const fixture = await aiFixture({ persistent: true });
try {
  const { job, text } = await fixture.enqueue();
  await fixture.reopen();
  const before = await fixture.status(job.id);
  const result = await fixture.worker()();
  const after = await fixture.status(job.id);
  const draft = await fixture.vault.readDraft(after);
  // Judge encryption at rest from the stored bytes in addition to the decrypt round trip. The vault must hold only
  // plain files, including the draft's file, each an exact {version, nonce, ciphertext} envelope; neither the bytes
  // nor the base64-decoded ciphertext may contain the input text or the draft summary. A heuristic, not a proof.
  const vault = join(fixture.directory, 'vault');
  const entries = await readdir(vault, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  const leaks = bytes => bytes.includes(text) || bytes.includes(draft.summary);
  const sealed = bytes => {
    try {
      const envelope = JSON.parse(bytes.toString('utf8'));
      return Object.keys(envelope).sort().join(',') === 'ciphertext,nonce,version' && !leaks(Buffer.from(envelope.ciphertext, 'base64'));
    } catch { return false; }
  };
  const stored = await Promise.all(files.map(name => readFile(join(vault, name))));
  const atRest = entries.length === files.length && files.includes(`${after.result_ref}.json`) && stored.every(bytes => !leaks(bytes) && sealed(bytes));
  console.log(JSON.stringify({
    mode: 'SYNTHETIC_LOCAL_ONLY_NO_EXTERNAL_AI',
    queue_survived_restart: before.state === 'queued',
    final_state: result.state,
    provider_calls: fixture.calls(),
    draft_encrypted_at_rest: !!after.result_ref && !!draft.summary && atRest,
    source_revision_unchanged: (await fixture.db.query('select revision::text revision from app.documents where id=$1', [fixture.document])).rows[0].revision === '1',
    budget_accounts: await fixture.balances(),
    actual_money_charged: false,
  }, null, 2));
} finally { await fixture.close(); }
