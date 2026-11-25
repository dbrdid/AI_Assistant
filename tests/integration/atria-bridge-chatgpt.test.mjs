// Sign in with ChatGPT through the bridge, against a local stand-in for auth.openai.com and api.openai.com.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwt = claims => {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(head + '.' + body), privateKey).toString('base64url')}`;
};

async function fakeOpenAI(t, { scope = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke', failWith } = {}) {
  const seen = [];
  let base, pending;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, base);
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer: base, jwks_uri: base + '/jwks', revocation_endpoint: base + '/revoke' });
      if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
      if (url.pathname === '/revoke') { res.writeHead(200).end(); return; }
      if (url.pathname === '/api/accounts/oauth/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code') {
          // PKCE: the verifier must hash to the challenge sent with the authorize request.
          const challenge = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
          if (form.get('code') !== 'the-code' || challenge !== pending.code_challenge || form.get('client_id') !== 'oaiapp_test') return json(400, { error: 'invalid_grant' });
          return json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer', scope,
            id_token: jwt({ iss: base, aud: 'oaiapp_test', sub: 'user-1', email: 'owner@example.com', nonce: pending.nonce, exp: Math.floor(Date.now() / 1000) + 3600 }) });
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (form.get('refresh_token') !== 'rt-1') return json(400, { error: 'refresh_token_reused' });
          return json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope });
        }
      }
      if (url.pathname === '/v1/models') return json(200, { models: [{ slug: 'gpt-x', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] });
      if (url.pathname === '/v1/responses') {
        if (failWith) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: failWith } } })}\n\n`); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '안녕' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '하세요' })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`);
        return;
      }
      json(404, {});
    });
  });
  base = await listen(server);
  t.after(() => server.close());
  process.env.ATRIA_CHATGPT_AUTH = base;
  process.env.ATRIA_CHATGPT_API = base + '/v1';
  t.after(() => { delete process.env.ATRIA_CHATGPT_AUTH; delete process.env.ATRIA_CHATGPT_API; });
  // Plays the browser: reads the authorize URL and calls the loopback callback like auth.openai.com would.
  const browser = (url, { clientId = 'oaiapp_test', error } = {}) => {
    const q = Object.fromEntries(new URL(url).searchParams);
    pending = q;
    const back = new URL(q.redirect_uri);
    back.search = new URLSearchParams(error ? { error, state: q.state } : { code: 'the-code', state: q.state, scope, ...(clientId ? { client_id: clientId } : {}) }).toString();
    setTimeout(() => fetch(back).catch(() => {}), 20);
  };
  return { seen, browser, base };
}

test('sign in registers once, checks the ID token and plan scope, then serves chatgpt/ models over SSE', async t => {
  const { seen, browser } = await fakeOpenAI(t);
  const { chatgptLogin, sources, createBridge } = await import('../../bridge/bridge.mjs');
  const config = { key: 'k'.repeat(43), local: {}, providers: {}, cli: {}, plugins: {} };
  let saves = 0;
  const save = () => { saves++; };
  const s = await chatgptLogin(config, save, { print: () => {}, browser, port: 0 });
  assert.equal(s.clientId, 'oaiapp_test');
  assert.equal(s.email, 'owner@example.com');
  assert.ok(s.planUsage);
  assert.match(s.hostId, /^urn:uuid:/);
  assert.ok(saves >= 1);

  const { models } = await sources(config, 3000, [], save);
  assert.deepEqual(models.filter(m => m.owned_by === 'chatgpt').map(m => m.id), ['chatgpt/gpt-x']);

  const bridge = createBridge(config, { log: () => {}, timeoutMs: 3000, save });
  const base = await listen(bridge);
  t.after(() => bridge.close());
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + config.key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt/gpt-x', messages: [{ role: 'system', content: '짧게' }, { role: 'user', content: '인사' }] }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, '안녕하세요');
  const sent = JSON.parse(seen.find(x => x.path === '/v1/responses').body);
  assert.deepEqual({ model: sent.model, instructions: sent.instructions, store: sent.store, stream: sent.stream }, { model: 'gpt-x', instructions: '짧게', store: false, stream: true });
  assert.ok(!sent.input.some(m => m.role === 'system'));
  assert.equal(seen.find(x => x.path === '/v1/responses').headers.authorization, 'Bearer at-1');
});

test('an expiring access token is refreshed once with the issued client id; tokens rotate', async t => {
  const { seen, browser } = await fakeOpenAI(t);
  const { chatgptLogin, chatgptChat } = await import('../../bridge/bridge.mjs');
  const config = { plugins: {} };
  await chatgptLogin(config, () => {}, { print: () => {}, browser, port: 0 });
  config.chatgpt.expiresAt = Date.now() + 1000;
  const req = { messages: [{ role: 'user', content: 'a' }], maxTokens: 10 };
  await Promise.all([chatgptChat(config, () => {}, 'gpt-x', req, 3000), chatgptChat(config, () => {}, 'gpt-x', req, 3000)]);
  const refreshes = seen.filter(x => x.path === '/api/accounts/oauth/token' && new URLSearchParams(x.body).get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(new URLSearchParams(refreshes[0].body).get('client_id'), 'oaiapp_test');
  assert.equal(config.chatgpt.accessToken, 'at-2');
  assert.equal(config.chatgpt.refreshToken, 'rt-2');
});

test('no plan scope means no inference; usage limit errors carry the manage-usage link; cancel is reported', async t => {
  const { browser } = await fakeOpenAI(t, { scope: 'openid profile email offline_access', failWith: 'subscription_sharing_usage_limit_exceeded' });
  const { chatgptLogin, chatgptChat } = await import('../../bridge/bridge.mjs');
  const config = { plugins: {} };
  const s = await chatgptLogin(config, () => {}, { print: () => {}, browser, port: 0 });
  assert.equal(s.planUsage, false);
  const req = { messages: [{ role: 'user', content: 'a' }] };
  await assert.rejects(chatgptChat(config, () => {}, 'gpt-x', req, 3000), /플랜 사용 권한/);
  config.chatgpt.planUsage = true;
  await assert.rejects(chatgptChat(config, () => {}, 'gpt-x', req, 3000), /chatgpt\.com\/settings\/usage/);

  const fresh = { plugins: {}, chatgpt: { hostId: 'urn:uuid:x', clientId: 'oaiapp_test' } };
  await assert.rejects(chatgptLogin(fresh, () => {}, { print: () => {}, browser: url => browser(url, { error: 'access_denied' }), port: 0 }), /취소/);
  assert.equal(fresh.chatgpt.clientId, 'oaiapp_test'); // registration kept for the next try
});

test('update picks the newest release with a verified bridge file', async t => {
  const exeBytes = Buffer.from('new exe');
  const hash = createHash('sha256').update(exeBytes).digest('hex');
  let base;
  const server = createServer((req, res) => {
    if (req.url.startsWith('/releases')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify([
        { tag_name: 'v0.0.3', assets: [{ name: 'Atria-0.0.3.apk', browser_download_url: base + '/apk' }] }, // no bridge file
        { tag_name: 'v0.0.2', assets: [{ name: 'atria-bridge-0.0.2.tgz', browser_download_url: base + '/tgz' }, { name: 'SHA256SUMS.txt', browser_download_url: base + '/sums' }] },
        { tag_name: 'v0.0.1', assets: [{ name: 'atria-bridge-0.0.1.tgz', browser_download_url: base + '/old' }, { name: 'SHA256SUMS.txt', browser_download_url: base + '/sums' }] },
      ]));
    }
    if (req.url === '/sums') return res.end(`${hash}  atria-bridge-0.0.2.tgz\n`);
    if (req.url === '/tgz') return res.end(exeBytes);
    res.statusCode = 404; res.end();
  });
  base = await listen(server);
  t.after(() => server.close());
  process.env.ATRIA_BRIDGE_RELEASES = base + '/releases';
  t.after(() => { delete process.env.ATRIA_BRIDGE_RELEASES; });
  const { latestBridgeRelease, downloadVerified, newerVersion } = await import('../../bridge/bridge.mjs');
  assert.ok(newerVersion('0.0.10', '0.0.9'));
  assert.ok(!newerVersion('0.0.1', '0.0.1'));
  const release = await latestBridgeRelease('0.0.1', { exe: false });
  assert.equal(release.version, '0.0.2');
  assert.deepEqual(await downloadVerified(release), exeBytes);
  assert.equal(await latestBridgeRelease('0.0.2', { exe: false }), null);
});
