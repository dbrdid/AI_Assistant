import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, cliPrompt, resolveCli } from '../../bridge/bridge.mjs';
import { parseBridgeLink, sendToProvider, setSessionKey } from '../../frontend/Frontend_UI/src/integration/aiGateway.mjs';

const KEY = 'k'.repeat(43), UPSTREAM_KEY = 'sk-upstream-secret';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

async function fixture(t, { timeoutMs = 5000 } = {}) {
  const seen = [];
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/compat/models') return res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      if (req.url === '/compat/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: 'compat:' + body.length } }] }));
      if (req.url === '/anthropic/messages') return res.end(JSON.stringify({ content: [{ type: 'text', text: 'claude says hi' }] }));
      res.statusCode = 500; res.end('{}');
    });
  });
  const upstreamBase = await listen(upstream);
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  const fakeCli = join(dir, 'fake-cli.mjs');
  // Echoes its arguments and stdin; "SLOW" in the prompt makes it hang past the timeout.
  writeFileSync(fakeCli, `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{if(s.includes('SLOW'))setTimeout(()=>{},60000);else process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:s}));});`);
  const logs = [];
  const config = {
    key: KEY, local: { compat: upstreamBase + '/compat', ollama: 'http://127.0.0.1:9' },
    providers: { anthropic: { type: 'anthropic', base: upstreamBase + '/anthropic', key: UPSTREAM_KEY, models: ['claude-sonnet-5-5'] } },
    cli: { claude: { enabled: true, command: [process.execPath, fakeCli] }, codex: { enabled: false } },
  };
  const bridge = createBridge(config, { log: line => logs.push(line), timeoutMs });
  const base = await listen(bridge);
  t.after(() => { bridge.close(); upstream.close(); });
  const call = (path, { key = KEY, body, raw } = {}) => fetch(base + path, {
    method: body || raw ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
    ...(body || raw ? { body: raw ?? JSON.stringify(body) } : {}),
  });
  return { base, call, seen, logs, upstreamBase };
}
const chat = (model, extra = {}) => ({ model, messages: [{ role: 'system', content: '지침' }, { role: 'user', content: '질문' }], max_tokens: 50, ...extra });

test('bridge requires the connection key on /v1 and answers OPTIONS without it', async t => {
  const { call, base } = await fixture(t);
  assert.equal((await call('/v1/models', { key: null })).status, 401);
  assert.equal((await call('/v1/models', { key: 'wrong' })).status, 401);
  assert.equal((await call('/v1/chat/completions', { key: 'wrong', body: chat('compat/m1') })).status, 401);
  const preflight = await fetch(base + '/v1/chat/completions', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});

test('model list and OpenAI response shape; unreachable local servers are left out', async t => {
  const { call } = await fixture(t);
  const list = await (await call('/v1/models')).json();
  assert.deepEqual(list.data.map(m => m.id).sort(), ['anthropic/claude-sonnet-5-5', 'claude-cli/default', 'compat/m1']);
  assert.ok(list.data.every(m => m.object === 'model' && m.owned_by));
  const reply = await (await call('/v1/chat/completions', { body: chat('compat/m1') })).json();
  assert.equal(reply.model, 'compat/m1');
  assert.equal(reply.choices[0].message.role, 'assistant');
  assert.match(reply.choices[0].message.content, /^compat:/);
  assert.equal((await call('/v1/chat/completions', { body: chat('compat/m1', { stream: true }) })).status, 400);
  assert.equal((await call('/v1/chat/completions', { body: chat('nobody/x') })).status, 404);
});

test('Anthropic gets system separately; the CLI gets one stdin text with no prompt in its arguments', async t => {
  const { call, seen } = await fixture(t);
  const reply = await (await call('/v1/chat/completions', { body: chat('anthropic/claude-sonnet-5-5') })).json();
  assert.equal(reply.choices[0].message.content, 'claude says hi');
  const sent = seen.find(s => s.url === '/anthropic/messages');
  assert.equal(sent.headers['x-api-key'], UPSTREAM_KEY);
  assert.equal(sent.body.system, '지침');
  assert.deepEqual(sent.body.messages, [{ role: 'user', content: '질문' }]);
  assert.equal(sent.body.model, 'claude-sonnet-5-5');

  const cli = JSON.parse((await (await call('/v1/chat/completions', { body: chat('claude-cli/default') })).json()).choices[0].message.content);
  assert.equal(cli.stdin, cliPrompt(chat('x').messages));
  assert.match(cli.stdin, /\[지침\]\n지침[\s\S]*사용자: 질문/);
  assert.ok(cli.args.includes('-p') && cli.args.includes('--tools'));
  assert.ok(!cli.args.some(arg => arg.includes('질문')));
});

test('a CLI past the time limit is stopped with 504; an oversized body gets 413', async t => {
  const { call } = await fixture(t, { timeoutMs: 400 });
  const slow = chat('claude-cli/default'); slow.messages[1].content = 'SLOW';
  assert.equal((await call('/v1/chat/completions', { body: slow })).status, 504);
  // The CLI slot is free again after the timeout.
  assert.equal((await call('/v1/chat/completions', { body: chat('claude-cli/default') })).status, 200);
  const big = await call('/v1/chat/completions', { raw: JSON.stringify(chat('compat/m1', { pad: 'x'.repeat(300 * 1024) })) });
  assert.equal(big.status, 413);
});

test('logs and errors carry no keys, prompts or upstream addresses', async t => {
  const { call, logs, upstreamBase } = await fixture(t);
  await call('/v1/chat/completions', { body: chat('compat/m1') });
  await call('/v1/models', { key: 'wrong' });
  const failed = await (await call('/v1/chat/completions', { body: chat('ollama/none') })).text();
  for (const text of [...logs, failed]) {
    for (const secret of [KEY, UPSTREAM_KEY, '질문', '지침', upstreamBase, '127.0.0.1:9']) assert.ok(!text.includes(secret), `${secret} in ${text}`);
  }
  assert.match(logs[0], /^\S+ POST \/v1\/chat\/completions compat\/m1 200 \d+ms$/);
});

test('an npm .cmd wrapper resolves to its real target, not the optional bundled node.exe', { skip: process.platform !== 'win32' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-path-'));
  mkdirSync(join(dir, 'node_modules', 'fake', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'fake', 'bin', 'fakecli.js'), '');
  // Shape of the wrapper npm writes (seen in %APPDATA%\npm\codex.cmd).
  writeFileSync(join(dir, 'fakecli.cmd'), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\fake\\bin\\fakecli.js" %*\r\n');
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; });
  process.env.PATH = dir;
  assert.deepEqual(resolveCli('fakecli'), [process.execPath, join(dir, 'node_modules', 'fake', 'bin', 'fakecli.js')]);
  assert.equal(resolveCli('missing'), null);
});

test('init writes the config and prints the app link; the app keeps slash model IDs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-init-'));
  const file = join(dir, 'config.json');
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../../bridge/atria-bridge.mjs', import.meta.url)), 'init'], { env: { ...process.env, ATRIA_BRIDGE_CONFIG: file }, encoding: 'utf8' });
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const link = parseBridgeLink(out.trim().split('\n').at(-1));
  assert.equal(link.key, config.key);
  assert.ok(config.key.length >= 43);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(parseBridgeLink('http://10.0.0.2:8787'), null);

  const sent = [];
  setSessionKey('server', link.key);
  await sendToProvider({ provider: 'server', serverUrl: link.url, serverModel: 'ollama/llama3:8b' }, { system: 's', user: 'u', mode: 'chat' },
    { fetchImpl: async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; } });
  assert.equal(JSON.parse(sent[0].init.body).model, 'ollama/llama3:8b');
  assert.equal(sent[0].init.headers.authorization, 'Bearer ' + link.key);
  assert.ok(sent[0].url.endsWith('/v1/chat/completions'));
});

test('plugins: only enabled plugin files add models; broken or colliding files are reported, not fatal', async t => {
  const { loadPlugins, sources } = await import('../../bridge/bridge.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bridge-plugins-'));
  writeFileSync(join(dir, 'echo.mjs'), `export default { id: 'echo', label: 'Echo', models: async ctx => ['default', ctx.settings.extra].filter(Boolean),
    chat: async (model, req, ctx) => model + ':' + req.messages.at(-1).content + ':' + typeof ctx.signal };`);
  writeFileSync(join(dir, 'off.mjs'), `export default { id: 'off', models: () => ['x'], chat: () => 'never' };`);
  writeFileSync(join(dir, 'broken.mjs'), `export default { id: 'Bad Id' };`);
  writeFileSync(join(dir, 'clash.mjs'), `export default { id: 'ollama', models: () => [], chat: () => '' };`);
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  const config = { key: KEY, local: { ollama: 'http://127.0.0.1:9' }, providers: {}, cli: { claude: { enabled: false }, codex: { enabled: false } },
    plugins: { echo: { enabled: true, settings: { extra: 'big' } }, off: { enabled: false } } };
  const plugins = await loadPlugins(config, dir);
  assert.deepEqual(plugins.map(p => [p.id, !!p.error]), [['broken', true], ['clash', true], ['echo', false], ['off', false]]);

  const { models, status } = await sources(config, 3000, plugins);
  assert.deepEqual(models.filter(m => m.owned_by === 'echo').map(m => m.id), ['echo/default', 'echo/big']);
  assert.ok(!models.some(m => m.id.startsWith('off/')));
  assert.match(status.find(s => s.source === 'broken').state, /플러그인 오류/);
  assert.equal(status.find(s => s.source === 'off').state, '플러그인 꺼짐');

  const bridge = createBridge(config, { log: () => {}, timeoutMs: 3000, plugins });
  const base = await listen(bridge);
  t.after(() => bridge.close());
  const call = model => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });
  const ok = await call('echo/default');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).choices[0].message.content, 'default:hi:object');
  assert.equal((await call('off/x')).status, 404);
});

test('a half-typed connection string is not split into address and key', () => {
  assert.equal(parseBridgeLink('http://10.0.0.2:8787#key=' + 'a'.repeat(32)), null);
  assert.deepEqual(parseBridgeLink('http://10.0.0.2:8787#key=' + 'a'.repeat(43)), { url: 'http://10.0.0.2:8787', key: 'a'.repeat(43) });
});
