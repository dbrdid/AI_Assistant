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
function world({ account = null, favorites, engineExtra = {}, bridgeOptions = {} } = {}) {
  const t = setup();
  t.team = t.store.createWorkspace({ name: '팀 공간' });
  t.store.switchWorkspace(t.team);
  t.store.linkWorkspace(t.team, SERVER_WS);
  const rec = new Map();                                            // 서버 공간 id → { notes, tasks, events, note_attachments }
  const of = ws => rec.get(ws) ?? rec.set(ws, { notes: new Map(), tasks: new Map(), events: new Map(), note_attachments: new Map(), workspace_members: new Map() }).get(ws);
  t.records = of;                                                   // 테스트에서 "서버에서 받은 기록"을 직접 넣을 때
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
        else if (c.kind === 'link') r[c.entity].set(`${c.data.note_id}:${c.data.asset_id}`, { ...c.data });
        else if (c.kind === 'unlink') r[c.entity].delete(`${c.data.note_id}:${c.data.asset_id}`);
      }
      return 'op';
    },
    syncNow: async ctx => {
      t.calls.push(`syncNow:${ctx.workspaceId}`);
      await Promise.resolve();
      if (t.during) { const fn = t.during; t.during = null; fn(ctx.workspaceId); }
      return { flush: t.flush, pull: { status: 'OK', applied: 0, lastSeq: 1 } };
    },
    listLocal: async (db, ws, entity) => [...of(ws)[entity].entries()].map(([key, data]) => ({ key: data.id ?? key, data })),
    ...engineExtra,
  };
  t.bridge = createBridge({ store: t.store, engine: t.engine, db: {}, transport: {}, accountId: account, favorites, pause: async () => { t.pauses = (t.pauses ?? 0) + 1; }, ...bridgeOptions });
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

test('공유 공간에서도 올리기 전 사진을 붙일 수 있다: 다리가 올린 뒤 첨부 id로 바꾸고 연결을 보낸다', async () => {
  const uploads = [];
  const photos = { upload: async (ws, ref, info) => { uploads.push([ws, ref, info.memoId]); if (photos.fail) throw Object.assign(new Error(photos.fail), { code: photos.fail }); return ASSET; } };
  const t = world({ bridgeOptions: { photos } });
  const memo = t.store.addMemo({ title: '사진 메모', photos: ['file:///a.jpg'] });       // 오프라인에서 찍은 사진
  assert.deepEqual(t.store.peekOutbox(10).map(r => r.changes.map(c => c.kind)), [['create'], ['upload']]);
  photos.fail = 'NETWORK';
  let out = await t.bridge.syncAll();
  assert.deepEqual([out[t.team].status, out[t.team].uploadFailed, t.store.getMemo(memo.id).photos, t.store.outboxCount()], ['OK', undefined, ['file:///a.jpg'], 1]);   // 연결이 안 되면 기다림. 화면의 사진은 그대로
  photos.fail = null;
  out = await t.bridge.syncAll();
  assert.deepEqual([t.store.getMemo(memo.id).photos, t.store.outboxCount(), uploads.at(-1)], [[ASSET], 0, [SERVER_WS, 'file:///a.jpg', memo.id]]);
  assert.deepEqual(t.handed.map(h => h[2]), ['create:notes', 'link:note_attachments']);                    // 올린 뒤의 연결이 같은 호출에서 넘어감
  assert.deepEqual([...t.records(SERVER_WS).note_attachments.values()], [{ note_id: memo.id, asset_id: ASSET, position: 0 }]);

  // 올리기 전에 뗀 사진은 올리지 않고, 붙였다 뗀 기기 사진은 서버에 보낼 것이 없음
  uploads.length = 0;
  t.store.attachPhoto(memo.id, 'file:///b.jpg');
  t.store.detachPhoto(memo.id, 'file:///b.jpg');
  await t.bridge.syncAll();
  assert.deepEqual([uploads, t.store.outboxCount(), t.store.getMemo(memo.id).photos], [[], 0, [ASSET]]);
  assert.equal(t.handed.some(h => h[2].includes('unlink')), false);                                        // 서버가 모르는 사진의 연결 해제를 보내지 않음

  // 올릴 수 없는 파일은 결과로 알리고, 그 사진은 이 기기에만 남음 (다시 시도하지 않음)
  photos.fail = 'TOO_LARGE';
  t.store.updateMemo(memo.id, { photos: [ASSET, 'file:///big.mov'] });
  out = await t.bridge.syncAll();
  assert.deepEqual(out[t.team].uploadFailed, [{ memoId: memo.id, ref: 'file:///big.mov', code: 'TOO_LARGE', error: 'TOO_LARGE' }]);
  assert.deepEqual([t.store.getMemo(memo.id).photos, t.store.outboxCount()], [[ASSET, 'file:///big.mov'], 0]);
  assert.equal((await t.bridge.syncAll())[t.team].uploadFailed, undefined);

  // 올리는 길이 없으면(photos 없이 만든 다리) 기다리기만 함
  const u = world();
  const waitingMemo = u.store.addMemo({ title: '기다리는 사진' });
  u.store.attachPhoto(waitingMemo.id, 'file:///c.jpg');
  await u.bridge.syncAll();
  assert.deepEqual([u.store.outboxCount(), u.store.getMemo(waitingMemo.id).photos], [1, ['file:///c.jpg']]);
  // 사진 올리기를 기다리는 동안에도 그 메모는 남이 고친 내용을 받음
  const waitingNote = u.records(SERVER_WS).notes;
  waitingNote.set(waitingMemo.id, { ...waitingNote.get(waitingMemo.id), title: '남이 고친 제목' });
  await u.bridge.syncAll();
  assert.deepEqual([u.store.getMemo(waitingMemo.id).title, u.store.getMemo(waitingMemo.id).photos], ['남이 고친 제목', ['file:///c.jpg']]);
  // 저장소: 올린 뒤 바꾸기. 그새 지워졌으면 false, 같은 첨부가 이미 있으면 기기 파일만 뺌
  assert.equal(u.store.resolveUpload(SERVER_WS, waitingMemo.id, 'file:///없는.jpg', ASSET), false);
  assert.equal(u.store.resolveUpload(SERVER_WS, waitingMemo.id, 'file:///c.jpg', ASSET), true);
  assert.deepEqual(u.store.peekOutbox(10).at(-1).changes, [{ kind: 'link', entity: 'note_attachments', data: { note_id: waitingMemo.id, asset_id: ASSET, position: 0 } }]);
  u.store.attachPhoto(waitingMemo.id, 'file:///d.jpg');
  const rows = u.store.outboxCount();
  assert.equal(u.store.resolveUpload(SERVER_WS, waitingMemo.id, 'file:///d.jpg', ASSET), true);
  assert.deepEqual([u.store.getMemo(waitingMemo.id).photos, u.store.outboxCount()], [[ASSET], rows]);
  rejects(() => u.store.resolveUpload(SERVER_WS, waitingMemo.id, 'file:///c.jpg', 'uuid-아님'), 'invalid_input', 'assetId');
});

test('공간의 내 역할·멤버 수·이름을 맞춘다: 보기 전용으로 바뀌면 기기에서도 저장이 막히고, 다른 기기에서 들어간 공간이 생긴다', async () => {
  const list = [{ id: SERVER_WS, name: '팀 공간', description: '', role: 'EDITOR' }];
  const t = world({ account: ACCOUNT, bridgeOptions: { workspaces: { list: async () => { if (list.offline) throw new Error('fetch failed'); return list; } } } });
  const members = t.records(SERVER_WS).workspace_members;
  members.set(ACCOUNT, { account_id: ACCOUNT, role: 'EDITOR', status: 'ACTIVE' });
  members.set(STRANGER, { account_id: STRANGER, role: 'OWNER', status: 'ACTIVE' });
  members.set(OTHER_WS, { account_id: OTHER_WS, role: 'EDITOR', status: 'LEFT' });
  await t.bridge.syncAll();
  const info = () => { const w = t.store.getWorkspaces().find(x => x.serverId === SERVER_WS); return [w.name, w.role, w.members]; };
  assert.deepEqual(info(), ['팀 공간', '멤버', 2]);                                   // 나간 사람은 세지 않음
  list[0] = { ...list[0], name: '이름이 바뀐 공간', description: '설명' };
  list.push({ id: OTHER_WS, name: '다른 기기에서 들어간 공간', description: null, role: 'VIEWER' });
  members.set(ACCOUNT, { account_id: ACCOUNT, role: 'VIEWER', status: 'ACTIVE' });
  const out = await t.bridge.syncAll();
  assert.deepEqual(info(), ['이름이 바뀐 공간', '보기 전용', 2]);
  rejects(() => t.store.addMemo({ title: '보기 전용이라 못 씀' }), 'read_only');
  const joined = t.store.getWorkspaces().find(w => w.serverId === OTHER_WS);
  assert.deepEqual([joined.name, joined.role, out[joined.id].status], ['다른 기기에서 들어간 공간', '보기 전용', 'OK']);   // 새 공간도 같은 호출에서 동기화
  list.offline = true;                                                                  // 목록을 못 받아도 동기화는 계속
  assert.equal((await t.bridge.syncAll())[t.team].status, 'OK');
});

test('바뀐 기록만 화면용 표에 반영하고, 많을 때는 나눠서 반영한다', async () => {
  const t = world();
  const applied = [];
  const counting = { ...t.store, applyServer: (ws, items) => { applied.push(items.length); return t.store.applyServer(ws, items); } };
  const bridge = createBridge({ store: counting, engine: t.engine, db: {}, transport: {}, pause: async () => { t.pauses = (t.pauses ?? 0) + 1; } });
  const notes = t.records(SERVER_WS).notes;
  const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  for (let i = 0; i < 450; i++) notes.set(id(i), { id: id(i), title: `받은 메모 ${i}`, body: '', strokes: [] });
  await bridge.syncAll();
  assert.deepEqual([applied, t.pauses, t.store.getMemos().length], [[200, 200, 50], 2, 450]);       // 200개씩, 사이에 화면에 차례를 넘김
  applied.length = 0;
  await bridge.syncAll();
  assert.deepEqual(applied, []);                                                                     // 달라진 것이 없으면 아무것도 반영하지 않음
  notes.set(id(7), { ...notes.get(id(7)), title: '남이 고친 제목' });
  notes.delete(id(8));
  await bridge.syncAll();
  assert.deepEqual([applied, t.store.getMemo(id(7)).title, t.store.getMemo(id(8)), t.store.getMemos().length], [[2], '남이 고친 제목', null, 449]);

  // 화면에서 방금 한 저장 때문에 건너뛴 기록은 "반영함"으로 기억하지 않는다: 그 저장이 넘어간 뒤 서버 값이 들어옴
  const mine = t.store.addTask({ title: '내 할 일', date: '2026-11-20' });
  await bridge.syncAll();
  notes.set(id(9), { ...notes.get(id(9)), title: '남이 고친 9번' });
  t.during = () => { t.store.updateMemo(id(9), { taskIds: [mine.id] }); };                           // 그 메모에 할 일을 연결 (메모 내용은 안 바뀜)
  await bridge.syncAll();
  assert.deepEqual([t.store.getMemo(id(9)).title, t.store.getMemo(id(9)).taskIds, t.store.outboxCount()], ['남이 고친 9번', [mine.id], 0]);

  // 기기에서 그 기록이 없어졌으면(공간을 지웠다 다시 받음) 지문이 같아도 다시 넣음
  applied.length = 0;
  t.store.deleteWorkspace(t.team);
  t.store.upsertServerWorkspace({ id: SERVER_WS, name: '팀 공간', role: 'EDITOR', members: 2 });
  await bridge.syncAll();
  assert.equal(t.store.getWorkspaces().length, 2);
  t.store.switchWorkspace(SERVER_WS);
  assert.deepEqual([applied.reduce((a, b) => a + b, 0) >= 449, t.store.getMemos().length], [true, 449]);
  // refresh는 전부 다시 맞춤
  applied.length = 0;
  await bridge.refresh(SERVER_WS);
  assert.equal(applied.reduce((a, b) => a + b, 0) >= 449, true);
});

test('충돌은 스스로 합쳐 보고, 못 합치면 화면에서 고를 수 있게 내용을 준다', async () => {
  const calls = [];
  let answers = [];
  const engineExtra = {
    resolveConflict: async (ctx, seq, choice) => { calls.push(['resolve', seq, choice]); const a = answers.shift(); if (a) throw Object.assign(new Error(a), { code: a }); },
    discardOutbox: async (ctx, seq) => { calls.push(['discard', seq]); },
    listConflicts: async () => [{ outboxSeq: 7, mergeable: false, canKeep: true, items: [{ entity: 'notes', id: 'n', kind: 'update', reason: 'REVISION_MISMATCH', serverDeleted: false, fields: [{ field: 'title', base: 'a', mine: 'b', server: 'c' }] }] }],
    listOutbox: async () => [{ seq: 7, status: 'CONFLICT', lastError: null, changes: [] }, { seq: 8, status: 'FAILED', lastError: 'CHECK_FAILED: 제목이 너무 깁니다: 200자까지', changes: [{ kind: 'update' }] }],
  };
  const t = world({ engineExtra });
  const flushes = [];
  const real = t.engine.syncNow;
  t.engine.syncNow = async ctx => { const r = await real(ctx); return flushes.length ? { ...r, flush: flushes.shift() } : r; };
  const conflict = { status: 'CONFLICT', sent: 0, outboxSeq: 7, conflicts: [] };
  // 합칠 수 있는 충돌: 합치고 다시 보냄
  flushes.push(conflict);
  let out = await t.bridge.syncAll();
  assert.deepEqual([calls, out[t.team].flush.status, out[t.team].merged], [[['resolve', 7, 'merge']], 'DONE', 1]);
  // 같은 칸을 양쪽에서 고친 충돌: 그대로 두고 화면에 맡김
  calls.length = 0; answers = ['CANNOT_MERGE']; flushes.push(conflict);
  out = await t.bridge.syncAll();
  assert.deepEqual([calls, out[t.team].flush.status, out[t.team].merged], [[['resolve', 7, 'merge']], 'CONFLICT', undefined]);
  // 합친 뒤에도 계속 충돌이면 세 번까지만
  calls.length = 0; flushes.push(conflict, conflict, conflict, conflict, conflict);
  out = await t.bridge.syncAll();
  assert.deepEqual([calls.length, out[t.team].flush.status, out[t.team].merged], [3, 'CONFLICT', 3]);
  flushes.length = 0;
  // 화면용: 무엇이 다른지, 서버가 거절한 저장
  const found = await t.bridge.issues(t.team);
  assert.deepEqual([found.conflicts[0].items[0].fields[0], found.rejected], [{ field: 'title', base: 'a', mine: 'b', server: 'c' },
    [{ outboxSeq: 8, code: 'CHECK_FAILED', error: '제목이 너무 깁니다: 200자까지', changes: [{ kind: 'update' }] }]]);
  // 사용자가 고르면 풀고 이어서 동기화
  calls.length = 0;
  const syncs = () => t.calls.filter(c => c.startsWith('syncNow')).length;
  const before = syncs();
  assert.equal((await t.bridge.resolve(SERVER_WS, 7, 'keep_both')).flush.status, 'DONE');
  assert.equal((await t.bridge.discard(t.team, 8)).flush.status, 'DONE');
  assert.deepEqual([calls, syncs() - before], [[['resolve', 7, 'keep_both'], ['discard', 8]], 2]);         // 풀 때마다 바로 이어서 보내고 받음
  await assert.rejects(t.bridge.resolve('없는 공간', 7, 'keep_mine'), e => e.code === 'not_found');
  // conflicts: 'ask'면 스스로 합치지 않음
  const ask = world({ engineExtra, bridgeOptions: { conflicts: 'ask' } });
  const realAsk = ask.engine.syncNow;
  ask.engine.syncNow = async ctx => ({ ...(await realAsk(ctx)), flush: conflict });
  calls.length = 0;
  assert.deepEqual([(await ask.bridge.syncAll())[ask.team].flush.status, calls], ['CONFLICT', []]);
  assert.throws(() => createBridge({ store: t.store, engine: t.engine, db: {}, transport: {}, conflicts: 'always' }), /conflicts/);
});

test('start: 저장하면 알아서 돌고, 실패하면 간격을 늘려 다시 시도하고, stop으로 멈춘다', async () => {
  const t = world();
  const timers = { list: [], set(fn, ms) { const timer = { fn, ms }; this.list.push(timer); return timer; }, clear(timer) { this.list = this.list.filter(x => x !== timer); } };
  const fire = async () => { const timer = timers.list.shift(); await timer.fn(); return timer.ms; };
  const results = [], errors = [];
  const stop = t.bridge.start({ timers, onResult: out => results.push(Object.values(out).map(r => r.flush?.status ?? r.status)), onError: e => errors.push(e.message) });
  assert.equal(t.bridge.start({ timers }), stop);                                       // 두 번 불러도 하나
  assert.deepEqual(timers.list.map(x => x.ms), [0]);                                    // 시작하자마자 한 번
  await fire();
  assert.deepEqual([results, timers.list], [[['DONE']], []]);
  t.store.addMemo({ title: '첫 저장' });
  t.store.addMemo({ title: '바로 이어진 저장' });
  assert.deepEqual(timers.list.map(x => x.ms), [400]);                                  // 조금 모아서 한 번
  await fire();
  assert.deepEqual([t.store.outboxCount(), t.handed.length, timers.list], [0, 2, []]);  // 다리가 줄을 지운 것은 새 일이 아님
  // 연결이 안 되면 2초 → 5초 → 15초 → 60초 → 60초
  t.flush = { status: 'OFFLINE', sent: 0, error: 'fetch failed', code: 'NETWORK' };
  t.store.addMemo({ title: '오프라인 저장' });
  const waits = [await fire()];
  for (let i = 0; i < 5; i++) waits.push(await fire());
  assert.deepEqual([waits, timers.list.map(x => x.ms)], [[400, 2000, 5000, 15000, 60000, 60000], [60000]]);
  // 기다리는 중에 저장하면 그 기다림 대신 곧 다시
  t.store.addMemo({ title: '기다리는 중 저장' });
  assert.deepEqual(timers.list.map(x => x.ms), [400]);
  t.flush = { status: 'DONE', sent: 1 };
  await fire();
  assert.deepEqual(timers.list, []);                                                    // 성공하면 다시 시도하지 않고
  t.flush = { status: 'OFFLINE', sent: 0, error: 'fetch failed', code: 'NETWORK' };
  t.store.addMemo({ title: '다시 오프라인' });
  await fire();
  assert.deepEqual(timers.list.map(x => x.ms), [2000]);                                 // 간격도 처음부터
  // 한 공간의 오류도 다시 시도
  t.flush = { status: 'DONE', sent: 0 };
  const sync = t.engine.syncNow;
  t.engine.syncNow = async () => { throw new Error('서버 오류'); };
  await fire();
  assert.deepEqual([results.at(-1), timers.list.map(x => x.ms)], [['ERROR'], [5000]]);
  t.engine.syncNow = sync;
  stop();
  assert.deepEqual(timers.list, []);
  t.store.addMemo({ title: '멈춘 뒤 저장' });
  assert.deepEqual([timers.list, errors], [[], []]);                                    // 멈춘 뒤에는 돌지 않음

  // 다른 계정의 기기: 알리고 다시 시도하지 않음
  const v = world({ account: ACCOUNT });
  v.store.bindAccount(STRANGER);
  const failed = [];
  v.bridge.start({ timers, onError: e => failed.push(e.code) });
  await fire();
  assert.deepEqual([failed, timers.list], [['account_mismatch'], []]);
});

test('status와 signOut: 안 보낸 저장이 남아 있으면 지우지 않고 알려 준다', async () => {
  let pending = 2, lastError = null, cleared = 0;
  const engineExtra = {
    getSyncStatus: async () => ({ pending, conflicts: lastError === 'c' ? 1 : 0, failed: 0, lastError: lastError === 'c' ? null : lastError, attempts: lastError ? 4 : 0 }),
    clearLocalSync: async () => { cleared++; return { droppedOutbox: pending }; },
  };
  const t = world({ engineExtra });
  t.store.createWorkspace({ name: '아직 서버에 없는 공간' });
  const unlinked = t.store.getWorkspaces().at(-1).id;
  t.store.switchWorkspace(unlinked);
  t.store.addMemo({ title: '올라갈 곳이 없는 메모' });
  t.store.switchWorkspace(t.team);
  let s = await t.bridge.status();
  assert.deepEqual([s.state, s.unsent, s.workspaces[t.team], s.workspaces[unlinked].waiting], ['pending', 3, { waiting: 0, pending: 2, conflicts: 0, failed: 0, lastError: null, attempts: 0 }, 1]);
  lastError = 'c';
  assert.equal((await t.bridge.status()).state, 'attention');
  lastError = 'AUTH_REQUIRED: 로그인이 필요합니다';
  s = await t.bridge.status();
  assert.deepEqual([s.state, s.workspaces[t.team].attempts], ['needs_login', 4]);
  lastError = null;

  const timers = { list: [], set(fn, ms) { const x = { fn, ms }; this.list.push(x); return x; }, clear(x) { this.list = this.list.filter(y => y !== x); } };
  t.bridge.start({ timers });
  assert.deepEqual(await t.bridge.signOut(), { cleared: false, unsent: 3 });            // 그대로 둠
  assert.deepEqual([cleared, t.store.getWorkspaces().length, timers.list.length], [0, 3, 1]);
  assert.deepEqual(await t.bridge.signOut({ force: true }), { cleared: true, unsent: 3 });
  assert.deepEqual([cleared, t.store.getWorkspaces().length, t.store.outboxCount(), timers.list.length], [1, 1, 0, 0]);   // 기기 기록을 지우고 알아서 돌기도 멈춤

  // 남은 저장이 없으면 마지막 동기화 뒤 바로 지움
  pending = 0;
  const u = world({ engineExtra });
  u.store.addMemo({ title: '보낼 메모' });
  assert.deepEqual(await u.bridge.signOut(), { cleared: true, unsent: 0 });
  assert.deepEqual([u.handed.map(h => h[2]), u.store.getWorkspaces().length], [['create:notes'], 1]);   // 지우기 전에 올려 보냄
});
