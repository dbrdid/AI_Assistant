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
