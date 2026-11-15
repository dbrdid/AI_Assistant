// 동기화 다리(bridge.js): 동기화 도중의 저장, 겹친 호출, 큰 묶음, 별표 순서, 막힌 줄, 계정
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, rejects } from './helpers.mjs';
import { createBridge, OUTBOX_BATCH, splitChanges } from '../src/index.js';

const SERVER_WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const ASSET = '11111111-1111-4111-8111-111111111111';

/**
 * 공유 공간으로 전환한 저장소 + 가짜 엔진.
 * 가짜 엔진은 local-sync의 규칙을 흉내 냄: 한 묶음 1~100개·같은 대상 한 번, handoffKey는 한 번만, 넘겨받은 변경을 자기 기록에 얹음.
 */
function world({ account = null, favorites, engineExtra = {} } = {}) {
  const t = setup();
  t.team = t.store.createWorkspace({ name: '팀 공간' });
  t.store.switchWorkspace(t.team);
  t.store.linkWorkspace(t.team, SERVER_WS);
  const rec = new Map();                                            // 서버 공간 id → { notes, tasks, events, note_attachments }
  const of = ws => rec.get(ws) ?? rec.set(ws, { notes: new Map(), tasks: new Map(), events: new Map(), note_attachments: new Map() }).get(ws);
  t.handed = [];                                                    // 엔진이 실제로 받은 묶음: [서버 공간 id, handoffKey, 'kind:entity,...']
  t.keys = new Set();
  t.calls = [];
  t.during = null;                                                  // 다음 syncNow 도중에 한 번 실행할 일 (화면에서 한 저장 흉내)
  t.flush = { status: 'DONE', sent: 0 };
  t.engine = {
    saveLocal: async (ctx, changes, opts = {}) => {
      t.calls.push('saveLocal');
      await Promise.resolve();
      if (changes.length === 0 || changes.length > 100) throw Object.assign(new Error('한 번에 1~100개까지 저장할 수 있습니다'), { code: 'INVALID_REQUEST' });
      const targets = changes.map(c => `${c.entity}|${c.id ?? `${c.data.note_id}:${c.data.asset_id}`}`);
      if (new Set(targets).size !== targets.length) throw Object.assign(new Error('같은 대상을 한 묶음에 두 번 넣을 수 없습니다'), { code: 'INVALID_REQUEST' });
      if (opts.handoffKey !== undefined) {
        if (t.keys.has(opts.handoffKey)) return 'again';
        t.keys.add(opts.handoffKey);
      }
      t.handed.push([ctx.workspaceId, opts.handoffKey, changes.map(c => `${c.kind}:${c.entity}`).join(',')]);
      const r = of(ctx.workspaceId);
      for (const c of changes) {
        if (c.kind === 'create') r[c.entity].set(c.id, { id: c.id, ...c.data });
        else if (c.kind === 'update') r[c.entity].set(c.id, { ...r[c.entity].get(c.id), ...c.data });
        else if (c.kind === 'delete') r[c.entity].set(c.id, { ...r[c.entity].get(c.id), deleted_at: '2026-11-15T01:00:00.000Z' });
        else if (c.kind === 'restore') r[c.entity].set(c.id, { ...r[c.entity].get(c.id), deleted_at: null });
        else if (c.kind === 'purge') r[c.entity].delete(c.id);
      }
      return 'op';
    },
    syncNow: async ctx => {
      t.calls.push(`syncNow:${ctx.workspaceId}`);
      await Promise.resolve();
      if (t.during) { const fn = t.during; t.during = null; fn(ctx.workspaceId); }
      return { flush: t.flush, pull: { status: 'OK', applied: 0, lastSeq: 1 } };
    },
    listLocal: async (db, ws, entity) => [...of(ws)[entity].values()].map(data => ({ key: data.id, data })),
    ...engineExtra,
  };
  t.bridge = createBridge({ store: t.store, engine: t.engine, db: {}, transport: {}, accountId: account, favorites });
  t.titles = () => t.store.getMemos().map(m => m.title).sort();
  return t;
}

test('큰 묶음은 엔진이 받는 크기로 나뉜다: 101개를 한 번에 휴지통으로 보내도 동기화가 막히지 않는다', async () => {
  assert.equal(OUTBOX_BATCH, 100);
  const many = Array.from({ length: 250 }, (_, i) => ({ kind: 'delete', entity: 'notes', id: `n${i}` }));
  assert.deepEqual(splitChanges(many).map(b => b.length), [100, 100, 50]);
  assert.deepEqual(splitChanges(many).flat(), many);                                    // 순서 그대로
  // 같은 대상이 다시 나오면 다음 묶음으로 (엔진은 한 묶음에 같은 대상을 한 번만 받음)
  const link = (kind, position) => ({ kind, entity: 'note_attachments', data: { note_id: 'n1', asset_id: 'a1', ...(position === undefined ? {} : { position }) } });
  assert.deepEqual(splitChanges([{ kind: 'update', entity: 'notes', id: 'n1', data: {} }, { kind: 'delete', entity: 'notes', id: 'n1' }, link('link', 0), link('unlink')]).map(b => b.map(c => c.kind)),
    [['update'], ['delete', 'link'], ['unlink']]);
  assert.deepEqual(splitChanges([]), []);

  const t = world();
  const ids = Array.from({ length: 101 }, (_, i) => t.store.addMemo({ title: `메모 ${i}` }).id);
  await t.bridge.syncAll();
  assert.equal(t.store.trashMemos(ids), 101);
  assert.deepEqual(t.store.peekOutbox(10).map(r => r.changes.length), [100, 1]);
  const later = t.store.addMemo({ title: '그 뒤에 쓴 메모' });
  const out = await t.bridge.syncAll();
  assert.deepEqual([out[t.team].status, out[t.team].handOff, t.store.outboxCount()], ['OK', undefined, 0]);
  assert.deepEqual([t.store.getTrashedMemos().length, t.titles()], [101, ['그 뒤에 쓴 메모']]);
  // 휴지통에 없던 150개를 바로 영구 삭제: 삭제 150 → 영구 삭제 150, 삭제가 모두 영구 삭제보다 먼저
  const fresh = Array.from({ length: 150 }, (_, i) => t.store.addMemo({ title: `새 메모 ${i}` }).id);
  await t.bridge.syncAll();
  t.store.deleteMemosForever(fresh);
  assert.deepEqual(t.store.peekOutbox(10).map(r => [r.changes[0].kind, r.changes.length]), [['delete', 100], ['delete', 50], ['purge', 100], ['purge', 50]]);
  assert.equal((await t.bridge.syncAll())[t.team].status, 'OK');
  assert.deepEqual([t.store.outboxCount(), t.titles(), t.store.getMemo(later.id).title], [0, ['그 뒤에 쓴 메모'], '그 뒤에 쓴 메모']);
});

test('동기화 도중에 한 저장은 화면에서 사라지거나 되돌아가지 않고, 같은 호출 안에서 이어서 올라간다', async () => {
  const t = world();
  const old = t.store.addMemo({ title: '원래 제목', body: 'a' });
  const gone = t.store.addMemo({ title: '곧 영구 삭제할 메모' });
  await t.bridge.syncAll();
  let created, edited, proposal;
  t.during = () => {
    created = t.store.addMemo({ title: '동기화 중에 쓴 메모', body: '내일 3시 회의' });
    [proposal] = t.store.addProposals([{ kind: 'event', title: '회의', date: '2026-11-16', start: '15:00', sourceType: 'memo', sourceId: created.id, sourceTitle: created.title, sourceRevision: created.revision }]);
    edited = t.store.updateMemo(old.id, { title: '고친 제목' });
    t.store.deleteMemoForever(gone.id);
  };
  const before = t.handed.length;
  const out = await t.bridge.syncAll();
  assert.equal(out[t.team].status, 'OK');
  assert.deepEqual(t.titles(), ['고친 제목', '동기화 중에 쓴 메모']);            // 새 메모는 남고, 수정은 그대로, 영구 삭제한 메모는 되살아나지 않음
  assert.equal(t.store.getProposal(proposal.id)?.status, 'pending');             // 새 메모의 AI 제안도 그대로
  assert.equal(t.store.getMemo(old.id).revision, edited.revision);               // 화면이 들고 있던 revision으로 이어서 저장할 수 있음
  assert.equal(t.store.updateMemo(old.id, { body: '이어서 씀' }, { expectedRevision: edited.revision }).body, '이어서 씀');
  assert.equal(t.store.getMemo(created.id).revision, created.revision);
  // 도중의 저장 4번(만들기·수정·삭제·영구 삭제)이 같은 syncAll 안에서 한 번씩만 엔진에 넘어감
  assert.deepEqual(t.handed.slice(before).map(h => h[2]), ['create:notes', 'update:notes', 'delete:notes', 'purge:notes']);
  assert.deepEqual(t.calls.filter(c => c.startsWith('syncNow')).length, 3);      // 첫 실행 1번 + 이번 2번(도중 저장 때문에 한 번 더)
  await t.bridge.syncAll();
  assert.deepEqual([t.store.outboxCount(), t.titles()], [0, ['고친 제목', '동기화 중에 쓴 메모']]);
});

test('저장소: 보낼 목록에 남은 기록은 서버 값으로 덮지 않고, 넘어간 뒤에는 맞춘다', () => {
  const t = world();
  const memo = t.store.addMemo({ title: '내 메모', body: '내 본문' });
  const task = t.store.addTask({ title: '내 할 일', date: '2026-11-20' });
  t.store.setFavorites([memo.id], true);
  const remote = { id: '77777777-7777-4777-8777-777777777777', title: '남의 메모', body: '', strokes: [] };
  const items = [
    { entity: 'notes', data: { id: memo.id, title: '서버의 옛 제목', body: '', strokes: [] } },
    { entity: 'tasks', data: { id: task.id }, purged: true },
    { entity: 'notes', data: remote },
  ];
  assert.deepEqual(t.store.applyServer(SERVER_WS, items), { notes: 1, tasks: 0, photos: 0 });   // 남의 메모만 반영
  assert.equal(t.store.applyFavorites(SERVER_WS, []), 0);                                        // 안 보낸 별표는 그대로
  assert.deepEqual([t.store.getMemo(memo.id).title, t.store.getMemo(memo.id).favorite, t.store.getTask(task.id)?.title, t.titles()],
    ['내 메모', true, '내 할 일', ['남의 메모', '내 메모']]);
  // 방금 붙인 사진(연결이 아직 보낼 목록에 있음)도 서버에 없다는 이유로 떼지 않음
  for (const row of t.store.peekOutbox(10)) t.store.ackOutbox(row.seq);
  t.store.attachPhoto(memo.id, ASSET);
  const unlink = [{ entity: 'note_attachments', data: { note_id: memo.id, asset_id: ASSET }, removed: true }];
  assert.deepEqual([t.store.applyServer(SERVER_WS, unlink), t.store.getMemo(memo.id).photos], [{ notes: 0, tasks: 0, photos: 0 }, [ASSET]]);
  t.store.updateMemo(memo.id, { title: '내 메모' });                                               // (보낼 목록에 이 메모의 수정이 다시 생김)
  t.store.setFavorites([memo.id], false); t.store.setFavorites([memo.id], true);
  for (const row of t.store.peekOutbox(10)) t.store.ackOutbox(row.seq);                          // 엔진에 넘어간 뒤
  assert.deepEqual([t.store.applyServer(SERVER_WS, unlink), t.store.getMemo(memo.id).photos], [{ notes: 0, tasks: 0, photos: 1 }, []]);
  assert.deepEqual(t.store.applyServer(SERVER_WS, items), { notes: 1, tasks: 1, photos: 0 });
  assert.equal(t.store.applyFavorites(SERVER_WS, []), 1);
  assert.deepEqual([t.store.getMemo(memo.id).title, t.store.getMemo(memo.id).favorite, t.store.getTask(task.id)], ['서버의 옛 제목', false, null]);
  // 다른 공간의 보낼 목록은 상관없음
  const other = t.store.createWorkspace({ name: '다른 공간' });
  t.store.switchWorkspace(other);
  t.store.addMemo({ title: '다른 공간 메모' });
  t.store.switchWorkspace(t.team);
  assert.deepEqual(t.store.applyServer(SERVER_WS, [{ entity: 'notes', data: { ...remote, title: '남이 고친 제목' } }]), { notes: 1, tasks: 0, photos: 0 });
  assert.deepEqual(t.store.peekOutbox(10, { workspaceId: other }).length, 1);
  assert.deepEqual(t.store.peekOutbox(10, { workspaceId: t.team }), []);
});

test('겹쳐 불러도 같은 저장은 한 번만 넘어간다 (syncAll 도중 syncWorkspace·refresh)', async () => {
  const t = world();
  t.store.addMemo({ title: '한 번만 가야 하는 메모' });
  const [all, one] = await Promise.all([t.bridge.syncAll(), t.bridge.syncWorkspace(t.team), t.bridge.refresh(SERVER_WS), t.bridge.syncWorkspace(SERVER_WS)]);
  assert.deepEqual(t.handed.map(h => h[2]), ['create:notes']);
  assert.equal(t.calls.filter(c => c === 'saveLocal').length, 1);               // 다시 넘기는 일 자체가 없음
  assert.deepEqual([all[t.team].status, one.status, t.store.outboxCount()], ['OK', 'OK', 0]);
  assert.equal(t.bridge.syncAll(), t.bridge.syncAll());                          // 도는 중에는 같은 실행
  assert.deepEqual(await t.bridge.syncWorkspace('없는 공간'), { status: 'NOT_SHARED' });
  assert.deepEqual(await t.bridge.syncWorkspace(t.store.getWorkspaces()[0].id), { status: 'NOT_SHARED' });
  assert.equal(await t.bridge.refresh('없는 공간'), null);
});

test('넘길 때 묶음마다 고유 표시를 붙여, 넘긴 직후 앱이 꺼져 다시 넘겨도 엔진에는 한 번만 들어간다', async () => {
  const t = world();
  t.store.addMemo({ title: '메모' });
  const [row] = t.store.peekOutbox();
  let failOnce = true;
  const flaky = { ...t.store, ackOutbox: seq => { if (failOnce) { failOnce = false; throw new Error('앱이 꺼짐'); } return t.store.ackOutbox(seq); } };
  const bridge = createBridge({ store: flaky, engine: t.engine, db: {}, transport: {} });
  assert.deepEqual([(await bridge.syncAll())[t.team].status, t.store.outboxCount()], ['ERROR', 1]);   // 엔진에는 들어갔고 보낼 목록에는 남음
  assert.deepEqual([(await bridge.syncAll())[t.team].status, t.store.outboxCount()], ['OK', 0]);
  assert.deepEqual(t.handed, [[SERVER_WS, `${row.seq}:${row.createdAt}`, 'create:notes']]);
  assert.equal(t.calls.filter(c => c === 'saveLocal').length, 2);                                     // 두 번 넘겼지만 한 번만 저장
});

test('별표는 메모가 서버에 올라간 뒤에 보낸다: 새 메모에 바로 별표를 눌러도 첫 동기화에서 켜진 채로 남는다', async () => {
  const known = new Set(), stars = new Set(), sets = [];
  const favorites = {
    set: async (ws, ids, on) => {
      sets.push([ids.length, on]);
      if (favorites.offline) throw new Error('fetch failed');
      for (const id of ids) if (!known.has(id)) throw new Error(`NOT_FOUND: 이 공간에 없는 메모가 1개 있습니다`);
      for (const id of ids) on ? stars.add(id) : stars.delete(id);
    },
    list: async () => [...stars],
  };
  const t = world({ favorites });
  const real = t.engine.syncNow;
  t.engine.syncNow = async ctx => {                                               // 보내기가 끝나면 서버가 그 메모를 앎
    const result = await real(ctx);
    if (t.flush.status === 'DONE') for (const r of await t.engine.listLocal({}, ctx.workspaceId, 'notes')) known.add(r.key);
    return result;
  };
  const memo = t.store.addMemo({ title: '별표 메모', favorite: true });
  await t.bridge.syncAll();
  assert.deepEqual([t.store.getMemo(memo.id).favorite, t.store.outboxCount(), [...stars]], [true, 0, [memo.id]]);

  // 연결이 안 되면 남겨 두고, 화면의 별표는 그대로
  favorites.offline = true;
  t.store.setFavorites([memo.id], false);
  await t.bridge.syncAll();
  assert.deepEqual([t.store.getMemo(memo.id).favorite, t.store.outboxCount(), [...stars]], [false, 1, [memo.id]]);
  favorites.offline = false;
  await t.bridge.syncAll();
  assert.deepEqual([t.store.getMemo(memo.id).favorite, t.store.outboxCount(), [...stars]], [false, 0, []]);

  // 보내기가 덜 끝났을 때의 NOT_FOUND는 기다리고(그 메모가 아직 서버에 없을 수 있음), 다 보낸 뒤에도 NOT_FOUND면 그 줄을 버림
  t.flush = { status: 'OFFLINE', sent: 0, error: 'fetch failed' };
  const offline = t.store.addMemo({ title: '오프라인에서 쓴 메모', favorite: true });
  await t.bridge.syncAll();
  assert.deepEqual([t.store.getMemo(offline.id).favorite, t.store.outboxCount()], [true, 1]);
  known.delete(offline.id);
  t.flush = { status: 'DONE', sent: 1 };
  t.engine.syncNow = real;                                                        // 서버가 끝내 이 메모를 모르는 경우
  await t.bridge.syncAll();
  assert.deepEqual([t.store.outboxCount(), t.store.getMemo(offline.id).favorite], [0, false]);   // 버리고 서버 값(별표 없음)으로

  // 한 번에 500개까지만 보냄
  sets.length = 0;
  const many = Array.from({ length: 501 }, (_, i) => t.store.addMemo({ title: `m${i}` }).id);
  await t.bridge.syncAll();
  for (const id of many) known.add(id);
  t.store.setFavorites(many, true);
  await t.bridge.syncAll();
  assert.deepEqual([sets, stars.size, t.store.outboxCount()], [[[500, true], [1, true]], 501, 0]);
});

test('한 공간이 막혀도 다른 공간은 계속 돌고, 막힌 줄은 결과에 나온다', async () => {
  const t = world();
  const second = t.store.createWorkspace({ name: '둘째 공간' });
  t.store.linkWorkspace(second, OTHER_WS);
  const bad = t.store.addMemo({ title: '엔진이 받지 않는 저장' });
  t.store.updateMemo(bad.id, { body: '그 뒤의 저장' });
  t.store.switchWorkspace(second);
  const fine = t.store.addMemo({ title: '둘째 공간 메모' });
  const save = t.engine.saveLocal;
  t.engine.saveLocal = async (ctx, changes, opts) => {
    // 첫째 공간의 첫 줄(만들기)만 거절: 그 뒤의 줄(수정)은 받을 수 있어도 순서를 지켜 기다려야 함
    if (ctx.workspaceId === SERVER_WS && changes[0].kind === 'create') throw Object.assign(new Error('한 번에 1~100개까지 저장할 수 있습니다'), { code: 'INVALID_REQUEST' });
    return save(ctx, changes, opts);
  };
  const [badRow] = t.store.peekOutbox(1, { workspaceId: t.team });
  let out = await t.bridge.syncAll();
  assert.deepEqual(out[t.team].handOff, { status: 'BLOCKED', seq: badRow.seq, code: 'INVALID_REQUEST', error: '한 번에 1~100개까지 저장할 수 있습니다' });
  assert.deepEqual([out[t.team].status, out[second].status, out[second].handOff], ['OK', 'OK', undefined]);
  assert.deepEqual(t.handed.map(h => h[0]), [OTHER_WS]);
  assert.equal(t.store.getMemo(fine.id).title, '둘째 공간 메모');
  assert.equal(t.calls.filter(c => c === `syncNow:${SERVER_WS}`).length, 1);     // 막힌 공간을 같은 호출 안에서 되풀이하지 않음
  t.store.switchWorkspace(t.team);
  assert.deepEqual([t.store.getMemo(bad.id).body, t.store.outboxCount()], ['그 뒤의 저장', 2]);   // 막힌 저장은 화면에 그대로

  // 엔진이 동기화 도중 오류를 내도 그 공간만 ERROR
  t.engine.saveLocal = save;
  const sync = t.engine.syncNow;
  t.engine.syncNow = async ctx => { if (ctx.workspaceId === SERVER_WS) throw Object.assign(new Error('서버가 거절'), { code: 'CHECK_FAILED' }); return sync(ctx); };
  out = await t.bridge.syncAll();
  assert.deepEqual([out[t.team], out[second].status], [{ status: 'ERROR', code: 'CHECK_FAILED', error: '서버가 거절' }, 'OK']);
  t.engine.syncNow = sync;
  out = await t.bridge.syncAll();
  assert.deepEqual([out[t.team].status, t.store.outboxCount(), t.store.getMemo(bad.id).body], ['OK', 0, '그 뒤의 저장']);
});

test('계정: 첫 동기화 전에 엔진 DB를 이 계정에 묶고, 기기 저장소가 다른 계정 것이면 동기화하지 않는다', async () => {
  const binds = [];
  const t = world({ account: ACCOUNT, engineExtra: { bindSyncAccount: async (db, id) => { binds.push(id); return { cleared: false, droppedOutbox: 0 }; } } });
  t.engine.bindSyncAccount = async (db, id) => { binds.push([id, [...t.calls]]); return { cleared: false, droppedOutbox: 0 }; };
  t.store.addMemo({ title: '메모' });
  await t.bridge.syncAll();
  await t.bridge.syncWorkspace(t.team);
  assert.deepEqual(binds, [[ACCOUNT, []]]);                                        // 한 번만, 어떤 저장·동기화보다 먼저

  // 묶기가 실패하면 그 호출은 실패하고, 다음 호출에서 다시 시도
  const u = world({ account: ACCOUNT });
  let attempts = 0;
  u.engine.bindSyncAccount = async () => { if (++attempts === 1) throw new Error('disk I/O error'); return { cleared: true, droppedOutbox: 2 }; };
  u.store.addMemo({ title: '메모' });
  await assert.rejects(u.bridge.syncAll(), /disk I\/O error/);
  assert.deepEqual([u.calls, u.store.outboxCount()], [[], 1]);
  assert.equal((await u.bridge.syncAll())[u.team].status, 'OK');
  assert.equal(attempts, 2);

  // 기기 저장소가 다른 계정에 묶여 있으면 아무것도 넘기지 않음
  const v = world({ account: ACCOUNT });
  v.engine.bindSyncAccount = async () => { v.calls.push('bind'); return { cleared: false, droppedOutbox: 0 }; };
  v.store.bindAccount(STRANGER);
  v.store.addMemo({ title: '앞사람이 못 보낸 메모' });
  await assert.rejects(v.bridge.syncAll(), e => e.code === 'account_mismatch');
  await assert.rejects(v.bridge.syncWorkspace(v.team), e => e.code === 'account_mismatch');
  assert.deepEqual([v.calls, v.store.outboxCount()], [[], 1]);
  rejects(() => v.store.bindAccount(ACCOUNT), 'account_mismatch');
});
