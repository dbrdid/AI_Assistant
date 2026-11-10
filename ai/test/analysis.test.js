import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDocument, summarizeLongDocument, answerDocument } from '../src/analysis.js';
import { createOllamaDocumentProvider } from '../src/documents.js';
const doc = text => ({ documentId: 'doc-1', revision: 2, text });
const summary = citation => ({ summary: '예산은 미정이다.', keywords: ['예산'],
  keyPoints: [{ text: '예산 미정', citation }] });
const answer = citation => ({ answer: '예산은 미정입니다.', insufficientEvidence: false, citations: [citation] });
const unavailable = () => ({ answer: '근거 없음', insufficientEvidence: true, citations: [] });
const reject = (promise, code) => assert.rejects(promise, error => error.code === code);
function mockProvider(calls) {
  return { generate: async request => {
    calls.push(request);
    const { task, payload } = request;
    const citation = payload.parts ? payload.parts[0].keyPoints?.[0].citation ?? payload.parts[0].citations[0]
      : { chunkId: payload.chunkId, quote: payload.document.slice(0, 5) };
    return task.startsWith('summary') ? summary(citation) : answer(citation);
  } };
}
test('chunks cover full source, overlap and preserve UTF-16 surrogate boundaries', () => {
  const source = '가'.repeat(3999) + '😀' + '나'.repeat(5000);
  const chunks = splitDocument(source);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, source.length);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    assert.equal(chunk.text, source.slice(chunk.start, chunk.end));
    assert.ok(chunk.text.length <= 4000);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text));
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.text));
    if (i) assert.ok(chunk.start < chunks[i - 1].end);
  }
});
test('all chunks including final fragment feed bounded pairwise reduction', async () => {
  const calls = [];
  const source = '문서내용'.repeat(3000);
  const result = await summarizeLongDocument(doc(source), { provider: mockProvider(calls), summaryLength: 'short' });
  const count = splitDocument(source).length;
  assert.equal(calls.filter(call => call.task === 'summary-chunk').length, count);
  assert.equal(calls.filter(call => call.task === 'summary-merge').length, count - 1);
  assert.ok(calls.filter(call => call.payload.parts).every(call => call.payload.parts.length === 2));
  assert.equal(result.chunks.at(-1).end, source.length);
  assert.equal(result.inputRevision, 2);
  assert.equal(result.summaryLength, 'short');
  assert.deepEqual(result.result.keywords, ['예산']);
});
test('length profiles enforce distinct schema and runtime limits', async () => {
  for (const [summaryLength, limit] of Object.entries({ short: 300, standard: 800, detailed: 1600 })) {
    const provider = { generate: async ({ schema }) => {
      assert.equal(schema.properties.summary.maxLength, limit);
      return { ...summary({ chunkId: 'chunk-0', quote: '예산' }), summary: '가'.repeat(limit + 1) };
    } };
    await reject(summarizeLongDocument(doc('예산 미정'), { provider, summaryLength }), 'INVALID_MODEL_OUTPUT');
  }
});
test('invalid options, oversized documents and questions fail before model calls', async () => {
  const provider = { generate() { assert.fail('not called'); } };
  await reject(summarizeLongDocument(doc('가'), { provider, summaryLength: 'unknown' }), 'INVALID_INPUT');
  await reject(summarizeLongDocument(doc('가'.repeat(80001)), { provider }), 'INVALID_INPUT');
  await reject(answerDocument(doc('가'), ' ', { provider }), 'INVALID_INPUT');
  await reject(answerDocument(doc('가'), '가'.repeat(1001), { provider }), 'INVALID_INPUT');
});
test('duplicate keywords and extra fields fail closed', async () => {
  for (const output of [ { ...summary({ chunkId: 'chunk-0', quote: '예산' }), keywords: ['예산', '예산'] },
    { ...summary({ chunkId: 'chunk-0', quote: '예산' }), tool: 'delete' } ]) {
    await reject(summarizeLongDocument(doc('예산 미정'), { provider: { generate: async () => output } }), 'INVALID_MODEL_OUTPUT');
  }
});
test('summary merge cannot invent citation even when it exists elsewhere in source', async () => {
  const provider = { generate: async ({ task, payload }) => {
    if (task === 'summary-chunk') return summary({ chunkId: payload.chunkId, quote: payload.document.slice(0, 1) });
    return summary({ chunkId: 'chunk-0', quote: '가가가' });
  } };
  await reject(summarizeLongDocument(doc('가'.repeat(5000)), { provider }), 'INVALID_MODEL_OUTPUT');
});
test('QA examines every chunk, cites source IDs, merges supported answers', async () => {
  const calls = [];
  const result = await answerDocument(doc('예산미정'.repeat(3000)), '예산은?', { provider: mockProvider(calls) });
  assert.equal(calls.filter(call => call.task === 'answer-chunk').length, result.chunks.length);
  assert.equal(result.result.insufficientEvidence, false);
  assert.ok(result.result.citations.length > 0);
});
test('QA reports insufficient evidence without a merge if no chunk supports answer', async () => {
  let count = 0;
  const result = await answerDocument(doc('가'.repeat(5000)), '예산은?', { provider: { generate: async ({ task }) => {
    assert.equal(task, 'answer-chunk'); count++; return unavailable();
  } } });
  assert.equal(count, 2);
  assert.equal(result.result.insufficientEvidence, true);
  assert.deepEqual(result.result.citations, []);
});
test('QA rejects fabricated citations, unsupported IDs and contradictory evidence flags', async () => {
  const bad = [answer({ chunkId: 'chunk-0', quote: '없음' }), answer({ chunkId: 'chunk-1', quote: '예산' }),
    { ...unavailable(), citations: [{ chunkId: 'chunk-0', quote: '예산' }] },
    { ...answer({ chunkId: 'chunk-0', quote: '예산' }), citations: [] }];
  for (const value of bad) await reject(answerDocument(doc('예산 미정'), '예산은?', {
    provider: { generate: async () => value } }), 'INVALID_MODEL_OUTPUT');
});
test('QA merge cannot invent new quote from original source', async () => {
  const provider = { generate: async ({ task, payload }) => task === 'answer-chunk'
    ? answer({ chunkId: payload.chunkId, quote: payload.document.slice(0, 1) })
    : answer({ chunkId: 'chunk-0', quote: '가가가' }) };
  await reject(answerDocument(doc('가'.repeat(5000)), '질문', { provider }), 'INVALID_MODEL_OUTPUT');
});
test('cancellation between chunks stops subsequent generation', async () => {
  const controller = new AbortController(); let count = 0;
  await reject(summarizeLongDocument(doc('가'.repeat(5000)), { signal: controller.signal,
    provider: { generate: async ({ payload }) => { count++; controller.abort();
      return summary({ chunkId: payload.chunkId, quote: '가' }); } } }), 'CANCELLED');
  assert.equal(count, 1);
});
test('one overall deadline bounds all chunk calls', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try { await reject(answerDocument(doc('내용'), '질문', { timeoutMs: 10,
    provider: { generate: () => new Promise(() => {}) } }), 'MODEL_TIMEOUT'); }
  finally { clearTimeout(keepAlive); }
});
test('extended Ollama tasks use their own instructions and data payload', async () => {
  const provider = createOllamaDocumentProvider({ baseUrl: 'http://localhost:11434', model: 'test',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /Answer the question/);
      assert.deepEqual(JSON.parse(body.messages[1].content), { question: '예산은?', chunkId: 'chunk-0', document: '예산 미정' });
      return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify(
        answer({ chunkId: 'chunk-0', quote: '예산 미정' })) } }));
    } });
  const result = await answerDocument(doc('예산 미정'), '예산은?', { provider });
  assert.equal(result.result.insufficientEvidence, false);
});
