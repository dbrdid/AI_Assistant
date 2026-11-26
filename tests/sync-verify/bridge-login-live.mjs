// 브리지 로그인 왕복 확인 (테스트 서버 권장, .env의 A 계정 사용)
//   node bridge-login-live.mjs
// 브리지: 코드 받기 → 앱(A): 코드 승인 → 브리지: 토큰 받기 → 앱: my_bridges에 보임 → heartbeat → 앱이 로그아웃 → heartbeat 거절
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { bridgeLogin, heartbeat, rpc } from '../../bridge/account.mjs';

const env = Object.fromEntries(readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => /^\w+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const server = { url: env.SUPABASE_URL, apikey: env.SUPABASE_KEY };
const app = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, { auth: { persistSession: false } });
const { error: signErr } = await app.auth.signInWithPassword({ email: env.A_EMAIL, password: env.A_PASSWORD });
if (signErr) throw signErr;

const config = { key: randomBytes(32).toString('base64url') };
const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? '✔' : '✘'} ${name}${detail ? `  (${detail})` : ''}`);
const wrong = await app.rpc('bridge_login_approve', { p_code: 'ZZZZ-ZZZZ' });
ok('없는 코드는 승인 안 됨', !!wrong.error, wrong.error?.message);

let shown = '';
const login = bridgeLogin(config, { server, pollMs: 700, name: 'test-pc', log: m => { shown = /\n\s+([0-9A-Z]{4}-[0-9A-Z]{4})\n/.exec(m)?.[1] ?? shown; } });
for (let i = 0; i < 20 && !shown; i++) await new Promise(r => setTimeout(r, 200));
const approve = await app.rpc('bridge_login_approve', { p_code: shown.toLowerCase().replace('-', ' ') });
ok('PC에 뜬 코드를 앱에서 승인 (대소문자·띄어쓰기 무관)', !approve.error, approve.error?.message ?? shown);
config.account = await login;
ok('브리지가 토큰과 계정 이메일을 받음', !!config.account.token && config.account.email === env.A_EMAIL, config.account.email);
const mine = await app.rpc('my_bridges');
const found = (mine.data ?? []).find(b => b.id === config.account.bridgeId);
ok('같은 계정의 앱이 브리지를 찾고 연결 키를 받음', found?.relay_key === config.key && found?.name === 'test-pc');
ok('브리지 켜짐 알림(heartbeat)', (await heartbeat(config, server))?.status === 'OK');
const reuse = await rpc('bridge_login_approve', { p_code: shown }, server).catch(e => e);
ok('로그인 안 한 사람은 승인 불가', reuse instanceof Error, reuse?.message);
await app.rpc('revoke_bridge', { p_bridge_id: config.account.bridgeId });
const after = await heartbeat(config, server).catch(e => e);
ok('앱에서 로그아웃하면 브리지가 거절됨', after instanceof Error && /로그아웃/.test(after.message), after?.message);
const gone = ((await app.rpc('my_bridges')).data ?? []).some(b => b.id === config.account.bridgeId);
ok('로그아웃한 브리지는 목록에서 빠짐', !gone);
console.log(results.join('\n'));
process.exit(results.every(r => r.startsWith('✔')) ? 0 : 1);
