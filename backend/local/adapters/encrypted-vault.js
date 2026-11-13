import { mkdir, stat, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { constants } from 'node:fs';
import { randomUUID, createHash, webcrypto } from 'node:crypto';
const REF = /^[a-f0-9]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 262144;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function binding(context, kind) {
  for (const key of ['actor_id','workspace_id','document_id','consent_id']) if (!UUID.test(context[key] || '')) throw new Error('Invalid vault context');
  if (!/^[1-9][0-9]{0,18}$/.test(context.source_revision || '') || !HASH.test(context.payload_sha256 || '')) throw new Error('Invalid vault context');
  return JSON.stringify(['ai-vault-v1', kind, context.actor_id, context.workspace_id, context.document_id, context.consent_id, context.source_revision, context.payload_sha256]);
}
/** Server-side encrypted blob adapter, NOT device key custody or KMS.
 * Key must be supplied by a trusted key provider; never generated/persisted here.
 * No plaintext files, implicit fallback, network, logging, or source mutations.
 */
export async function createEncryptedVault({ directory, key }) {
  if (typeof directory !== 'string' || !key || key.algorithm?.name !== 'AES-GCM' || key.algorithm.length !== 256 || key.extractable !== false || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) throw new Error('Protected AES-256 key and directory required');
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await stat(root);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error('Vault directory must be private');
  function filename(ref) { if (!REF.test(ref || '')) throw new Error('Invalid encrypted reference'); return join(root, `${ref}.json`); }
  async function put(text, context, kind) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Vault payload too large');
    const aad = binding(context, kind); const ref = randomUUID().replaceAll('-', ''); const nonce = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(aad), tagLength: 128 }, key, Buffer.from(text));
    const envelope = JSON.stringify({ version: 1, nonce: Buffer.from(nonce).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') });
    const file = await open(filename(ref), 'wx', 0o600);
    try { await file.writeFile(envelope, 'utf8'); await file.sync(); } finally { await file.close(); }
    return ref;
  }
  async function get(ref, context, kind) {
    const file = await open(filename(ref), constants.O_RDONLY | constants.O_NOFOLLOW);
    let envelope;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 360000 || (info.mode & 0o077) !== 0) throw new Error('Invalid encrypted object');
      envelope = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (envelope.version !== 1 || Object.keys(envelope).sort().join(',') !== 'ciphertext,nonce,version') throw new Error('Invalid encrypted envelope');
    const nonce = Buffer.from(envelope.nonce, 'base64'); const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (nonce.length !== 12 || ciphertext.length < 16 || nonce.toString('base64') !== envelope.nonce || ciphertext.toString('base64') !== envelope.ciphertext) throw new Error('Invalid encrypted envelope');
    const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(binding(context, kind)), tagLength: 128 }, key, ciphertext);
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  }
  return Object.freeze({
    async putInput(context, text) { if (hash(text) !== context.payload_sha256) throw new Error('Consent payload mismatch'); return put(text, context, 'input'); },
    async loadInput(job) { const text = await get(job.input_ref, job, 'input'); if (hash(text) !== job.payload_sha256) throw new Error('Consent payload mismatch'); return text; },
    async saveDraft({ job, draft }) { return put(JSON.stringify(draft), job, 'draft'); },
    async readDraft(job) { return JSON.parse(await get(job.result_ref, job, 'draft')); },
    async remove(ref) { await unlink(filename(ref)); },
  });
}
