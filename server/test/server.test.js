import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { OllamaProvider } from '../src/ollama.js';

const bearer = randomBytes(32).toString('base64url');
const otherBearer = randomBytes(32).toString('base64url');
const record = (token, userId = 'alice') => ({
  userId, sha256: createHash('sha256').update(token).digest('hex'),
  expiresAt: '2099-01-01T00:00:00Z',
});
const env = {
  OLLAMA_MODEL: 'test-model',
  AI_AUTH_TOKENS: JSON.stringify([record(bearer), record(otherBearer, 'bob')]),
};
const config = loadConfig(env);
const common = {
  clientRequestId: 'request-1', inputRevision: 3, consent: true,
  timeZone: 'Asia/Seoul', referenceTime: '2026-11-09T10:00:00+09:00',
};
const organize = { ...common, text: '11월 10일 보고서 제출' };
const validDraft = {
  summary: '보고서 제출 예정',
  candidates: [{ kind: 'task', title: '보고서 제출', dueDate: '2026-11-10', sourceQuote: '보고서 제출' }],
};
const answer = { ...common, question: '무엇을 제출하나요?',
  evidence: [{ id: 'note-1', revision: 2, text: '내일 보고서 제출' }] };
const validAnswer = {
  answer: '보고서를 제출합니다.', insufficientEvidence: false,
  citations: [{ id: 'note-1', revision: 2, quote: '보고서 제출' }],
};
function setup(t, generate = async () => structuredClone(validDraft), overrides = {}) {
  const app = buildApp({ config: { ...config, ...overrides }, provider: { generate } });
  t.after(() => app.close());
  return app;
}
function call(app, body = organize, task = 'organize', token = bearer) {
  return app.inject({
    method: 'POST', url: '/v1/ai/' + task,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    payload: body,
  });
}

test('configuration fails closed for missing, malformed and duplicate credentials', () => {
  assert.throws(() => loadConfig({}), /Configure/);
  assert.throws(() => loadConfig({ ...env, AI_AUTH_TOKENS: 'bad' }), /JSON/);
  assert.throws(() => loadConfig({ ...env, AI_AUTH_TOKENS: JSON.stringify([record(bearer), record(bearer)]) }), /Invalid/);
  assert.throws(() => loadConfig({ ...env, PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ ...env, OLLAMA_MODEL: '' }), /MODEL/);
  assert.throws(() => loadConfig({ ...env, OLLAMA_BASE_URL: 'http://user:secret@localhost' }), /origin/);
});

test('organize returns a validated draft and request correlation, without caching', async t => {
  const response = await call(setup(t));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json().inputRevision, 3);
  assert.equal(response.json().clientRequestId, common.clientRequestId);
  assert.deepEqual(response.json().result, validDraft);
});

test('authentication runs before parsing and no prompt is returned in errors', async t => {
  let calls = 0;
  const app = setup(t, async () => { calls++; });
  const response = await app.inject({ method: 'POST', url: '/v1/ai/organize', payload: 'private-input' });
  assert.equal(response.statusCode, 401);
  assert.equal(calls, 0);
  assert.doesNotMatch(response.body, /private-input/);
  assert.equal((await call(app, organize, 'organize', randomBytes(32).toString('base64url'))).statusCode, 401);
});

test('expired per-user token is rejected', async t => {
  const tokens = [{ ...record(bearer), expiresAt: '2000-01-01T00:00:00Z' }];
  assert.equal((await call(setup(t, undefined, { tokens }))).statusCode, 401);
});

test('request schema rejects missing consent, wrong types and unexpected properties', async t => {
  const app = setup(t);
  for (const body of [
    { ...organize, consent: false },
    { ...organize, inputRevision: '3' },
    { ...organize, text: '   ' },
    { ...organize, model: 'client-selected-model' },
    { ...organize, text: 'x'.repeat(8001) },
    { ...organize, text: '😀'.repeat(4001) },
  ]) assert.equal((await call(app, body)).statusCode, 400);
});

test('invalid time zone and impossible reference date are rejected', async t => {
  const app = setup(t);
  assert.equal((await call(app, { ...organize, timeZone: 'Invalid/Zone' })).statusCode, 400);
  assert.equal((await call(app, { ...organize, referenceTime: '2026-02-30T10:00:00Z' })).statusCode, 400);
});

test('malformed JSON, wrong media type and oversized body have bounded errors', async t => {
  const app = setup(t);
  const headers = { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' };
  const malformed = await app.inject({ method: 'POST', url: '/v1/ai/organize', headers, payload: '{"secret":' });
  assert.equal(malformed.statusCode, 400);
  assert.doesNotMatch(malformed.body, /secret/);
  const large = await app.inject({ method: 'POST', url: '/v1/ai/organize', headers, payload: 'x'.repeat(50000) });
  assert.equal(large.statusCode, 413);
  const wrong = await app.inject({ method: 'POST', url: '/v1/ai/organize',
    headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: 'x' });
  assert.equal(wrong.statusCode, 415);
});

test('model output with unknown fields, impossible date or invented quote is rejected', async t => {
  for (const result of [
    { ...validDraft, sql: 'DELETE FROM notes' },
    { ...validDraft, candidates: [{ ...validDraft.candidates[0], dueDate: '2026-02-30' }] },
    { ...validDraft, candidates: [{ ...validDraft.candidates[0], sourceQuote: 'invented' }] },
  ]) {
    const response = await call(setup(t, async () => result));
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'INVALID_MODEL_OUTPUT');
  }
});

test('conditions endpoint returns only an allowed search DTO', async t => {
  const result = { keywords: ['보고서'], recordType: 'task' };
  const app = setup(t, async () => result);
  const response = await call(app, { ...common, question: '보고서 할 일 찾아줘' }, 'conditions');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().result, result);
});

test('answer checks citation id, revision and literal source quote', async t => {
  const good = await call(setup(t, async () => validAnswer), answer, 'answer');
  assert.equal(good.statusCode, 200);
  for (const citation of [
    { id: 'other', revision: 2, quote: '보고서 제출' },
    { id: 'note-1', revision: 5, quote: '보고서 제출' },
    { id: 'note-1', revision: 2, quote: '다른 내용' },
  ]) {
    const response = await call(setup(t, async () => ({ ...validAnswer, citations: [citation] })), answer, 'answer');
    assert.equal(response.statusCode, 502);
  }
});

test('empty evidence returns insufficientEvidence without calling the model', async t => {
  const response = await call(setup(t, async () => { throw new Error('must not call'); }),
    { ...answer, evidence: [] }, 'answer');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().result.insufficientEvidence, true);
});

test('duplicate evidence and excessive evidence are rejected', async t => {
  const app = setup(t);
  assert.equal((await call(app, { ...answer, evidence: [answer.evidence[0], answer.evidence[0]] }, 'answer')).statusCode, 400);
  assert.equal((await call(app, { ...answer, evidence: Array(4).fill(answer.evidence[0]) }, 'answer')).statusCode, 400);
});

test('unsupported answer without citations is rejected', async t => {
  const response = await call(setup(t, async () => ({ ...validAnswer, citations: [] })), answer, 'answer');
  assert.equal(response.statusCode, 502);
});

test('rate limit is per user and emits Retry-After', async t => {
  const app = setup(t, undefined, { requestsPerMinute: 1 });
  assert.equal((await call(app)).statusCode, 200);
  const limited = await call(app);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal((await call(app, organize, 'organize', otherBearer)).statusCode, 200);
});

test('global and per-user concurrency reject excess work and release after completion', async t => {
  let release;
  const started = new Promise(resolve => { release = resolve; });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = setup(t, async () => { release(); await pending; return validDraft; }, { maxConcurrent: 1 });
  const first = call(app);
  await started;
  assert.equal((await call(app)).statusCode, 429);
  assert.equal((await call(app, organize, 'organize', otherBearer)).statusCode, 429);
  finish();
  assert.equal((await first).statusCode, 200);
  assert.equal((await call(app)).statusCode, 200);
});

test('deadline aborts inference and releases capacity', async t => {
  let calls = 0;
  const app = setup(t, async (_task, _input, signal) => {
    if (++calls > 1) return validDraft;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { modelTimeoutMs: 30 });
  const timedOut = await call(app);
  assert.equal(timedOut.statusCode, 504);
  assert.equal(timedOut.json().error.code, 'MODEL_TIMEOUT');
  assert.equal((await call(app)).statusCode, 200);
});

test('unexpected provider error never leaks its message', async t => {
  const response = await call(setup(t, async () => { throw new Error('PRIVATE_PROMPT_AND_TOKEN'); }));
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, /PRIVATE/);
});

test('health is liveness only, unknown route is JSON 404', async t => {
  const app = setup(t);
  assert.deepEqual((await app.inject('/healthz')).json(), { status: 'ok' });
  assert.equal((await app.inject('/unknown')).statusCode, 404);
});

test('Ollama adapter uses server-selected model, schema, no tools or automatic retries', async () => {
  let calls = 0;
  const provider = new OllamaProvider(config, async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
    assert.equal(body.format.additionalProperties, false);
    assert.equal(body.tools, undefined);
    assert.equal(options.redirect, 'error');
    return Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify(validDraft) } });
  });
  assert.deepEqual(await provider.generate('organize', organize, new AbortController().signal), validDraft);
  assert.equal(calls, 1);
});

test('Ollama malformed, truncated, oversized and non-2xx responses fail closed', async () => {
  const responses = [
    new Response('bad json'),
    Response.json({ done: false, message: { content: '{}' } }),
    Response.json({ done: true, done_reason: 'length', message: { content: '{}' } }),
    new Response('x'.repeat(131073)),
    new Response('private upstream failure', { status: 503 }),
  ];
  for (const response of responses) {
    const provider = new OllamaProvider(config, async () => response);
    await assert.rejects(provider.generate('organize', organize, new AbortController().signal),
      error => error.statusCode === 502 && !error.message.includes('private'));
  }
});

test('per-user concurrency is enforced even when global capacity is available', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let count = 0;
  const app = setup(t, async () => {
    if (++count === 1) { entered(); await pending; }
    return validDraft;
  }, { maxConcurrent: 2 });
  const first = call(app);
  await started;
  assert.equal((await call(app)).statusCode, 429);
  assert.equal((await call(app, organize, 'organize', otherBearer)).statusCode, 200);
  finish();
  assert.equal((await first).statusCode, 200);
});

test('Ollama transport failures become safe errors and deadline abort reaches fetch', async () => {
  const failed = new OllamaProvider(config, async () => { throw new Error('upstream private URL'); });
  await assert.rejects(failed.generate('organize', organize, new AbortController().signal),
    error => error.code === 'MODEL_UNAVAILABLE' && !error.message.includes('private'));
  const controller = new AbortController();
  const stalled = new OllamaProvider(config, async (_url, options) =>
    new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))));
  const pending = stalled.generate('organize', organize, controller.signal);
  const reason = new Error('deadline');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
});

test('client disconnect aborts in-flight inference over a real socket', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let stopped;
  const aborted = new Promise(resolve => { stopped = resolve; });
  const app = setup(t, async (_task, _input, signal) => {
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      stopped(signal.reason); reject(signal.reason);
    }, { once: true }));
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const socketRequest = http.request(url + '/v1/ai/organize', {
    method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
  });
  // ECONNRESET is the expected consequence of deliberately closing this test socket.
  socketRequest.on('error', error => {
    if (error.code !== 'ECONNRESET') throw error;
  });
  socketRequest.end(JSON.stringify(organize));
  await started;
  socketRequest.destroy();
  const reason = await Promise.race([
    aborted,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('disconnect was not propagated')), 1000);
      timer.unref();
    }),
  ]);
  assert.equal(reason.code, 'CLIENT_CLOSED');
});

test('real HTTP connects API to a fake Ollama transport', async t => {
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(request.url, '/api/chat');
    assert.equal(body.model, 'test-model');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ done: true, message: { content: JSON.stringify(validDraft) } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const integrationConfig = { ...config, ollamaBaseUrl: 'http://127.0.0.1:' + upstream.address().port };
  const app = buildApp({ config: integrationConfig, provider: new OllamaProvider(integrationConfig) });
  t.after(() => app.close());
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(url + '/v1/ai/organize', {
    method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
    body: JSON.stringify(organize),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, validDraft);
});
