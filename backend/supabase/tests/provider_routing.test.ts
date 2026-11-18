import assert from 'node:assert/strict';
import { selectRoute, callSelfHosted, readUsage } from '../functions/ai-gateway/providers.ts';
import { buildApp } from '../../cloud/src/app.js';
import { loadConfig } from '../../cloud/src/config.js';

Deno.test('actual Gateway handler preserves consent, routing and unknown settlement with mock Auth/RPC', async t => {
  const configured: Record<string, string> = { SUPABASE_URL: 'https://supabase.fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
    OPENAI_API_KEY: 'synthetic-api-key', OPENAI_BASE_URL: 'https://external.fixture.invalid/v1',
    SELF_HOSTED_URL: 'https://host.fixture.invalid', SELF_HOSTED_SECRET: 'synthetic-secret'.repeat(4), SELF_HOSTED_MODEL: 'fixture-model' };
  const before = new Map(Object.keys(configured).map(k => [k, Deno.env.get(k)]));
  const fetchBefore = globalThis.fetch; const serveBefore = Deno.serve;
  let handler: ((req: Request) => Promise<Response>) | undefined;
  let consent = true; let externalCalls = 0; let hostCalls = 0; const finishes: Record<string, unknown>[] = [];
  const draft = { summary: '합성 요약', topics: [], key_concepts: [], tasks: [], events: [], decisions: [], open_questions: [] };
  try {
    for (const [k, value] of Object.entries(configured)) Deno.env.set(k, value);
    Object.defineProperty(Deno, 'serve', { configurable: true, writable: true, value: (fn: typeof handler) => { handler = fn; return {}; } });
    globalThis.fetch = async (input, options) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/auth/v1/user')) return Response.json({ id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated' });
      if (url.includes('/rest/v1/consents')) return Response.json(consent ? [{ id: 'consent-fixture' }] : []);
      if (url.endsWith('/rpc/ai_begin_request')) return Response.json({ ok: true, request_id: '00000000-0000-4000-8000-000000000002', remaining: 9 });
      if (url.endsWith('/rpc/ai_finish_request')) { finishes.push(JSON.parse(String(options?.body))); return Response.json({ ok: true }); }
      if (url === 'https://host.fixture.invalid/internal/generate') {
        hostCalls++; return Response.json({ done: true, model: 'fixture-model', output: draft, usage: { input: 10, output: 5 } });
      }
      if (url === 'https://external.fixture.invalid/v1/responses') { externalCalls++; throw new TypeError('synthetic network interruption'); }
      throw new Error('Unexpected test transport: ' + new URL(url).pathname);
    };
    await import('../functions/ai-gateway/index.ts');
    const call = (route: string) => {
      assert.ok(handler);
      return handler(new Request('https://gateway.fixture.invalid/functions/v1/ai-gateway/analyze', {
        method: 'POST', headers: { authorization: 'Bearer synthetic-session', 'content-type': 'application/json', 'x-ai-route': route },
        body: JSON.stringify({ client_request_id: crypto.randomUUID(), text: '합성 원문', timezone: 'Asia/Seoul', kind: 'MEMO' }),
      }));
    };
    await t.step('self-hosted request traverses actual handler validation and settlement without external calls', async () => {
      const response = await call('self_hosted'); assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.provider, 'self_hosted'); assert.equal(result.draft.summary, draft.summary);
      assert.equal(hostCalls, 1); assert.equal(externalCalls, 0);
      assert.equal(finishes.at(-1)?.p_status, 'SUCCEEDED'); assert.equal(finishes.at(-1)?.p_cost_usd_micros, null);
    });
    await t.step('missing separate consent blocks the host before inference', async () => {
      consent = false; const response = await call('self_hosted'); assert.equal(response.status, 403);
      assert.equal(hostCalls, 1); assert.equal(externalCalls, 0);
    });
    await t.step('interrupted external request is UNKNOWN with null usage and no automatic paid retry', async () => {
      const response = await call('external'); assert.equal(response.status, 504);
      assert.equal(externalCalls, 1); assert.equal(finishes.at(-1)?.p_status, 'UNKNOWN');
      assert.equal(finishes.at(-1)?.p_input_tokens, null); assert.equal(finishes.at(-1)?.p_output_tokens, null);
      assert.equal(finishes.at(-1)?.p_cost_usd_micros, null);
    });
  } finally {
    globalThis.fetch = fetchBefore;
    Object.defineProperty(Deno, 'serve', { configurable: true, writable: true, value: serveBefore });
    for (const [k, value] of before) { if (value === undefined) Deno.env.delete(k); else Deno.env.set(k, value); }
  }
});

Deno.test('unknown or malformed provider usage stays unknown, and explicit zero remains a measured zero', () => {
  for (const raw of [null, {}, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1, output_tokens: 1.5 },
    { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } }]) assert.equal(readUsage(raw), undefined);
  assert.deepEqual(readUsage({ input_tokens: 0, output_tokens: 0 }), { input: 0, output: 0, cached: 0 });
});

Deno.test('route is explicit and a self-hosted failure never invokes an external fallback', async () => {
  assert.equal(selectRoute(null), 'external'); assert.equal(selectRoute('self_hosted'), 'self_hosted');
  assert.throws(() => selectRoute('https://untrusted.invalid'));
  let calls = 0;
  const r = await callSelfHosted({ origin: 'https://internal.example', secret: 'x'.repeat(40), instructions: 'fixture', input: 'fixture',
    schema: {}, maxOutputTokens: 100, timeoutMs: 50, fetchImpl: async () => { calls++; return new Response('', { status: 503 }); } });
  assert.equal(r.kind, 'error'); assert.equal(calls, 1);
  const unsafe = await callSelfHosted({ origin: 'http://remote.example', secret: 'x'.repeat(40), instructions: 'fixture', input: 'fixture', schema: {}, maxOutputTokens: 100, timeoutMs: 50,
    fetchImpl: async () => { throw new Error('must not run'); } });
  assert.equal(unsafe.kind, 'error');
});

Deno.test('Edge adapter → actual Fastify HTTP host → mock Ollama preserves cloud schema and usage', async () => {
  const secret = 'test-service-secret'.repeat(3);
  const config = loadConfig({ AI_GATEWAY_SECRET: secret, OLLAMA_MODEL: 'fixture-model' });
  let calls = 0;
  const app = buildApp({ config, provider: {}, fetchImpl: async () => {
    calls++; return Response.json({ done: true, prompt_eval_count: 40, eval_count: 8, message: { content: JSON.stringify({ answer: '근거 답변' }) } });
  } });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const r = await callSelfHosted({ origin, secret, instructions: 'fixture', input: '합성 원문', schema: { type: 'object' }, maxOutputTokens: 100, timeoutMs: 3000 });
    assert.equal(r.kind, 'ok');
    if (r.kind === 'ok') { assert.deepEqual(r.json, { answer: '근거 답변' }); assert.equal(r.usage.input, 40); }
    assert.equal(calls, 1);
  } finally { await app.close(); }
});
