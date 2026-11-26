// 내 PC 브리지 중계 연결 (같은 와이파이 밖에서도): 앱 ↔ Supabase 실시간 채널 ↔ PC 브리지
//
// 브리지 연결 문자열의 키 하나로 채널 이름과 암호 키를 만든다 (연결 문자열 형식은 그대로).
//   채널: 'atria-relay-' + SHA-256('atria-relay/v1/topic:' + 키)의 앞 32자리(hex)
//   암호: AES-256-GCM, 키 = SHA-256('atria-relay/v1/key:' + 키), 12바이트 무작위 iv, 태그는 암호문 끝 (WebCrypto와 같음)
// 요청 'req' { id, iv, ct } → 평문 { method, path, body, at }   응답 'res' { id, iv, ct } → 평문 { status, body }
// 서버(Supabase)는 암호문만 전달하므로 내용을 볼 수 없다. 브리지는 오래된(60초) 요청과 같은 id를 다시 받지 않는다.
// 같은 규약이 bridge/relay.mjs에 있다 (WebCrypto). 둘이 맞는지는 tests/integration/bridge-relay.test.mjs가 확인한다.
import { gcm } from '@noble/ciphers/aes';

const enc = new TextEncoder(), dec = new TextDecoder();
export const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const fromHex = hex => Uint8Array.from(String(hex).match(/../g) ?? [], h => parseInt(h, 16));

/** digest: (bytes) => Promise<Uint8Array> SHA-256 */
export async function relayKeys(key, digest) {
  const topic = toHex(new Uint8Array(await digest(enc.encode('atria-relay/v1/topic:' + key)))).slice(0, 32);
  const aes = new Uint8Array(await digest(enc.encode('atria-relay/v1/key:' + key)));
  return { topic: 'atria-relay-' + topic, aes };
}
export function seal(aes, value, randomBytes) {
  const iv = randomBytes(12);
  return { iv: toHex(iv), ct: toHex(gcm(aes, iv).encrypt(enc.encode(JSON.stringify(value)))) };
}
export function open(aes, message) {
  return JSON.parse(dec.decode(gcm(aes, fromHex(message.iv)).decrypt(fromHex(message.ct))));
}

/**
 * fetch처럼 쓰는 중계 요청. openChannel(topic) → { ready: Promise, send(event, payload), on(event, cb), close() }
 * 반환값은 fetch Response의 필요한 부분 { ok, status, json(), text() }.
 */
export function createRelayFetch({ key, digest, randomBytes, openChannel, newId, now = Date.now, timeoutMs = 120000 }) {
  let session = null;   // { keys, channel, waiting: Map(id → resolve) }
  async function connect() {
    if (session) return session;
    const keys = await relayKeys(key, digest);
    const channel = openChannel(keys.topic);
    const waiting = new Map();
    channel.on('res', message => {
      const done = waiting.get(message?.id);
      if (!done) return;
      try { done.resolve(open(keys.aes, message)); } catch { done.reject(new Error('브리지 응답을 풀지 못했습니다. 연결 키를 확인해 주세요.')); }
      waiting.delete(message.id);
    });
    session = { keys, channel, waiting };
    try { await channel.ready; } catch (error) { session = null; channel.close(); throw error; }
    return session;
  }
  const relayFetch = async (url, init = {}) => {
    const { keys, channel, waiting } = await connect();
    const id = newId();
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('브리지가 응답하지 않습니다. PC에서 브리지가 켜져 있는지 확인해 주세요.')); }, timeoutMs);
      const finish = fn => value => { clearTimeout(timer); fn(value); };
      waiting.set(id, { resolve: finish(resolve), reject: finish(reject) });
      init.signal?.addEventListener?.('abort', () => { waiting.delete(id); finish(reject)(Object.assign(new Error('작업이 취소되었습니다.'), { name: 'AbortError' })); });
    });
    channel.send('req', { id, ...seal(keys.aes, { method: init.method ?? 'GET', path, body: init.body ?? null, at: now() }, randomBytes) });
    const res = await reply;
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text: async () => res.body ?? '', json: async () => JSON.parse(res.body ?? 'null') };
  };
  relayFetch.close = () => { session?.channel.close(); session = null; };
  return relayFetch;
}
