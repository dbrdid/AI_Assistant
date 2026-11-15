#!/usr/bin/env node
// Stella 두 기기 동기화 검증
//   원격(기본):  npm run verify          → .env의 테스트 계정 2개로 실제 Supabase에 대고 실행
//   로컬 DB:     npm run verify:local    → supabase/tests의 로컬 Postgres에 대고 실행
const fs = require('node:fs');
const path = require('node:path');
const { runScenarios } = require('./src/scenarios');

const LOCAL = process.argv.includes('--local');
const ROOT = __dirname;

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function makeReport() {
  const rows = [];
  let current = '';
  return {
    rows,
    group(name) { current = name; console.log(`\n■ ${name}`); },
    check(name, pass, detail) {
      rows.push({ group: current, name, pass: !!pass, detail: detail ?? '' });
      console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? `  (${detail})` : ''}`);
    },
  };
}

async function main() {
  const report = makeReport();
  const env = { dataDir: path.join(ROOT, 'device-data'), cleanup: [], users: {} };
  const closers = [];
  const startedAt = new Date();

  if (LOCAL) {
    const { localAdmin, localUser } = require('./src/server-local');
    const admin = await localAdmin();
    closers.push(() => admin.close());
    const stamp = Date.now();
    const aId = await admin.createUser(`verify-a-${stamp}@stella.test`, '검증A');
    const bId = await admin.createUser(`verify-b-${stamp}@stella.test`, '검증B');
    env.users.A = await localUser(aId, `verify-a-${stamp}@stella.test`);
    env.users.B = await localUser(bId, `verify-b-${stamp}@stella.test`);
    if (!process.env.VERIFY_FAKE_SNAPSHOT) env.forceSnapshotRequired = (ws) => admin.forceSnapshotRequired(ws);
    console.log('대상: 로컬 Postgres (supabase/tests 로컬 DB)');
  } else {
    const cfg = { ...loadEnv(path.join(ROOT, '.env')), ...process.env };
    const need = ['SUPABASE_URL', 'SUPABASE_KEY', 'A_EMAIL', 'A_PASSWORD', 'B_EMAIL', 'B_PASSWORD'];
    const missing = need.filter((k) => !cfg[k]);
    if (missing.length) {
      console.error(`\n[!] .env에 값이 없어요: ${missing.join(', ')}\n    .env.example을 .env로 복사하고 테스트 계정 2개를 넣어 주세요.\n`);
      process.exit(2);
    }
    if (cfg.A_EMAIL === cfg.B_EMAIL) {
      console.error('\n[!] A와 B는 서로 다른 계정이어야 해요.\n');
      process.exit(2);
    }
    const { remoteUser } = require('./src/server-remote');
    try {
      env.users.A = await remoteUser(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, cfg.A_EMAIL, cfg.A_PASSWORD);
      env.users.B = await remoteUser(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, cfg.B_EMAIL, cfg.B_PASSWORD);
    } catch (e) {
      console.error(`\n[!] ${e.message}`);
      console.error('    - 이메일·비밀번호가 맞는지 (Supabase 대시보드 → Authentication → Users)');
      console.error('    - 계정이 이메일 인증된 상태인지 (Add user 할 때 Auto Confirm User 체크)');
      console.error('    - "fetch failed"면 인터넷 연결이나 SUPABASE_URL을 확인해 주세요\n');
      process.exit(2);
    }
    console.log(`대상: ${cfg.SUPABASE_URL}`);
  }
  closers.push(() => env.users.A.close(), () => env.users.B.close());

  let info = null;
  let crash = null;
  try {
    info = await runScenarios(env, report);
  } catch (e) {
    crash = e;
    console.error(`\n[중단] ${e.code ? `${e.code}: ` : ''}${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
  } finally {
    for (const fn of env.cleanup) await fn();     // 검증용 공간은 삭제(휴지통) 처리
    for (const fn of closers) await Promise.resolve(fn()).catch(() => undefined);
  }

  const pass = report.rows.filter((r) => r.pass).length;
  const fail = report.rows.length - pass;
  console.log(`\n결과: ${pass}개 통과 / ${fail}개 실패${crash ? ' / 도중에 중단됨' : ''}`);
  const out = {
    target: LOCAL ? 'local' : 'remote',
    startedAt: startedAt.toISOString(),
    node: process.version,
    passed: pass,
    failed: fail,
    crashed: crash ? `${crash.code ?? ''} ${crash.message}`.trim() : null,
    workspaceId: info?.workspaceId ?? null,
    checks: report.rows,
  };
  fs.writeFileSync(path.join(ROOT, `result-${out.target}.json`), JSON.stringify(out, null, 2));
  console.log(`자세한 결과: result-${out.target}.json\n`);
  process.exit(fail === 0 && !crash ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
