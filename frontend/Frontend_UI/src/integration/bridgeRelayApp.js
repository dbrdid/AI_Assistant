// 앱에서 중계 연결을 켠다: Supabase 실시간 채널(공개 broadcast)과 expo-crypto를 bridgeRelay.mjs에 이어 준다.
// 이 파일을 불러오면 aiGateway가 내 서버에 직접 닿지 않을 때 중계로 보낸다.
import * as Crypto from 'expo-crypto';
import { supabase } from '../lib/stella/supabase';
import { createRelayFetch } from './bridgeRelay.mjs';
import { setBridgeResolver, setRelayFactory } from './aiGateway.mjs';

function openChannel(topic) {
  const channel = supabase.channel(topic, { config: { broadcast: { self: false, ack: false } } });
  let subscribed = null;
  return {
    // 이벤트를 먼저 등록한 뒤 구독해야 하므로 ready를 처음 볼 때 구독한다
    get ready() {
      subscribed ??= new Promise((resolve, reject) => channel.subscribe(status => {
        if (status === 'SUBSCRIBED') resolve();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error('중계 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'));
      }));
      return subscribed;
    },
    on: (event, cb) => channel.on('broadcast', { event }, ({ payload }) => cb(payload)),
    send: (event, payload) => channel.send({ type: 'broadcast', event, payload }),
    close: () => { supabase.removeChannel(channel); },
  };
}

setRelayFactory(key => createRelayFetch({
  key,
  digest: async bytes => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)),
  randomBytes: n => Crypto.getRandomBytes(n),
  newId: () => Crypto.randomUUID(),
  openChannel,
}));

// 같은 계정에 로그인된 PC 브리지 (atria-bridge login으로 등록). 연결 키는 계정 주인만 받는다.
export async function myBridges() {
  const { data, error } = await supabase.rpc('my_bridges');
  if (error) throw new Error(error.message?.replace(/^[A-Z_]+:\s*/, '') || '브리지 목록을 불러오지 못했습니다.');
  return Array.isArray(data) ? data : [];
}
export async function approveBridgeLogin(code) {
  const { error } = await supabase.rpc('bridge_login_approve', { p_code: code });
  if (error) throw new Error(error.message?.replace(/^[A-Z_]+:\s*/, '') || '승인하지 못했습니다.');
}
export async function revokeBridge(id) {
  const { error } = await supabase.rpc('revoke_bridge', { p_bridge_id: id });
  if (error) throw new Error(error.message?.replace(/^[A-Z_]+:\s*/, '') || '로그아웃하지 못했습니다.');
}
setBridgeResolver(async id => (await myBridges().catch(() => [])).find(b => b.id === id)?.relay_key ?? null);
