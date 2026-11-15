/**
 * 동기화 다리: 기기 저장소(store) ↔ 동기화 엔진(fe/stella/local-sync.ts) ↔ 서버.
 * 이 파일은 네트워크·React Native를 직접 쓰지 않고, 필요한 것을 넘겨받습니다.
 *
 *   import * as engine from '@/lib/stella/local-sync';          // setupLocalSync, saveLocal, syncNow, listLocal
 *   const bridge = createBridge({
 *     store, engine, db: expoSqliteDb(await SQLite.openDatabaseAsync('stella.db')), transport: supabaseTransport(supabase),
 *     accountId, deviceId,
 *     favorites: { set: (ws, ids, on) => setNoteFavorites(supabase, ws, ids, on), list: ws => listNoteFavorites(supabase, ws) },
 *   });
 *   await bridge.syncAll();        // 앱 시작·화면 복귀·실시간 신호(watchWorkspace)·저장 직후(store.subscribeOutbox)에 부름
 *
 * 한 번의 sync:
 *   ① 보낼 목록(store.peekOutbox)을 엔진의 saveLocal에 넘기고 지움 (즐겨찾기는 favorites.set으로)
 *   ② 엔진이 보내고 받음 (syncNow)
 *   ③ 엔진이 가진 기록(안 보낸 내 수정이 얹힌 값)을 store.applyServer로 화면용 표에 맞춤. 서버에서 사라진 기록은 지움
 */
export function createBridge({ store, engine, db, transport, accountId = null, deviceId = null, favorites = null }) {
  for (const fn of ['saveLocal', 'syncNow', 'listLocal']) if (typeof engine?.[fn] !== 'function') throw new Error(`engine.${fn}가 필요해요 (local-sync)`);
  const contextOf = serverId => ({ db, transport, workspaceId: serverId, myAccountId: accountId, deviceId });
  let running = null;

  /** ① 공간 연결이 끝난(serverId가 있는) 줄만 넘김. 넘긴 줄 수를 돌려줌 */
  async function handOff() {
    let moved = 0;
    for (const row of store.peekOutbox(1000)) {
      if (!row.serverId) continue;                                   // 아직 서버에 없는 공간: linkWorkspace 뒤에 올라감
      if (row.changes.every(c => c.kind === 'favorite')) {
        if (!favorites) continue;
        try {
          for (const c of row.changes) await favorites.set(row.serverId, c.data.note_ids, c.data.favorite);
        } catch { continue; }                                        // 연결이 안 되면 남겨 두고 다음에
      } else {
        await engine.saveLocal(contextOf(row.serverId), row.changes);
      }
      store.ackOutbox(row.seq);
      moved++;
    }
    return moved;
  }

  /** ③ 엔진의 기록 → 저장소 */
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
    const applied = store.applyServer(serverId, items);
    if (favorites?.list) {
      try { store.applyFavorites(serverId, [...await favorites.list(serverId)]); } catch { /* 다음 sync 때 */ }
    }
    return applied;
  }

  /** 공유 공간 하나를 동기화. 돌려주는 값: { status, flush, pull, applied } — flush.status가 CONFLICT·BLOCKED면 화면에서 풀어야 함 */
  async function syncWorkspace(workspaceId) {
    const ws = store.getWorkspaces().find(w => w.id === workspaceId || w.serverId === workspaceId);
    if (!ws || ws.personal) return { status: 'NOT_SHARED' };
    if (!ws.serverId) return { status: 'NOT_LINKED' };
    await handOff();
    const { flush, pull } = await engine.syncNow(contextOf(ws.serverId));
    if (pull.status === 'CLOSED') return { status: 'CLOSED', flush, pull };   // 공간에서 빠짐·공간 삭제: 화면에서 알리고 store.deleteWorkspace
    const applied = await reconcile(ws.serverId);
    return { status: 'OK', flush, pull, applied };
  }

  /** 연결된 공유 공간 전부. 동시에 여러 번 불러도 한 번만 돎 */
  function syncAll() {
    if (running) return running;
    const run = (async () => {
      const out = {};
      for (const ws of store.getWorkspaces()) if (!ws.personal && ws.serverId) out[ws.id] = await syncWorkspace(ws.id);
      return out;
    })();
    running = run;
    // 끝난 뒤에 비움 (연결된 공간이 없어 바로 끝나는 경우에도 다음 호출이 새로 돌도록, 대입 뒤에 정리)
    const clear = () => { if (running === run) running = null; };
    run.then(clear, clear);
    return run;
  }

  /** 충돌·거절을 엔진에서 푼 뒤(resolveConflict·discardOutbox) 화면용 표를 엔진 값으로 다시 맞춤 */
  const refresh = workspaceId => {
    const ws = store.getWorkspaces().find(w => w.id === workspaceId || w.serverId === workspaceId);
    return ws?.serverId ? reconcile(ws.serverId) : Promise.resolve(null);
  };

  return Object.freeze({ syncWorkspace, syncAll, refresh });
}
