import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createRecorder, p95 } from '../../frontend/Frontend_UI/src/integration/s22Metrics.mjs';
import { COMMAND_MAX_CHARS, COMMAND_OVERHEAD_TOKENS, GENERAL_MAX_CHARS, GENERAL_MAX_TOKENS, HEAVY_INPUT_TOKENS, outputLimit, profiles, revision } from '../../frontend/Frontend_UI/src/integration/mobileModelPolicy.mjs';
import { commandGrammar, commandPrompt, EVIDENCE_THRESHOLD, examples, screens } from '../../frontend/Frontend_UI/src/features/stella/appCommands.mjs';

const collect = createRequire(import.meta.url)('../../frontend/Frontend_UI/scripts/s22-collect.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const root = new URL('../../', import.meta.url);

test('metric records keep allowlisted values and drop free text', () => {
  const secret = '합성 비밀 문서 본문';
  let written = '';
  const recorder = createRecorder(text => { written = text; }, () => 1, run => run());
  recorder.record('inference', { model: 'Q4_K_M', task: 'command', ms: 12, prompt: secret, text: secret, error: secret, outcome: secret });
  recorder.record(secret, { ms: 1 });
  assert.deepEqual(JSON.parse(written).events, [{ name: 'inference', at: 1, model: 'Q4_K_M', task: 'command', ms: 12 }]);
  assert.ok(!written.includes(secret));
});

test('a failing metric write cannot reach the app', () => {
  const recorder = createRecorder(() => { throw new Error('disk'); }, () => 1, run => run());
  assert.doesNotThrow(() => recorder.record('cancel', { ms: 1 }));
});

test('p95 uses the nearest rank', () => {
  assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);
  assert.equal(p95([]), null);
});

test('adb parsers read synthetic system output', () => {
  assert.equal(collect.parseColdStart('TotalTime: 1834\n'), 1834);
  assert.deepEqual(collect.parseBattery('  level: 77\n  temperature: 312\n'), { level: 77, temperatureC: 31.2 });
  assert.equal(collect.parseThermal('Thermal Status: 2'), 2);
  assert.equal(collect.parsePssKb('TOTAL PSS:   204800 TOTAL RSS: 1'), 204800);
  assert.deepEqual(collect.parseFrames('Total frames rendered: 200\nJanky frames: 10 (5.00%)\nHISTOGRAM: 5ms=100 650ms=1 700ms=2 900ms=1'),
    { total: 200, janky: 10, slowPercent: 5, frozenOver700ms: 3 });
  assert.deepEqual(collect.parseExits('reason=6 (ANR)\nreason=3 (LOW_MEMORY)\nreason=4 (CRASH)'), { anr: 1, crash: 1, lowMemory: 1 });
});

test('command output limit covers every command form and keeps the general limit', () => {
  const forms = [...examples, ...Object.keys(screens).map(name => name + ' 화면 열어줘')];
  assert.ok(Math.max(...forms.map(form => Buffer.byteLength(form))) <= COMMAND_OVERHEAD_TOKENS);
  assert.equal(outputLimit(null), GENERAL_MAX_TOKENS);
  assert.equal(outputLimit(10), 10 + COMMAND_OVERHEAD_TOKENS);
  assert.equal(outputLimit(5000), GENERAL_MAX_TOKENS);
});

test('frozen S22 config matches the code that produces model output', () => {
  const frozen = JSON.parse(readFileSync(new URL('ai/eval/s22-frozen-config.json', root), 'utf8'));
  assert.equal(frozen.model.revision, revision);
  assert.deepEqual(frozen.model.files, profiles);
  assert.equal(frozen.outputLimits.generalMaxTokens, GENERAL_MAX_TOKENS);
  assert.equal(frozen.outputLimits.commandOverheadTokens, COMMAND_OVERHEAD_TOKENS);
  const source = readFileSync(new URL('frontend/Frontend_UI/src/integration/mobileModel.native.js', root), 'utf8');
  for (const setting of ['n_ctx: 4096', 'n_batch: 128', 'n_ubatch: 64', 'temperature: 0.2', 'use_mmap: true', 'use_mlock: false', 'ctx_shift: false', 'enable_thinking: false']) assert.ok(source.includes(setting), setting);
  const prompt = readFileSync(new URL(frozen.prompts.commandPromptFile, root));
  assert.equal(sha(prompt.toString('utf8').replace(/\r\n/g, '\n')), frozen.prompts.commandPromptFileSha256);
  assert.equal(sha(commandPrompt('{{input}}')), frozen.prompts.commandPromptRenderedSha256);
  assert.equal(sha(commandGrammar), frozen.prompts.commandGrammarSha256);
  assert.deepEqual(frozen.inputLimits, { commandMaxChars: COMMAND_MAX_CHARS, generalMaxChars: GENERAL_MAX_CHARS, heavyInputTokens: HEAVY_INPUT_TOKENS, commandDocumentBlocksSent: 0 });
  assert.equal(frozen.calibration.evidenceThreshold, EVIDENCE_THRESHOLD);
  assert.equal(sha(readFileSync(new URL('ai/eval/s22-calibration.json', root))), frozen.calibration.sha256);
  assert.equal(sha(readFileSync(new URL('ai/eval/s22-command-dev.json', root))), frozen.calibration.devSetSha256);
  assert.equal(frozen.evaluationSampling.seed, 42);
  assert.ok(!/\bseed\s*:/.test(source), 'app runtime seed stays unset');
});
