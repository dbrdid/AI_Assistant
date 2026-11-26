const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { transformSync } = require('@babel/core');

test('native service publishes verified downloads, handles memory pressure, and releases the model', async () => {
  const policy = await import('../src/integration/mobileModelPolicy.mjs');
  const stored = new Map();
  const listeners = new Map();
  let digest, completionStarted, finishCompletion;
  let stops = 0, releases = 0, loadError, lastParams, tokenCount = 1;
  class File {
    constructor(directory, name) { this.uri = name; }
    get size() { return stored.get(this.uri) || 0; }
    get exists() { return stored.has(this.uri); }
    delete() { stored.delete(this.uri); }
    moveSync(destination) {
      stored.set(destination.uri, this.size);
      this.delete();
      this.uri = destination.uri;
    }
    static async downloadFileAsync(url, partial) {
      const profile = Object.keys(policy.profiles).find(key => url.endsWith(key + '.gguf'));
      stored.set(partial.uri, policy.profiles[profile].bytes);
    }
  }
  function addListener(name, listener) {
    listeners.set(name, listener);
    return { remove: () => listeners.delete(name) };
  }
  const device = {
    directoryUri: () => 'file:///models', addListener, digestStagingFile: async () => digest,
    memory: () => ({ total: 8e9, available: 5e9, lowMemory: false }), thermalRestricted: () => false,
  };
  const mocks = {
    'react-native': { Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener: addListener } },
    'expo': { requireOptionalNativeModule: () => device },
    'expo-file-system': { File, Directory: class { create() {} }, Paths: { availableDiskSpace: 8e9 } },
    './mobileModelPolicy.mjs': policy,
    './s22Gate': { metrics: null },
    'llama.rn': { initLlama: async ({ model }) => {
      if (loadError) throw loadError;
      assert.match(model, /Q4_K_M/);
      return {
        getFormattedChat: async () => ({ prompt: 'hello' }), tokenize: async () => ({ tokens: Array(tokenCount).fill(1) }),
        completion(params) { lastParams = params; completionStarted(); return new Promise(resolve => { finishCompletion = resolve; }); },
        async stopCompletion() { stops++; finishCompletion({ interrupted: true }); },
        async release() { releases++; },
      };
    } },
  };
  const source = readFileSync(require.resolve('../src/integration/mobileModel.native.js'), 'utf8');
  const { code } = transformSync(source, { configFile: false, babelrc: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] });
  const api = {};
  new Function('require', 'exports', code)(id => mocks[id], api);
  await assert.rejects(api.installMobileModel('Q4_K_M'), /무결성/);
  assert.equal(stored.size, 0);
  for (const [id, profile] of Object.entries(policy.profiles)) {
    digest = profile.sha256;
    await api.installMobileModel(id);
  }
  assert.deepEqual(await api.listMobileModels(), Object.keys(policy.profiles));
  const query = { model: 'Q5_K_M', prompt: 'hello' };
  const started = new Promise(resolve => { completionStarted = resolve; });
  const active = api.askMobileModel(query);
  await started;
  await assert.rejects(api.askMobileModel(query), /정리/);
  listeners.get('memoryWarning')();
  await assert.rejects(active, { name: 'AbortError' });
  assert.equal(stops, 1);
  assert.equal(releases, 1);
  const next = new Promise(resolve => { completionStarted = resolve; });
  const retry = api.askMobileModel(query);
  await next;
  finishCompletion({ text: '안녕' });
  assert.deepEqual(await retry, { text: '안녕', model: 'Q4_K_M' });
  assert.equal(releases, 2);
  assert.equal(listeners.size, 0);
  assert.equal(lastParams.n_predict, 512);

  // A command stopped at its limit is rejected, so a cut-off value cannot reach review.
  const commandStarted = new Promise(resolve => { completionStarted = resolve; });
  const command = api.askMobileModel({ ...query, commandRequest: '제목 추가' });
  await commandStarted;
  assert.equal(lastParams.n_predict, 65);
  finishCompletion({ text: '제목 블록 추가: 다음 주 계', stopped_limit: 1 });
  await assert.rejects(command, /완전한 응답/);

  // A failed load explains the state, hides the native error and leaves the service usable.
  loadError = new Error('native detail');
  await assert.rejects(api.askMobileModel(query), error => /불러오지 못했습니다/.test(error.message) && /문서 기능/.test(error.message) && !/native detail/.test(error.message));
  loadError = null;
  const recovered = new Promise(resolve => { completionStarted = resolve; });
  const afterFailure = api.askMobileModel(query);
  await recovered;
  finishCompletion({ text: '복구' });
  assert.equal((await afterFailure).text, '복구');

  // The grammar reaches the native call only for commands.
  assert.equal('grammar' in lastParams, false);
  const constrainedStarted = new Promise(resolve => { completionStarted = resolve; });
  const constrained = api.askMobileModel({ ...query, commandRequest: '제목 추가', grammar: 'root ::= "x"' });
  await constrainedStarted;
  assert.equal(lastParams.grammar, 'root ::= "x"');
  finishCompletion({ text: 'x' });
  await constrained;

  // Input bounds are enforced before the model is loaded.
  const releasesBefore = releases;
  await assert.rejects(api.askMobileModel({ ...query, prompt: '가'.repeat(12001) }), /너무 깁니다/);
  await assert.rejects(api.askMobileModel({ ...query, commandRequest: '가'.repeat(2001) }), /너무 깁니다/);
  assert.equal(releases, releasesBefore);

  // Heavy input is refused without generating under heat or unreadable state; short input still runs.
  tokenCount = 513;
  lastParams = null;
  device.thermalRestricted = () => true;
  await assert.rejects(api.askMobileModel(query), error => /온도/.test(error.message) && /문서 기능/.test(error.message));
  device.thermalRestricted = () => { throw new Error('native detail'); };
  await assert.rejects(api.askMobileModel(query), error => /확인할 수 없어/.test(error.message) && !/native detail/.test(error.message));
  assert.equal(lastParams, null);
  tokenCount = 1;
  const lightStarted = new Promise(resolve => { completionStarted = resolve; });
  const light = api.askMobileModel(query);
  await lightStarted;
  finishCompletion({ text: '짧은 응답' });
  assert.equal((await light).text, '짧은 응답');
});
