// 브리지 로그인: PC에 짧은 코드를 띄우고, 같은 계정으로 로그인한 Atria 앱에서 승인하면 이 브리지가 계정에 등록된다.
// 등록된 브리지는 같은 계정의 앱이 연결 문자열 없이 찾아 중계로 연결한다. 서버 함수: 20261126150000_bridge_login.sql
import * as accountCrypto from 'node:crypto';   // 묶음 실행 파일에서 다른 파일의 import 이름과 겹치지 않게 이름공간으로
import * as accountOs from 'node:os';
import { RELAY_DEFAULTS } from './relay.mjs';

const sha256hex = text => accountCrypto.createHash('sha256').update(text).digest('hex');

export async function rpc(name, args, { url = RELAY_DEFAULTS.url, apikey = RELAY_DEFAULTS.apikey, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey, 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(String(data?.message ?? `서버 요청이 실패했습니다 (${res.status})`).replace(/^[A-Z_]+:\s*/, ''));
  return data;
}

/** 로그인: 코드를 보여 주고 앱의 승인을 기다린다. 성공하면 { bridgeId, token, email } */
export async function bridgeLogin(config, { log = console.log, pollMs = 2000, name = accountOs.hostname(), server } = {}) {
  const secret = accountCrypto.randomBytes(32).toString('hex');
  const start = await rpc('bridge_login_start', { p_secret_hash: sha256hex(secret) }, server);
  log(`휴대폰 Atria 앱에서 같은 계정으로 로그인한 뒤, AI 연결 → 내 서버 → "PC 브리지 승인"에 아래 코드를 입력하세요.\n\n    ${start.code}\n\n10분 안에 승인해 주세요. 기다리는 중...`);
  const until = Date.parse(start.expires_at);
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, pollMs));
    let res;
    try { res = await rpc('bridge_login_finish', { p_id: start.id, p_secret: secret, p_name: name, p_relay_key: config.key }, server); }
    catch (error) {
      if (/없거나 만료/.test(error.message)) throw error;   // 코드가 사라짐: 다시 login
      continue;   // 잠깐 끊긴 네트워크: 만료 전까지 계속 기다림
    }
    if (res?.status === 'OK') return { bridgeId: res.bridge_id, token: res.token, email: res.email };
  }
  throw new Error('10분 안에 승인되지 않았습니다. 다시 login을 실행해 주세요.');
}

/** 켜져 있음을 알림 (연결 키가 바뀌었으면 서버에도 반영). 로그아웃된 브리지면 오류 */
export const heartbeat = (config, server) => rpc('bridge_heartbeat', { p_token: config.account.token, p_relay_key: config.key }, server);
