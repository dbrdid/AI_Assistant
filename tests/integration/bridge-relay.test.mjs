// 앱(@noble/ciphers)과 브리지(WebCrypto)의 중계 규약이 서로 맞는지, 위조·재전송·오래된 요청을 버리는지
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRelayFetch, relayKeys as appKeys, seal as appSeal } from '../../frontend/Frontend_UI/src/integration/bridgeRelay.mjs';
import { handleRelayRequest, relayKeys as bridgeKeys } from '../../bridge/relay.mjs';

const digest = async bytes => new Uint8Array(createHash('sha256').update(bytes).digest());
const KEY = randomBytes(32).toString('base64url');

// 메모리 안의 실시간 채널: 같은 topic끼리 이벤트를 주고받음
function bus() {
  const subs = new Map();
  const openChannel = topic => ({
    ready: Promise.resolve(),
    on: (event, cb) => subs.set(topic + '|' + event, cb),
    send: (event, payload) => setTimeout(() => subs.get(topic + '|' + event)?.(payload)),
    close() {},
  });
  return { openChannel, subs };
}

test('app and bridge derive the same channel and talk end to end', async () => {
  const a = await appKeys(KEY, digest), b = await bridgeKeys(KEY);
  assert.equal(a.topic, b.topic);
  const { openChannel } = bus();
  const seen = new Set();
  const calls = [];
  const localFetch = async (path, init) => { calls.push([path, init.method, init.body]); return { status: 200, text: async () => JSON.stringify({ path, ok: true }) }; };
  // 브리지 쪽: 같은 채널의 req를 받아 res로 돌려줌
  const bridgeSide = openChannel(b.topic);
  bridgeSide.on('req', async msg => { const reply = await handleRelayRequest(b, msg, { localFetch, seen }); if (reply) bridgeSide.send('res', reply); });
  const relayFetch = createRelayFetch({ key: KEY, digest, randomBytes: n => new Uint8Array(randomBytes(n)), openChannel, newId: randomUUID });
  const res = await relayFetch('http://192.168.0.9:8787/v1/chat/completions', { method: 'POST', body: '{"model":"m"}' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: '/v1/chat/completions', ok: true });
  assert.deepEqual(calls, [['/v1/chat/completions', 'POST', '{"model":"m"}']]);
  const models = await relayFetch('http://192.168.0.9:8787/v1/models');
  assert.equal(models.ok, true);
});

test('an account bridge address always uses the relay and fetches its key when the app has none', async () => {
  const gw = await import('../../frontend/Frontend_UI/src/integration/aiGateway.mjs');
  const id = '11111111-2222-3333-4444-555555555555';
  const asked = [], direct = [];
  gw.setRelayFactory(key => async url => { asked.push([key, url]); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'pc-model' }] }) }; });
  gw.setBridgeResolver(async bridgeId => (bridgeId === id ? 'K'.repeat(43) : null));
  gw.setSessionKey('server', '');
  const models = await gw.listServerModels({ serverUrl: gw.accountBridgeUrl(id) }, { fetchImpl: async url => { direct.push(url); throw new Error('no'); } });
  assert.deepEqual(models, ['pc-model']);
  assert.deepEqual(direct, [], '주소로 직접 시도하지 않음');
  assert.equal(asked[0][0], 'K'.repeat(43));
  assert.equal(gw.accountBridgeId('http://' + id + '.atria-bridge'), id);
  gw.setRelayFactory(null); gw.setBridgeResolver(null); gw.setSessionKey('server', '');
});

test('bridge drops forged, replayed, stale and unknown-path requests', async () => {
  const b = await bridgeKeys(KEY), a = await appKeys(KEY, digest);
  const localFetch = async () => ({ status: 200, text: async () => '{}' });
  const rnd = n => new Uint8Array(randomBytes(n));
  const fresh = { id: 'r1', ...appSeal(a.aes, { method: 'GET', path: '/v1/models', at: Date.now() }, rnd) };
  const seen = new Set();
  assert.ok(await handleRelayRequest(b, fresh, { localFetch, seen }));
  assert.equal(await handleRelayRequest(b, fresh, { localFetch, seen }), null, '같은 id 재전송');
  const other = await appKeys('another-key', digest);
  assert.equal(await handleRelayRequest(b, { id: 'r2', ...appSeal(other.aes, { method: 'GET', path: '/v1/models', at: Date.now() }, rnd) }, { localFetch, seen }), null, '다른 키');
  assert.equal(await handleRelayRequest(b, { id: 'r3', ...appSeal(a.aes, { method: 'GET', path: '/v1/models', at: Date.now() - 120000 }, rnd) }, { localFetch, seen }), null, '2분 전 요청');
  const odd = await handleRelayRequest(b, { id: 'r4', ...appSeal(a.aes, { method: 'GET', path: '/admin', at: Date.now() }, rnd) }, { localFetch, seen });
  assert.ok(odd, '허용하지 않은 경로는 404로 답함');
});
