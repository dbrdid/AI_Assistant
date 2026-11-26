// 실제 Supabase 실시간 서버로 중계 연결 왕복 확인 (.env의 SUPABASE_URL·SUPABASE_KEY 사용, 테스트 서버 권장)
//   node relay-live.mjs
// 가짜 브리지 HTTP 서버(/v1/models) ← 브리지 중계(relay.mjs, WebSocket) ← Supabase 실시간 ← 앱 중계(bridgeRelay.mjs, supabase-js)
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { startRelay } from '../../bridge/relay.mjs';
import { createRelayFetch } from '../../frontend/Frontend_UI/src/integration/bridgeRelay.mjs';

const env = Object.fromEntries(readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => /^\w+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const KEY = randomBytes(32).toString('base64url');
const server = createServer((req, res) => {
  const ok = req.headers.authorization === 'Bearer ' + KEY && req.url === '/v1/models';
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok ? { data: [{ id: 'relay-test-model' }] } : { error: 'unauthorized' }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const logs = [];
const relay = startRelay({ key: KEY, port, url: env.SUPABASE_URL, apikey: env.SUPABASE_KEY, log: m => logs.push(m) });

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, { auth: { persistSession: false } });
const openChannel = topic => {
  const ch = supabase.channel(topic, { config: { broadcast: { self: false, ack: false } } });
  let sub = null;
  return {
    get ready() { return sub ??= new Promise((ok, no) => ch.subscribe(s => s === 'SUBSCRIBED' ? ok() : (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') && no(new Error(s)))); },
    on: (event, cb) => ch.on('broadcast', { event }, ({ payload }) => cb(payload)),
    send: (event, payload) => ch.send({ type: 'broadcast', event, payload }),
    close: () => supabase.removeChannel(ch),
  };
};
const relayFetch = createRelayFetch({
  key: KEY, openChannel, newId: randomUUID, timeoutMs: 20000,
  digest: async b => new Uint8Array(createHash('sha256').update(b).digest()), randomBytes: n => new Uint8Array(randomBytes(n)),
});

let result = 'FAIL';
try {
  await new Promise(r => setTimeout(r, 2500));   // 브리지가 채널에 들어갈 시간
  const started = Date.now();
  const res = await relayFetch('http://10.0.0.1:9/v1/models');
  const body = await res.json();
  result = res.status === 200 && body?.data?.[0]?.id === 'relay-test-model' ? `OK (${Date.now() - started}ms)` : `BAD ${res.status} ${JSON.stringify(body)}`;
} catch (e) { result = 'ERROR ' + e.message; }
console.log('bridge log:', logs.join(' | '));
console.log('relay round trip:', result);
relay.stop(); relayFetch.close(); server.close(); await supabase.removeAllChannels(); process.exit(result.startsWith('OK') ? 0 : 1);
