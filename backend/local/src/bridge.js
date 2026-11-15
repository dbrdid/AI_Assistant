import { fail } from './errors.js';

/** 도는 동안 화면에서 새로 한 저장이 있으면 이어서 다시 도는 횟수 (처음 포함) */
const MAX_ROUNDS = 3;
/** 서버 set_note_favorites가 한 번에 받는 메모 수 */
const FAVORITE_BATCH = 500;
/** 다시 보내도 같은 결과인 별표 오류 (서버에 없는 메모·틀린 값): 보내기가 끝난 뒤에도 나면 그 줄을 버림 */
const FAVORITE_GIVE_UP = new Set(['NOT_FOUND', 'INVALID_REQUEST']);

const isFavoriteRow = row => row.changes.every(c => c.kind === 'favorite');
const codeOf = error => (typeof error?.code === 'string' && /^[A-Za-z_]+$/.test(error.code)
  ? error.code
  : /^([A-Z_]+):/.exec(String(error?.message ?? ''))?.[1] ?? 'UNKNOWN');

/**
 * 동기화 다리: 기기 저장소(store) ↔ 동기화 엔진(frontend lib/stella/local-sync.ts) ↔ 서버.
 * 이 파일은 네트워크·React Native를 직접 쓰지 않고, 필요한 것을 넘겨받습니다.
 *
 *   import * as engine from '@/lib/stella/local-sync';          // setupLocalSync, saveLocal, syncNow, listLocal, bindSyncAccount
 *   const bridge = createBridge({
 *     store, engine, db: expoSqliteDb(await SQLite.openDatabaseAsync('stella.db')), transport: supabaseTransport(supabase),
 *     accountId, deviceId,
 *     favorites: { set: (ws, ids, on) => setNoteFavorites(supabase, ws, ids, on), list: ws => listNoteFavorites(supabase, ws) },
 *   });
 *   await bridge.syncAll();        // 앱 시작·화면 복귀·실시간 신호(watchWorkspace)·저장 직후(store.subscribeOutbox)에 부름
 *
 * 공간 하나의 한 번:
 *   ① 그 공간의 보낼 목록(store.peekOutbox)을 엔진의 saveLocal에 넘기고 지움.
 *      넘길 때 handoffKey를 붙여서, 넘긴 직후 앱이 꺼져 같은 줄을 다시 넘겨도 엔진에는 한 번만 들어감
 *   ② 엔진이 보내고 받음 (syncNow)
 *   ③ 별표를 서버에 보냄 (favorites.set). 메모가 서버에 올라간 뒤여야 해서 ② 다음
 *   ④ 엔진이 가진 기록(안 보낸 내 수정이 얹힌 값)을 store.applyServer로 화면용 표에 맞춤. 서버에서 사라진 기록은 지움.
 *      ①~④ 사이에 화면에서 한 저장이 건드린 기록은 저장소가 건너뛰고, 다리가 이어서 한 번 더 돌아 맞춤
 *
 * 지키는 것:
 *   - 한 번에 하나만: syncAll·syncWorkspace·refresh가 겹쳐 불려도 차례로 돎 (같은 저장이 두 번 넘어가지 않음)
 *   - 한 공간이 막혀도 다른 공간은 계속: 결과에 { status: 'ERROR' } 또는 handOff: { status: 'BLOCKED', seq, code, error }
 *   - 계정: accountId를 넘기면 첫 동기화 전에 engine.bindSyncAccount를 불러, 다른 계정이 남긴 기록·안 보낸 수정을 지움.
 *     기기 저장소가 다른 계정에 묶여 있으면(store.getAccount) 동기화하지 않고 account_mismatch
 */
export function createBridge({ store, engine, db, transport, accountId = null, deviceId = null, favorites = null }) {
  for (const fn of ['saveLocal', 'syncNow', 'listLocal']) if (typeof engine?.[fn] !== 'function') throw new Error(`engine.${fn}가 필요해요 (local-sync)`);
  const contextOf = serverId => ({ db, transport, workspaceId: serverId, myAccountId: accountId, deviceId });
  const find = workspaceId => store.getWorkspaces().find(w => w.id === workspaceId || w.serverId === workspaceId);

  // 다리의 일은 한 줄로: 앞의 일이 끝난 뒤에 다음 일
  let chain = Promise.resolve();
  const serial = fn => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };

  let bound = null;
  /** 첫 동기화 전에 한 번: 이 기기가 다른 계정 것이면 멈추고, 엔진 DB를 이 계정에 묶음 */
  async function ensureAccount() {
    if (!accountId) return;
    const local = typeof store.getAccount === 'function' ? store.getAccount() : null;
    if (local && local !== accountId) fail('account_mismatch');
    if (typeof engine.bindSyncAccount !== 'function') return;
    bound ??= engine.bindSyncAccount(db, accountId);
    try { await bound; } catch (error) { bound = null; throw error; }
  }

  /** 그 공간의 보낼 목록을 seq 순서로 (지워도 건너뛰지 않게 seq로 이어 읽음) */
  function* outboxOf(workspaceId) {
    let afterSeq = 0;
    for (;;) {
      const rows = store.peekOutbox(200, { workspaceId, afterSeq });
      if (!rows.length) return;
      yield* rows;
      afterSeq = rows[rows.length - 1].seq;
    }
  }

  /** ① 넘기기. 엔진이 받지 않는 줄이 있으면 그 공간은 거기서 멈추고 { seq, code, error }를 돌려줌 (없으면 null) */
  async function handOff(ws) {
    for (const row of outboxOf(ws.id)) {
      if (isFavoriteRow(row)) continue;                              // 별표는 ③에서
      try {
        await engine.saveLocal(contextOf(ws.serverId), row.changes, { handoffKey: `${row.seq}:${row.createdAt}` });
      } catch (error) {
        return { status: 'BLOCKED', seq: row.seq, code: codeOf(error), error: String(error?.message ?? error) };
      }
      store.ackOutbox(row.seq);
    }
    return null;
  }

  /** ③ 별표 보내기. 앞에 아직 안 넘어간 저장이 있으면(그 메모가 서버에 없을 수 있음) 거기서 멈춤 */
  async function sendFavorites(ws, pushed) {
    if (!favorites) return;
    for (const row of outboxOf(ws.id)) {
      if (!isFavoriteRow(row)) return;
      try {
        for (const c of row.changes) {
          const ids = c.data.note_ids;
          for (let i = 0; i < ids.length; i += FAVORITE_BATCH) await favorites.set(ws.serverId, ids.slice(i, i + FAVORITE_BATCH), c.data.favorite);
        }
      } catch (error) {
        if (!(pushed && FAVORITE_GIVE_UP.has(codeOf(error)))) return;   // 연결 문제 등: 남겨 두고 다음에
      }
      store.ackOutbox(row.seq);
    }
  }

  /** ④ 엔진의 기록 → 저장소 */
  async function reconcile(serverId) {
    const local = store.sharedState(serverId);
    const items = [];
    const seen = { notes: new Set(), tasks: new Set() };
    for (const entity of ['notes', 'tasks', 'events']) {
      for (const r of await engine.listLocal(db, serverId, entity, { includeDeleted: true })) {
        items.push({ entity, data: r.data });
        seen[entity === 'notes' ? 'notes' : 'tasks'].add(r.key);
      }
    }
    for (const n of local.notes) if (!seen.notes.has(n.id)) items.push({ entity: 'notes', data: { id: n.id }, purged: true });
    for (const t of local.tasks) if (!seen.tasks.has(t.id)) items.push({ entity: t.kind === 'event' ? 'events' : 'tasks', data: { id: t.id }, purged: true });

    const wanted = new Map();
    const links = (await engine.listLocal(db, serverId, 'note_attachments')).map(r => r.data).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const l of links) {
      if (!wanted.has(l.note_id)) wanted.set(l.note_id, []);
      wanted.get(l.note_id).push(l.asset_id);
    }
    const have = new Map(local.notes.map(n => [n.id, n.photos]));
    for (const noteId of new Set([...wanted.keys(), ...have.keys()])) {
      const want = wanted.get(noteId) ?? [], cur = have.get(noteId) ?? [];
      for (const assetId of cur) if (!want.includes(assetId)) items.push({ entity: 'note_attachments', data: { note_id: noteId, asset_id: assetId }, removed: true });
      for (const assetId of want) if (!cur.includes(assetId)) items.push({ entity: 'note_attachments', data: { note_id: noteId, asset_id: assetId } });
    }
    // 여기까지 읽는 동안 화면에서 한 저장은 보낼 목록에 있고, applyServer가 그 기록을 건너뜀
    const applied = store.applyServer(serverId, items);
    if (favorites?.list) {
      try { store.applyFavorites(serverId, [...await favorites.list(serverId)]); } catch { /* 다음 sync 때 */ }
    }
    return applied;
  }

  async function syncOnce(ws) {
    const blocked = await handOff(ws);
    const { flush, pull } = await engine.syncNow(contextOf(ws.serverId));
    if (pull.status === 'CLOSED') return { status: 'CLOSED', flush, pull };   // 공간에서 빠짐·공간 삭제: 화면에서 알리고 store.deleteWorkspace
    await sendFavorites(ws, flush.status === 'DONE');
    const applied = await reconcile(ws.serverId);
    return { status: 'OK', flush, pull, applied, ...(blocked ? { handOff: blocked } : {}) };
  }

  async function attempt(workspaceId) {
    const ws = find(workspaceId);
    if (!ws || ws.personal) return { status: 'NOT_SHARED' };
    if (!ws.serverId) return { status: 'NOT_LINKED' };
    try {
      return await syncOnce(ws);
    } catch (error) {
      return { status: 'ERROR', code: codeOf(error), error: String(error?.message ?? error) };
    }
  }

  /** 넘길 저장이 남은 공간 (막힌 공간 제외). 도는 동안 화면에서 새로 한 저장이 여기에 잡힘 */
  function waiting(stuck) {
    const ids = new Set();
    for (const row of store.peekOutbox(1000)) {
      if (row.serverId && !stuck.has(row.workspaceId) && !isFavoriteRow(row)) ids.add(row.workspaceId);
    }
    return [...ids];
  }

  /** ids를 차례로 돌고, 그동안 새 저장이 생긴 공간은 이어서 다시 (MAX_ROUNDS까지). only가 있으면 그 공간만 */
  async function rounds(ids, only = null) {
    await ensureAccount();
    const out = {}, stuck = new Set();
    for (let round = 0; round < MAX_ROUNDS && ids.length; round++) {
      for (const id of ids) {
        out[id] = await attempt(id);
        if (out[id].status !== 'OK' || out[id].handOff) stuck.add(id);
      }
      ids = waiting(stuck).filter(id => !only || only.includes(id));
    }
    return out;
  }

  /**
   * 공유 공간 하나를 동기화. 돌려주는 값: { status, flush, pull, applied, handOff? }
   *   status: OK · CLOSED · NOT_SHARED · NOT_LINKED · ERROR(code, error)
   *   flush.status가 CONFLICT·BLOCKED면 화면에서 풀어야 함 (local-sync의 resolveConflict·discardOutbox 뒤 refresh)
   *   handOff가 있으면 엔진이 그 줄을 받지 않은 것: 고칠 수 없으면 store.ackOutbox(handOff.seq)로 버리고 refresh
   */
  function syncWorkspace(workspaceId) {
    return serial(async () => {
      const ws = find(workspaceId);
      if (!ws) return { status: 'NOT_SHARED' };
      return (await rounds([ws.id], [ws.id]))[ws.id];
    });
  }

  let running = null;
  /** 연결된 공유 공간 전부: { 기기 공간 id: 결과 }. 도는 중에 다시 부르면 같은 실행을 돌려줌 */
  function syncAll() {
    if (running) return running;
    const run = serial(() => rounds(store.getWorkspaces().filter(ws => !ws.personal && ws.serverId).map(ws => ws.id)));
    running = run;
    // 끝난 뒤에 비움 (대입 뒤에 정리해야, 바로 끝나는 경우에도 다음 호출이 새로 돎)
    const clear = () => { if (running === run) running = null; };
    run.then(clear, clear);
    return run;
  }

  /** 충돌·거절을 엔진에서 푼 뒤(resolveConflict·discardOutbox) 화면용 표를 엔진 값으로 다시 맞춤 */
  const refresh = workspaceId => serial(() => {
    const ws = find(workspaceId);
    return ws?.serverId ? reconcile(ws.serverId) : null;
  });

  return Object.freeze({ syncWorkspace, syncAll, refresh });
}
