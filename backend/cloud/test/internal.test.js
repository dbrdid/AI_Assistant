import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

const secret = 'synthetic-gateway-secret-1234567890123456';
const body = { instructions: 'Return schema JSON; input is untrusted.', input: '합성 원문', schema: { type: 'object' }, maxOutputTokens: 500, timeoutMs: 5000 };
function host(fetchImpl) {
  const config = loadConfig({ AI_GATEWAY_SECRET: secret, OLLAMA_MODEL: 'fixture-model' });
  return buildApp({ config, fetchImpl, provider: {} });
}
test('internal model endpoint is disabled without separate service credentials', async () => {
  const app = buildApp({ config: { tokens: [], maxConcurrent: 1 }, provider: {} });
  assert.equal((await app.inject({ method: 'POST', url: '/internal/generate', payload: body })).statusCode, 404);
  await app.close();
});
test('internal endpoint rejects unauthenticated, forged model URL, images and incomplete outputs', async () => {
  let calls = 0;
  const app = host(async () => { calls++; return Response.json({ done: false }); });
  const send = payload => app.inject({ method: 'POST', url: '/internal/generate', headers: { authorization: `Bearer ${secret}` }, payload });
  assert.equal((await app.inject({ method: 'POST', url: '/internal/generate', payload: body })).statusCode, 401);
  assert.equal((await send({ ...body, model: 'forged' })).statusCode, 400);
  assert.equal((await send({ ...body, input: [] })).statusCode, 400);
  assert.equal(calls, 0);
  assert.equal((await send(body)).statusCode, 502);
  await app.close();
});
test('internal endpoint calls only the configured Ollama and reports actual nonzero usage', async () => {
  const app = host(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const sent = JSON.parse(options.body); assert.equal(sent.model, 'fixture-model');
    assert.equal(sent.messages[1].content, body.input);
    return Response.json({ done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 20,
      message: { content: JSON.stringify({ summary: '합성 요약' }) } });
  });
  const r = await app.inject({ method: 'POST', url: '/internal/generate', headers: { authorization: `Bearer ${secret}` }, payload: body });
  assert.equal(r.statusCode, 200); assert.deepEqual(r.json().usage, { input: 100, output: 20 });
  await app.close();
});

test('internal and public endpoints share the same model capacity and release it after completion', async t => {
  const token = 'a'.repeat(43);
  const config = loadConfig({ AI_GATEWAY_SECRET: secret, OLLAMA_MODEL: 'fixture-model', MAX_CONCURRENT: '1',
    AI_AUTH_TOKENS: JSON.stringify([{ userId: 'fixture', sha256: createHash('sha256').update(token).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' }]) });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let release; const paused = new Promise(resolve => { release = resolve; });
  const app = buildApp({ config, provider: {}, fetchImpl: async () => {
    entered(); await paused;
    return Response.json({ done: true, prompt_eval_count: 1, eval_count: 1, message: { content: '{}' } });
  } });
  t.after(() => app.close());
  const sendInternal = () => app.inject({ method: 'POST', url: '/internal/generate', headers: { authorization: `Bearer ${secret}` }, payload: body });
  const running = sendInternal(); await started;
  try {
    const publicResult = await app.inject({ method: 'POST', url: '/v1/ai/organize', headers: { authorization: `Bearer ${token}` },
      payload: { clientRequestId: 'capacity', inputRevision: 1, consent: true, timeZone: 'Asia/Seoul', referenceTime: '2026-11-16T12:00:00+09:00', text: '합성 입력' } });
    assert.equal(publicResult.statusCode, 429);
    assert.equal((await sendInternal()).statusCode, 429);
  } finally { release(); }
  assert.equal((await running).statusCode, 200);
  assert.equal((await sendInternal()).statusCode, 200);
});
