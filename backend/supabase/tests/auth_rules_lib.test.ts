// 앱 모듈 login-rules.ts · auth.ts · invites.ts ↔ 프론트 화면 규칙 (2026-11-15 결정: 프론트 기준으로 맞춤)
//   실행: deno test -A --no-check --config deno.auth.test.json auth_rules_lib.test.ts
//   - 비밀번호 규칙이 프론트 AuthApi.checkPasswordRule과 같은 결과인지 (같은 입력 40개)
//   - 5회 실패 → 10분 잠금 → 풀린 뒤 다시 셈 → 성공·재설정이면 풀림 (프론트 AuthApi.login과 같은 동작)
//   - 진짜 auth.ts를 가짜 Supabase Auth 서버에 대고: 틀린 비밀번호만 세고, 규칙 위반은 서버에 보내지 않음
//   - 역할 이름: 관리자 = OWNER, 멤버 = EDITOR
import nodeAssert from 'node:assert/strict';
const assert = (v: unknown, msg?: string) => nodeAssert.ok(v, msg);
const assertEquals = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepStrictEqual(a, b, msg);
async function assertRejects(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); } catch (e) { return e; }
  throw new Error('오류가 나야 하는데 성공함');
}

const LIB = '../../../frontend/Frontend_UI/src/lib/stella';
const R = await import(`${LIB}/login-rules.ts`);

// 프론트 src/services/auth/AuthApi.js 의 규칙 그대로 (비교 기준)
function frontCheckPasswordRule(pw: unknown) {
  const s = String(pw || '');
  return s.length >= 8 && /[A-Za-z]/.test(s) && /[0-9]/.test(s) && /[^A-Za-z0-9\s]/.test(s);
}

Deno.test('비밀번호 규칙 = 프론트 checkPasswordRule', () => {
  const cases = [
    '', 'a', 'abc12!', 'abcd123!', 'Abcd123!', 'abcdefgh', '12345678', '!!!!!!!!', 'abcd1234', 'abcd!!!!', '1234!!!!',
    'abc 123!', 'abc 1234', '        ', 'Stella2026', 'Stella2026!', 'stella_2026', '스텔라2026!', '스텔라abcd1!', 'abc1!',
    'aaaaaaa1!', 'A1!aaaaa', 'A1!aaaa', 'pass word1', 'pass-word1', 'pässword1', 'PASSWORD1~', 'pw1\t!!!!!', '1a!'.repeat(3),
    'ab12cd34', 'ab12cd3@', '😀abc1234', 'abc1234😀', 'ABCDEFG1.', '..........1a', 'a1' + ' '.repeat(6), 'a1!', 'a'.repeat(100) + '1!',
    'Zz9#', 'Zz9#Zz9#',
  ];
  assertEquals(cases.length, 40);
  for (const pw of cases) assertEquals(R.checkPasswordRule(pw), frontCheckPasswordRule(pw), JSON.stringify(pw));
  assertEquals(R.checkPasswordRule(null), false);
  assertEquals(R.checkPasswordRule(undefined), false);
});

function memStore() {
  const m = new Map<string, string>();
  return { m, getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => { m.set(k, v); } };
}

Deno.test('5회 실패 → 10분 잠금 (이메일별, 대소문자·공백 무시)', async () => {
  let t = 1_000_000;
  const g = R.createLoginGuard(memStore(), () => t);
  for (let i = 1; i <= 4; i++) {
    const r = await g.recordFailure('User@Test.dev ');
    assertEquals(r, { count: i, lockedUntil: null });
  }
  assertEquals(await g.lockedUntil('user@test.dev'), null, '4번까지는 안 잠김');
  const r5 = await g.recordFailure('user@test.dev');
  assertEquals(r5.lockedUntil, t + 10 * 60 * 1000, '5번째에 잠금, 10분');
  assertEquals(await g.lockedUntil('USER@test.dev'), t + 600_000);
  assertEquals(await g.lockedUntil('other@test.dev'), null, '다른 이메일은 따로 셈');
  t += 600_000 - 1;
  assert(await g.lockedUntil('user@test.dev'), '10분 되기 직전까지 잠김');
  t += 1;
  assertEquals(await g.lockedUntil('user@test.dev'), null, '10분 지나면 풀림');
  assertEquals((await g.recordFailure('user@test.dev')).count, 1, '풀린 뒤에는 처음부터 다시 셈');
  await g.recordFailure('user@test.dev');
  await g.clear('user@test.dev');
  assertEquals((await g.recordFailure('user@test.dev')).count, 1, '성공·재설정(clear)하면 처음부터');
});

Deno.test('잠금 기록이 깨졌거나 저장이 실패해도 로그인은 막지 않음', async () => {
  const s = memStore();
  s.m.set('stella.auth.attempts.v1', '{망가진 JSON');
  const g = R.createLoginGuard(s);
  assertEquals(await g.lockedUntil('a@b.c'), null);
  const broken = { getItem: async () => null, setItem: async () => { throw new Error('disk full'); } };
  const g2 = R.createLoginGuard(broken);
  assertEquals((await g2.recordFailure('a@b.c')).count, 1);
});

// ---------------------------------------------------------------------
// 진짜 auth.ts ↔ 가짜 Supabase Auth
// ---------------------------------------------------------------------
const calls: { path: string; body: Record<string, unknown> }[] = [];
const GOOD = 'Right1234!';
const user = { id: '00000000-0000-4000-8000-0000000000a1', aud: 'authenticated', role: 'authenticated', email: 'pw@test.dev', app_metadata: {}, user_metadata: {}, identities: [{ id: 'x' }], created_at: new Date().toISOString() };
const session = () => ({ access_token: 'fake.jwt.token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
const server = Deno.serve({ port: 54333, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
  calls.push({ path: `${req.method} ${url.pathname}${url.search}`, body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/auth/v1/token') {
    if (body.password === GOOD) return json(200, session());
    if (body.password === 'NETWORK') return json(503, { code: 503, error_code: 'unexpected_failure', msg: 'down' });
    return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
  }
  if (url.pathname === '/auth/v1/signup') return json(200, { ...user, identities: [{ id: 'x' }] });
  if (url.pathname === '/auth/v1/user' && req.method === 'PUT') return json(200, user);
  return json(404, { msg: 'not found' });
});

Deno.env.set('EXPO_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54333');
Deno.env.set('EXPO_PUBLIC_SUPABASE_KEY', 'sb_publishable_test');
const A = await import(`${LIB}/auth.ts`);
const I = await import(`${LIB}/invites.ts`);
const E = await import(`${LIB}/errors.ts`);

Deno.test({
  name: 'auth.ts: 틀린 비밀번호 5번 → login_locked, 서버 오류는 안 셈, 재설정하면 풀림',
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const tokenCalls = () => calls.filter((c) => c.path.startsWith('POST /auth/v1/token')).length;
    // 서버 오류(503)는 실패 횟수에 안 넣음
    await assertRejects(() => A.signInWithEmail('pw@test.dev', 'NETWORK'));
    for (let i = 1; i <= 4; i++) {
      const e = await assertRejects(() => A.signInWithEmail(' PW@test.dev', 'wrong-pass1!')) as { code?: string };
      assertEquals(e.code, 'invalid_credentials', `${i}번째는 그냥 실패`);
      assertEquals(A.authErrorMessage(e), '이메일 또는 비밀번호가 맞지 않아요');
    }
    const e5 = await assertRejects(() => A.signInWithEmail('pw@test.dev', 'wrong-pass1!')) as { code?: string; lockedUntil?: number };
    assertEquals(e5.code, 'login_locked', '5번째(서버 오류 제외)에 잠금');
    assert((e5.lockedUntil ?? 0) - Date.now() > 9 * 60_000);
    assertEquals(A.authErrorMessage(e5), '비밀번호 5회 불일치. 10분 후 다시 시도해주세요');
    const before = tokenCalls();
    const e6 = await assertRejects(() => A.signInWithEmail('pw@test.dev', GOOD)) as { code?: string };
    assertEquals(e6.code, 'login_locked', '잠긴 동안은 맞는 비밀번호도 막음');
    assertEquals(tokenCalls(), before, '잠긴 동안은 서버에 보내지 않음');

    // 비밀번호 재설정: 재설정 코드 확인(verifyOtp type=recovery)으로 세션을 받은 상태를 흉내 → updatePassword → 잠금 풀림
    const { supabase } = await import(`${LIB}/supabase.ts`);
    // @ts-ignore 테스트 전용: 재설정 코드 확인이 끝난 세션을 넣음 (supabase-js 내부 저장 함수)
    await supabase.auth._saveSession(session());
    const puts = calls.filter((c) => c.path === 'PUT /auth/v1/user').length;
    await A.updatePassword('NewPass12#');
    assertEquals(calls.filter((c) => c.path === 'PUT /auth/v1/user').length, puts + 1, '새 비밀번호를 서버에 저장');
    assertEquals(await A.loginGuard.lockedUntil('pw@test.dev'), null, '재설정하면 잠금이 풀림');
    const ok = await A.signInWithEmail('pw@test.dev', GOOD);
    assertEquals(ok.user.email, 'pw@test.dev', '풀린 뒤 로그인 성공');
  },
});

Deno.test({
  name: 'auth.ts: 규칙에 안 맞는 비밀번호는 서버에 보내기 전에 weak_password',
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const n = calls.filter((c) => c.path.startsWith('POST /auth/v1/signup')).length;
    const e = await assertRejects(() => A.signUpWithEmail('new@test.dev', 'Stella2026')) as { code?: string };
    assertEquals(e.code, 'weak_password');
    assertEquals(A.authErrorMessage(e), R.PASSWORD_RULE_MESSAGE);
    assertEquals(calls.filter((c) => c.path.startsWith('POST /auth/v1/signup')).length, n, '서버에 안 보냄');
    const e2 = await assertRejects(() => A.updatePassword('abcdefgh')) as { code?: string };
    assertEquals(e2.code, 'weak_password');
    await A.signUpWithEmail('new@test.dev', 'Stella2026!', { displayName: '새 사용자' });
    assertEquals(calls.filter((c) => c.path.startsWith('POST /auth/v1/signup')).length, n + 1, '규칙에 맞으면 서버로');
  },
});

Deno.test('역할 이름: 관리자 = OWNER, 멤버 = EDITOR', () => {
  assertEquals(I.roleLabel('OWNER'), '관리자');
  assertEquals(I.roleLabel('EDITOR'), '멤버');
  assertEquals(I.APP_ROLE['관리자'], 'OWNER');
  assertEquals(I.APP_ROLE['멤버'], 'EDITOR');
  assert(I.isAdmin('OWNER') && !I.isAdmin('EDITOR'));
  const text = I.inviteShareText({ workspaceName: '스텔라 팀', code: 'ABCDE-FGHJK', role: 'EDITOR', expiresAt: '2026-11-20T06:00:00Z' });
  assert(text.includes('멤버 · 11월 20일 오후 3:00까지'), text);
  assertEquals(I.memberErrorMessage(new E.SyncError('FORBIDDEN', 'OWNER만 초대할 수 있습니다')), '관리자만 초대할 수 있습니다');
  assert(I.memberErrorMessage(new E.SyncError('LAST_OWNER', 'x')).startsWith('마지막 관리자는'));
});

Deno.test({ name: '정리', sanitizeOps: false, sanitizeResources: false, async fn() { await server.shutdown(); } });
