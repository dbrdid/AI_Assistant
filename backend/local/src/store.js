import { migrate } from './schema.js';
import * as memos from './memos.js';
import * as tasks from './tasks.js';
import * as proposals from './proposals.js';
import * as workspaces from './workspaces.js';
import * as backup from './backup.js';
import { applyServer, applyFavorites, sharedState } from './apply.js';
import { createServerMap } from './server.js';
import { fail } from './errors.js';
import { isUuid } from './validate.js';

const AREAS = ['memos', 'tasks', 'proposals', 'workspaces', 'outbox'];
const DB_METHODS = ['execSync', 'runSync', 'getFirstSync', 'getAllSync', 'withTransactionSync'];

/** A random RFC 4122 version 4 id. Pass expo-crypto's randomUUID as newId on devices without crypto.randomUUID. */
export function defaultId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 동기화 엔진(local-sync)의 saveLocal이 받는 한 묶음: 1~100개, 같은 대상은 한 번만 */
export const OUTBOX_BATCH = 100;

/** 엔진이 보는 "같은 대상" (local-sync의 changeKey와 같은 기준: 기록은 id, 연결은 양쪽 id) */
function targetOf(change) {
  if (typeof change.id === 'string') return `${change.entity}|${change.id}`;
  const data = change.data ?? {};
  return `${change.entity}|${Object.keys(data).filter(k => k.endsWith('_id')).sort().map(k => data[k]).join(':')}`;
}

/**
 * 한 번의 저장에서 나온 변경을 엔진이 받는 크기로 나눔 (순서 유지).
 * 100개를 넘거나 같은 대상이 다시 나오면 다음 묶음으로 넘김: 휴지통 비우기처럼 한 번에 많이 바꿔도 동기화가 막히지 않음.
 */
export function splitChanges(changes, size = OUTBOX_BATCH) {
  const out = [];
  let batch = [], seen = new Set();
  for (const change of changes) {
    const target = targetOf(change);
    if (batch.length >= size || seen.has(target)) {
      out.push(batch);
      batch = [];
      seen = new Set();
    }
    batch.push(change);
    seen.add(target);
  }
  if (batch.length) out.push(batch);
  return out;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * 메모·일정·할 일·AI 제안을 담는 기기 저장소 (expo-sqlite). 화면이 부르는 함수 이름은 CONTRACT.md 그대로이고,
 * 저장 규칙은 서버(Supabase) 스키마에 맞췄습니다.
 *
 *   import { openDatabaseSync } from 'expo-sqlite';
 *   import { randomUUID } from 'expo-crypto';
 *   const store = createLocalStore({ db: openDatabaseSync('planner.db'), newId: randomUUID });
 *
 * 쓰기는 SQLite 트랜잭션 하나로 끝나고 결과를 바로 돌려줍니다. 목록은 바뀔 때까지 같은 배열입니다(useSyncExternalStore용).
 * 공유 공간(개인 공간이 아닌 곳)에서 한 저장은 같은 트랜잭션에서 보낼 목록(outbox)에 서버 형식으로 적힙니다.
 *
 * 옵션: now() 밀리초 · newId() UUID · timezone(기본 'Asia/Seoul', 서버 시각 변환에 씀)
 *       labels(화면 글자 ↔ 서버 값, server.js의 DEFAULT_LABELS) · onListenerError
 */
export function createLocalStore({ db, now = Date.now, newId = defaultId, timezone = 'Asia/Seoul', labels, onListenerError } = {}) {
  if (!db || DB_METHODS.some(m => typeof db[m] !== 'function')) throw new Error('An expo-sqlite database opened with openDatabaseSync is required');
  if (typeof now !== 'function' || typeof newId !== 'function') throw new Error('now and newId must be functions');
  const clock = () => {
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) throw new Error('now() must return integer milliseconds');
    return t;
  };
  const nextId = () => {
    const value = newId();
    if (!isUuid(value)) throw new Error('newId() must return a UUID (서버 기록 id로 그대로 쓰입니다)');
    return value;
  };
  const reportListenerError = onListenerError ?? (error => { queueMicrotask(() => { throw error; }); });

  // Foreign keys are off per connection by default and cannot be switched inside a transaction.
  db.execSync('pragma foreign_keys = on');
  db.execSync('pragma journal_mode = wal');
  migrate(db, { now: clock, newId: nextId });

  let touched = null;
  let current = null;
  let queued = null;   // 이번 쓰기에서 서버로 보낼 변경: { ws, main, later, separate }
  const currentRow = () => db.getFirstSync('select personal, role from workspaces where id=?', [current]);
  const isShared = () => currentRow()?.personal === 0;
  const group = () => (queued ??= { ws: current, main: [], later: [], separate: [] });
  const ctx = {
    db,
    now: clock,
    newId: nextId,
    freeze: deepFreeze,
    map: createServerMap({ timezone, labels }),
    ws: () => current,
    setWs: workspaceId => { current = workspaceId; },
    /** 현재 워크스페이스가 공유 공간(서버와 동기화하는 곳)인지 */
    shared: isShared,
    /** 공유 공간이면 이번 저장의 변경 묶음에 더함 (한 묶음 = 서버에서 같이 성공·실패) */
    queue: changes => { if (changes.length && isShared()) group().main.push(...changes); },
    /** 앞 묶음이 서버에 반영된 뒤에 보낼 변경 (삭제 다음의 영구 삭제) */
    queueLater: changes => { if (changes.length && isShared()) group().later.push(...changes); },
    /** 동기화가 아닌 다른 길로 가는 변경 (즐겨찾기) */
    queueSeparate: changes => { if (changes.length && isShared()) group().separate.push(changes); },
    touch: area => {
      if (!touched) throw new Error('Write outside a transaction');
      touched.add(area);
    },
  };
  current = workspaces.loadCurrent(ctx);

  const cache = { memos: null, trashed: null, tasks: null, trashedTasks: null, proposals: null, workspaces: null, allMemos: null, allTasks: null };
  const reuse = { memos: new Map(), trashed: new Map(), allMemos: new Map() };
  const listeners = new Map(AREAS.map(area => [area, new Set()]));
  const anyListeners = new Set();

  function invalidate(areas) {
    if (areas.has('memos')) { cache.memos = null; cache.trashed = null; cache.allMemos = null; }
    if (areas.has('tasks')) { cache.tasks = null; cache.trashedTasks = null; cache.allTasks = null; }
    if (areas.has('proposals')) cache.proposals = null;
    if (areas.has('workspaces')) { cache.workspaces = null; cache.allMemos = null; cache.allTasks = null; }
  }

  /**
   * 모든 워크스페이스(개인 + 공유)의 목록을 하나로: 각 항목에 workspaceId를 붙임. 읽는 동안만 현재 공간을 바꿨다가 되돌림.
   * 화면의 "합쳐 보기"(오늘·캘린더·할 일·메모)용. 쓰기는 inWorkspace로.
   */
  function acrossWorkspaces(list) {
    const before = current;
    const out = [];
    try {
      for (const ws of workspaces.listWorkspaces(ctx)) {
        current = ws.id;
        for (const item of list(ws.id)) out.push(Object.freeze({ ...item, workspaceId: ws.id }));
      }
    } finally {
      current = before;
    }
    return Object.freeze(out);
  }

  // 다른 공간의 항목에 바로 할 수 있는 쓰기 (목록에서 완료 체크·미루기·휴지통 등). 그 공간의 규칙(보기 전용·동기화)을 그대로 따름
  const CROSS = {
    addMemo: input => memos.addMemo(ctx, input),
    trashMemos: ids => memos.trashMemos(ctx, ids),
    restoreMemos: ids => memos.restoreMemos(ctx, ids),
    setFavorites: (ids, favorite) => memos.setFavorites(ctx, ids, favorite),
    addTask: input => tasks.addTask(ctx, input),
    updateTask: (taskId, patch) => tasks.updateTask(ctx, taskId, patch),
    deleteTask: taskId => tasks.deleteTask(ctx, taskId),
    toggleDone: taskId => tasks.toggleDone(ctx, taskId),
  };

  function notify(areas) {
    const called = new Set();
    const call = fn => {
      if (called.has(fn)) return;
      called.add(fn);
      try { fn([...areas]); } catch (error) { reportListenerError(error); }
    };
    for (const area of AREAS) if (areas.has(area)) for (const fn of [...listeners.get(area)]) call(fn);
    for (const fn of [...anyListeners]) call(fn);
  }

  let writing = false;
  function write(fn) {
    if (writing) throw new Error('A listener or callback tried to write during another write');
    writing = true;
    touched = new Set();
    queued = null;
    const before = current;
    let result;
    try {
      db.withTransactionSync(() => {
        result = fn();
        if (queued) {
          const t = clock();
          // 엔진이 받는 크기(OUTBOX_BATCH)로 나눠 적음. 즐겨찾기(separate)는 다른 길이라 그대로
          for (const changes of [...splitChanges(queued.main), ...splitChanges(queued.later), ...queued.separate]) {
            if (changes.length) db.runSync('insert into outbox(workspace_id,changes,created_at) values(?,?,?)', [queued.ws, JSON.stringify(changes), t]);
          }
          touched.add('outbox');
        }
      });
    } catch (error) {
      // 되돌려짐: 바뀐 영역과, 트랜잭션 안에서 바꾼 현재 워크스페이스를 잊음
      current = before;
      touched = null;
      throw error;
    } finally {
      writing = false;
      queued = null;
    }
    const areas = touched;
    touched = null;
    if (areas.has('all')) AREAS.forEach(a => areas.add(a));
    areas.delete('all');
    if (areas.size) {
      invalidate(areas);
      notify(areas);
    }
    return result;
  }

  /** 메모·일정·제안 쓰기: 공유 공간에서 보기 전용(VIEWER)이면 서버가 거절하므로 기기에서 먼저 막음 */
  const edit = fn => write(() => {
    const row = currentRow();
    if (row && row.personal === 0 && row.role === 'VIEWER') fail('read_only');
    return fn();
  });

  /** edit와 같지만 지정한 워크스페이스에서 실행 (현재 공간은 바뀌지 않음). 서버로 보낼 변경도 그 공간의 것으로 적힘 */
  const editIn = (workspaceId, fn) => write(() => {
    if (typeof workspaceId !== 'string' || !workspaces.workspaceRow(ctx, workspaceId)) fail('not_found');
    const before = current;
    current = workspaceId;
    try {
      const row = currentRow();
      if (row.personal === 0 && row.role === 'VIEWER') fail('read_only');
      return fn();
    } finally {
      current = before;
    }
  });

  function subscriber(area) {
    return fn => {
      if (typeof fn !== 'function') throw new TypeError('listener must be a function');
      const set = area ? listeners.get(area) : anyListeners;
      set.add(fn);
      return () => { set.delete(fn); };
    };
  }

  const store = {
    // memos
    getMemos: () => (cache.memos ??= Object.freeze(memos.listMemos(ctx, false, reuse.memos))),
    getTrashedMemos: () => (cache.trashed ??= Object.freeze(memos.listMemos(ctx, true, reuse.trashed))),
    getMemo: memoId => memos.getMemo(ctx, memoId),
    addMemo: input => edit(() => memos.addMemo(ctx, input)),
    updateMemo: (memoId, patch, options) => edit(() => memos.updateMemo(ctx, memoId, patch, options)),
    trashMemo: memoId => edit(() => memos.trashMemo(ctx, memoId)),
    trashMemos: ids => edit(() => memos.trashMemos(ctx, ids)),
    restoreMemos: ids => edit(() => memos.restoreMemos(ctx, ids)),
    deleteMemoForever: memoId => edit(() => memos.deleteMemoForever(ctx, memoId)),
    deleteMemosForever: ids => edit(() => memos.deleteMemosForever(ctx, ids)),
    setFavorites: (ids, favorite) => edit(() => memos.setFavorites(ctx, ids, favorite)),
    attachPhoto: (memoId, fileId) => edit(() => memos.attachPhoto(ctx, memoId, fileId)),
    detachPhoto: (memoId, fileId) => edit(() => memos.detachPhoto(ctx, memoId, fileId)),
    subscribeMemos: subscriber('memos'),

    // tasks (일정·할 일)
    getTasks: () => (cache.tasks ??= Object.freeze(tasks.listTasks(ctx, false))),
    getTask: taskId => tasks.getTask(ctx, taskId),
    addTask: input => edit(() => tasks.addTask(ctx, input)),
    updateTask: (taskId, patch, options) => edit(() => tasks.updateTask(ctx, taskId, patch, options)),
    deleteTask: taskId => edit(() => tasks.deleteTask(ctx, taskId)),
    toggleDone: taskId => edit(() => tasks.toggleDone(ctx, taskId)),
    // 공유 공간의 일정·할 일 휴지통 (개인 공간은 바로 지워서 늘 비어 있음)
    getTrashedTasks: () => (cache.trashedTasks ??= Object.freeze(tasks.listTasks(ctx, true))),
    restoreTasks: ids => edit(() => tasks.restoreTasks(ctx, ids)),
    deleteTasksForever: ids => edit(() => tasks.deleteTasksForever(ctx, ids)),
    findOverlap: (fields, excludeId) => tasks.findOverlap(ctx, fields, excludeId),
    subscribeTasks: subscriber('tasks'),

    // AI proposals
    getProposals: () => (cache.proposals ??= Object.freeze(proposals.listProposals(ctx))),
    getProposal: proposalId => proposals.getProposal(ctx, proposalId),
    addProposals: items => edit(() => proposals.addProposals(ctx, items)),
    approveProposal: (proposalId, edits) => edit(() => proposals.approveProposal(ctx, proposalId, edits)),
    setProposalStatus: (proposalId, status) => edit(() => proposals.setProposalStatus(ctx, proposalId, status)),
    findDuplicate: fields => proposals.findDuplicate(ctx, fields),
    subscribeProposals: subscriber('proposals'),

    // 모든 공간 합쳐 보기 (항목마다 workspaceId) · 다른 공간 항목 고치기
    getAllMemos: () => (cache.allMemos ??= acrossWorkspaces(wsId => {
      if (!reuse.allMemos.has(wsId)) reuse.allMemos.set(wsId, new Map());
      return memos.listMemos(ctx, false, reuse.allMemos.get(wsId));
    })),
    getAllTasks: () => (cache.allTasks ??= acrossWorkspaces(() => tasks.listTasks(ctx, false))),
    /** inWorkspace(공간 id, 'toggleDone' | 'updateTask' | 'deleteTask' | 'addTask' | 'addMemo' | 'trashMemos' | 'restoreMemos' | 'setFavorites', ...인자) */
    inWorkspace: (workspaceId, name, ...args) => {
      const op = Object.hasOwn(CROSS, name) ? CROSS[name] : fail('invalid_input', 'name');
      return editIn(workspaceId, () => op(...args));
    },

    // 워크스페이스: 개인 공간(이 기기만) + 공유 공간(서버)
    getWorkspaces: () => store.getWorkspaceState().list,
    getCurrentWorkspace: () => store.getWorkspaceState().current,
    getWorkspaceState: () => (cache.workspaces ??= (() => {
      const list = workspaces.listWorkspaces(ctx);
      return Object.freeze({ list: Object.freeze(list), current: list.find(w => w.id === current) });
    })()),
    createWorkspace: input => write(() => workspaces.createWorkspace(ctx, input)),
    switchWorkspace: workspaceId => write(() => workspaces.switchWorkspace(ctx, workspaceId)),
    deleteWorkspace: workspaceId => write(() => workspaces.deleteWorkspace(ctx, workspaceId)),
    linkWorkspace: (workspaceId, serverId) => write(() => workspaces.linkWorkspace(ctx, workspaceId, serverId)),
    upsertServerWorkspace: input => write(() => workspaces.upsertServerWorkspace(ctx, input)),
    joinWorkspace: input => write(() => workspaces.joinWorkspace(ctx, input)),
    subscribeWorkspaces: subscriber('workspaces'),

    // 서버 연결 (동기화 다리가 씀): 보낼 목록 꺼내기 → 넘긴 뒤 지우기 → 받은 기록 반영
    /**
     * 공유 공간에서 한 저장들, 오래된 것부터. serverId가 null이면 아직 서버에 없는 공간이라 기다려야 함.
     * 옵션: workspaceId(기기 공간 id 하나만) · afterSeq(이 seq 다음부터, 여러 번 나눠 읽을 때)
     */
    peekOutbox: (limit = 20, { workspaceId = null, afterSeq = 0 } = {}) => db.getAllSync(
      `select o.seq, o.workspace_id, w.server_id, o.changes, o.created_at from outbox o join workspaces w on w.id = o.workspace_id
        where o.seq > ? and (? is null or o.workspace_id = ?) order by o.seq limit ?`, [afterSeq, workspaceId, workspaceId, limit],
    ).map(r => ({ seq: r.seq, workspaceId: r.workspace_id, serverId: r.server_id, changes: JSON.parse(r.changes), createdAt: r.created_at })),
    ackOutbox: seq => write(() => {
      if (db.runSync('delete from outbox where seq=?', [seq]).changes) ctx.touch('outbox');
      return true;
    }),
    outboxCount: () => db.getFirstSync('select count(*) as n from outbox').n,
    subscribeOutbox: subscriber('outbox'),
    applyServer: (workspaceRef, items) => write(() => applyServer(ctx, workspaceRef, items)),
    applyFavorites: (workspaceRef, noteIds) => write(() => applyFavorites(ctx, workspaceRef, noteIds)),
    /** 기기 파일을 서버에 올린 뒤: 메모의 그 사진을 첨부 id로 바꾸고 연결을 보낼 목록에 적음. 사진이 그새 지워졌으면 false */
    resolveUpload: (workspaceRef, memoId, ref, assetId) => write(() => memos.resolveUpload(ctx, workspaceRef, memoId, ref, assetId)),
    sharedState: workspaceRef => sharedState(ctx, workspaceRef),
    /** 화면 글자 ↔ 서버 값 변환 (server.js). AI 결과는 store.serverMap.proposalsFromAnalyze(draft, source) */
    serverMap: ctx.map,

    // 백업·계정
    exportAll: () => backup.exportAll(ctx),
    importAll: payload => write(() => backup.importAll(ctx, payload)),
    clearAll: () => write(() => backup.clearAll(ctx)),
    counts: () => backup.counts(ctx),
    getAccount: () => backup.getAccount(ctx),
    bindAccount: accountId => write(() => backup.bindAccount(ctx, accountId)),

    /** Called with the changed areas after every committed change. */
    subscribe: subscriber(null),
  };
  return Object.freeze(store);
}
