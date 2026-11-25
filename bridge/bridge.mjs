// Stella bridge core: one OpenAI-compatible API over the AI this machine can reach. Node 20+, standard library only.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

// The single executable has no package.json beside it; build.mjs writes the version in place of this line.
export const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
export const MAX_BODY_BYTES = 256 * 1024;
export const TIMEOUT_MS = 120000;
export const configPath = () => process.env.STELLA_BRIDGE_CONFIG || join(homedir(), '.stella-bridge', 'config.json');
export const newKey = () => randomBytes(32).toString('base64url');

export const DEFAULT_CONFIG = Object.freeze({
  key: '', host: '0.0.0.0', port: 8787,
  // Local servers are probed on every model list; one that does not answer is left out.
  local: { ollama: 'http://127.0.0.1:11434/v1', lmstudio: 'http://127.0.0.1:1234/v1' },
  // API providers appear only after `add-key`. models: the IDs shown in the list (any name after the prefix is accepted).
  providers: {},
  cli: { claude: { enabled: false }, codex: { enabled: false } },
});
export const PROVIDER_DEFAULTS = Object.freeze({
  openai: { type: 'openai', base: 'https://api.openai.com/v1', models: ['gpt-6.1-terra'] },
  anthropic: { type: 'anthropic', base: 'https://api.anthropic.com/v1', models: ['claude-sonnet-5-5'] },
  gemini: { type: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash'] },
});

export function loadConfig(file = configPath()) {
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return { ...structuredClone(DEFAULT_CONFIG), ...saved, cli: { ...structuredClone(DEFAULT_CONFIG.cli), ...saved.cli } };
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
const inSea = (await import('node:sea').catch(() => null))?.isSea?.() ?? false;
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
export async function sources(config, timeoutMs = TIMEOUT_MS) {
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
  return { models, status };
}

async function complete(config, req, timeoutMs) {
  const cut = req.model.indexOf('/'), prefix = req.model.slice(0, cut), name = req.model.slice(cut + 1);
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

const digest = value => createHash('sha256').update(String(value)).digest();
const sameKey = (given, key) => !!key && timingSafeEqual(digest(given), digest(key));

/** The HTTP server. log receives one line per request: time, method, path, model, status, ms. Never prompts, replies or keys. */
export function createBridge(config, { log = console.log, timeoutMs = TIMEOUT_MS } = {}) {
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
      return sources(config, timeoutMs).then(({ models: list }) => send(200, { object: 'list', data: list.map(m => ({ id: m.id, object: 'model', owned_by: m.owned_by })) }), fail);
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
        const content = await complete(config, request, timeoutMs);
        send(200, { id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      } catch (error) { fail(error); }
    });
  });
  server.requestTimeout = timeoutMs + 10000;
  return server;
}
