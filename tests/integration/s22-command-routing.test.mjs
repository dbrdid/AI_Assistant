import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { createStellaDocumentStore } from '../../backend/local/src/stella-documents.js';
import { createDocumentWorkspace } from '../../frontend/Frontend_UI/src/integration/documentWorkspace.mjs';
import { commandGrammar, commandPrompt, EVIDENCE_THRESHOLD, examples, planCommand, routeCommand, screens } from '../../frontend/Frontend_UI/src/features/stella/appCommands.mjs';
import { heavyTaskBlock, HEAVY_INPUT_TOKENS } from '../../frontend/Frontend_UI/src/integration/mobileModelPolicy.mjs';
import { calibrate } from '../../ai/eval/calibrate-command.mjs';

const json = path => JSON.parse(readFileSync(new URL('../../ai/eval/' + path, import.meta.url), 'utf8'));

function fixture(t, count = 3) {
  const { store, db } = setup();
  t.after(() => db.closeSync());
  const content = createStellaDocumentStore({ db, store });
  const prefs = new Map();
  const documents = createDocumentWorkspace({ store, content, read: (key, fallback) => prefs.get(key) ?? fallback, write: (key, value) => prefs.set(key, value) });
  const rt = { store, documents, closedSpaces: new Set() };
  const memo = store.addMemo({ title: '합성 문서', body: '' });
  const start = Array.from({ length: count }, (_, i) => ({ id: 'seed-' + i, type: 'paragraph', text: '합성 블록 ' + i, checked: false }));
  documents.saveContent(memo.id, { title: memo.title, blocks: start, body: start.map(block => block.text).join('\n\n') }, store.getMemo(memo.id).revision);
  let id = 0;
  const newId = () => 'new-' + ++id;
  const blocks = () => documents.blocksFor(store.getMemo(memo.id));
  const routed = (request, runtime = rt) => planCommand(runtime, routeCommand(request).command, memo.id, newId, request);
  return { rt, memo, blocks, routed, newId };
}

// Enough GBNF for this grammar: literals, classes, groups, alternation and ?/+ become a RegExp.
function grammarRegExp(grammar) {
  const rules = Object.fromEntries(grammar.trim().split('\n').map(line => line.split(' ::= ')));
  const expand = body => body.replace(/"[^"]*"|\[[^\]]*\]|[a-z]+|\s+/g, token =>
    !token.trim() ? '' : token[0] === '"' ? token.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : token[0] === '[' ? token : '(?:' + expand(rules[token]) + ')');
  return new RegExp('^(?:' + expand(rules.root) + ')$', 'u');
}

test('라우터: 개발셋의 명확한 명령·되묻기·모델 경로를 구분한다', () => {
  for (const item of json('s22-command-dev.json').route) {
    const result = routeCommand(item.request);
    if (item.command) assert.equal(result.command, item.command, item.id);
    else if (item.clarify) assert.ok(result.clarify && !result.command, item.id);
    else assert.deepEqual(result, {}, item.id);
  }
});

test('라우터: 표 셀 요청을 본문 수정으로 해석하지 않는다', t => {
  assert.equal(routeCommand('1번 블록의 2행 3열을 담당자로 수정').command, '1번 블록의 2행 3열 수정: 담당자');
  const { routed, blocks } = fixture(t);
  const before = blocks();
  assert.throws(() => routed('1번 블록의 1행 1열을 담당자로 수정'), /표 셀/);
  assert.deepEqual(blocks(), before);
});

test('라우터: 규칙이 읽은 값은 근거 비율로 다시 거부하지 않고, 빈 제목은 명령으로 만들지 않는다', t => {
  const { rt, routed, blocks } = fixture(t, 8);
  routed('8번 블록 내용을 수정된 공지로 바꿔줘').approve(rt);
  assert.equal(blocks()[7].text, '수정된 공지');
  assert.deepEqual(routeCommand('""라는 제목을 추가해줘'), {});
});

test('되묻기: 공손한 표현만 더한 요청은 근거 부족으로 거부하지 않는다', t => {
  const { rt, memo, newId } = fixture(t);
  assert.doesNotThrow(() => planCommand(rt, '문서 만들기: 회의록', memo.id, newId, '회의록 문서 좀 만들어줘'));
});

test('라우터: 승인 전에는 저장하지 않고 승인은 한 번만 실행한다', t => {
  const { rt, routed, blocks } = fixture(t);
  const before = blocks();
  const plan = routed('두 번째 블록을 지워줘');
  assert.deepEqual(blocks(), before);
  plan.approve(rt);
  assert.deepEqual(blocks(), [before[0], before[2]]);
  assert.throws(() => plan.approve(rt), /이미 처리/);
});

test('라우터: 검토 후 문서가 바뀌면 승인을 거부한다', t => {
  const { rt, memo, routed, blocks } = fixture(t);
  const plan = routed('1번 블록 삭제해줘');
  const changed = blocks().map(block => ({ ...block, text: block.text + ' 변경' }));
  rt.documents.saveContent(memo.id, { title: memo.title, blocks: changed, body: changed.map(block => block.text).join('\n\n') }, rt.store.getMemo(memo.id).revision);
  assert.throws(() => plan.approve(rt), /바뀌었습니다/);
  assert.deepEqual(blocks(), changed);
});

test('라우터: 저장 후 값이 다르면 원래 블록으로 되돌린다', t => {
  const { rt, routed, blocks } = fixture(t);
  const before = blocks();
  let corrupted = false;
  const documents = { ...rt.documents, saveContent(id, fields, revision) {
    if (corrupted) return rt.documents.saveContent(id, fields, revision);
    corrupted = true;
    const damaged = fields.blocks.map((block, index) => index === 0 ? { ...block, text: '손상' } : block);
    return rt.documents.saveContent(id, { ...fields, blocks: damaged, body: damaged.map(block => block.text).join('\n\n') }, revision);
  } };
  const faulty = { ...rt, documents };
  assert.throws(() => routed('2번 블록을 새 내용으로 수정해줘', faulty).approve(faulty), /되돌/);
  assert.deepEqual(blocks(), before);
});

test('라우터: 규칙이 해석한 요청과 다른 모델 출력은 거부한다', t => {
  const { memo, rt, newId } = fixture(t);
  assert.throws(() => planCommand(rt, '1번 블록을 다른 값으로 수정', memo.id, newId, '2번 블록을 새 내용으로 수정해줘'), /블록/);
});

test('입력 축소: 500블록 문서의 본문은 프롬프트에 없고 대상 외 블록은 그대로다', t => {
  const { rt, routed, blocks } = fixture(t, 500);
  const before = blocks();
  const prompt = commandPrompt('250번 블록을 교체된 내용으로 수정해줘');
  assert.ok(before.every(block => !prompt.includes(block.text)));
  routed('250번 블록을 교체된 내용으로 수정해줘').approve(rt);
  const after = blocks();
  assert.equal(after.length, 500);
  assert.equal(after[249].text, '교체된 내용');
  assert.deepEqual(after.filter((_, i) => i !== 249), before.filter((_, i) => i !== 249));
});

test('문법: 모든 명령 형식을 허용하고 설명문과 줄바꿈을 막는다', () => {
  const grammar = grammarRegExp(commandGrammar);
  for (const form of [...examples, '지원불가', ...Object.keys(screens).map(name => name + ' 열어줘')]) assert.ok(grammar.test(form), form);
  for (const bad of ['물론입니다. 1번 블록 삭제', '1번 블록 삭제\n2번 블록 삭제', '0번 블록 삭제', '없는화면 열어줘', '일정 추가 내일: 회의', '']) assert.ok(!grammar.test(bad), bad);
});

test('문법: llama.cpp 파서가 허용하는 규칙 이름과 한 줄 규칙만 쓴다', () => {
  const lines = commandGrammar.trim().split('\n');
  assert.ok(lines.every(line => /^[a-z]+ ::= \S/.test(line)));
  assert.equal(lines.filter(line => line.startsWith('root ::= ')).length, 1);
  const defined = new Set(lines.map(line => line.split(' ')[0]));
  const used = commandGrammar.replace(/"[^"]*"|\[[^\]]*\]/g, ' ').match(/\b[a-z]+\b/g);
  assert.ok(used.every(name => defined.has(name)));
});

test('기기 제한: 긴 입력만 제한하고 읽지 못한 상태는 안전하게 처리한다', () => {
  const normal = { thermal: false, memory: { available: 4e9, lowMemory: false } };
  const long = HEAVY_INPUT_TOKENS + 1;
  assert.equal(heavyTaskBlock(HEAVY_INPUT_TOKENS, {}), '');
  assert.equal(heavyTaskBlock(long, normal), '');
  assert.match(heavyTaskBlock(long, { ...normal, thermal: true }), /온도/);
  assert.match(heavyTaskBlock(long, { ...normal, memory: { available: 4e9, lowMemory: true } }), /메모리/);
  for (const state of [{}, { ...normal, thermal: null }, { ...normal, thermal: undefined }, { thermal: false }]) assert.match(heavyTaskBlock(long, state), /확인할 수 없어/);
});

test('보정: 임계값은 보정셋 계산값과 같고 되물어야 할 항목을 통과시키지 않는다', () => {
  const result = calibrate();
  assert.equal(result.threshold, EVIDENCE_THRESHOLD);
  assert.equal(result.unsafe, 0);
  assert.deepEqual(result.refusedExecute, []);
  assert.equal(result.sha256, json('s22-frozen-config.json').calibration.sha256);
});

test('보정: 보정셋·개발셋·13개 개발셋의 요청이 겹치지 않는다', () => {
  const cases = readFileSync(new URL('../../ai/eval/mobile-cases.json', import.meta.url), 'utf8');
  const dev = json('s22-command-dev.json');
  const all = [...json('s22-calibration.json').items, ...dev.route, ...dev.gate].map(item => item.request);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(all.filter(request => cases.includes(request)), []);
});

test('되묻기: 개발셋에서 근거 부족·지원불가·대상 변경을 실행하지 않는다', t => {
  const { rt, memo, newId, blocks } = fixture(t, 8);
  const before = blocks();
  for (const item of json('s22-command-dev.json').gate) {
    const run = () => planCommand(rt, item.output, memo.id, newId, item.request);
    if (item.expected === 'execute') assert.doesNotThrow(run, item.id);
    else assert.throws(run, undefined, item.id);
  }
  assert.deepEqual(blocks(), before);
});
