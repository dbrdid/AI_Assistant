import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { createStellaDocumentStore } from '../../backend/local/src/stella-documents.js';
import { createDocumentWorkspace } from '../../frontend/Frontend_UI/src/integration/documentWorkspace.mjs';
import { blockRequest, canAsk, decide, isPlaced, livePending, pendingDocKey, pendingKey, placeAnswer, placeProposal, saveBlocks, targetLine, targetRewrite } from '../../frontend/Frontend_UI/src/features/stella/aiPending.mjs';
import { gatewayMessages } from '../../frontend/Frontend_UI/src/integration/aiGateway.mjs';
import { ROUTES, TABS, MORE_SECTIONS } from '../../frontend/Frontend_UI/src/navigation/routes.js';
import { planCommand, routeCommand, screens } from '../../frontend/Frontend_UI/src/features/stella/appCommands.mjs';

function fixture(t) {
  const { store, db } = setup();
  t.after(() => db.closeSync());
  const prefMap = new Map();
  const prefs = { read: (key, fallback) => prefMap.get(key) ?? fallback, write: (key, value) => prefMap.set(key, value) };
  const documents = createDocumentWorkspace({ store, content: createStellaDocumentStore({ db, store }), ...prefs });
  const added = store.addMemo({ title: '회의', body: '첫 문단\n\n둘째 문단' });
  const memo = documents.saveContent(added.id, { title: '회의', body: added.body, blocks: [
    { id: 'b1', type: 'paragraph', text: '첫 문단', checked: false }, { id: 'b2', type: 'paragraph', text: '둘째 문단', checked: false }] }, added.revision);
  let n = 0;
  return { rt: { store, documents }, memo, prefs, newId: () => 'ai-' + ++n, blocks: () => documents.blocksFor(store.getMemo(memo.id)) };
}

test('long-press answer is inserted after the target as waiting blocks; accept keeps, reject removes only them', t => {
  const { rt, memo, prefs, newId, blocks } = fixture(t);
  const before = blocks();
  assert.equal(before.length, 2);
  const target = { ...before[0], index: 0 };
  assert.throws(() => placeAnswer(rt, { memoId: memo.id, revision: memo.revision + 1, blockId: target.id, text: 'x' }, prefs, newId), /바뀌었습니다/);
  placeAnswer(rt, { memoId: memo.id, revision: memo.revision, blockId: target.id, text: '답 하나\n\n답 둘' }, prefs, newId);
  assert.deepEqual(blocks().map(b => b.text), ['첫 문단', '답 하나', '답 둘', '둘째 문단']);
  const waiting = livePending(prefs.read(pendingKey(memo.id), []), blocks());
  assert.deepEqual(waiting.map(e => e.id), ['ai-1', 'ai-2']);

  const accepted = decide(blocks(), waiting, ['ai-1'], true);
  assert.deepEqual(accepted.blocks, blocks());
  assert.deepEqual(accepted.pending.map(e => e.id), ['ai-2']);
  const rejected = decide(blocks(), accepted.pending, ['ai-2'], false);
  saveBlocks(rt.documents, rt.store.getMemo(memo.id), rejected.blocks, new Set(['ai-2']));
  assert.deepEqual(blocks().map(b => b.text), ['첫 문단', '답 하나', '둘째 문단']);
  assert.deepEqual(rejected.pending, []);
  // A save that would touch a block outside the decided ones is refused.
  const tampered = blocks().map(b => b.id === before[1].id ? { ...b, text: '변경' } : b);
  assert.throws(() => saveBlocks(rt.documents, rt.store.getMemo(memo.id), tampered, new Set()), /주변 블록/);
});

test('review proposals become highlighted document blocks or a waiting document, and decisions sync proposal status', t => {
  const { rt, memo, prefs, newId, blocks } = fixture(t);
  const [task, other, summary] = rt.store.addProposals([
    { kind: 'task', title: '자료 준비', date: '2026-12-01', sourceType: 'memo', sourceId: memo.id, sourceRevision: memo.revision },
    { kind: 'task', title: '장소 예약', date: '2026-12-02', sourceType: 'memo', sourceId: memo.id, sourceRevision: memo.revision },
    { kind: 'memo', title: '회의 요약', body: '요약 본문', sourceType: 'memo', sourceId: memo.id, sourceRevision: memo.revision },
  ]);
  const docId = placeProposal(rt, summary, prefs, newId);
  assert.notEqual(docId, memo.id);
  assert.equal(prefs.read(pendingDocKey(docId)), true);
  assert.equal(rt.store.getMemo(docId).body, '요약 본문');

  assert.equal(placeProposal(rt, task, prefs, newId), memo.id);
  placeProposal(rt, other, prefs, newId);
  assert.deepEqual(blocks().slice(-2).map(b => [b.type, b.text]), [['task', '2026-12-01 자료 준비'], ['task', '2026-12-02 장소 예약']]);
  assert.ok(isPlaced(task, prefs.read) && isPlaced(other, prefs.read));

  // Placing the block moved the source revision on: plain approval is stale, the reviewed revision is accepted.
  assert.throws(() => rt.store.approveProposal(task.id, {}), e => e.code === 'source_changed');
  const saved = rt.store.approveProposal(task.id, {}, { reviewedRevision: rt.store.getMemo(memo.id).revision });
  assert.equal(saved.title, '자료 준비');
  rt.store.setProposalStatus(other.id, 'rejected');
  assert.equal(rt.store.getProposals().some(p => p.id === task.id || p.id === other.id), false);
});

test('a long-press command passes review with the "N번 블록" request, not the target line', t => {
  const { rt, memo, newId, blocks } = fixture(t);
  const target = { ...blocks()[1], index: 1 };
  const prompt = '1분기 예산 초안으로 수정해줘';
  const routed = routeCommand(blockRequest(target, prompt));
  assert.ok(routed.command);
  const world = { ...rt, closedSpaces: new Set() };
  assert.throws(() => planCommand(world, routed.command, memo.id, newId, targetLine(target) + '\n' + prompt), /다릅니다/);
  planCommand(world, routed.command, memo.id, newId, blockRequest(target, prompt)).approve(world);
  assert.deepEqual(blocks().map(b => b.text), ['첫 문단', '1분기 예산 초안']);
});

test('long-press target context reaches the gateway and the AI menus are gone', () => {
  const line = targetLine({ index: 2, type: 'task', text: '보고서\n제출' });
  assert.equal(line, '대상: 현재 문서의 3번 블록(체크): "보고서 제출"');
  assert.ok(gatewayMessages(line + '\n이거 내일로 미뤄줘', 'chat').user.startsWith(line));
  const menu = [...TABS.flatMap(tab => tab.pages), ...MORE_SECTIONS.flatMap(section => section.items)].map(item => item.route);
  assert.equal(menu.includes(ROUTES.Ai), false);
  assert.equal(menu.includes(ROUTES.AppCommand), false);
  assert.ok(menu.includes(ROUTES.LocalModel) && menu.includes(ROUTES.Proposals));
  assert.equal(screens['AI 채팅'], ROUTES.Ai); // the frozen command list still resolves to a route
  // The AI tab (no params) and the old AI chat route show settings only; a block or app command enables the request input.
  assert.equal(canAsk(undefined), false);
  assert.equal(canAsk({}), false);
  assert.equal(canAsk({ block: { id: 'b1', index: 0 } }), true);
  assert.equal(canAsk({ commandRequest: '' }), true);
});

test('a replace answer keeps the original until accepted; reject restores the document exactly', t => {
  const { rt, memo, prefs, newId, blocks } = fixture(t);
  const before = blocks();
  placeAnswer(rt, { memoId: memo.id, revision: memo.revision, blockId: 'b1', text: '고친 문단', replace: true }, prefs, newId);
  assert.deepEqual(blocks(), before);
  const waiting = livePending(prefs.read(pendingKey(memo.id), []), blocks());
  assert.equal(waiting[0].id, 'b1');
  assert.equal(waiting[0].preview[0].text, '고친 문단');

  const rejected = decide(blocks(), waiting, ['b1'], false);
  assert.deepEqual(rejected.blocks, before);
  const accepted = decide(blocks(), waiting, ['b1'], true);
  assert.deepEqual([...accepted.replaced], ['b1']);
  saveBlocks(rt.documents, rt.store.getMemo(memo.id), accepted.blocks, accepted.replaced);
  assert.deepEqual(blocks().map(b => b.text), ['고친 문단', '둘째 문단']);
  assert.equal(blocks()[0].id, 'b1');
});

test('top tabs keep daily destinations; review, AI settings and tools stay reachable', () => {
  assert.deepEqual(TABS.map(tab => tab.route), [ROUTES.Home, ROUTES.Tasks, ROUTES.Memos, ROUTES.Projects]);
  const more = MORE_SECTIONS.flatMap(section => section.items).map(item => item.route);
  for (const route of [ROUTES.LocalModel, ROUTES.Proposals, ROUTES.Relations, ROUTES.AdvancedMemos, ROUTES.Trash]) assert.ok(more.includes(route), route);
});

test('an AI rewrite of the long-pressed block becomes that block\'s proposed text, not a refused app command', () => {
  const block = { id: 'b1', index: 0, type: 'paragraph', text: 'Budget review meeting with Kim tomorrow at 3pm.' };
  assert.equal(targetRewrite('1번 블록을 Kim budget review tomorrow at 3pm로 수정', block), 'Kim budget review tomorrow at 3pm');
  assert.equal(targetRewrite('1번 블록을 "더 짧은 문장"으로 수정', block), '더 짧은 문장');
  assert.equal(targetRewrite('2번 블록을 다른 내용으로 수정', block), null); // another block stays a command for review
  assert.equal(targetRewrite('1번 블록 삭제', block), null);
  assert.equal(targetRewrite('1번 블록을 X로 수정', null), null);
});
