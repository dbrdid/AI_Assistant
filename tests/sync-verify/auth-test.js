#!/usr/bin/env node
// 이메일+비밀번호 가입 → 메일 6자리 코드 인증 → 로그인, 비밀번호 재설정을 실제 서버에서 확인
//   가입:   node auth-test.js signup <이메일> <비밀번호> [이름]
//   재설정: node auth-test.js reset  <이메일> <새 비밀번호>
//   (앱 연결 모듈 auth.ts와 같은 Supabase 호출을 씁니다. .env의 SUPABASE_URL·SUPABASE_KEY 사용)
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { createClient } = require('@supabase/supabase-js');

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const cfg = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };
const URL = cfg.SUPABASE_URL || 'https://zcblwwcukkbcwmgugknl.supabase.co';
const KEY = cfg.SUPABASE_KEY || 'sb_publishable_mgBnoYrbmRRkhtykoMKEwg_mrf_sGvT';

const [mode, email, password, name] = process.argv.slice(2);
if (!['signup', 'reset'].includes(mode) || !email || !password) {
  console.log('사용법:\n  node auth-test.js signup <이메일> <비밀번호> [이름]\n  node auth-test.js reset  <이메일> <새 비밀번호>');
  console.log('\n팁: Gmail은 주소 뒤에 +아무거나 를 붙여도 같은 메일함으로 와요 (예: me+t1@gmail.com) → 테스트 계정을 여러 개 만들 수 있어요');
  process.exit(2);
}

const sb = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let fails = 0;
const check = (name, pass, detail) => {
  if (!pass) fails++;
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? `  (${detail})` : ''}`);
};

/** 코드 입력 → 확인. 틀리면 다시, r 입력 시 재전송 */
async function askCode(c, type, resend) {
  for (let i = 0; i < 5; i++) {
    const ans = (await rl.question('  메일로 받은 6자리 코드 (다시 보내기: r) > ')).trim();
    if (ans.toLowerCase() === 'r') {
      const { error } = await resend();
      console.log(error ? `    재전송 실패: ${error.code ?? ''} ${error.message}` : '    다시 보냈어요');
      continue;
    }
    const token = ans.replace(/\D/g, '');
    const { data, error } = await c.auth.verifyOtp({ email, token, type });
    if (!error && data.session) return { data, digits: token.length };
    console.log(`    확인 실패: ${error?.code ?? ''} ${error?.message ?? '세션 없음'}`);
  }
  return null;
}

async function signup() {
  console.log(`\n■ 가입: ${email}`);
  const c = sb();
  const { data, error } = await c.auth.signUp({
    email, password, options: { data: { display_name: name ?? '테스트', affiliation: null } },
  });
  if (error) {
    check('가입 요청', false, `${error.code ?? ''} ${error.message}`);
    if (error.code === 'weak_password') console.log('    → 비밀번호 규칙(8자 이상, 영문+숫자)을 확인해 주세요');
    if (/fetch failed/.test(error.message)) console.log('    → 인터넷 연결이나 SUPABASE_URL을 확인해 주세요');
    return;
  }
  if (data.user && (data.user.identities?.length ?? 0) === 0) {
    check('가입 요청', false, '이미 가입된 이메일 (앱은 user_already_exists로 안내)');
    return;
  }
  check('가입 요청 → 인증 메일 발송', !data.session, data.session ? 'Confirm email이 꺼져 있어서 바로 로그인됨' : '인증 전 상태');

  const early = await sb().auth.signInWithPassword({ email, password });
  check('인증 전 로그인 시도 → 막힘 (email_not_confirmed)', early.error?.code === 'email_not_confirmed', early.error?.code ?? '로그인됨');

  const ok = await askCode(c, 'email', () => c.auth.resend({ type: 'signup', email }));
  if (!ok) { check('코드 인증', false, '5번 실패'); return; }
  check('6자리 코드로 이메일 인증 → 로그인 완료', true, `${ok.digits}자리, 인증 시각 ${ok.data.user?.email_confirmed_at ?? '-'}`);

  const { data: prof } = await c.from('profiles').select('display_name').eq('account_id', ok.data.user.id);
  check('가입 트리거가 프로필 생성', prof?.length === 1, `이름=${prof?.[0]?.display_name}`);

  const again = await sb().auth.signInWithPassword({ email, password });
  check('이후 이메일+비밀번호로 로그인', !again.error && !!again.data.session, again.error?.code);
  const wrong = await sb().auth.signInWithPassword({ email, password: `${password}x` });
  check('틀린 비밀번호 → invalid_credentials', wrong.error?.code === 'invalid_credentials', wrong.error?.code);
}

async function reset() {
  console.log(`\n■ 비밀번호 재설정: ${email}`);
  const c = sb();
  const { error } = await c.auth.resetPasswordForEmail(email);
  check('재설정 코드 메일 발송 요청', !error, error ? `${error.code ?? ''} ${error.message}` : '가입 안 된 주소여도 성공으로 보임(보안상)');
  if (error) return;
  const ok = await askCode(c, 'recovery', () => c.auth.resetPasswordForEmail(email));
  if (!ok) { check('재설정 코드 확인', false, '5번 실패'); return; }
  check('재설정 코드 확인 → 임시 로그인', true);
  const up = await c.auth.updateUser({ password });
  check('새 비밀번호 저장', !up.error, up.error ? `${up.error.code} ${up.error.message}` : '');
  if (up.error) return;
  const login = await sb().auth.signInWithPassword({ email, password });
  check('새 비밀번호로 로그인', !login.error, login.error?.code);
}

(async () => {
  console.log(`대상: ${URL}`);
  try {
    if (mode === 'signup') await signup(); else await reset();
  } catch (e) {
    fails++;
    console.error(`\n[중단] ${e.message}${/fetch failed/.test(e.message) ? ' → 인터넷 연결이나 SUPABASE_URL을 확인해 주세요' : ''}`);
  } finally {
    rl.close();
  }
  console.log(fails === 0 ? '\n결과: 모두 통과' : `\n결과: ${fails}개 실패`);
  process.exit(fails === 0 ? 0 : 1);
})();
