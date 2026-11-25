import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { createStellaDocumentStore } from '../../backend/local/src/stella-documents.js';
import { createDocumentWorkspace } from '../../frontend/Frontend_UI/src/integration/documentWorkspace.mjs';
import { createAIService } from '../../frontend/Frontend_UI/src/integration/ai-service.js';
import { planCommand } from '../../frontend/Frontend_UI/src/features/stella/appCommands.mjs';
import { guardPlan, locateFile, originalEvidence, unstatedTimeWarning } from '../../frontend/Frontend_UI/src/integration/recordEvidence.mjs';

// errors.ts uses parameter properties, which Node's type stripping rejects; ai-chat only needs the class.
registerHooks({ resolve: (specifier, context, next) => specifier === './errors' && context.parentURL?.endsWith('/ai-chat.ts')
  ? { url: 'data:text/javascript,export class AiError extends Error {}', shortCircuit: true } : next(specifier, context) });
const { askAssistant } = await import('../../frontend/Frontend_UI/src/lib/stella/ai-chat.ts');

function fixture(t) {
  const { store, db } = setup();
  t.after(() => db.closeSync());
  const content = createStellaDocumentStore({ db, store });
  const prefs = new Map();
  const documents = createDocumentWorkspace({ store, content, read: (key, fallback) => prefs.get(key) ?? fallback, write: (key, value) => prefs.set(key, value) });
  const rt = { store, documents, closedSpaces: new Set() };
  const memo = store.addMemo({ title: '합성 문서', body: '앞 블록' });
  let id = 0;
  const newId = () => 'block-' + ++id;
  const blocks = () => documents.blocksFor(store.getMemo(memo.id));
  planCommand(rt, '문단 블록 추가: 뒤 블록', memo.id, newId).approve(rt);
  return { rt, memo, newId, blocks, model: (request, output, runtime = rt) => planCommand(runtime, output, memo.id, newId, request) };
}

const paragraphRequest = '예산 초안을 문단으로 추가해줘';
for (const [request, output] of [
  ['내일 장보기 할 일 추가해줘', '할 일 추가 2026-11-27: 장보기'],
  ['장보기 일정 추가해줘', '일정 추가 2026-11-27: 장보기'],
  ['12월 1일 장보기 일정 추가해줘', '일정 추가 2026-11-27: 장보기'],
  ...['표 블록 추가', '문단 블록 추가', '최상위로 이동', '현재 버전 저장', '즐겨찾기 해제', '휴지통 열어줘',
    '목록 블록 추가: 예산 초안'].map(output => [paragraphRequest, output]),
  ['겨울 독서 감상문 초고를 문단으로 추가해줘', '문서 만들기: 겨울 독서 감상문 초고'],
  ['12월 1일 장보기 일정 추가해줘', '할 일 추가 2026-12-01: 장보기'],
  ['다음 달 캘린더 열어줘', '캘린더 열어줘'],
]) {
  test('E1 승인 차단 · ' + request + ' → ' + output, t => {
    const { model, blocks } = fixture(t);
    const before = blocks();
    assert.throws(() => model(request, output), /날짜|작업|내용/);
    assert.deepEqual(blocks(), before);
  });
}

for (const [request, output] of [
  ['12월 1일 장보기 일정 추가해줘', '일정 추가 2026-12-01: 장보기'],
  ['2026-12-01 장보기 할 일 추가해줘', '할 일 추가 2026-12-01: 장보기'],
  [paragraphRequest, '본문 블록 추가: 예산 초안'],
  ['표 블록 추가', '표 블록 추가'],
  ['빈 문단 블록 하나 추가해줘', '문단 블록 추가'],
  ['이번 달 캘린더 열어줘', '캘린더 열어줘'],
]) {
  test('E1 승인 유지 · ' + request, t => {
    const { model } = fixture(t);
    assert.equal(typeof model(request, output).approve, 'function');
  });
}

function analysis(t, body, draft, wrap = store => store) {
  const world = setup();
  t.after(() => world.db.closeSync());
  const memo = world.store.addMemo({ title: '합성 메모', body });
  const service = createAIService({ store: wrap(world.store), newId: () => 'request', getSession: () => ({ id: 'account', generation: 1 }),
    getPolicy: () => ({ route: 'self_hosted', allowedProviders: ['self_hosted'], consent: { self_hosted: true } }),
    gateway: async () => ({ ok: true, request_id: 'fixture', draft: { summary: '', tasks: [], events: [], ...draft } }) });
  return { ...world, memo, run: () => service.analyzeMemo(memo.id) };
}

const event = fields => ({ title: '낭독회', description: null, location: null, date: '2026-12-02', start_time: null, end_date: null, end_time: null, all_day: false, evidence: '', ...fields });
const plan = fields => ({ intent: 'search', reply: null, keywords: [], types: [], date_from: null, date_to: null, status: 'any', people: [], project: null, sort: 'relevance', limit: 8, ...fields });
function chat(draft) {
  const paths = [];
  const client = { functions: { invoke: async path => {
    paths.push(path);
    return { data: { ok: true, request_id: 'fixture', draft: path.endsWith('plan') ? draft
      : { answer: '합성 답변', insufficient: false, citations: [], follow_ups: [], used_source_ids: ['old'], dropped_citations: 0 } }, error: null };
  } } };
  let id = 0;
  return { paths, client, newId: () => 'request-' + ++id };
}

test('결함1: Q5의 문단 명령은 제목 요청에서 제목 블록 하나로 저장되고 주변 블록을 보존한다', t => {
  const { rt, model, blocks } = fixture(t);
  const before = blocks();
  const proposal = model('맨 아래에 현장 기록이라는 제목을 하나 넣어줘', '문단 추가: 현장 기록');
  assert.deepEqual(blocks(), before);
  proposal.approve(rt);
  assert.deepEqual(blocks().slice(0, 2), before);
  assert.deepEqual(blocks().slice(2).map(block => [block.type, block.text]), [['heading', '현장 기록']]);
});

test('결함1: 끝이 아닌 위치의 제목 요청과 복합 요청은 승인 전에 거부한다', t => {
  const { model, blocks } = fixture(t);
  const before = blocks();
  assert.throws(() => model('1번 블록 뒤에 현장 기록이라는 제목을 넣어줘', '제목 블록 추가: 현장 기록'), /위치/);
  assert.throws(() => model('현장 기록이라는 제목을 넣고 1번 블록을 삭제해줘', '문단 추가: 현장 기록'), /지원/);
  assert.deepEqual(blocks(), before);
});

test('결함1: 저장 후 블록 값이 다르면 원래 블록으로 되돌린다', t => {
  const { rt, model, blocks } = fixture(t);
  const before = blocks();
  let corrupted = false;
  const documents = { ...rt.documents, saveContent(id, fields, revision) {
    if (corrupted) return rt.documents.saveContent(id, fields, revision);
    corrupted = true;
    const damaged = fields.blocks.map((block, index) => index === 0 ? { ...block, text: '손상' } : block);
    return rt.documents.saveContent(id, { ...fields, blocks: damaged, body: damaged.map(block => block.text).join('\n\n') }, revision);
  } };
  const faulty = { ...rt, documents };
  assert.throws(() => model('현장 기록이라는 제목을 추가해줘', '제목 블록 추가: 현장 기록', faulty).approve(faulty), /되돌/);
  assert.deepEqual(blocks(), before);
});

test('결함2: 종일로 표시된 일정도 요청 시각을 승인 대기와 저장 값에 보존한다', async t => {
  const body = '2026년 12월 2일 오후 3시에 해솔관에서 낭독회가 열린다.';
  for (const fields of [{ all_day: true, start_time: '15:00' }, { all_day: true, start_time: null }]) {
    const world = analysis(t, body, { events: [event({ ...fields, evidence: body })] });
    await world.run();
    const [proposal] = world.store.getProposals();
    assert.equal(proposal.start, '15:00');
    assert.equal(world.store.getTask(world.store.approveProposal(proposal.id).id).start, '15:00');
  }
});

test('결함2: 오전·오후를 알 수 없는 시각을 잃는 제안은 저장하지 않고 원문을 보존한다', async t => {
  const body = '12월 2일 3시 낭독회';
  const world = analysis(t, body, { events: [event({ all_day: true, evidence: body })] });
  const result = await world.run();
  assert.equal(result.blocked, 1);
  assert.equal(world.store.getProposals().length, 0);
  assert.equal(world.store.getMemo(world.memo.id).body, body);
});

test('결함2: 제안 저장 값의 시각이 다르면 승인 대기에서 제거한다', async t => {
  const body = '2026년 12월 2일 오후 3시에 낭독회가 열린다.';
  const world = analysis(t, body, { events: [event({ start_time: '15:00', evidence: body })] },
    store => ({ ...store, addProposals: items => store.addProposals(items.map(item => ({ ...item, start: '' }))) }));
  await assert.rejects(world.run(), /INVALID_MODEL_OUTPUT/);
  assert.equal(world.store.getProposals().length, 0);
  assert.equal(world.store.getMemo(world.memo.id).body, body);
});

test('결정11: 원문에 없는 시각은 값을 유지하고 승인 카드 경고와 접근성 라벨로 알린다', async t => {
  const body = '2026년 12월 2일에 낭독회가 열린다.';
  const world = analysis(t, body, { events: [event({ start_time: '15:00', evidence: body })] });
  await world.run();
  const [proposal] = world.store.getProposals();
  assert.equal(proposal.start, '15:00');
  assert.match(unstatedTimeWarning(proposal, body), /원문에서 확인되지 않는 시각.*15:00/);
  const read = path => readFileSync(new URL('../../frontend/Frontend_UI/src/features/' + path, import.meta.url), 'utf8');
  assert.match(read('proposal/useProposalActions.js'), /unstatedTimeWarning\(p, getMemo\(p\.sourceId\)\?\.body\)/);
  assert.match(read('proposal/components/ProposalCard.js'), /accessibilityLabel=\{`경고: \$\{reason\}`\}/);
  assert.match(read('proposal/screens/ProposalConfirmScreen.js'), /accessibilityLabel=\{`경고: \$\{timeWarning\}`\}/);
  assert.match(read('stella/WorkspaceScreen.js'), /accessibilityLabel=\{`경고: \$\{reviewReason\(p\)\}`\}/);
});

test('결정11: 정오·자정·원문 시각은 값을 유지하고 경고하지 않는다', async t => {
  const body = '2026년 12월 2일 정오에 낭독회가 열린다.';
  const world = analysis(t, body, { events: [event({ start_time: '12:00', evidence: body })] });
  await world.run();
  const [proposal] = world.store.getProposals();
  assert.equal(proposal.start, '12:00');
  assert.equal(unstatedTimeWarning(proposal, body), '');
  assert.equal(unstatedTimeWarning({ start: '00:00', end: '' }, '자정에 점검'), '');
  assert.equal(unstatedTimeWarning({ start: '15:00', end: '17:00' }, '오후 3시부터 5시까지'), '');
  assert.match(unstatedTimeWarning({ start: '15:00', end: '18:00' }, '오후 3시 시작'), /: 18:00\./);
});

test('결정12: Android 자동 백업 제외 규칙은 모델 폴더 하나만 가리킨다', () => {
  const android = new URL('../../frontend/Frontend_UI/modules/stella-model-device/android/src/main/', import.meta.url);
  const read = path => readFileSync(new URL(path, android), 'utf8');
  const manifest = read('AndroidManifest.xml');
  assert.match(manifest, /fullBackupContent="@xml\/stella_model_backup_rules"/);
  assert.match(manifest, /dataExtractionRules="@xml\/stella_model_extraction_rules"/);
  assert.doesNotMatch(manifest, /allowBackup/);
  assert.match(read('java/expo/modules/stellamodeldevice/StellaModelDeviceModule.kt'), /File\(context\.filesDir, "qwen35"\)/);
  for (const file of ['res/xml/stella_model_backup_rules.xml', 'res/xml/stella_model_extraction_rules.xml']) {
    const rules = read(file).replace(/<!--[\s\S]*?-->/g, '');
    assert.deepEqual(rules.match(/<(?:exclude|include)\b[^>]*>/g), ['<exclude domain="file" path="qwen35/" />']);
  }
});

test('결함2: 앱 명령의 시각 누락·변경은 승인 전에, 저장 값 불일치는 저장 후에 막는다', t => {
  const { rt, model } = fixture(t);
  const request = '12월 2일 오후 3시에 낭독회 일정 넣어줘';
  assert.throws(() => model(request, '일정 추가 2026-12-02: 낭독회'), /시각/);
  assert.throws(() => model(request, '일정 추가 2026-12-02 14:00: 낭독회'), /시각/);
  assert.throws(() => model(request, '일정 추가 2026-12-03 15:00: 낭독회'), /날짜/);
  assert.equal(rt.store.getTasks().length, 0);
  const faulty = { ...rt, store: { ...rt.store, addTask: input => rt.store.addTask({ ...input, start: '' }) } };
  assert.throws(() => model(request, '일정 추가 2026-12-02 15:00: 낭독회', faulty).approve(faulty), /되돌/);
  assert.equal(rt.store.getTasks().length, 0);
});

test('결함3: 인용은 원문 표기만 사용하고 숫자 일부 일치를 근거로 삼지 않는다', () => {
  assert.equal(originalEvidence('작은 상자 12개', '상자 12 개'), '상자 12개');
  assert.equal(originalEvidence('회비 1,200원 납부', '1,200 원'), '1,200원');
  assert.equal(originalEvidence('작은 상자 12개', '2개'), '');
  assert.equal(originalEvidence('작은 상자 12개', '1 2개'), '');
  assert.equal(originalEvidence('길이 12.5km', '12'), '');
});

test('결함3: 제안 제목의 날짜 공백 변형을 원문 표기로 저장한다', async t => {
  const body = '2026년 12월 2일 오후 3시에 해솔관에서 낭독회가 열린다.';
  const world = analysis(t, body, { events: [event({ title: '2026 년 12 월 2 일 낭독회', start_time: '15:00', evidence: '2026 년 12 월 2 일 오후 3 시에' })] });
  await world.run();
  const [proposal] = world.store.getProposals();
  assert.equal(proposal.title, '2026년 12월 2일 낭독회');
  assert.equal(proposal.evidence, '2026년 12월 2일 오후 3시에');
});

test('결함3: 앱 명령 값은 원문 표기로 저장하고 원문에 없는 수량은 거부한다', t => {
  const { rt, model, blocks } = fixture(t);
  model('상자 12개라는 제목을 추가해줘', '제목 블록 추가: 상자 12 개').approve(rt);
  assert.equal(blocks().at(-1).text, '상자 12개');
  const before = blocks();
  assert.throws(() => model('상자 12개를 문단으로 추가해줘', '문단 블록 추가: 상자 13개'), /원문/);
  assert.deepEqual(blocks(), before);
});

test('결함3: 채팅 출처는 변형된 인용 대신 원문 구절을 표시한다', async () => {
  const c = chat(plan({ keywords: ['상자'] }));
  const invoke = c.client.functions.invoke;
  c.client.functions.invoke = async (path, options) => {
    const result = await invoke(path, options);
    if (path.endsWith('answer')) result.data.draft.citations = [{ source_id: 'old', quote: '상자 12 개' }];
    return result;
  };
  const reply = await askAssistant(c.client, { question: '상자 몇 개야?', newId: c.newId, today: '2026-11-23',
    findRecords: () => [{ id: 'old', type: 'memo', title: '합성', text: '작은 상자 12개', date: '2026-11-01' }] });
  assert.equal(reply.sources[0].quote, '상자 12개');
});

test('결함4: 모델이 검색 전에 부재를 단정해도 실제 파일 검색 결과로 답한다', async () => {
  const c = chat(plan({ intent: 'chitchat', reply: '해당 파일이 없습니다.', keywords: ['단풍 회의'] }));
  const history = [{ role: 'user', text: '단풍 회의에 대해 찾아줘.' }];
  const question = '그 회의 파일 있어?';
  const reply = await askAssistant(c.client, { question, history, newId: c.newId, findRecords: () => [],
    locateFile: found => locateFile(question, history, found.keywords, [{ id: 'file', name: '단풍 회의 최종.pdf' }], found.types) });
  assert.equal(reply.sources[0].id, 'file');
  assert.doesNotMatch(reply.text, /없습니다/);
});

test('결함4: 기록과 무관한 직접 답변은 검색으로 바꾸지 않는다', async () => {
  const c = chat(plan({ intent: 'unsupported', reply: '날씨 정보는 없어요.' }));
  let searched = false;
  const reply = await askAssistant(c.client, { question: '내일 날씨 어때?', newId: c.newId, findRecords: () => { searched = true; return []; } });
  assert.equal(searched, false);
  assert.equal(reply.kind, 'direct');
});

test('결함5: 원문에 없는 검색 기간을 제거해 기간 밖 기록을 찾는다', async () => {
  const c = chat(plan({ keywords: ['단풍'], date_from: '2026-11-16', date_to: '2026-11-22' }));
  let searched;
  const reply = await askAssistant(c.client, { question: '그 단풍 회의 기록 찾아줘', history: [{ role: 'user', text: '단풍 회의에 대해 찾아줘.' }],
    newId: c.newId, today: '2026-11-23', findRecords: found => { searched = found; return [{ id: 'old', type: 'memo', title: '단풍 회의', text: '합성', date: '2026-10-01' }]; } });
  assert.deepEqual([searched.date_from, searched.date_to], [null, null]);
  assert.equal(reply.sources[0].id, 'old');
});

test('결함5: 질문이나 지시한 이전 대화에 있는 기간은 유지한다', async () => {
  for (const [question, history] of [['지난주 단풍 회의 찾아줘', []], ['그 회의 기록 다시 찾아줘', [{ role: 'user', text: '지난주 단풍 회의 찾아줘' }]]]) {
    const c = chat(plan({ keywords: ['단풍'], date_from: '2026-11-16', date_to: '2026-11-22' }));
    let searched;
    await askAssistant(c.client, { question, history, newId: c.newId, today: '2026-11-23', findRecords: found => { searched = found; return []; } });
    assert.deepEqual([searched.date_from, searched.date_to], ['2026-11-16', '2026-11-22']);
  }
});

test('리뷰: 제목 앞의 위치 표현을 제목 값으로 저장하지 않는다', t => {
  const { model, blocks } = fixture(t);
  const before = blocks();
  assert.throws(() => model('결론 앞에 회의라는 제목을 넣어줘', '제목 블록 추가: 회의'), /제목을 확정/);
  assert.deepEqual(blocks(), before);
});

test('리뷰: 모델이 바꾼 블록 번호와 동작은 승인 전에 거부한다', t => {
  const { rt, model, blocks } = fixture(t);
  const before = blocks();
  for (const [request, output] of [['2번 블록 삭제해줘', '1번 블록 삭제'], ['2번 블록 복제해줘', '2번 블록 삭제'], ['2번 블록을 1번으로 이동해줘', '1번 블록을 2번으로 이동']])
    assert.throws(() => model(request, output), /블록/);
  assert.deepEqual(blocks(), before);
  model('두 번째 블록을 첫 번째 자리로 옮겨 줘', '2번 블록을 1번으로 이동');
  model('두 번째 블록을 지워줘', '2번 블록 삭제').approve(rt);
  assert.deepEqual(blocks(), before.slice(0, 1));
});

test('리뷰: 근거 구절에 시각이 없어도 단일 일정의 원문 시각을 보존한다', async t => {
  const world = analysis(t, '12월 2일 오후 3시 해솔관 낭독회', { events: [event({ all_day: true, evidence: '해솔관 낭독회' })] });
  await world.run();
  assert.equal(world.store.getProposals()[0].start, '15:00');
});

test('리뷰: 시각 없는 할 일에 다른 일의 시각을 넣지 않는다', async t => {
  const body = '오늘 오후 3시 회의에서 12월 2일까지 보고서를 제출하기로 했다.';
  const world = analysis(t, body, { tasks: [{ title: '보고서 제출', description: null, assignee_name: null, due_date: '2026-12-02', due_time: null, priority: 0, evidence: body }] });
  await world.run();
  assert.equal(world.store.getProposals()[0].start, '');
});

test('리뷰: 다음 날 끝나는 일정의 종료 시각을 보존한다', async t => {
  const body = '12월 2일 밤 11시부터 다음날 새벽 1시까지 관측회';
  const world = analysis(t, body, { events: [event({ title: '관측회', start_time: '23:00', end_date: '2026-12-03', end_time: '01:00', evidence: body })] });
  await world.run();
  assert.equal(world.store.getProposals()[0].end, '01:00');
});

test('리뷰: 질문에 없는 상태 조건은 제거하고 말한 상태와 상대 기간은 유지한다', () => {
  const found = fields => guardPlan(plan({ keywords: ['단풍'], ...fields }), fields.question);
  assert.equal(guardPlan(plan({ status: 'open' }), '단풍 회의 기록 찾아줘').status, 'any');
  assert.equal(guardPlan(plan({ status: 'open' }), '아직 안 끝난 단풍 일정 찾아줘').status, 'open');
  assert.equal(guardPlan(plan({ status: 'done' }), '완료한 단풍 일정 찾아줘').status, 'done');
  for (const question of ['일주일 전 단풍 회의 찾아줘', '한 달 전 단풍 회의 찾아줘', '며칠 전 단풍 회의 찾아줘', '이달 단풍 회의 찾아줘', '11/27 단풍 회의 찾아줘'])
    assert.equal(found({ question, date_from: '2026-11-16' }).date_from, '2026-11-16', question);
});

test('리뷰: 게이트웨이는 띄어쓰기만 다른 답변 인용을 유지하고 숫자를 붙이지 않는다', () => {
  const source = readFileSync(new URL('../../backend/supabase/functions/ai-gateway/assist.ts', import.meta.url), 'utf8');
  const code = source.match(/export function normalizeForMatch[\s\S]*?(?=export function isRealDate)/)[0].replaceAll('export ', '');
  const spacedQuoteFound = runInNewContext(stripTypeScriptTypes(code) + '\nspacedQuoteFound');
  assert.equal(spacedQuoteFound('상자 12 개', '작은 상자 12개'), true);
  assert.equal(spacedQuoteFound('1 2개', '작은 상자 12개'), false);
  assert.equal(spacedQuoteFound('상자 13개', '작은 상자 12개'), false);
});
