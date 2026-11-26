// 중계 연결: 같은 와이파이 밖의 Atria 앱이 이 브리지를 쓰게 한다.
// 브리지가 Supabase 실시간 채널에 바깥 방향으로 접속해 기다리므로 포트 열기·공유기 설정이 필요 없다.
// 규약은 앱의 src/integration/bridgeRelay.mjs와 같다 (채널·키 만드는 법, AES-256-GCM, req/res).
// 받은 요청은 이 PC의 브리지 API(127.0.0.1)로 그대로 넘기고, 답을 암호화해 돌려준다. 서버는 암호문만 본다.
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle, enc = new TextEncoder(), dec = new TextDecoder();
const toHex = bytes => Buffer.from(bytes).toString('hex');
const fromHex = hex => new Uint8Array(Buffer.from(String(hex), 'hex'));
const sha256 = async text => new Uint8Array(await subtle.digest('SHA-256', enc.encode(text)));

// Atria 앱이 쓰는 Supabase 프로젝트 (공개 주소와 공개 키: 앱에도 들어 있는 값)
export const RELAY_DEFAULTS = Object.freeze({
  url: 'https://zcblwwcukkbcwmgugknl.supabase.co',
  apikey: 'sb_publishable_mgBnoYrbmRRkhtykoMKEwg_mrf_sGvT',
});
export const MAX_AGE_MS = 60000;

export async function relayKeys(key) {
  const topic = toHex(await sha256('atria-relay/v1/topic:' + key)).slice(0, 32);
  const raw = await sha256('atria-relay/v1/key:' + key);
  return { topic: 'atria-relay-' + topic, aes: await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) };
}
export async function seal(aes, value) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  return { iv: toHex(iv), ct: toHex(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(JSON.stringify(value))))) };
}
export async function open(aes, message) {
  return JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: fromHex(message.iv) }, aes, fromHex(message.ct))));
}

/** 요청 하나 처리 → 보낼 응답 { id, iv, ct } 또는 버릴 것이면 null (위조·오래됨·재전송) */
export async function handleRelayRequest(keys, message, { localFetch, seen, now = Date.now }) {
  if (!message?.id || seen.has(message.id)) return null;
  let req;
  try { req = await open(keys.aes, message); } catch { return null; }   // 키가 다른 요청: 조용히 버림
  if (!Number.isFinite(req.at) || Math.abs(now() - req.at) > MAX_AGE_MS) return null;
  seen.add(message.id);
  if (seen.size > 500) seen.delete(seen.values().next().value);
  if (!/^\/(v1\/)?(models|chat\/completions)$/.test(req.path ?? '')) return { id: message.id, ...(await seal(keys.aes, { status: 404, body: '{"error":"not found"}' })) };
  let status = 502, body = '{"error":"bridge unavailable"}';
  try {
    const res = await localFetch(req.path, { method: req.method === 'POST' ? 'POST' : 'GET', body: req.method === 'POST' ? req.body : undefined });
    status = res.status; body = await res.text();
  } catch { /* 위 502 */ }
  return { id: message.id, ...(await seal(keys.aes, { status, body })) };
}

/** Supabase 실시간(Phoenix) 채널에 붙어 요청을 기다린다. 끊기면 다시 붙는다. Node 22 이상(내장 WebSocket). */
export function startRelay({ key, port, url = RELAY_DEFAULTS.url, apikey = RELAY_DEFAULTS.apikey, log = console.log, WebSocketImpl = globalThis.WebSocket }) {
  if (!WebSocketImpl) { log('중계 연결은 Node 22 이상에서 켜집니다. 지금은 같은 네트워크에서만 접속할 수 있어요.'); return { stop() {} }; }
  const seen = new Set();
  const localFetch = (path, init) => fetch(`http://127.0.0.1:${port}${path.startsWith('/v1') ? path : '/v1' + path}`, {
    ...init, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
  });
  let ws = null, ref = 0, beat = null, stopped = false, keysP = relayKeys(key), announced = false;
  const send = (topic, event, payload) => ws?.readyState === 1 && ws.send(JSON.stringify({ topic, event, payload, ref: String(++ref) }));
  const connect = async () => {
    const keys = await keysP, topic = 'realtime:' + keys.topic;
    ws = new WebSocketImpl(`${url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(apikey)}&vsn=1.0.0`);
    ws.onopen = () => {
      send(topic, 'phx_join', { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false } });
      beat = setInterval(() => send('phoenix', 'heartbeat', {}), 25000);
    };
    ws.onmessage = async ({ data }) => {
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.event === 'phx_reply' && msg.topic === topic && !announced) {
        announced = msg.payload?.status === 'ok';
        log(announced ? '  중계 연결: 켜짐 (같은 와이파이 밖에서도 같은 연결 문자열로 접속)' : '  중계 연결: 실패 (' + JSON.stringify(msg.payload?.response ?? '') + ')');
      }
      if (msg.event !== 'broadcast' || msg.payload?.event !== 'req') return;
      const reply = await handleRelayRequest(keys, msg.payload.payload, { localFetch, seen });
      if (reply) send(topic, 'broadcast', { type: 'broadcast', event: 'res', payload: reply });
    };
    ws.onclose = () => { clearInterval(beat); announced = false; if (!stopped) setTimeout(connect, 3000); };
    ws.onerror = () => {};
  };
  connect();
  return { stop() { stopped = true; clearInterval(beat); ws?.close(); } };
}
