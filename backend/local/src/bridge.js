import { fail } from './errors.js';
import { isUuid } from './validate.js';

/** 도는 동안 화면에서 새로 한 저장이 있으면 이어서 다시 도는 횟수 (처음 포함) */
const MAX_ROUNDS = 3;
/** 서버 set_note_favorites가 한 번에 받는 메모 수 */
const FAVORITE_BATCH = 500;
/** 다시 보내도 같은 결과인 별표 오류 (서버에 없는 메모·틀린 값): 보내기가 끝난 뒤에도 나면 그 줄을 버림 */
const FAVORITE_GIVE_UP = new Set(['NOT_FOUND', 'INVALID_REQUEST']);
/** 다시 올려도 같은 결과인 사진 올리기 오류: 그 사진은 이 기기에만 남기고 결과의 uploadFailed로 알림 */
const UPLOAD_GIVE_UP = new Set(['INVALID_REQUEST', 'UNSUPPORTED_TYPE', 'TOO_LARGE', 'NOT_FOUND', 'FILE_NOT_FOUND', 'HASH_MISMATCH', 'SIZE_MISMATCH', 'TYPE_MISMATCH']);
/** 한 번의 충돌에서 스스로 합치기를 되풀이하는 횟수 (합친 뒤 보내는 사이에 상대가 또 고친 경우) */
const MERGE_TRIES = 3;
/** 화면용 표에 한 번에 반영하는 기록 수. 사이사이 화면에 차례를 넘김 */
const APPLY_CHUNK = 200;
/** start(): 실패한 뒤 다시 시도하는 간격 (계속 실패하면 마지막 값) */
const RETRY_MS = [2000, 5000, 15000, 60000];

/** 동기화 엔진이 아닌 다른 길로 가는 줄: 별표(favorites.set), 올리기를 기다리는 사진(photos.upload) */
const isSideRow = row => row.changes.every(c => c.kind === 'favorite' || c.kind === 'upload');
const codeOf = error => (typeof error?.code === 'string' && /^[A-Za-z_]+$/.test(error.code)
  ? error.code
  : /^([A-Z_]+):/.exec(String(error?.message ?? ''))?.[1] ?? 'UNKNOWN');

/** 기록 내용의 지문 (길이 + 53비트 해시). 지난번에 반영한 것과 같으면 다시 반영하지 않음 */
function fingerprint(data) {
  const text = JSON.stringify(data);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${4294967296 * (2097151 & h2) + (h1 >>> 0)}`;
}

/**
 * 동기화 다리: 기기 저장소(store) ↔ 동기화 엔진(frontend lib/stella/local-sync.ts) ↔ 서버.
 * 이 파일은 네트워크·React Native를 직접 쓰지 않고, 필요한 것을 넘겨받습니다.
 *
 *   import * as engine from '@/lib/stella/local-sync';
 *   const bridge = createBridge({
 *     store, engine, db: expoSqliteDb(await SQLite.openDatabaseAsync('stella.db')), transport: supabaseTransport(supabase),
 *     accountId, deviceId,
 *     favorites: { set: (ws, ids, on) => setNoteFavorites(supabase, ws, ids, on), list: ws => listNoteFavorites(supabase, ws) },
 *     photos: { upload: async (ws, ref) => (await uploadAttachment(supabase, { workspaceId: ws, assetId: newId(), ...파일(ref) })).id },
 *     workspaces: { list: async () => (await listMyWorkspaces()).map(m => ({ id: m.workspace.id, name: m.workspace.name, description: m.workspace.description, role: m.role })) },
 *   });
 *   const stop = bridge.start({ onResult });   // 저장할 때마다 알아서 돌고, 실패하면 간격을 늘려 다시 시도
 *   bridge.syncAll();                          // 앱이 앞으로 올 때, 실시간 신호(watchWorkspace)가 올 때
 *
 * 공간 하나의 한 번:
 *   ① 그 공간의 보낼 목록(store.peekOutbox)을 엔진의 saveLocal에 넘기고 지움.
 *      넘길 때 handoffKey를 붙여서, 넘긴 직후 앱이 꺼져 같은 줄을 다시 넘겨도 엔진에는 한 번만 들어감
 *   ② 엔진이 보내고 받음 (syncNow). 충돌이 나면 스스로 합쳐 보고(서로 다른 칸·다른 줄·다른 획) 다시 보냄
 *   ③ 별표를 서버에 보내고(favorites.set, 메모가 올라간 뒤여야 해서 ② 다음), 올리기를 기다리던 사진을 올림(photos.upload)
 *   ④ 엔진이 가진 기록(안 보낸 내 수정이 얹힌 값) 가운데 지난번과 달라진 것만 store.applyServer로 화면용 표에 맞춤.
 *      서버에서 사라진 기록은 지움. 공간의 내 역할·멤버 수도 맞춤.
 *      ①~④ 사이에 화면에서 한 저장이 건드린 기록은 저장소가 건너뛰고, 다리가 이어서 한 번 더 돌아 맞춤
 *
 * 지키는 것:
 *   - 한 번에 하나만: syncAll·syncWorkspace·refresh·resolve가 겹쳐 불려도 차례로 돎 (같은 저장이 두 번 넘어가지 않음)
 *   - 한 공간이 막혀도 다른 공간은 계속: 결과에 { status: 'ERROR' } 또는 handOff: { status: 'BLOCKED', seq, code, error }
 *   - 계정: accountId를 넘기면 첫 동기화 전에 engine.bindSyncAccount를 불러, 다른 계정이 남긴 기록·안 보낸 수정을 지움.
 *     기기 저장소가 다른 계정에 묶여 있으면(store.getAccount) 동기화하지 않고 account_mismatch
 *
 * 옵션: conflicts 'merge'(기본, 스스로 합쳐 봄) | 'ask'(항상 화면에서 고름) · pause(화면에 차례를 넘기는 함수, 기본 setTimeout 0)
 */
export function createBridge({
  store, engine, db, transport, accountId = null, deviceId = null,
  favorites = null, photos = null, workspaces = null, conflicts = 'merge',
  pause = () => new Promise(resolve => setTimeout(resolve, 0)),
}) {
  for (const fn of ['saveLocal', 'syncNow', 'listLocal']) if (typeof engine?.[fn] !== 'function') throw new Error(`engine.${fn}가 필요해요 (local-sync)`);
  if (conflicts !== 'merge' && conflicts !== 'ask') throw new Error("conflicts는 'merge' 또는 'ask'");
  const contextOf = serverId => ({ db, transport, workspaceId: serverId, myAccountId: accountId, deviceId });
  const find = workspaceId => store.getWorkspaces().find(w => w.id === workspaceId || w.serverId === workspaceId);
  const linked = workspaceId => {
    const ws = find(workspaceId);
    return ws && !ws.personal && ws.serverId ? ws : fail('not_found');
  };

  // 다리의 일은 한 줄로: 앞의 일이 끝난 뒤에 다음 일
  let chain = Promise.resolve();
  let working = 0;                 // 지금 도는 다리의 일 (0이 아니면 보낼 목록 알림은 다리 자신이 낸 것이거나, 이어지는 실행이 처리함)
  let afterJob = null;             // start()가 넣음: 일이 끝난 뒤 그새 생긴 저장이 있으면 다시 돌게 함
  const stuckNow = new Set();      // 마지막 실행에서 막힌 공간 (엔진이 줄을 안 받음·오류): 풀릴 때까지 스스로 되풀이하지 않음
  const serial = fn => {
    const next = chain.then(async () => {
      working++;
      try { return await fn(); } finally { working--; if (!working) afterJob?.(); }
    });
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
  /** 엔진에 넘길 저장이 그 공간에 남아 있는지 (화면에서 방금 한 저장) */
  function hasPending(workspaceId) {
    for (const row of outboxOf(workspaceId)) if (!isSideRow(row)) return true;
    return false;
  }

  /** ① 넘기기. 엔진이 받지 않는 줄이 있으면 그 공간은 거기서 멈추고 { seq, code, error }를 돌려줌 (없으면 null) */
  async function handOff(ws) {
    for (const row of outboxOf(ws.id)) {
      if (isSideRow(row)) continue;                                  // 별표·사진 올리기는 ③에서
      try {
        await engine.saveLocal(contextOf(ws.serverId), row.changes, { handoffKey: `${row.seq}:${row.createdAt}` });
      } catch (error) {
        return { status: 'BLOCKED', seq: row.seq, code: codeOf(error), error: String(error?.message ?? error) };
      }
      store.ackOutbox(row.seq);
    }
    return null;
  }

  /** ② 보내고 받기. 충돌이 나면 스스로 합칠 수 있는 것은 합쳐서 다시 보냄. 합친 횟수를 같이 돌려줌 */
  async function exchange(ws) {
    const ctx = contextOf(ws.serverId);
    let result = await engine.syncNow(ctx);
    let merged = 0;
    while (conflicts === 'merge' && result.flush.status === 'CONFLICT' && typeof engine.resolveConflict === 'function' && merged < MERGE_TRIES) {
      try {
        await engine.resolveConflict(ctx, result.flush.outboxSeq, 'merge');
      } catch (error) {
        if (['CANNOT_MERGE', 'CANNOT_KEEP'].includes(codeOf(error))) break;   // 같은 칸을 양쪽에서 고침: 화면에서 고름
        throw error;
      }
      merged++;
      result = await engine.syncNow(ctx);
    }
    return { ...result, merged };
  }

  /** ③ 별표·사진. 앞에 아직 안 넘어간 저장이 있으면(그 메모가 서버에 없을 수 있음) 거기서 멈춤. 실패한 줄은 남겨 두고 다음에 */
  async function sendSide(ws, pushed) {
    const uploadFailed = [];
    let notes = null;
    for (const row of outboxOf(ws.id)) {
      if (!isSideRow(row)) break;
      let done = true;
      for (const c of row.changes) {
        if (c.kind === 'favorite') {
          if (!favorites) { done = false; break; }
          try {
            const ids = c.data.note_ids;
            for (let i = 0; i < ids.length; i += FAVORITE_BATCH) await favorites.set(ws.serverId, ids.slice(i, i + FAVORITE_BATCH), c.data.favorite);
          } catch (error) {
            if (!(pushed && FAVORITE_GIVE_UP.has(codeOf(error)))) { done = false; break; }   // 연결 문제 등: 남겨 두고 다음에
          }
          continue;
        }
        const { note_id: memoId, ref } = c.data;
        notes ??= new Map(store.sharedState(ws.serverId).notes.map(n => [n.id, n.photos]));
        if (!notes.get(memoId)?.includes(ref)) continue;             // 올리기 전에 사진이나 메모가 지워짐
        if (typeof photos?.upload !== 'function') { done = false; break; }
        try {
          const assetId = await photos.upload(ws.serverId, ref, { memoId });
          if (!isUuid(assetId)) throw Object.assign(new Error('photos.upload는 올린 첨부의 id(UUID)를 돌려줘야 해요'), { code: 'INVALID_REQUEST' });
          store.resolveUpload(ws.serverId, memoId, ref, assetId);    // 사진 연결이 보낼 목록에 들어가고, 이어지는 실행에서 올라감
        } catch (error) {
          if (!UPLOAD_GIVE_UP.has(codeOf(error))) { done = false; break; }
          uploadFailed.push({ memoId, ref, code: codeOf(error), error: String(error?.message ?? error) });
        }
      }
      if (done) store.ackOutbox(row.seq);
    }
    return uploadFailed;
  }

  const lastApplied = new Map();   // 서버 공간 id → Map('entity|id' → 지문): 지난번에 화면용 표에 반영한 내용

  /** ④ 엔진의 기록 → 저장소. full이면 지난번 기억을 버리고 전부 다시 맞춤 */
  async function reconcile(ws, { full = false } = {}) {
    const serverId = ws.serverId;
    const cache = full ? new Map() : lastApplied.get(serverId) ?? new Map();
    const local = store.sharedState(serverId);
    const have = new Set([...local.notes.map(n => n.id), ...local.tasks.map(t => t.id)]);
    const items = [], marks = new Map();
    const seen = { notes: new Set(), tasks: new Set() };
    for (const entity of ['notes', 'tasks', 'events']) {
      for (const r of await engine.listLocal(db, serverId, entity, { includeDeleted: true })) {
        seen[entity === 'notes' ? 'notes' : 'tasks'].add(r.key);
        const key = `${entity}|${r.key}`, mark = fingerprint(r.data);
        if (cache.get(key) === mark && have.has(r.key)) continue;    // 지난번에 반영한 그대로
        const item = { entity, data: r.data };
        items.push(item);
        marks.set(item, [key, mark]);
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
    // 아직 안 올린 기기 사진(UUID가 아님)은 서버에 없는 것이 당연하므로 비교하지 않음
    const current = new Map(local.notes.map(n => [n.id, n.photos.filter(isUuid)]));
    for (const noteId of new Set([...wanted.keys(), ...current.keys()])) {
      const want = wanted.get(noteId) ?? [], cur = current.get(noteId) ?? [];
      for (const assetId of cur) if (!want.includes(assetId)) items.push({ entity: 'note_attachments', data: { note_id: noteId, asset_id: assetId }, removed: true });
      for (const assetId of want) if (!cur.includes(assetId)) items.push({ entity: 'note_attachments', data: { note_id: noteId, asset_id: assetId } });
    }

    // 메모 → 일정·할 일 → 사진 순서로, 조금씩 나눠 반영 (기록이 많아도 화면이 오래 멈추지 않게)
    const order = { notes: 0, tasks: 1, events: 1, note_attachments: 2 };
    items.sort((a, b) => order[a.entity] - order[b.entity]);
    const applied = { notes: 0, tasks: 0, photos: 0 };
    for (let i = 0; i < items.length; i += APPLY_CHUNK) {
      const chunk = items.slice(i, i + APPLY_CHUNK);
      const count = store.applyServer(serverId, chunk);
      for (const key of Object.keys(applied)) applied[key] += count[key];
      // 화면에서 방금 한 저장이 있으면 저장소가 그 기록을 건너뛰었을 수 있으니, 이번 묶음은 "반영함"으로 기억하지 않음
      if (!hasPending(ws.id)) for (const item of chunk) { const m = marks.get(item); if (m) cache.set(m[0], m[1]); }
      if (i + APPLY_CHUNK < items.length) await pause();
    }
    lastApplied.set(serverId, cache);

    if (favorites?.list) {
      try { store.applyFavorites(serverId, [...await favorites.list(serverId)]); } catch { /* 다음 sync 때 */ }
    }
    await memberInfo(ws);
    return applied;
  }

  /** 공간의 내 역할·멤버 수를 엔진이 받은 멤버 목록으로 맞춤 (역할이 보기 전용으로 바뀌면 기기에서도 저장이 막힘) */
  async function memberInfo(ws) {
    try {
      const active = (await engine.listLocal(db, ws.serverId, 'workspace_members')).filter(r => r.data?.status === 'ACTIVE');
      if (!active.length) return;
      const mine = accountId ? active.find(r => r.key === accountId)?.data.role : undefined;
      store.upsertServerWorkspace({ id: ws.serverId, members: active.length, ...(mine ? { role: mine } : {}) });
    } catch { /* 멤버 목록이 없는 엔진·모르는 역할 값: 그대로 둠 */ }
  }

  /** 공간 이름·설명, 다른 기기에서 새로 들어간 공간을 서버 목록으로 맞춤 (workspaces.list가 있을 때) */
  async function workspaceList() {
    if (typeof workspaces?.list !== 'function') return;
    let list;
    try { list = await workspaces.list(); } catch { return; }       // 연결 안 됨: 다음에
    for (const w of Array.isArray(list) ? list : []) {
      try {
        store.upsertServerWorkspace({
          id: w.id, name: w.name, description: w.description ?? '',
          ...(w.role ? { role: w.role } : {}), ...(Number.isSafeInteger(w.members) ? { members: w.members } : {}),
        });
      } catch { /* 이름이 기기 한도를 넘는 등: 그 공간만 건너뜀 */ }
    }
  }

  async function syncOnce(ws) {
    const blocked = await handOff(ws);
    const { flush, pull, merged } = await exchange(ws);
    if (pull.status === 'CLOSED') return { status: 'CLOSED', flush, pull };   // 공간에서 빠짐·공간 삭제: 화면에서 알리고 store.deleteWorkspace
    const uploadFailed = await sendSide(ws, flush.status === 'DONE');
    const applied = await reconcile(ws);
    return {
      status: 'OK', flush, pull, applied,
      ...(merged ? { merged } : {}), ...(blocked ? { handOff: blocked } : {}), ...(uploadFailed.length ? { uploadFailed } : {}),
    };
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

  /** 넘길 저장이 남은 공간 (막힌 공간 제외). 도는 동안 화면에서 새로 한 저장과, 방금 올린 사진의 연결이 여기에 잡힘 */
  function waiting(stuck) {
    const ids = new Set();
    for (const row of store.peekOutbox(1000)) {
      if (row.serverId && !stuck.has(row.workspaceId) && !isSideRow(row)) ids.add(row.workspaceId);
    }
    return [...ids];
  }

  /** only(공간 id들)를 차례로 돌고, 그동안 새 저장이 생긴 공간은 이어서 다시 (MAX_ROUNDS까지). only가 없으면 연결된 공간 전부 */
  async function rounds(only = null) {
    await ensureAccount();
    if (!only) await workspaceList();
    let ids = only ?? store.getWorkspaces().filter(ws => !ws.personal && ws.serverId).map(ws => ws.id);
    const out = {}, stuck = new Set();
    for (let round = 0; round < MAX_ROUNDS && ids.length; round++) {
      for (const id of ids) {
        out[id] = await attempt(id);
        if (out[id].status !== 'OK' || out[id].handOff) { stuck.add(id); stuckNow.add(id); } else stuckNow.delete(id);
      }
      ids = waiting(stuck).filter(id => !only || only.includes(id));
    }
    return out;
  }

  /**
   * 공유 공간 하나를 동기화. 돌려주는 값: { status, flush, pull, applied, merged?, handOff?, uploadFailed? }
   *   status: OK · CLOSED · NOT_SHARED · NOT_LINKED · ERROR(code, error)
   *   flush.status가 CONFLICT·BLOCKED면 화면에서 풀어야 함: issues(공간 id)로 내용을 보고 resolve·discard
   *   merged: 스스로 합친 충돌 수 · uploadFailed: 올릴 수 없는 사진 [{ memoId, ref, code, error }] (기기에만 남음)
   *   handOff가 있으면 엔진이 그 줄을 받지 않은 것: 고칠 수 없으면 store.ackOutbox(handOff.seq)로 버리고 refresh
   */
  function syncWorkspace(workspaceId) {
    return serial(async () => {
      const ws = find(workspaceId);
      if (!ws) return { status: 'NOT_SHARED' };
      return (await rounds([ws.id]))[ws.id];
    });
  }

  let running = null;
  /** 연결된 공유 공간 전부: { 기기 공간 id: 결과 }. 도는 중에 다시 부르면 같은 실행을 돌려줌 */
  function syncAll() {
    if (running) return running;
    const run = serial(() => rounds());
    running = run;
    // 끝난 뒤에 비움 (대입 뒤에 정리해야, 바로 끝나는 경우에도 다음 호출이 새로 돎)
    const clear = () => { if (running === run) running = null; };
    run.then(clear, clear);
    return run;
  }

  /** 엔진 쪽을 직접 바꾼 뒤(store.ackOutbox로 줄을 버림 등) 화면용 표를 엔진 값으로 전부 다시 맞춤 */
  const refresh = workspaceId => serial(() => {
    const ws = find(workspaceId);
    return ws?.serverId ? reconcile(ws, { full: true }) : null;
  });

  /**
   * 화면에서 풀어야 하는 것: { conflicts, rejected }
   *   conflicts: [{ outboxSeq, mergeable, canKeep, items: [{ entity, id, kind, reason, serverDeleted, fields: [{ field, base, mine, server }] }] }]
   *              fields = 양쪽이 다르게 고쳐서 골라야 하는 칸. canKeep이 false면 resolve(..., 'use_server')만 가능
   *   rejected:  [{ outboxSeq, code, error, changes }] 서버가 거절한 저장 → discard
   */
  async function issues(workspaceId) {
    const ws = linked(workspaceId);
    const found = typeof engine.listConflicts === 'function' ? await engine.listConflicts(db, ws.serverId) : [];
    const outbox = typeof engine.listOutbox === 'function' ? await engine.listOutbox(db, ws.serverId) : [];
    const rejected = outbox.filter(r => r.status === 'FAILED').map(r => {
      const [code, ...rest] = String(r.lastError ?? '').split(': ');
      return { outboxSeq: r.seq, code: code || 'UNKNOWN', error: rest.join(': '), changes: r.changes };
    });
    return { conflicts: found, rejected };
  }

  /** 충돌을 사용자가 고른 대로 풀고 이어서 동기화. choice: 'keep_mine' | 'use_server' | 'keep_both' | 'merge'. 그 공간의 결과를 돌려줌 */
  function resolve(workspaceId, outboxSeq, choice) {
    return serial(async () => {
      const ws = linked(workspaceId);
      await engine.resolveConflict(contextOf(ws.serverId), outboxSeq, choice);
      lastApplied.delete(ws.serverId);
      return (await rounds([ws.id]))[ws.id];
    });
  }

  /** 서버가 거절했거나 충돌 난 저장을 버리고(내 수정 취소) 이어서 동기화. 그 공간의 결과를 돌려줌 */
  function discard(workspaceId, outboxSeq) {
    return serial(async () => {
      const ws = linked(workspaceId);
      await engine.discardOutbox(contextOf(ws.serverId), outboxSeq);
      lastApplied.delete(ws.serverId);
      return (await rounds([ws.id]))[ws.id];
    });
  }

  /**
   * 지금 상태 (배지·배너·로그아웃 전 확인용).
   *   state: 'needs_login'(로그인 만료) · 'attention'(충돌·거절: issues로 풀기) · 'pending'(안 보낸 저장 있음) · 'synced'
   *   unsent: 서버에 아직 안 올라간 저장 묶음 수 · workspaces: { 기기 공간 id: { waiting, pending, conflicts, failed, lastError, attempts } }
   */
  async function status() {
    const out = {};
    let unsent = 0, attention = false, login = false;
    for (const ws of store.getWorkspaces()) {
      if (ws.personal) continue;
      let waitingRows = 0;
      for (const row of outboxOf(ws.id)) if (row) waitingRows++;
      const s = ws.serverId && typeof engine.getSyncStatus === 'function'
        ? await engine.getSyncStatus(db, ws.serverId) : { pending: 0, conflicts: 0, failed: 0, lastError: null, attempts: 0 };
      out[ws.id] = { waiting: waitingRows, pending: s.pending, conflicts: s.conflicts, failed: s.failed, lastError: s.lastError ?? null, attempts: s.attempts ?? 0 };
      unsent += waitingRows + s.pending;
      if (s.conflicts || s.failed) attention = true;
      if (String(s.lastError ?? '').startsWith('AUTH_REQUIRED')) login = true;
    }
    return { state: login ? 'needs_login' : attention ? 'attention' : unsent ? 'pending' : 'synced', unsent, workspaces: out };
  }

  let stop = null;
  /**
   * 알아서 돌기: 공유 공간에서 저장할 때마다(조금 모아서) 동기화하고, 연결이 안 되거나 오류가 나면 간격을 늘려 가며 다시 시도.
   * 앱이 앞으로 올 때와 실시간 신호가 올 때는 syncAll()을 직접 부르세요. 돌려주는 함수를 부르면 멈춤.
   *   debounceMs: 저장 뒤 기다리는 시간 · retryMs: 다시 시도 간격들 · onResult(결과) · onError(오류) · timers: { set, clear } (테스트용)
   */
  function start({ debounceMs = 400, retryMs = RETRY_MS, onResult, onError, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) } } = {}) {
    // Wrapped: browsers throw "Illegal invocation" when setTimeout is called as timers.set(...).
    if (stop) return stop;
    let timer = null, failures = 0, stopped = false;
    const schedule = ms => {
      if (stopped) return;
      if (timer !== null) timers.clear(timer);
      timer = timers.set(run, ms);
    };
    async function run() {
      timer = null;
      let retry = false;
      try {
        const out = await syncAll();
        retry = Object.values(out).some(r => r.status === 'ERROR' || r.flush?.status === 'OFFLINE' || r.pull?.status === 'OFFLINE');
        onResult?.(out);
      } catch (error) {
        retry = codeOf(error) !== 'account_mismatch';              // 다른 계정의 기기: 다시 해도 같음
        onError?.(error);
      }
      if (stopped) return;
      if (!retry) { failures = 0; return; }
      if (timer === null) schedule(retryMs[Math.min(failures, retryMs.length - 1)]);
      failures++;
    }
    // 화면에서 저장함: 조금 모아서 돎 (다시 시도를 기다리던 중이면 그 기다림 대신)
    const unsubscribe = store.subscribeOutbox(() => { if (!working && waiting(stuckNow).length) schedule(debounceMs); });
    // 다리의 일이 끝났는데 그새 한 저장이 남아 있음 (마지막 확인 뒤에 저장한 경우)
    afterJob = () => { if (!stopped && timer === null && waiting(stuckNow).length) schedule(debounceMs); };
    const halt = () => {
      stopped = true;
      if (timer !== null) timers.clear(timer);
      unsubscribe();
      afterJob = null;
      if (stop === halt) stop = null;
    };
    stop = halt;
    schedule(0);
    return halt;
  }

  /**
   * 로그아웃·탈퇴: 마지막으로 한 번 동기화한 뒤, 안 보낸 저장이 없으면 기기의 기록을 모두 지움.
   * 안 보낸 저장이 남아 있으면 지우지 않고 { cleared: false, unsent }를 돌려줌 → 사용자에게 알리고, 그래도 지우려면 { force: true }.
   * 개인 공간 기록도 함께 지워지므로 백업(store.exportAll)을 먼저 하세요.
   */
  function signOut({ force = false } = {}) {
    return serial(async () => {
      try { await rounds(); } catch { /* 연결이 안 돼도 아래에서 남은 저장을 셈 */ }
      const { unsent } = await status();
      if (unsent > 0 && !force) return { cleared: false, unsent };
      stop?.();
      if (typeof engine.clearLocalSync === 'function') await engine.clearLocalSync(db);
      store.clearAll();
      lastApplied.clear();
      bound = null;
      return { cleared: true, unsent };
    });
  }

  return Object.freeze({ syncWorkspace, syncAll, refresh, issues, resolve, discard, status, start, signOut });
}
