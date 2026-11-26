import assert from 'node:assert/strict';
import test from 'node:test';
import { finishRecordedClip, storeVerifiedClip } from '../../frontend/Frontend_UI/src/services/device/recordedClip.mjs';

const clip = { uri: 'file:///cache/one.m4a', seconds: 69 };
const save = async () => ({ uri: 'content://recordings/one.m4a', id: 'one' });

test('0.022-second, all-silent 44.8-second and malformed takes never reach storage, usage or transcription', async () => {
  let count = 0;
  const store = () => { count++; };
  for (const audio of [
    { durationSeconds: 0.022, hasSignal: true },
    { durationSeconds: 44.8, hasSignal: false },
    { durationSeconds: NaN, hasSignal: true },
    { durationSeconds: 2, hasSignal: undefined },
    null,
  ]) {
    const result = await finishRecordedClip(clip, async () => audio, store);
    assert.equal(result.state, 'error');
    assert.ok(result.message);
    assert.equal(result.uri, undefined);
  }
  assert.equal((await finishRecordedClip(clip, async () => { throw Error(); }, store)).state, 'error');
  assert.equal((await finishRecordedClip(null, null, store)).state, 'error');
  assert.equal(count, 0);
});

test('decoded subsecond or longer duration replaces the recorder clock before save and transcription', async () => {
  for (const durationSeconds of [0.1, 1.9, 13.6]) {
    const saved = await finishRecordedClip(clip, async uri => {
      assert.equal(uri, clip.uri);
      return { durationSeconds, hasSignal: true };
    }, async (uri, seconds) => {
      assert.equal(uri, clip.uri);
      assert.equal(seconds, durationSeconds);
      return save();
    });
    assert.deepEqual(saved, { state: 'saved', uri: 'content://recordings/one.m4a', seconds: durationSeconds, fileId: 'one' });
  }
});

test('a failed destination write retains the original cache file and inspected duration for retry', async () => {
  const failed = await finishRecordedClip(clip, async () => ({ durationSeconds: 13.6, hasSignal: true }), async () => { throw Error('폴더 권한'); });
  assert.deepEqual(failed, { state: 'save_error', uri: clip.uri, seconds: 13.6, fileId: null, saveError: '폴더 권한' });
  const retried = await storeVerifiedClip(failed.uri, failed.seconds, async (uri, seconds) => {
    assert.equal(uri, clip.uri);
    assert.equal(seconds, 13.6);
    return save();
  });
  assert.equal(retried.state, 'saved');
  assert.equal(retried.seconds, 13.6);
});

test('other platforms keep their own recorder duration without loading the Android decoder', async () => {
  const result = await finishRecordedClip(clip, null, save);
  assert.equal(result.seconds, 69);
  assert.equal(result.state, 'saved');
});

test('a retry survives remount only in the original session and workspace, and cannot reopen a dismissed sheet', async () => {
  const { readRecordingSheet, writeRecordingSheet, subscribeRecordingSheets } = await import('../../frontend/Frontend_UI/src/services/device/recordedClip.mjs');
  const owner = { session: {}, workspaceId: 'A' };
  const failed = { state: 'save_error', ...clip };
  const done = { state: 'saved', uri: 'content://other' };
  let changes = 0;
  const unsubscribe = subscribeRecordingSheets(() => { changes++; });
  writeRecordingSheet(owner, failed);
  writeRecordingSheet(owner, done);
  assert.equal(readRecordingSheet({ ...owner }), failed);
  assert.equal(readRecordingSheet({ ...owner, workspaceId: 'B' }), null);
  assert.equal(readRecordingSheet({ ...owner, session: {} }), null);
  const saving = { ...failed, saving: true };
  writeRecordingSheet(owner, saving, failed);
  writeRecordingSheet(owner, null, saving);
  writeRecordingSheet(owner, { state: 'saved' }, saving);
  assert.equal(readRecordingSheet(owner), done);
  unsubscribe();
  writeRecordingSheet(owner, null, done);
  assert.equal(readRecordingSheet(owner), null);
  assert.equal(changes, 4);
});

test('native recorder handles denied permission, navigation during preparation, concurrent starts and an interrupted partial recording', async t => {
  const { registerHooks } = await import('node:module');
  const calls = [];
  let permitted = false, visible = true;
  const native = {
    uri: null,
    async prepareToRecordAsync() { calls.push('prepare'); this.uri = 'file:///unique/current.m4a'; },
    record() { calls.push('record'); },
    getStatus() { return { isRecording: false, durationMillis: 13000 }; },
    async stop() { calls.push('stop'); },
  };
  globalThis.atriaRecorderTest = {
    native,
    permission: () => ({ granted: permitted, canAskAgain: false }),
    mode: async value => calls.push(value.allowsRecording ? 'enable' : 'disable'),
  };
  t.after(() => { delete globalThis.atriaRecorderTest; });
  const stubs = {
    'react-native': "export const Platform = { OS: 'android' };",
    'expo-audio': `export const AudioModule = { requestRecordingPermissionsAsync: () => globalThis.atriaRecorderTest.permission() };
      export const RecordingPresets = {HIGH_QUALITY:{}};
      export const setAudioModeAsync = settings => globalThis.atriaRecorderTest.mode(settings);
      export const useAudioRecorder = () => globalThis.atriaRecorderTest.native;`,
    '../../integration/runtime': 'export const loadAudioSplit = () => ({ canInspectRecording: () => true });',
    '../../lib/stella/recordings': 'export const RECORDING_AUDIO = {sampleRate:22050, numberOfChannels:1, bitRate:64000};',
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (stubs[specifier] && context.parentURL?.endsWith('/Recorder.js')) {
      return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
    }
    return next(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const { useRecorder } = await import('../../frontend/Frontend_UI/src/services/device/Recorder.js');
  const recorder = useRecorder();
  assert.deepEqual(await recorder.start(() => true), { ok: false, reason: 'denied', canAskAgain: false });
  assert.deepEqual(calls, []);

  permitted = true;
  const prepare = native.prepareToRecordAsync;
  native.prepareToRecordAsync = async function () { await prepare.call(this); visible = false; };
  assert.deepEqual(await recorder.start(() => visible), { ok: false, reason: 'cancelled' });
  assert.deepEqual(calls, ['enable', 'prepare', 'stop', 'disable']);
  calls.length = 0;
  native.prepareToRecordAsync = prepare;
  assert.deepEqual(await recorder.start(() => true), { ok: true });
  assert.equal((await useRecorder().start(() => true)).ok, false);
  assert.deepEqual(calls, ['enable', 'prepare', 'record']);
  native.stop = async () => { throw Error('OS already stopped'); };
  const partial = await recorder.stop();
  assert.deepEqual(partial, { uri: 'file:///unique/current.m4a', seconds: 0 });
  assert.equal(calls.at(-1), 'disable');
});
