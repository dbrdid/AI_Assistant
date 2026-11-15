import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { openDatabaseSync } from './expo-sqlite-node.mjs';
import { setup } from './helpers.mjs';
import { createLocalStore, createHooks, defaultId, SCHEMA_VERSION } from '../src/index.js';

test('opening migrates once, turns foreign keys on and refuses a database from a newer app version', () => {
  const t = setup();
  assert.equal(t.db.getFirstSync('pragma user_version').user_version, SCHEMA_VERSION);
  assert.equal(t.db.getFirstSync('pragma foreign_keys').foreign_keys, 1);
  const again = createLocalStore({ db: t.db });
  assert.equal(again.getWorkspaces().length, 1, 'a second open does not add another personal workspace');

  const newer = openDatabaseSync();
  newer.execSync(`pragma user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => createLocalStore({ db: newer }), /Unsupported local database version/);
});

test('createLocalStore needs an expo-sqlite style database and sane clock and id functions', () => {
  assert.throws(() => createLocalStore({}), /openDatabaseSync/);
  assert.throws(() => createLocalStore({ db: { execSync() {} } }), /openDatabaseSync/);
  // A new database creates the personal workspace right away, so bad functions fail at open.
  assert.throws(() => createLocalStore({ db: openDatabaseSync(), now: () => 1.5 }), /integer milliseconds/);
  assert.throws(() => createLocalStore({ db: openDatabaseSync(), newId: () => 7 }), /non-empty string/);
  let late = 0;
  const store = createLocalStore({ db: openDatabaseSync(), now: () => (late++ ? -1 : 1) });
  assert.throws(() => store.addMemo({ title: 'x' }), /integer milliseconds/);
  assert.equal(store.getMemos().length, 0);
});

test('listeners run once per committed change, with the changed areas; failed or empty writes stay silent', () => {
  const t = setup();
  const seen = [];
  const off = t.store.subscribe(areas => seen.push(areas.join(',')));
  let taskCalls = 0;
  const offTasks = t.store.subscribeTasks(() => { taskCalls++; });
  const memo = t.store.addMemo({ title: 'a' });
  t.store.updateMemo(memo.id, { title: 'a' });
  assert.throws(() => t.store.addMemo({ title: '' }));
  t.store.addTask({ title: 'x', date: '2026-11-16' });
  assert.deepEqual(seen, ['memos', 'tasks']);
  assert.equal(taskCalls, 1);
  off(); offTasks();
  t.store.addMemo({ title: 'b' });
  assert.equal(seen.length, 2);
});

test('a throwing listener does not undo the write or stop other listeners', () => {
  const errors = [];
  const t = setup({ onListenerError: error => errors.push(error.message) });
  let other = 0;
  t.store.subscribeMemos(() => { throw new Error('screen bug'); });
  t.store.subscribeMemos(() => { other++; });
  const memo = t.store.addMemo({ title: 'kept' });
  assert.deepEqual(errors, ['screen bug']);
  assert.equal(other, 1);
  assert.equal(t.store.getMemo(memo.id).title, 'kept');
});

test('createHooks wires each hook to its subscribe function and cached snapshot', () => {
  const t = setup();
  const calls = [];
  const fake = (subscribe, getSnapshot) => { calls.push(subscribe); return getSnapshot(); };
  const hooks = createHooks(fake, t.store);
  assert.equal(hooks.useMemos(), t.store.getMemos());
  assert.equal(hooks.useTrashedMemos(), t.store.getTrashedMemos());
  assert.equal(hooks.useTasks(), t.store.getTasks());
  assert.equal(hooks.useProposals(), t.store.getProposals());
  assert.equal(hooks.useWorkspaces(), t.store.getWorkspaceState());
  assert.deepEqual(calls, [t.store.subscribeMemos, t.store.subscribeMemos, t.store.subscribeTasks, t.store.subscribeProposals, t.store.subscribeWorkspaces]);
  assert.throws(() => createHooks(null, t.store), /useSyncExternalStore/);
});

test('defaultId returns version 4 UUIDs, also without crypto.randomUUID', () => {
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(defaultId(), v4);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    const ids = new Set(Array.from({ length: 50 }, defaultId));
    assert.equal(ids.size, 50);
    for (const value of ids) assert.match(value, v4);
  } finally {
    Object.defineProperty(globalThis, 'crypto', saved);
  }
});

test('the store source runs in React Native: no Node built-ins, Buffer, process, React or expo imports', () => {
  const dir = new URL('../src/', import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    const imports = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map(m => m[1]);
    if (file === 'store.js') assert.ok(imports.length >= 5, 'the import pattern finds store.js imports');
    for (const spec of imports) assert.ok(spec.startsWith('./'), `${file} imports ${spec}`);
    assert.doesNotMatch(source, /\b(Buffer|process|require)\b/, file);
  }
});
