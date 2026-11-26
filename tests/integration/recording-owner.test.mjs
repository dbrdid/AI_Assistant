import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Exercise the real FileStore copy/commit and scoped-reference paths with in-memory native adapters.
const source = readFileSync(new URL('../../frontend/Frontend_UI/src/data/files/FileStore.js', import.meta.url), 'utf8')
  .replace(/^import [^;]+;\n/gm, '').replace(/^export /gm, '');

function makeStore() {
  const raw = 'file:///cache/test.m4a', dest = 'content://folder/녹음.m4a';
  const files = new Set([raw]), rows = [], events = [];
  const state = { workspace: 'a', whileCopying() {}, whileResolving() {} };
  const rt = { session: { id: 'account' }, closedSpaces: new Set(), store: { getCurrentWorkspace: () => ({ id: state.workspace }) } };
  class File {
    constructor(parent, name) { this.uri = name ? parent.uri + '/' + name : parent; }
    get exists() { return files.has(this.uri); }
    get size() { return 100; }
    async copy(target) { events.push('copy'); files.add(target.uri); state.whileCopying(); }
    delete() { files.delete(this.uri); }
  }
  class Directory {
    constructor(uri) { this.uri = uri; this.exists = true; }
    createFile(name) { return new File(this, name); }
  }
  const dependencies = {
    Platform: { OS: 'android' }, File, Directory, Paths: { cache: { uri: 'file:///cache/' } }, randomUUID: () => 'uuid',
    runtimeSubscribe() {}, runtime: () => rt, maybeRuntime: () => rt, list: () => rows,
    saveList(key, values) { events.push('commit'); rows.splice(0, rows.length, ...values); },
    AsyncStorage: { async getItem(key) { return key.includes('saveDirectory') ? '{"uri":"content://folder","reference":"root"}' : 'root'; } },
    async resolveDeviceReference(ref) { events.push('resolve'); state.whileResolving(); return { uri: 'content://folder', reference: state.refreshed || ref, token: 'lease' }; },
    async releaseDeviceAccess() { events.push('release'); },
  };
  const api = new Function(...Object.keys(dependencies), source + '\nreturn {captureRecordingOwner, isRecordingOwnerCurrent, addRecording, withRecordingUri};')(...Object.values(dependencies));
  return { ...api, rt, state, raw, dest, events, rows, files };
}

test('recording copy cannot commit into a different workspace and retains the original', async () => {
  const s = makeStore(), owner = s.captureRecordingOwner();
  s.state.whileCopying = () => { s.state.workspace = 'b'; };
  await assert.rejects(s.addRecording(s.raw, 3.5, owner), /계정이나 공간/);
  assert.deepEqual([...s.files], [s.raw]);
  assert.deepEqual(s.rows, []);
  assert.ok(s.events.includes('copy'));
  s.state.workspace = 'a';
  s.state.whileCopying = () => {};
  await s.addRecording(s.raw, 3.5, owner);
  assert.deepEqual([...s.files], [s.dest]);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].seconds, 3.5);
});

test('signing into the same account again or revoking workspace access invalidates capture', async () => {
  const s = makeStore();
  for (const change of [() => { s.rt.session = { id: 'account' }; }, () => s.rt.closedSpaces.add('a')]) {
    const owner = s.captureRecordingOwner();
    change();
    assert.equal(s.isRecordingOwnerCurrent(owner), false);
    await assert.rejects(s.addRecording(s.raw, 2, owner), /계정이나 공간/);
    assert.deepEqual(s.events, []);
  }
});

test('a scope change during file resolution releases access without opening or refreshing another workspace', async () => {
  const s = makeStore();
  s.rows.push({ id: 'clip', uri: s.dest, saveDirectoryReference: 'root' });
  s.state.refreshed = 'new-bookmark';
  s.state.whileResolving = () => { s.state.workspace = 'b'; };
  await assert.rejects(s.withRecordingUri('clip', s.dest, () => assert.fail('stale recording opened')), /계정이나 공간/);
  assert.deepEqual(s.events, ['resolve', 'release']);
});
