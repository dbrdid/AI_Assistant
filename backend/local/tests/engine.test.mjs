// 동기화 엔진(frontend lib/stella/local-sync.ts)의 넘겨받기·계정 규칙. 다리(bridge.js)가 이 규칙에 기대고 있어서 여기서 같이 확인합니다.
//   엔진은 tests/sync-verify/lib/의 컴파일 사본을 씁니다 (STELLA_VERIFY로 경로 지정 가능). 사본이 없으면 건너뜁니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifyDir = process.env.STELLA_VERIFY ?? path.resolve(here, '../../../tests/sync-verify');
const available = fs.existsSync(path.join(verifyDir, 'lib/local-sync.js'));
const require = createRequire(path.join(verifyDir, 'verify.js'));
const engine = available ? require('./lib/local-sync.js') : null;
const { newDevice } = available ? require('./src/device.js') : {};

const WS = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const OTHER = '55555555-5555-4555-8555-555555555555';
const NOTE = '66666666-6666-4666-8666-666666666666';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
let n = 0;

/** 새 기기 DB + 무엇이든 받아 주는 가짜 서버 */
async function device() {
  const dev = newDevice(dir, `d${++n}`);
  await engine.setupLocalSync(dev.db);
  const pushed = [];
  const transport = {
    push: async (ws, operationId, ops) => {
      pushed.push([operationId, ops.map(o => `${o.op}:${o.entity}`).join(',')]);
      return { status: 'ACCEPTED', operation_id: operationId, last_seq: pushed.length, auth_epoch: 1, results: ops.map((o, index) => ({ index, entity: o.entity, id: o.id, revision: 1, seq: pushed.length })) };
    },
    pull: async (ws, afterSeq) => ({ status: 'OK', changes: [], next_seq: afterSeq, has_more: false, last_seq: afterSeq, auth_epoch: 1 }),
    snapshot: async () => ({ status: 'OK', as_of_seq: 0, auth_epoch: 1, members: [] }),
  };
  const clock = { t: Date.UTC(2026, 10, 15, 1) };
  let id = 0;
  const ctx = { db: dev.db, transport, workspaceId: WS, myAccountId: ME, now: () => new Date(clock.t).toISOString(), newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` };
  const count = async table => (await dev.db.get(`select count(*) as n from ${table}`)).n;
  return { ctx, db: dev.db, pushed, clock, count };
}
const create = (id = NOTE) => [{ kind: 'create', entity: 'notes', id, data: { title: '메모', body: '', strokes: [] } }];

test('넘겨받기: 같은 handoffKey의 묶음은 한 번만 저장한다 (이미 보낸 뒤에 다시 넘어와도)', { skip: !available }, async () => {
  const d = await device();
  const first = await engine.saveLocal(d.ctx, create(), { handoffKey: '1:1794704400000' });
  assert.equal(await engine.saveLocal(d.ctx, create(), { handoffKey: '1:1794704400000' }), first);   // 넘긴 직후 앱이 꺼져 다시 넘김
  assert.deepEqual([await d.count('stella_outbox'), (await engine.listLocal(d.db, WS, 'notes')).length], [1, 1]);
  assert.equal((await engine.syncNow(d.ctx)).flush.status, 'DONE');
  assert.equal(await engine.saveLocal(d.ctx, create(), { handoffKey: '1:1794704400000' }), first);   // 서버에 올라간 뒤에 다시 넘어와도
  assert.deepEqual([await d.count('stella_outbox'), d.pushed], [0, [[first, 'UPSERT:notes']]]);
  // 표시가 다르면 다른 저장, 표시가 없으면 예전처럼 부를 때마다 저장
  const second = await engine.saveLocal(d.ctx, [{ kind: 'update', entity: 'notes', id: NOTE, data: { body: '고침' } }], { handoffKey: '2:1794704401000' });
  assert.notEqual(second, first);
  await engine.saveLocal(d.ctx, [{ kind: 'update', entity: 'notes', id: NOTE, data: { body: '또 고침' } }]);
  await engine.saveLocal(d.ctx, [{ kind: 'update', entity: 'notes', id: NOTE, data: { body: '또 고침' } }]);
  assert.equal(await d.count('stella_outbox'), 3);
  await assert.rejects(engine.saveLocal(d.ctx, create(), { handoffKey: '' }), e => e.code === 'INVALID_REQUEST');
  await assert.rejects(engine.saveLocal(d.ctx, create(), { handoffKey: 'k'.repeat(201) }), e => e.code === 'INVALID_REQUEST');
  await assert.rejects(engine.saveLocal(d.ctx, Array.from({ length: 101 }, (_, i) => ({ kind: 'delete', entity: 'notes', id: `n${i}` })), { handoffKey: 'big' }), e => e.code === 'INVALID_REQUEST');
  assert.deepEqual([await d.count('stella_outbox'), await d.count('stella_handoffs')], [3, 2]);        // 거절된 묶음은 표시도 남기지 않음
  // 30일 지난 표시는 정리
  d.clock.t += 31 * 24 * 60 * 60 * 1000;
  await engine.saveLocal(d.ctx, [{ kind: 'update', entity: 'notes', id: NOTE, data: { title: '한 달 뒤' } }], { handoffKey: '9:1797382800000' });
  assert.deepEqual((await d.db.all('select key from stella_handoffs')).map(r => r.key), ['9:1797382800000']);
});

test('계정: 다른 계정으로 바뀌면 앞 계정의 기록·안 보낸 수정을 지우고, 같은 계정이면 그대로 둔다', { skip: !available }, async () => {
  const d = await device();
  assert.equal(await engine.getSyncAccount(d.db), null);
  await engine.saveLocal(d.ctx, create(), { handoffKey: 'a' });                                       // 계정을 묶기 전부터 있던 기록
  assert.deepEqual(await engine.bindSyncAccount(d.db, ME), { cleared: false, droppedOutbox: 0 });     // 처음 묶을 때는 지우지 않음
  await engine.syncNow(d.ctx);
  await engine.saveLocal(d.ctx, [{ kind: 'update', entity: 'notes', id: NOTE, data: { body: '안 보낸 수정' } }], { handoffKey: 'b' });
  assert.deepEqual(await engine.bindSyncAccount(d.db, ME), { cleared: false, droppedOutbox: 0 });
  assert.deepEqual([await engine.getSyncAccount(d.db), await d.count('stella_outbox'), await d.count('stella_records'), await d.count('stella_sync_state'), await d.count('stella_handoffs')], [ME, 1, 1, 1, 2]);

  assert.deepEqual(await engine.bindSyncAccount(d.db, OTHER), { cleared: true, droppedOutbox: 1 });
  assert.deepEqual([await engine.getSyncAccount(d.db), await d.count('stella_outbox'), await d.count('stella_records'), await d.count('stella_sync_state'), await d.count('stella_handoffs')], [OTHER, 0, 0, 0, 0]);
  const before = d.pushed.length;
  assert.deepEqual([(await engine.syncNow({ ...d.ctx, myAccountId: OTHER })).flush, d.pushed.length], [{ status: 'DONE', sent: 0 }, before]);   // 앞사람 수정이 뒷사람 이름으로 올라가지 않음
  assert.deepEqual(await engine.listLocal(d.db, WS, 'notes'), []);
  await assert.rejects(engine.bindSyncAccount(d.db, ''), e => e.code === 'INVALID_REQUEST');

  // 로그아웃·탈퇴: 전부 지우고 계정 표시도 지움
  await engine.saveLocal({ ...d.ctx, myAccountId: OTHER }, create('77777777-7777-4777-8777-777777777777'));
  assert.deepEqual(await engine.clearLocalSync(d.db), { droppedOutbox: 1 });
  assert.deepEqual([await engine.getSyncAccount(d.db), await d.count('stella_outbox'), await d.count('stella_records')], [null, 0, 0]);
  assert.deepEqual(await engine.bindSyncAccount(d.db, ME), { cleared: false, droppedOutbox: 0 });
});

/** 두 기기가 붙는 작은 가짜 서버: revision이 다르면 충돌(서버 현재 행을 돌려줌), 같으면 받아들이고 변경 기록에 남김 */
function fakeServer() {
  const rows = new Map(), ledger = [];
  let offline = 0;
  const transport = {
    push: async (ws, operationId, ops) => {
      if (offline > 0) { offline--; throw new Error('fetch failed'); }
      const conflicts = [];
      ops.forEach((o, index) => {
        const cur = rows.get(o.id);
        if (o.base_revision !== undefined && cur && cur.revision !== o.base_revision) conflicts.push({ index, entity: o.entity, id: o.id, reason: 'REVISION_MISMATCH', base_revision: o.base_revision, server: { ...cur } });
      });
      if (conflicts.length) return { status: 'CONFLICT', operation_id: operationId, conflicts, last_seq: ledger.length, auth_epoch: 1 };
      const results = ops.map((o, index) => {
        const cur = rows.get(o.id);
        const next = { ...(cur ?? { id: o.id, deleted_at: null }), ...JSON.parse(JSON.stringify(o.data ?? {})), revision: (cur?.revision ?? 0) + 1 };
        rows.set(o.id, next);
        ledger.push({ seq: ledger.length + 1, entity: o.entity, key: o.id, op: 'UPSERT', revision: next.revision, data: { ...next } });
        return { index, entity: o.entity, id: o.id, revision: next.revision, seq: ledger.length };
      });
      return { status: 'ACCEPTED', operation_id: operationId, results, last_seq: ledger.length, auth_epoch: 1 };
    },
    pull: async (ws, afterSeq) => ({ status: 'OK', changes: ledger.filter(c => c.seq > afterSeq), next_seq: ledger.length, has_more: false, last_seq: ledger.length, auth_epoch: 1 }),
    snapshot: async () => ({ status: 'OK', as_of_seq: ledger.length, auth_epoch: 1, members: [], notes: [...rows.values()].map(r => ({ ...r })) }),
  };
  return { transport, rows, goOffline: n => { offline = n; } };
}

/** 같은 서버에 붙은 기기 둘. 둘 다 메모 하나(본문 4줄)를 받은 상태에서 시작 */
async function pair() {
  const server = fakeServer();
  const make = async name => {
    const dev = newDevice(dir, `${name}${++n}`);
    await engine.setupLocalSync(dev.db);
    let id = 0;
    const ctx = { db: dev.db, transport: server.transport, workspaceId: WS, myAccountId: name, newId: () => `${name === 'a' ? 'aaaaaaaa' : 'bbbbbbbb'}-0000-4000-8000-${String(++id).padStart(12, '0')}` };
    const note = async () => (await engine.getLocal(dev.db, WS, 'notes', NOTE))?.data;
    const edit = data => engine.saveLocal(ctx, [{ kind: 'update', entity: 'notes', id: NOTE, data }]);
    return { ctx, db: dev.db, note, edit, sync: () => engine.syncNow(ctx) };
  };
  const a = await make('a'), b = await make('b');
  await engine.saveLocal(a.ctx, [{ kind: 'create', entity: 'notes', id: NOTE, data: { title: '회의', body: '안건\n1. 일정\n2. 예산\n3. 역할', strokes: [{ id: 's1', c: '#111', w: 2, p: [[1, 2]] }] } }]);
  await a.sync(); await b.sync();
  return { a, b, server };
}

test('충돌 합치기: 서로 다른 칸·다른 줄·다른 획은 둘 다 살리고, 같은 줄은 사용자가 고른다', { skip: !available }, async () => {
  const { a, b, server } = await pair();
  // 다른 칸: A는 제목, B는 본문
  await a.edit({ title: 'A가 고친 제목' }); await a.sync();
  await b.edit({ body: '안건\n1. 일정\n2. 예산\n3. 역할\n4. B가 더한 줄' });
  let r = await b.sync();
  assert.equal(r.flush.status, 'CONFLICT');                                            // 서버는 revision이 다르면 일단 충돌
  let [detail] = await engine.listConflicts(b.db, WS);
  assert.deepEqual([detail.outboxSeq, detail.mergeable, detail.canKeep, detail.items[0].fields], [r.flush.outboxSeq, true, true, []]);
  await engine.resolveConflict(b.ctx, r.flush.outboxSeq, 'merge');
  assert.equal((await b.sync()).flush.status, 'DONE');
  await a.sync();
  assert.deepEqual([(await a.note()).title, (await a.note()).body, await engine.listConflicts(b.db, WS)], ['A가 고친 제목', '안건\n1. 일정\n2. 예산\n3. 역할\n4. B가 더한 줄', []]);

  // 본문의 다른 줄 + 둘 다 끝에 한 줄씩 + 손글씨 한 획씩
  await a.edit({ body: '안건\n1. 일정 확정\n2. 예산\n3. 역할\n4. B가 더한 줄\n5. A의 줄', strokes: [{ id: 's1', c: '#111', w: 2, p: [[1, 2]] }, { id: 'a1', c: '#111', w: 2, p: [[3, 4]] }] });
  await a.sync();
  await b.edit({ body: '안건\n1. 일정\n2. 예산\n3. 역할 분담\n4. B가 더한 줄\n5. B의 줄', strokes: [{ id: 's1', c: '#111', w: 2, p: [[1, 2]] }, { id: 'b1', c: '#111', w: 2, p: [[5, 6]] }] });
  r = await b.sync();
  await engine.resolveConflict(b.ctx, r.flush.outboxSeq, 'merge');
  await b.sync(); await a.sync();
  const merged = await a.note();
  assert.equal(merged.body, '안건\n1. 일정 확정\n2. 예산\n3. 역할 분담\n4. B가 더한 줄\n5. B의 줄\n5. A의 줄');   // 같은 자리에 넣은 줄은 합친 쪽(B) 다음에 상대(A)
  assert.deepEqual(merged.strokes.map(s => s.id), ['s1', 'a1', 'b1']);
  assert.deepEqual(await b.note(), merged);

  // 같은 줄을 다르게 고침: 스스로 못 합침 → 무엇이 다른지 알려 주고, 고른 대로
  await a.edit({ body: merged.body.replace('2. 예산', '2. 예산 100만'), title: 'A의 새 제목' }); await a.sync();
  await b.edit({ body: merged.body.replace('2. 예산', '2. 예산 200만'), title: 'B의 새 제목' });
  r = await b.sync();
  await assert.rejects(engine.resolveConflict(b.ctx, r.flush.outboxSeq, 'merge'), e => e.code === 'CANNOT_MERGE' && e.details.fields.map(f => f.field).sort().join() === 'body,title');
  [detail] = await engine.listConflicts(b.db, WS);
  assert.deepEqual([detail.mergeable, detail.items[0].fields.map(f => [f.field, f.base, f.mine, f.server]).find(f => f[0] === 'title')], [false, ['title', 'A가 고친 제목', 'B의 새 제목', 'A의 새 제목']]);
  assert.equal((await b.sync()).flush.status, 'CONFLICT');                             // 실패한 합치기는 아무것도 바꾸지 않음
  await engine.resolveConflict(b.ctx, r.flush.outboxSeq, 'keep_both');                 // 본문은 둘 다, 한 줄 칸(제목)은 내 것
  assert.equal((await b.sync()).flush.status, 'DONE');
  await a.sync();
  const both = await a.note();
  assert.deepEqual([both.title, both.body.split('\n').filter(l => l.startsWith('2.'))], ['B의 새 제목', ['2. 예산 200만', '2. 예산 100만']]);
  assert.equal(server.rows.get(NOTE).revision, both.revision);
});

test('충돌 합치기의 기준은 보낼 내용을 고정한 때의 서버 값이다 (못 보낸 사이에 서버 값을 받아도 상대 수정을 덮지 않음)', { skip: !available }, async () => {
  const { a, b, server } = await pair();
  await b.edit({ title: 'B의 제목' });
  server.goOffline(1);
  let r = await b.sync();                                                              // 보내기 실패 (보낼 내용과 기준은 이때 고정됨)
  assert.deepEqual([r.flush.status, r.flush.code, r.flush.attempts], ['OFFLINE', 'NETWORK', 1]);
  await a.edit({ title: 'A의 제목' }); await a.sync();
  server.goOffline(1);
  r = await b.sync();                                                                  // 또 실패. 받기는 돼서 서버 사본이 'A의 제목'으로 바뀜
  const st = await engine.getSyncStatus(b.db, WS);
  assert.deepEqual([r.flush.status, r.pull.status, st.pending, st.attempts, st.lastError], ['OFFLINE', 'OK', 1, 2, 'NETWORK: fetch failed']);
  assert.equal((await b.note()).title, 'B의 제목');                                     // 화면에는 안 보낸 내 수정
  r = await b.sync();                                                                  // 같은 요청을 다시 보냄 → 충돌
  assert.equal(r.flush.status, 'CONFLICT');
  await assert.rejects(engine.resolveConflict(b.ctx, r.flush.outboxSeq, 'merge'), e => e.code === 'CANNOT_MERGE');   // 둘 다 제목을 고쳤으므로 물어야 함
  await engine.resolveConflict(b.ctx, r.flush.outboxSeq, 'use_server');
  assert.equal((await b.note()).title, 'A의 제목');

  // 기준이 없는 예전 묶음(base 칸이 비어 있음): 스스로 합치지 않음
  await a.edit({ body: 'A의 본문' }); await a.sync();
  await b.edit({ body: 'B의 본문' });
  r = await b.sync();
  await b.db.run('update stella_outbox set base = null where seq = ?', [r.flush.outboxSeq]);
  await assert.rejects(engine.resolveConflict(b.ctx, r.flush.outboxSeq, 'merge'), e => e.code === 'CANNOT_MERGE');
  await engine.resolveConflict(b.ctx, r.flush.outboxSeq, 'keep_both');
  await b.sync(); await a.sync();
  assert.equal((await a.note()).body, 'B의 본문\nA의 본문');
});

test('이전 버전으로 만든 기기 DB를 열면 새 칸·표만 더하고 기록은 그대로 둔다', { skip: !available }, async () => {
  const dev = newDevice(dir, `old${++n}`);
  await dev.db.exec(`
    create table stella_sync_state (workspace_id text primary key, last_seq integer not null default 0, auth_epoch integer not null default 0, status text not null default 'ACTIVE', updated_at text not null);
    create table stella_records (workspace_id text not null, entity text not null, key text not null, server_revision integer, server_data text, local_data text,
      local_removed integer not null default 0, pending integer not null default 0, conflict integer not null default 0, primary key (workspace_id, entity, key));
    create table stella_outbox (seq integer primary key autoincrement, workspace_id text not null, operation_id text not null unique, intent text not null, ops text,
      status text not null default 'PENDING', attempts integer not null default 0, last_error text, conflicts text, created_at text not null);
    insert into stella_outbox (workspace_id, operation_id, intent, created_at) values ('${WS}', 'op-1', '[{"kind":"create","entity":"notes","id":"${NOTE}","data":{"title":"예전 저장"}}]', '2026-11-14T00:00:00.000Z');
  `);
  await engine.setupLocalSync(dev.db);
  await engine.setupLocalSync(dev.db);                                                 // 여러 번 불러도 됨
  const cols = (await dev.db.all('pragma table_info(stella_outbox)')).map(c => c.name);
  assert.deepEqual([cols.includes('base'), (await engine.listOutbox(dev.db, WS)).map(r => r.operationId), await engine.getSyncAccount(dev.db)], [true, ['op-1'], null]);
  const server = fakeServer();
  assert.equal((await engine.syncNow({ db: dev.db, transport: server.transport, workspaceId: WS, newId: () => 'x' })).flush.status, 'DONE');
  assert.equal(server.rows.get(NOTE).title, '예전 저장');
});

test('글 합치기: 다른 줄은 둘 다, 같은 자리에 넣은 줄은 차례로, 같은 줄만 충돌 (무작위 3000번: 넣은 줄이 사라지지 않음)', { skip: !available }, () => {
  const base = '안건\n1. 일정\n2. 예산\n3. 역할';
  const m = (mine, theirs, union) => engine.mergeText(base, mine, theirs, union);
  assert.deepEqual(m('안건\n1. 일정 확정\n2. 예산\n3. 역할', '안건\n1. 일정\n2. 예산\n3. 역할 분담'), { text: '안건\n1. 일정 확정\n2. 예산\n3. 역할 분담', clean: true });
  assert.deepEqual(m('안건\n1. 일정 A\n2. 예산\n3. 역할', '안건\n1. 일정\n2. 예산 B\n3. 역할'), { text: '안건\n1. 일정 A\n2. 예산 B\n3. 역할', clean: true });   // 바로 옆줄
  assert.deepEqual(m(`${base}\n4. 내 줄`, `${base}\n4. 상대 줄`), { text: `${base}\n4. 내 줄\n4. 상대 줄`, clean: true });
  assert.deepEqual(m(`${base}\n끝`, `${base}\n끝`), { text: `${base}\n끝`, clean: true });
  assert.deepEqual(m(`안건 수정\n1. 일정\n2. 예산\n3. 역할\n끝`, `${base}\n끝`), { text: '안건 수정\n1. 일정\n2. 예산\n3. 역할\n끝', clean: true });   // 같은 자리에 같은 줄을 넣었으면 한 번만
  assert.deepEqual(m('안건\n1. 일정\n2. 예산\n3. 역할 분담\n4. B', '안건\n1. 일정 확정\n2. 예산\n3. 역할\n4. A'), { text: '안건\n1. 일정 확정\n2. 예산\n3. 역할 분담\n4. B\n4. A', clean: true });
  assert.equal(m('안건\n1. 일정 A\n2. 예산\n3. 역할', '안건\n1. 일정 B\n2. 예산\n3. 역할').clean, false);
  assert.deepEqual(m('안건\n1. 일정 A\n2. 예산\n3. 역할', '안건\n1. 일정 B\n2. 예산\n3. 역할', true), { text: '안건\n1. 일정 A\n1. 일정 B\n2. 예산\n3. 역할', clean: true });
  assert.equal(engine.mergeText('a\nb\nc\nd', 'a\nX\nd', 'a\nb\nNEW\nc\nd').clean, false);            // 상대가 넣은 줄이 내가 지운 구간 안
  assert.deepEqual(engine.mergeText('a\nb\nc\nd\ne', 'a\nc\nd\ne', 'a\nb\nc\nd\nE'), { text: 'a\nc\nd\nE', clean: true });
  assert.equal(engine.mergeText('', '내 글', '상대 글').clean, false);
  assert.deepEqual(engine.mergeText(base, base, '새 글'), { text: '새 글', clean: true });
  assert.equal(engine.sameValue({ a: 1, b: [1, { x: 1, y: 2 }] }, { b: [1, { y: 2, x: 1 }], a: 1 }), true);   // 서버 jsonb는 키 순서를 바꿈
  assert.equal(engine.sameValue({ a: 1 }, { a: 1, b: undefined }), false);
  const S = id => ({ id, c: '#111', w: 2, p: [[1, 2]] });
  assert.deepEqual(engine.mergeStrokes([S('a'), S('b')], [S('a'), S('m')], [{ p: [[1, 2]], w: 2, c: '#111', id: 'a' }, S('b'), S('t')]).map(s => s.id), ['a', 't', 'm']);   // 내가 지운 b는 빠지고, 서로 그린 획은 둘 다

  let seed = 7, bad = 0;
  const rnd = k => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k;
  for (let k = 0; k < 3000; k++) {
    const o = Array.from({ length: 2 + rnd(6) }, (_, i) => `o${i}`);
    const change = tag => {
      const l = o.slice();
      for (let q = rnd(3); q > 0; q--) {
        const at = rnd(l.length + 1), kind = rnd(3);
        if (kind === 0) l.splice(at, 0, `${tag}${k}_${q}`);
        else if (kind === 1 && l.length > 1) l.splice(Math.min(at, l.length - 1), 1);
        else if (l.length) l[Math.min(at, l.length - 1)] = `${tag}${k}_${q}`;
      }
      return l;
    };
    const mine = change('m'), theirs = change('t'), text = l => l.join('\n');
    const added = [...mine.filter(l => l.startsWith('m')), ...theirs.filter(l => l.startsWith('t'))];
    const clean = engine.mergeText(text(o), text(mine), text(theirs)), both = engine.mergeText(text(o), text(mine), text(theirs), true);
    if (clean.clean && !added.every(l => clean.text.split('\n').includes(l))) bad++;          // 깨끗하게 합쳐졌으면 양쪽이 쓴 줄이 모두 있음
    if (!both.clean || !added.every(l => both.text.split('\n').includes(l))) bad++;            // 둘 다 남기기는 언제나 모두 있음
    if (engine.mergeText(text(o), text(mine), text(o)).text !== text(mine)) bad++;             // 한쪽만 고쳤으면 그쪽 글
    if (engine.mergeText(text(o), text(o), text(theirs)).text !== text(theirs)) bad++;
  }
  assert.equal(bad, 0);
});
