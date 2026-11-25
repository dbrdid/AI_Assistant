import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAbort, inferenceLimits, loadCandidates, profiles } from '../../frontend/Frontend_UI/src/integration/mobileModelPolicy.mjs';

const installed = Object.keys(profiles);
test('Q5 falls back only to installed Q4 when memory permits', () => {
  const ample = { total: 12e9, available: 6e9 };
  assert.deepEqual(loadCandidates('Q5_K_M', installed, ample), ['Q5_K_M', 'Q4_K_M']);
  assert.deepEqual(loadCandidates('Q5_K_M', installed, { ...ample, total: 8e9 }), ['Q4_K_M']);
  assert.deepEqual(loadCandidates('Q5_K_M', installed, { ...ample, available: 3.9e9 }), ['Q4_K_M']);
  assert.deepEqual(loadCandidates('Q5_K_M', ['Q5_K_M'], { ...ample, total: 8e9 }), []);
  assert.deepEqual(loadCandidates('Q4_K_M', installed, { ...ample, available: 2e9 }), []);
  assert.throws(() => loadCandidates('Q4_K_M', [], ample), /설치/);
});

test('aborted operations expose the UI cancellation contract', () => {
  const controller = new AbortController();
  checkAbort(controller.signal);
  controller.abort();
  assert.throws(() => checkAbort(controller.signal), { name: 'AbortError' });
});

test('Android can attempt compact Q5 at 4 GB while preserving the Android memory reserve', () => {
  const androidMemory = { total: 7.7e9, rawAvailable: 4e9, available: 4e9 - 512 * 1024 ** 2 };
  assert.deepEqual(loadCandidates('Q5_K_M', installed, androidMemory, 'android'), ['Q5_K_M']);
  assert.deepEqual(inferenceLimits('Q5_K_M', androidMemory, 'android'), {
    context: 2048, batch: 64, microbatch: 32, output: 256,
  });
  assert.equal(inferenceLimits('Q5_K_M', { ...androidMemory, rawAvailable: 4e9 - 1 }, 'android'), null);
  assert.equal(inferenceLimits('Q5_K_M', { ...androidMemory, available: profiles.Q5_K_M.bytes - 1 }, 'android'), null);
  assert.equal(inferenceLimits('Q5_K_M', androidMemory, 'ios'), null);
  assert.equal(inferenceLimits('Q5_K_M', { total: 12e9, available: 6e9 }, 'android').context, 4096);
  assert.deepEqual(loadCandidates('gemma-4-E2B', ['gemma-4-E2B'], { total: 6e9, available: 1.5 * 1024 ** 3 }, 'android'), ['gemma-4-E2B']);
});
