import { migrate } from './schema.js';
import * as memos from './memos.js';
import * as tasks from './tasks.js';
import * as proposals from './proposals.js';
import * as workspaces from './workspaces.js';

const AREAS = ['memos', 'tasks', 'proposals', 'workspaces'];
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

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * The on-device store for memos, tasks (일정·할 일) and AI proposals, over an expo-sqlite database.
 *
 *   import { openDatabaseSync } from 'expo-sqlite';
 *   const store = createLocalStore({ db: openDatabaseSync('planner.db') });
 *
 * Every write runs in one SQLite transaction and returns synchronously, as the screens expect (addMemo returns the
 * memo). Lists (getMemos, getTasks, ...) are cached, frozen snapshots: the same array until something changes, which
 * is what React's useSyncExternalStore needs; see createHooks. Listeners run after the commit, never for a write
 * that failed or changed nothing.
 *
 * Options: now() returns epoch milliseconds; newId() returns a unique string id; onListenerError receives an error a
 * listener threw (by default it is rethrown asynchronously so it shows up without undoing the committed write).
 */
export function createLocalStore({ db, now = Date.now, newId = defaultId, onListenerError } = {}) {
  if (!db || DB_METHODS.some(m => typeof db[m] !== 'function')) throw new Error('An expo-sqlite database opened with openDatabaseSync is required');
  if (typeof now !== 'function' || typeof newId !== 'function') throw new Error('now and newId must be functions');
  const clock = () => {
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) throw new Error('now() must return integer milliseconds');
    return t;
  };
  const nextId = () => {
    const value = newId();
    if (typeof value !== 'string' || !value || value.length > 200) throw new Error('newId() must return a non-empty string');
    return value;
  };
  const reportListenerError = onListenerError ?? (error => { queueMicrotask(() => { throw error; }); });

  // Foreign keys are off per connection by default and cannot be switched inside a transaction.
  db.execSync('pragma foreign_keys = on');
  db.execSync('pragma journal_mode = wal');
  migrate(db, { now: clock, newId: nextId });

  let touched = null;
  let current = null;
  const ctx = {
    db,
    now: clock,
    newId: nextId,
    freeze: deepFreeze,
    ws: () => current,
    setWs: workspaceId => { current = workspaceId; },
    touch: area => {
      if (!touched) throw new Error('Write outside a transaction');
      touched.add(area);
    },
  };
  current = workspaces.loadCurrent(ctx);

  const cache = { memos: null, trashed: null, tasks: null, proposals: null, workspaces: null };
  const reuse = { memos: new Map(), trashed: new Map() };
  const listeners = new Map(AREAS.map(area => [area, new Set()]));
  const anyListeners = new Set();

  function invalidate(areas) {
    if (areas.has('memos')) { cache.memos = null; cache.trashed = null; }
    if (areas.has('tasks')) cache.tasks = null;
    if (areas.has('proposals')) cache.proposals = null;
    if (areas.has('workspaces')) cache.workspaces = null;
  }

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
    const before = current;
    let result;
    try {
      db.withTransactionSync(() => { result = fn(); });
    } catch (error) {
      // Rolled back: forget the touched areas and an in-memory workspace switch made inside the transaction.
      current = before;
      touched = null;
      throw error;
    } finally {
      writing = false;
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
    addMemo: input => write(() => memos.addMemo(ctx, input)),
    updateMemo: (memoId, patch, options) => write(() => memos.updateMemo(ctx, memoId, patch, options)),
    trashMemo: memoId => write(() => memos.trashMemo(ctx, memoId)),
    trashMemos: ids => write(() => memos.trashMemos(ctx, ids)),
    restoreMemos: ids => write(() => memos.restoreMemos(ctx, ids)),
    deleteMemoForever: memoId => write(() => memos.deleteMemoForever(ctx, memoId)),
    deleteMemosForever: ids => write(() => memos.deleteMemosForever(ctx, ids)),
    setFavorites: (ids, favorite) => write(() => memos.setFavorites(ctx, ids, favorite)),
    attachPhoto: (memoId, fileId) => write(() => memos.attachPhoto(ctx, memoId, fileId)),
    detachPhoto: (memoId, fileId) => write(() => memos.detachPhoto(ctx, memoId, fileId)),
    subscribeMemos: subscriber('memos'),

    // tasks (일정·할 일)
    getTasks: () => (cache.tasks ??= Object.freeze(tasks.listTasks(ctx))),
    getTask: taskId => tasks.getTask(ctx, taskId),
    addTask: input => write(() => tasks.addTask(ctx, input)),
    updateTask: (taskId, patch, options) => write(() => tasks.updateTask(ctx, taskId, patch, options)),
    deleteTask: taskId => write(() => tasks.deleteTask(ctx, taskId)),
    toggleDone: taskId => write(() => tasks.toggleDone(ctx, taskId)),
    findOverlap: (fields, excludeId) => tasks.findOverlap(ctx, fields, excludeId),
    subscribeTasks: subscriber('tasks'),

    // AI proposals
    getProposals: () => (cache.proposals ??= Object.freeze(proposals.listProposals(ctx))),
    getProposal: proposalId => proposals.getProposal(ctx, proposalId),
    addProposals: items => write(() => proposals.addProposals(ctx, items)),
    approveProposal: (proposalId, edits) => write(() => proposals.approveProposal(ctx, proposalId, edits)),
    setProposalStatus: (proposalId, status) => write(() => proposals.setProposalStatus(ctx, proposalId, status)),
    findDuplicate: fields => proposals.findDuplicate(ctx, fields),
    subscribeProposals: subscriber('proposals'),

    // workspaces (this device only)
    getWorkspaces: () => store.getWorkspaceState().list,
    getCurrentWorkspace: () => store.getWorkspaceState().current,
    getWorkspaceState: () => (cache.workspaces ??= (() => {
      const list = workspaces.listWorkspaces(ctx);
      return Object.freeze({ list: Object.freeze(list), current: list.find(w => w.id === current) });
    })()),
    createWorkspace: input => write(() => workspaces.createWorkspace(ctx, input)),
    switchWorkspace: workspaceId => write(() => workspaces.switchWorkspace(ctx, workspaceId)),
    deleteWorkspace: workspaceId => write(() => workspaces.deleteWorkspace(ctx, workspaceId)),
    subscribeWorkspaces: subscriber('workspaces'),

    /** Called with the changed areas after every committed change. */
    subscribe: subscriber(null),
  };
  return Object.freeze(store);
}
