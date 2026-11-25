// Atria bridge core: one OpenAI-compatible API over the AI this machine can reach. Node 20+, standard library only.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// The single executable has no package.json beside it; build.mjs writes the version in place of this line.
export const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
export const MAX_BODY_BYTES = 256 * 1024;
export const TIMEOUT_MS = 120000;
// STELLA_BRIDGE_CONFIG and ~/.stella-bridge are the pre-rename names; loadConfig still reads the old file once.
export const configPath = () => process.env.ATRIA_BRIDGE_CONFIG || process.env.STELLA_BRIDGE_CONFIG || join(homedir(), '.atria-bridge', 'config.json');
const legacyConfigPath = () => join(homedir(), '.stella-bridge', 'config.json');
export const newKey = () => randomBytes(32).toString('base64url');

export const DEFAULT_CONFIG = Object.freeze({
  key: '', host: '0.0.0.0', port: 8787,
  // Local servers are probed on every model list; one that does not answer is left out.
  local: { ollama: 'http://127.0.0.1:11434/v1', lmstudio: 'http://127.0.0.1:1234/v1' },
  // API providers appear only after `add-key`. models: the IDs shown in the list (any name after the prefix is accepted).
  providers: {},
  cli: { claude: { enabled: false }, codex: { enabled: false } },
  // Plugins found in <config folder>/plugins stay off until `enable-plugin`. { [id]: { enabled, settings } }
  plugins: {},
});
export const PROVIDER_DEFAULTS = Object.freeze({
  openai: { type: 'openai', base: 'https://api.openai.com/v1', models: ['gpt-6.1-terra'] },
  anthropic: { type: 'anthropic', base: 'https://api.anthropic.com/v1', models: ['claude-sonnet-5-5'] },
  gemini: { type: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash'] },
});

export function loadConfig(file = configPath()) {
  // First run after the rename: keep the old key so the app's saved connection keeps working. The next save writes the new path.
  const source = existsSync(file) ? file : file === join(homedir(), '.atria-bridge', 'config.json') && existsSync(legacyConfigPath()) ? legacyConfigPath() : null;
  const saved = source ? JSON.parse(readFileSync(source, 'utf8')) : {};
  return { ...structuredClone(DEFAULT_CONFIG), ...saved, cli: { ...structuredClone(DEFAULT_CONFIG.cli), ...saved.cli }, plugins: { ...saved.plugins } };
}

// ---------------------------------------------------------------------------------------------------------------
// Plugins: one .mjs file per plugin in <config folder>/plugins. Like Obsidian community plugins they run with this
// PC's permissions, so each one stays off until the owner runs `enable-plugin <id>`.
//   export default {
//     id: 'my-ai',                                   // model prefix: my-ai/<model>
//     label: 'My AI',
//     async models(ctx) { return ['default']; },     // model names after the prefix
//     async chat(model, request, ctx) { return 'reply text'; },
//   };
//   request: { messages: [{ role: 'system'|'user'|'assistant', content }], maxTokens, temperature }
//   ctx: { settings (config.plugins[id].settings), timeoutMs, signal }
// ---------------------------------------------------------------------------------------------------------------
export const pluginDir = (file = configPath()) => join(dirname(file), 'plugins');
const PLUGIN_ID = /^[a-z0-9-]{1,32}$/;

/** Every plugin file in the folder: [{ id, label, file, plugin?, error? }]. Broken files are reported, never fatal. */
export async function loadPlugins(config, dir = pluginDir()) {
  if (!existsSync(dir)) return [];
  const taken = new Set(['chatgpt', ...Object.keys(PROVIDER_DEFAULTS), ...Object.keys(config.local ?? {}), ...Object.keys(config.providers ?? {})]);
  const found = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.mjs')).sort()) {
    const file = join(dir, name);
    try {
      // The single executable's import() only reaches built-in modules; createRequire loads files from disk (require(esm), Node 22+).
      const plugin = inSea ? createRequire(file)(file).default : (await import(pathToFileURL(file).href)).default;
      if (!plugin || !PLUGIN_ID.test(plugin.id ?? '') || plugin.id.endsWith('-cli') || typeof plugin.models !== 'function' || typeof plugin.chat !== 'function')
        throw new Error('id(소문자·숫자·-), models(), chat()이 필요합니다.');
      if (taken.has(plugin.id)) throw new Error(`id "${plugin.id}"가 다른 공급원과 겹칩니다.`);
      taken.add(plugin.id);
      found.push({ id: plugin.id, label: String(plugin.label ?? plugin.id), file, plugin });
    } catch (error) { found.push({ id: name.replace(/\.mjs$/, ''), label: name, file, error: error?.message ?? String(error) }); }
  }
  return found;
}
const enabledPlugins = (config, plugins) => (plugins ?? []).filter(p => p.plugin && config.plugins?.[p.id]?.enabled);
const pluginCtx = (config, id, timeoutMs) => ({ settings: structuredClone(config.plugins?.[id]?.settings ?? {}), timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new HttpError(504, `${label} 응답 시간이 초과되었습니다.`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
export function saveConfig(config, file = configPath()) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(file, 0o600); // the file holds the connection key and API keys
}

/**
 * Finds the official CLI without a shell. On Windows npm installs `<name>.cmd` wrappers that spawn cannot run directly,
 * so the wrapper's real target (claude.exe, codex.js) is read from it. config.cli[name].command overrides the lookup.
 */
// Inside the single executable process.execPath is stella-bridge.exe itself, so a .js CLI needs the PC's own node.
export const inSea = (await import('node:sea').catch(() => null))?.isSea?.() ?? false;

// ---------------------------------------------------------------------------------------------------------------
// Updates: like other apps, only the program is replaced. The config folder (key, ChatGPT sign-in, plugins) stays.
// ---------------------------------------------------------------------------------------------------------------
const RELEASES_URL = () => process.env.ATRIA_BRIDGE_RELEASES || 'https://api.github.com/repos/dbrdid/AI_Assistant/releases?per_page=30';
const versionParts = v => String(v ?? '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
export const newerVersion = (a, b) => { const x = versionParts(a), y = versionParts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** The newest release that carries this platform's bridge file and is newer than VERSION, or null. */
export async function latestBridgeRelease(current = VERSION, { exe = inSea && process.platform === 'win32' } = {}) {
  const response = await fetch(RELEASES_URL(), { headers: { accept: 'application/vnd.github+json', 'user-agent': 'atria-bridge' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`업데이트 정보를 받지 못했습니다 (${response.status}).`);
  let best = null;
  for (const release of await response.json()) {
    if (release.draft) continue;
    const asset = (release.assets ?? []).find(a => exe ? a.name === 'atria-bridge.exe' : /^atria-bridge-[\d.]+\.tgz$/.test(a.name));
    const sums = (release.assets ?? []).find(a => a.name === 'SHA256SUMS.txt');
    const version = exe ? release.tag_name.replace(/^v/, '') : asset?.name.match(/^atria-bridge-([\d.]+)\.tgz$/)?.[1];
    if (!asset || !sums || !version || !newerVersion(version, best?.version ?? current)) continue;
    best = { version, asset, sums, notes: release.html_url };
  }
  return best;
}

/** Downloads the release file, checks it against SHA256SUMS.txt and returns its bytes. */
export async function downloadVerified(release) {
  const get = async url => { const r = await fetch(url, { headers: { 'user-agent': 'atria-bridge' }, signal: AbortSignal.timeout(10 * 60000) }); if (!r.ok) throw new Error(`내려받기에 실패했습니다 (${r.status}).`); return Buffer.from(await r.arrayBuffer()); };
  const sums = (await get(release.sums.browser_download_url)).toString('utf8');
  const expected = sums.split(/\r?\n/).map(line => line.trim().split(/\s+\*?/)).find(([, name]) => name === release.asset.name)?.[0];
  if (!expected) throw new Error('SHA256SUMS.txt에 파일 해시가 없습니다.');
  const bytes = await get(release.asset.browser_download_url);
  if (createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) throw new Error('내려받은 파일의 해시가 맞지 않습니다. 설치하지 않았습니다.');
  return bytes;
}

/**
 * Installs verified bytes. The Windows executable swaps itself (a running .exe may be renamed, not overwritten);
 * other installs get the checked package saved for `npm i -g`. Returns { replaced, file }.
 */
export function installUpdate(release, bytes) {
  if (inSea && process.platform === 'win32') {
    const exe = process.execPath, next = exe + '.new', old = exe + '.old';
    writeFileSync(next, bytes);
    rmSync(old, { force: true });
    renameSync(exe, old);
    try { renameSync(next, exe); } catch (error) { renameSync(old, exe); throw error; } // put the running version back
    return { replaced: true, file: exe };
  }
  const file = join(tmpdir(), release.asset.name);
  writeFileSync(file, bytes);
  return { replaced: false, file };
}
/** The previous executable kept by installUpdate; removed on the next start. */
export function cleanupOldExecutable() {
  if (inSea) try { rmSync(process.execPath + '.old', { force: true }); } catch { /* still locked: next start */ }
}
export function resolveCli(name, override) {
  if (Array.isArray(override) && override.length) return override;
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const node = () => inSea ? dirs.map(dir => join(dir, 'node.exe')).find(existsSync) : process.execPath;
  if (process.platform !== 'win32') return dirs.some(dir => existsSync(join(dir, name))) ? [name] : null;
  for (const dir of dirs) {
    if (existsSync(join(dir, name + '.exe'))) return [join(dir, name + '.exe')];
    const wrapper = join(dir, name + '.cmd');
    if (!existsSync(wrapper)) continue;
    // The target is the path followed by %*; an earlier "%dp0%\node.exe" is only an optional bundled node.
    const target = readFileSync(wrapper, 'utf8').match(/"%dp0%\\([^"]+\.(exe|js))"\s+%\*/);
    if (!target) continue;
    const file = join(dir, target[1]);
    if (!existsSync(file)) continue;
    if (target[2] !== 'js') return [file];
    const runtime = node();
    return runtime ? [runtime, file] : null;
  }
  return null;
}
// Single-response, no-tool options checked on this PC (2026-11-24):
// claude --help: -p/--print, --tools "" (no built-in tools), --no-session-persistence, --strict-mcp-config, --disable-slash-commands.
// codex exec --help: prompt from stdin when none is given, --sandbox read-only (no file changes), --skip-git-repo-check, --ephemeral, --color never.
//   ponytail: codex has no "no tools" flag; the read-only sandbox is the ceiling. Add one here when codex ships it.
const CLI_ARGS = {
  claude: ['-p', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--output-format', 'text'],
  codex: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never'],
};

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => part?.type === 'text' ? String(part.text ?? '') : '').join('') : '';

function readRequest(body) {
  if (body?.stream === true) throw new HttpError(400, 'stream은 지원하지 않습니다.');
  if (typeof body?.model !== 'string' || !body.model.includes('/')) throw new HttpError(400, 'model은 "공급원/모델" 형식이어야 합니다.');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'messages가 필요합니다.');
  const messages = body.messages.map(m => {
    if (!['system', 'user', 'assistant'].includes(m?.role)) throw new HttpError(400, 'messages의 role은 system, user, assistant만 지원합니다.');
    return { role: m.role, content: textOf(m.content) };
  });
  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? 1024);
  const temperature = body.temperature === undefined ? undefined : Number(body.temperature);
  return { model: body.model, messages, maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, 32000) : 1024, temperature };
}

async function upstream(url, init, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // The message never carries the upstream URL or key.
    if (error?.name === 'TimeoutError') throw new HttpError(504, '상위 AI 응답 시간이 초과되었습니다.');
    throw new HttpError(502, '상위 AI에 연결하지 못했습니다.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(502, `상위 AI 요청이 실패했습니다 (${response.status}).`);
  return data;
}

const splitSystem = messages => ({
  system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
  turns: messages.filter(m => m.role !== 'system'),
});
/** CLI input: system and the conversation as one text on stdin. */
export function cliPrompt(messages) {
  const { system, turns } = splitSystem(messages);
  const talk = turns.map(m => (m.role === 'user' ? '사용자: ' : '어시스턴트: ') + m.content).join('\n\n');
  return (system ? '[지침]\n' + system + '\n\n' : '') + '[대화]\n' + talk + '\n\n위 대화의 마지막 사용자 메시지에 답하세요. 답변만 출력하세요.';
}

const PROVIDERS = {
  async openai(p, name, req, timeoutMs) {
    const data = await upstream(p.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(p.key ? { authorization: 'Bearer ' + p.key } : {}) },
      body: JSON.stringify({ model: name, messages: req.messages, max_tokens: req.maxTokens, ...(req.temperature === undefined ? {} : { temperature: req.temperature }), stream: false }),
    }, timeoutMs);
    return textOf(data?.choices?.[0]?.message?.content);
  },
  async anthropic(p, name, req, timeoutMs) {
    const { system, turns } = splitSystem(req.messages);
    const data = await upstream(p.base.replace(/\/+$/, '') + '/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: name, max_tokens: req.maxTokens, ...(system ? { system } : {}), messages: turns, ...(req.temperature === undefined ? {} : { temperature: req.temperature }) }),
    }, timeoutMs);
    return (data?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('');
  },
  async gemini(p, name, req, timeoutMs) {
    const { system, turns } = splitSystem(req.messages);
    const data = await upstream(`${p.base.replace(/\/+$/, '')}/models/${encodeURIComponent(name)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': p.key },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: turns.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: req.maxTokens, ...(req.temperature === undefined ? {} : { temperature: req.temperature }) },
      }),
    }, timeoutMs);
    return (data?.candidates?.[0]?.content?.parts ?? []).map(part => part?.text ?? '').join('');
  },
};

let cliBusy = false; // one CLI run at a time on this machine
function runCli(command, args, input, timeoutMs) {
  if (cliBusy) return Promise.reject(new HttpError(429, 'CLI가 다른 요청을 처리 중입니다. 잠시 뒤 다시 시도해 주세요.'));
  cliBusy = true;
  return new Promise((resolve, reject) => {
    // No shell; the prompt only travels on stdin. An empty temp cwd keeps project files out of the CLI's context.
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '', done = false;
    const finish = (error, text) => { if (done) return; done = true; clearTimeout(timer); cliBusy = false; error ? reject(error) : resolve(text); };
    const timer = setTimeout(() => { child.kill(); finish(new HttpError(504, 'CLI 응답 시간이 초과되었습니다.')); }, timeoutMs);
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 1e6) { child.kill(); finish(new HttpError(502, 'CLI 응답이 너무 깁니다.')); } });
    child.on('error', () => finish(new HttpError(502, 'CLI를 실행하지 못했습니다.')));
    child.on('close', code => code === 0 ? finish(null, out.trim()) : finish(new HttpError(502, `CLI가 오류로 끝났습니다 (${code}).`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Every reachable model: [{ id, owned_by, call(name, req) }] plus per-source status lines for `list`. */
export async function sources(config, timeoutMs = TIMEOUT_MS, plugins = [], save = () => saveConfig(config)) {
  const status = [], models = [];
  const probe = async (prefix, base, key) => {
    try {
      const data = await upstream(base.replace(/\/+$/, '') + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {} }, Math.min(timeoutMs, 2000));
      const ids = (Array.isArray(data?.data) ? data.data : []).map(m => m?.id).filter(id => typeof id === 'string');
      status.push({ source: prefix, state: `사용 가능 (${ids.length}개)` });
      return ids.map(id => ({ id: prefix + '/' + id, owned_by: prefix }));
    } catch { status.push({ source: prefix, state: '응답 없음' }); return []; }
  };
  const compat = [...Object.entries(config.local ?? {}).map(([prefix, base]) => [prefix, { base }]),
    ...Object.entries(config.providers ?? {}).filter(([, p]) => p.type === 'compatible')];
  models.push(...(await Promise.all(compat.map(([prefix, p]) => probe(prefix, p.base, p.key)))).flat());
  for (const [prefix, p] of Object.entries(config.providers ?? {})) {
    if (p.type === 'compatible') continue;
    status.push({ source: prefix, state: p.key ? '키 등록됨' : '키 없음' });
    if (p.key) models.push(...(p.models ?? []).map(name => ({ id: prefix + '/' + name, owned_by: prefix })));
  }
  for (const name of Object.keys(CLI_ARGS)) {
    const entry = config.cli?.[name] ?? {};
    const command = resolveCli(name, entry.command);
    status.push({ source: name + '-cli', state: !command ? '설치되지 않음' : entry.enabled ? '켜짐 (서버 주인 본인 구독)' : '꺼짐' });
    if (command && entry.enabled) models.push({ id: name + '-cli/default', owned_by: name + '-cli' });
  }
  if (config.chatgpt?.accessToken) {
    try {
      const slugs = await chatgptModels(config, save, Math.min(timeoutMs, 10000));
      status.push({ source: 'chatgpt', state: `ChatGPT 플랜 사용 (${config.chatgpt.email || '로그인됨'}, ${slugs.length}개)` });
      models.push(...slugs.map(slug => ({ id: 'chatgpt/' + slug, owned_by: 'chatgpt' })));
    } catch (error) { status.push({ source: 'chatgpt', state: error?.message ?? '응답 없음' }); }
  } else status.push({ source: 'chatgpt', state: '로그인 안 됨 (login-chatgpt)' });
  for (const p of plugins) {
    if (p.error) { status.push({ source: p.id, state: `플러그인 오류: ${p.error}` }); continue; }
    if (!config.plugins?.[p.id]?.enabled) { status.push({ source: p.id, state: '플러그인 꺼짐' }); continue; }
    try {
      const ids = await withTimeout(Promise.resolve(p.plugin.models(pluginCtx(config, p.id, Math.min(timeoutMs, 5000)))), Math.min(timeoutMs, 5000), p.label);
      const names = (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id);
      status.push({ source: p.id, state: `플러그인 사용 가능 (${names.length}개)` });
      models.push(...names.map(id => ({ id: p.id + '/' + id, owned_by: p.id })));
    } catch { status.push({ source: p.id, state: '플러그인 응답 없음' }); }
  }
  return { models, status };
}

async function complete(config, req, timeoutMs, plugins = [], save = () => saveConfig(config)) {
  const cut = req.model.indexOf('/'), prefix = req.model.slice(0, cut), name = req.model.slice(cut + 1);
  if (prefix === 'chatgpt') {
    if (!name) throw new HttpError(404, '사용할 수 없는 모델입니다.');
    return chatgptChat(config, save, name, req, timeoutMs);
  }
  const plugin = enabledPlugins(config, plugins).find(p => p.id === prefix);
  if (plugin) {
    if (!name) throw new HttpError(404, '사용할 수 없는 모델입니다.');
    let text;
    try { text = await withTimeout(Promise.resolve(plugin.plugin.chat(name, req, pluginCtx(config, plugin.id, timeoutMs))), timeoutMs, plugin.label); }
    catch (error) { throw error instanceof HttpError ? error : new HttpError(502, `${plugin.label} 플러그인이 실패했습니다.`); }
    if (typeof text !== 'string') throw new HttpError(502, `${plugin.label} 플러그인이 글자 응답을 돌려주지 않았습니다.`);
    return text;
  }
  const cli = prefix.endsWith('-cli') && CLI_ARGS[prefix.slice(0, -4)] ? prefix.slice(0, -4) : null;
  if (cli) {
    const entry = config.cli?.[cli] ?? {};
    const command = entry.enabled && name === 'default' && resolveCli(cli, entry.command);
    if (!command) throw new HttpError(404, '사용할 수 없는 모델입니다.');
    return runCli(command, CLI_ARGS[cli], cliPrompt(req.messages), timeoutMs);
  }
  const p = config.local?.[prefix] ? { type: 'compatible', base: config.local[prefix] } : config.providers?.[prefix];
  if (!p || !name || (p.type !== 'compatible' && !p.key)) throw new HttpError(404, '사용할 수 없는 모델입니다.');
  return PROVIDERS[p.type === 'compatible' ? 'openai' : p.type](p, name, req, timeoutMs);
}

// ---------------------------------------------------------------------------------------------------------------
// Sign in with ChatGPT (open-source / locally hosted flow, developers.openai.com/siwc, read 2026-11-25).
// The owner signs in once in this PC's browser; the bridge keeps the tokens in its config (0600) and offers the
// account's models as chatgpt/<slug>. Requests use the owner's ChatGPT plan. Tokens never leave this PC.
// ---------------------------------------------------------------------------------------------------------------
const CHATGPT_AUTH = () => process.env.ATRIA_CHATGPT_AUTH || 'https://auth.openai.com';
const CHATGPT_API = () => process.env.ATRIA_CHATGPT_API || 'https://api.openai.com/v1';
const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
const CHATGPT_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
const b64url = buffer => Buffer.from(buffer).toString('base64url');
const RELOGIN = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

async function tokenRequest(fields, timeoutMs = 20000) {
  let response;
  try {
    response = await fetch(CHATGPT_AUTH() + '/api/accounts/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new HttpError(502, 'ChatGPT 로그인 서버에 연결하지 못했습니다.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new HttpError(response.status === 400 || response.status === 401 ? 401 : 502, 'ChatGPT 로그인이 만료되었습니다. PC에서 login-chatgpt를 다시 실행하세요.'), { code: data?.error });
  return data;
}

/** Signature, issuer, audience, expiry and nonce of the ID token, against OpenAI's published keys. Returns the claims. */
export async function verifyIdToken(idToken, { clientId, nonce, now = Date.now() }) {
  const [head, body, sig] = String(idToken ?? '').split('.');
  if (!head || !body || !sig) throw new Error('ID 토큰 형식이 올바르지 않습니다.');
  const header = JSON.parse(Buffer.from(head, 'base64url')), claims = JSON.parse(Buffer.from(body, 'base64url'));
  if (header.alg !== 'RS256') throw new Error('지원하지 않는 ID 토큰 서명 방식입니다.');
  const discovery = await (await fetch(CHATGPT_AUTH() + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(10000) })).json();
  const { keys = [] } = await (await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(10000) })).json();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('ID 토큰 서명 키를 찾지 못했습니다.');
  if (!verifySignature('RSA-SHA256', Buffer.from(head + '.' + body), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'))) throw new Error('ID 토큰 서명이 올바르지 않습니다.');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== discovery.issuer || !audience.includes(clientId) || claims.exp * 1000 < now - 60000 || (nonce && claims.nonce !== nonce)) throw new Error('ID 토큰 확인에 실패했습니다.');
  return claims;
}

function openBrowser(url) {
  // No shell: rundll32 keeps the '&' in the URL intact on Windows, where `start` would split it.
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch { /* the URL is printed too */ }
}

/**
 * Browser sign-in with PKCE and a 127.0.0.1 loopback callback. First run registers this host (dynamic_agent_client) and
 * keeps the issued client_id; later runs reuse it. Saves tokens into config.chatgpt via save().
 */
export async function chatgptLogin(config, save, { print = console.log, browser = openBrowser, port = 1455, waitMs = 5 * 60000 } = {}) {
  const state0 = config.chatgpt ?? {};
  const hostId = state0.hostId || 'urn:uuid:' + randomUUID();
  const registered = !!state0.clientId;
  const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(16)), nonce = b64url(randomBytes(16));
  const server = createServer();
  const listenOn = p => new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', () => resolve(server.address().port)); });
  // The first registration uses the documented 1455; a returning sign-in may use any free port.
  const bound = await listenOn(port).catch(error => (registered && error?.code === 'EADDRINUSE' ? listenOn(0) : Promise.reject(new Error(`127.0.0.1:${port}을 열지 못했습니다. 이 포트를 쓰는 프로그램을 닫고 다시 시도하세요.`))));
  const redirectUri = `http://127.0.0.1:${bound}/auth/callback`;
  const query = new URLSearchParams({ client_id: registered ? state0.clientId : 'dynamic_agent_client', response_type: 'code', redirect_uri: redirectUri, scope: CHATGPT_SCOPE,
    resource: CHATGPT_RESOURCE, state, nonce, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ext_agent_host_id: hostId,
    ...(registered ? (state0.idToken ? { id_token_hint: state0.idToken } : {}) : { agent_name_hint: 'Atria' }) });
  const url = `${CHATGPT_AUTH()}/api/accounts/authorize?${query}`;
  const callback = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('로그인 대기 시간이 지났습니다. 다시 실행하세요.')), waitMs);
    server.on('request', (req, res) => {
      const at = new URL(req.url, redirectUri);
      if (at.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
      const p = at.searchParams;
      const ok = p.get('state') === state && !p.get('error') && p.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${ok ? 'Atria 브리지에 ChatGPT 계정을 연결했어요. 이 창을 닫아도 돼요.' : '연결하지 못했어요. 터미널의 안내를 확인하세요.'}</body>`);
      clearTimeout(timer);
      if (p.get('state') !== state) return reject(new Error('로그인 응답의 state가 다릅니다. 다시 실행하세요.'));
      if (p.get('error')) return reject(new Error(p.get('error') === 'access_denied' ? '로그인을 취소했습니다.' : `로그인하지 못했습니다 (${p.get('error')}).`));
      resolve({ code: p.get('code'), clientId: p.get('client_id') });
    });
  });
  print('브라우저에서 ChatGPT로 계속하기를 진행하세요. 창이 열리지 않으면 아래 주소를 이 PC의 브라우저에 붙여 넣으세요.\n' + url);
  browser(url);
  let clientId = state0.clientId;
  try {
    const { code, clientId: issued } = await callback;
    if (!registered && !issued) throw new Error('ChatGPT가 이 브리지를 등록하지 않았습니다. 다시 실행하세요.');
    if (registered && issued && issued !== state0.clientId) throw new Error('다른 등록 정보로 돌아왔습니다. 다시 실행하세요.');
    clientId = registered ? state0.clientId : issued;
    const token = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: CHATGPT_RESOURCE });
    const claims = await verifyIdToken(token.id_token, { clientId, nonce });
    const scopes = String(token.scope ?? '').split(/[\s+]+/).filter(Boolean);
    config.chatgpt = { hostId, clientId, sub: claims.sub, email: claims.email ?? '', idToken: token.id_token, accessToken: token.access_token,
      refreshToken: token.refresh_token ?? '', expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000, scopes, planUsage: scopes.includes('chatgpt.tokens.use.direct') };
    save(config);
    return config.chatgpt;
  } catch (error) {
    // Keep the host id and an issued client id even when the sign-in fails, so the next attempt reuses the registration.
    config.chatgpt = { ...state0, hostId, ...(clientId ? { clientId } : {}) };
    save(config);
    throw error;
  } finally { server.close(); }
}

/** Revokes the refresh token and forgets the tokens. The host id and issued client id stay for the next sign-in. */
export async function chatgptLogout(config, save) {
  const s = config.chatgpt ?? {};
  if (s.refreshToken && s.clientId) {
    try {
      const discovery = await (await fetch(CHATGPT_AUTH() + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(10000) })).json();
      if (discovery.revocation_endpoint) await fetch(discovery.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: s.refreshToken, token_type_hint: 'refresh_token', client_id: s.clientId }).toString(), signal: AbortSignal.timeout(10000) });
    } catch { /* forgotten locally either way */ }
  }
  config.chatgpt = { hostId: s.hostId, clientId: s.clientId };
  save(config);
}

let refreshing = null; // one refresh at a time: the refresh token rotates on every use
async function chatgptToken(config, save) {
  const s = config.chatgpt;
  if (!s?.accessToken) throw new HttpError(404, '사용할 수 없는 모델입니다.');
  if (!s.planUsage) throw new HttpError(403, 'ChatGPT 플랜 사용 권한이 허락되지 않았습니다. PC에서 login-chatgpt를 다시 실행하세요.');
  if (s.expiresAt - Date.now() > 120000) return s.accessToken;
  refreshing ??= (async () => {
    try {
      const token = await tokenRequest({ grant_type: 'refresh_token', client_id: s.clientId, refresh_token: s.refreshToken, resource: CHATGPT_RESOURCE });
      Object.assign(s, { accessToken: token.access_token, refreshToken: token.refresh_token ?? s.refreshToken, expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
        ...(token.scope ? { scopes: String(token.scope).split(/[\s+]+/).filter(Boolean) } : {}) });
      s.planUsage = s.scopes.includes('chatgpt.tokens.use.direct');
      save(config);
    } catch (error) {
      if (RELOGIN.has(error?.code)) { Object.assign(s, { accessToken: '', refreshToken: '', planUsage: false }); save(config); }
      throw error;
    } finally { refreshing = null; }
  })();
  await refreshing;
  return s.accessToken;
}

const USAGE_MESSAGES = {
  subscription_sharing_usage_limit_exceeded: `ChatGPT 플랜 사용량 한도에 도달했습니다. 사용량 관리: ${CHATGPT_USAGE_URL}`,
  subscription_sharing_usage_unavailable: 'ChatGPT 플랜 사용량을 지금 쓸 수 없습니다. 잠시 뒤 다시 시도하세요.',
  subscription_sharing_user_not_eligible: 'ChatGPT 플랜(Go, Plus, Pro, Business)에서만 사용할 수 있습니다.',
};

async function chatgptModels(config, save, timeoutMs) {
  const token = await chatgptToken(config, save);
  const data = await upstream(CHATGPT_API() + '/models', { headers: { authorization: 'Bearer ' + token } }, timeoutMs);
  return (Array.isArray(data?.models) ? data.models : []).filter(m => m?.visibility === 'list' && typeof m.slug === 'string').map(m => m.slug);
}

/** One reply through the Responses API (stream: true, store: false), read from server-sent events. */
export async function chatgptChat(config, save, name, req, timeoutMs) {
  const token = await chatgptToken(config, save);
  const { system, turns } = splitSystem(req.messages);
  let response;
  try {
    response = await fetch(CHATGPT_API() + '/responses', { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, ...(system ? { instructions: system } : {}), input: turns.map(m => ({ role: m.role, content: m.content })), store: false, stream: true }) });
  } catch (error) { throw new HttpError(error?.name === 'TimeoutError' ? 504 : 502, 'ChatGPT에 연결하지 못했습니다.'); }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new HttpError(response.status === 429 ? 429 : 502, USAGE_MESSAGES[data?.error?.code] ?? `ChatGPT 요청이 실패했습니다 (${response.status}).`);
  }
  let text = '', buffer = '', finished = false;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
      const dataLine = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (!dataLine || dataLine === '[DONE]') continue;
      let event; try { event = JSON.parse(dataLine); } catch { continue; }
      if (event.type === 'response.output_text.delta') text += event.delta ?? '';
      else if (event.type === 'response.completed') finished = true;
      else if (event.type === 'response.failed' || event.type === 'error') {
        const codeName = event.response?.error?.code ?? event.error?.code ?? event.code;
        throw new HttpError(codeName === 'subscription_sharing_usage_limit_exceeded' ? 429 : 502, USAGE_MESSAGES[codeName] ?? 'ChatGPT가 답을 끝내지 못했습니다.');
      } else if (event.type === 'response.incomplete') throw new HttpError(502, 'ChatGPT 답이 중간에 끊겼습니다.');
    }
  }
  if (!finished) throw new HttpError(502, 'ChatGPT 답이 끝나기 전에 연결이 끊겼습니다.');
  return text;
}

const digest = value => createHash('sha256').update(String(value)).digest();
const sameKey = (given, key) => !!key && timingSafeEqual(digest(given), digest(key));

/** The HTTP server. log receives one line per request: time, method, path, model, status, ms. Never prompts, replies or keys. */
export function createBridge(config, { log = console.log, timeoutMs = TIMEOUT_MS, plugins = [], save = () => saveConfig(config) } = {}) {
  if (!config.key) throw new Error('연결 키가 없습니다. 먼저 init을 실행하세요.');
  const server = createServer((req, res) => {
    const started = Date.now();
    let model = '-';
    const send = (status, body) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
      log(`${new Date().toISOString()} ${req.method} ${req.url.split('?')[0]} ${model} ${status} ${Date.now() - started}ms`);
    };
    const fail = error => send(error instanceof HttpError ? error.status : 500, { error: { message: error instanceof HttpError ? error.message : '브리지 내부 오류입니다.' } });
    if (req.method === 'OPTIONS') return send(204);
    const path = req.url.split('?')[0];
    if (!path.startsWith('/v1/')) return send(404, { error: { message: '없는 경로입니다.' } });
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!auth || !sameKey(auth[1], config.key)) { req.resume(); return send(401, { error: { message: '연결 키가 올바르지 않습니다.' } }); }
    if (req.method === 'GET' && path === '/v1/models') {
      return sources(config, timeoutMs, plugins, save).then(({ models: list }) => send(200, { object: 'list', data: list.map(m => ({ id: m.id, object: 'model', owned_by: m.owned_by })) }), fail);
    }
    if (req.method !== 'POST' || path !== '/v1/chat/completions') return send(404, { error: { message: '없는 경로입니다.' } });
    let size = 0, chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size <= MAX_BODY_BYTES) chunks.push(chunk); else chunks = null; });
    req.on('end', async () => {
      // Oversized bodies are drained, not buffered, so the client always receives the 413.
      if (size > MAX_BODY_BYTES) return send(413, { error: { message: '요청 본문은 256KB까지 받을 수 있습니다.' } });
      try {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON 본문이 올바르지 않습니다.'); }
        const request = readRequest(body);
        model = request.model;
        const content = await complete(config, request, timeoutMs, plugins, save);
        send(200, { id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      } catch (error) { fail(error); }
    });
  });
  server.requestTimeout = timeoutMs + 10000;
  return server;
}
