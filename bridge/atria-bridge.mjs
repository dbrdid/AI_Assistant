#!/usr/bin/env node
// Atria bridge: node atria-bridge.mjs <init|serve|list|add-key|enable-cli|disable-cli|plugins|enable-plugin|disable-plugin|rotate-key>
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import { PROVIDER_DEFAULTS, VERSION, configPath, createBridge, loadConfig, loadPlugins, newKey, pluginDir, resolveCli, saveConfig, sources } from './bridge.mjs';

const lanAddresses = () => Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
const link = config => `http://${lanAddresses()[0] ?? '127.0.0.1'}:${config.port}#key=${config.key}`;
const option = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
// Keys come from stdin so they never land in shell history. ponytail: a TTY echoes the key; add a muted prompt if that matters.
async function readSecret(label) {
  if (process.stdin.isTTY) process.stderr.write(label + ': ');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) { rl.close(); return line.trim(); }
  return '';
}
function done(message, code = 0) { (code ? console.error : console.log)(message); process.exit(code); }

const [command, ...args] = process.argv.slice(2);
if (command === '--version' || command === '-v') done(VERSION);
const config = loadConfig();
const file = configPath();
const plugins = ['serve', 'list', 'plugins', 'enable-plugin', 'disable-plugin'].includes(command) ? await loadPlugins(config, pluginDir(file)) : [];

if (command === 'init' || command === 'rotate-key') {
  if (command === 'init' && config.key) done(`이미 초기화되어 있습니다: ${file}\n키를 바꾸려면 rotate-key를 실행하세요.`, 1);
  config.key = newKey();
  saveConfig(config);
  console.log(`설정 파일: ${file}`);
  console.log('Atria 앱의 AI 연결 → 내 서버 → 서버 주소 칸에 아래 한 줄을 붙여 넣으세요. 이 문자열은 비밀번호처럼 다루세요.');
  done(link(config));
} else if (command === 'serve') {
  if (!config.key) done('연결 키가 없습니다. 먼저 init을 실행하세요.', 1);
  const host = option(args, '--host', config.host), port = Number(option(args, '--port', config.port));
  createBridge(config, { plugins }).listen(port, host, () => {
    console.log(`Atria 브리지 실행 중: ${host}:${port}`);
    for (const address of host === '0.0.0.0' ? lanAddresses() : [host]) console.log(`  같은 네트워크 접속 주소: http://${address}:${port}`);
    const on = plugins.filter(p => p.plugin && config.plugins[p.id]?.enabled).map(p => p.id);
    if (on.length) console.log(`  켜진 플러그인: ${on.join(', ')}`);
    console.log('외부에서 접속하려면 HTTPS 역방향 프록시나 Tailscale을 사용하세요. 포트를 인터넷에 그대로 열지 마세요.');
  });
} else if (command === 'list') {
  const { models, status } = await sources(config, undefined, plugins);
  for (const s of status) console.log(`${s.source.padEnd(12)} ${s.state}`);
  console.log(models.length ? '\n모델:\n' + models.map(m => '  ' + m.id).join('\n') : '\n사용할 수 있는 모델이 없습니다.');
} else if (command === 'add-key') {
  const [type, ...rest] = args;
  if (PROVIDER_DEFAULTS[type]) {
    const key = await readSecret(`${type} API 키`);
    if (!key) done('키가 비어 있습니다.', 1);
    config.providers[type] = { ...PROVIDER_DEFAULTS[type], ...(rest.length ? { models: rest } : {}), key };
  } else if (type === 'openai-compatible') {
    const [name, base] = rest;
    if (!/^[a-z0-9-]{1,32}$/.test(name ?? '') || name.endsWith('-cli') || PROVIDER_DEFAULTS[name] || config.local[name]) done('이름은 소문자·숫자·-로 짓고 기존 공급원과 겹치지 않게 하세요.', 1);
    try { if (!['http:', 'https:'].includes(new URL(base).protocol)) throw 0; } catch { done('주소는 http:// 또는 https://로 시작해야 합니다. 예: http://127.0.0.1:8000/v1', 1); }
    config.providers[name] = { type: 'compatible', base, key: await readSecret('키 (없으면 Enter)') };
  } else done('사용법: add-key <openai|anthropic|gemini> [모델...]  또는  add-key openai-compatible <이름> <주소>', 1);
  saveConfig(config);
  done('저장했습니다. list로 확인하세요.');
} else if (command === 'enable-cli') {
  const [name] = args;
  if (!config.cli[name]) done('사용법: enable-cli <claude|codex>', 1);
  if (!resolveCli(name, config.cli[name].command)) done(`${name} CLI를 찾지 못했습니다. 먼저 이 서버에 설치하고 로그인하세요.`, 1);
  config.cli[name].enabled = true;
  saveConfig(config);
  done(`${name}-cli/default를 켰습니다. 이 서버에 로그인한 구독은 서버 주인 본인만 사용하세요. 다른 사람과 공유하면 이용 약관 위반이 될 수 있습니다.`);
} else if (command === 'disable-cli') {
  for (const name of args.length ? args : Object.keys(config.cli)) if (config.cli[name]) config.cli[name].enabled = false;
  saveConfig(config);
  done('CLI 사용을 껐습니다.');
} else if (command === 'plugins') {
  console.log(`플러그인 폴더: ${pluginDir(file)}`);
  if (!plugins.length) done('설치된 플러그인이 없습니다. 이 폴더에 .mjs 파일을 넣으세요.');
  for (const p of plugins) console.log(`${p.id.padEnd(16)} ${p.error ? '오류: ' + p.error : config.plugins[p.id]?.enabled ? '켜짐' : '꺼짐'}  ${p.label}`);
} else if (command === 'enable-plugin' || command === 'disable-plugin') {
  const [id] = args;
  const found = plugins.find(p => p.id === id);
  if (!found) done(`플러그인 "${id ?? ''}"를 찾지 못했습니다. plugins로 목록을 확인하세요.`, 1);
  if (found.error) done(`이 플러그인은 불러오지 못했습니다: ${found.error}`, 1);
  const on = command === 'enable-plugin';
  config.plugins[id] = { ...config.plugins[id], enabled: on };
  saveConfig(config);
  done(on ? `${id} 플러그인을 켰습니다. 플러그인은 이 PC의 권한으로 실행되니 믿을 수 있는 파일만 켜세요. 서버를 다시 시작하면 적용됩니다.` : `${id} 플러그인을 껐습니다. 서버를 다시 시작하면 적용됩니다.`);
} else {
  done('사용법: atria-bridge <init | serve [--host 0.0.0.0] [--port 8787] | list | add-key ... | enable-cli <claude|codex> | disable-cli [이름] | plugins | enable-plugin <id> | disable-plugin <id> | rotate-key>', command ? 1 : 0);
}
