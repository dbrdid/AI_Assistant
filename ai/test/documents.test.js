import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDocument, createOllamaDocumentProvider } from '../src/documents.js';
const input = () => ({ documentId: 'note-1', revision: 3, text: '회의는 금요일입니다. 예산은 아직 미정입니다.' });
const output = () => ({ summary: '금요일 회의이며 예산은 미정이다.',
  keyPoints: [{ text: '예산 미확정', sourceQuote: '예산은 아직 미정입니다.' }] });
const provider = value => ({ generate: async () => value });
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('summary preserves document identity, revision and exact evidence', async () => {
  const result = await summarizeDocument(input(), { provider: provider(output()) });
  assert.deepEqual(result, { documentId: 'note-1', inputRevision: 3, result: output() });
});
test('invalid input is rejected before provider invocation', async () => {
  const bad = [ { ...input(), text: '' }, { ...input(), text: 'x'.repeat(8001) },
    { ...input(), revision: -1 }, { ...input(), consent: true }, { ...input(), documentId: '../file' } ];
  for (const item of bad) await rejects(summarizeDocument(item), 'INVALID_INPUT');
});
test('unknown fields, fabricated evidence and invalid output shape fail closed', async () => {
  const bad = [ { ...output(), tool: 'delete' }, { ...output(), summary: ' ' },
    { ...output(), keyPoints: [] }, { ...output(), keyPoints: Array(6).fill(output().keyPoints[0]) },
    { ...output(), keyPoints: [{ text: '예산 확정', sourceQuote: '100만원' }] },
    { ...output(), keyPoints: [{ ...output().keyPoints[0], extra: true }] } ];
  for (const value of bad) await rejects(summarizeDocument(input(), { provider: provider(value) }), 'INVALID_MODEL_OUTPUT');
});
test('caller mutation cannot alter evidence validation or revision', async () => {
  const doc = input();
  const result = await summarizeDocument(doc, { provider: { generate: async () => {
    doc.text = '변조'; doc.revision = 99; return output();
  } } });
  assert.equal(result.inputRevision, 3);
});
test('cancelled request never calls provider', async () => {
  const controller = new AbortController(); controller.abort();
  await rejects(summarizeDocument(input(), { signal: controller.signal,
    provider: { generate() { assert.fail('must not run'); } } }), 'CANCELLED');
});
test('deadline releases caller even if injected provider ignores cancellation', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try { await rejects(summarizeDocument(input(), { timeoutMs: 10,
    provider: { generate: () => new Promise(() => {}) } }), 'MODEL_TIMEOUT'); }
  finally { clearTimeout(keepAlive); }
});
test('provider errors do not expose private messages', async () => {
  await rejects(summarizeDocument(input(), { provider: { generate() { throw Error('private'); } } }), 'MODEL_UNAVAILABLE');
});
function ollama(fetchImpl) {
  return createOllamaDocumentProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'test-model', fetchImpl });
}
const envelope = value => JSON.stringify({ done: true, message: { content: JSON.stringify(value) } });
test('Ollama sends fixed model and bounded options, untrusted document as data', async () => {
  const model = ollama(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model'); assert.equal(body.stream, false);
    assert.equal(body.think, false); assert.equal(body.tools, undefined);
    assert.deepEqual(JSON.parse(body.messages[1].content), { document: input().text });
    return new Response(envelope(output()));
  });
  await summarizeDocument(input(), { provider: model });
});
test('upstream HTTP, malformed JSON, truncation and oversized bodies are rejected', async () => {
  const cases = [ [new Response('private', { status: 500 }), 'MODEL_UNAVAILABLE'],
    [new Response('{'), 'INVALID_MODEL_OUTPUT'],
    [new Response(JSON.stringify({ done: false })), 'INVALID_MODEL_OUTPUT'],
    [new Response(JSON.stringify({ done: true, done_reason: 'length' })), 'INVALID_MODEL_OUTPUT'],
    [new Response('x'.repeat(65537)), 'INVALID_MODEL_OUTPUT'] ];
  for (const [response, code] of cases) await rejects(summarizeDocument(input(), {
    provider: ollama(async () => response) }), code);
});
test('runtime endpoint must be a configured HTTP origin without credentials', () => {
  for (const baseUrl of ['file:///tmp', 'http://user:secret@host', 'http://host/path', 'http://host/?key=1']) {
    assert.throws(() => createOllamaDocumentProvider({ baseUrl, model: 'x' }), error => error.code === 'INVALID_CONFIGURATION');
  }
});
