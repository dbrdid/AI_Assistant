import { insertBlock } from '../../../../../backend/local/src/document-blocks.mjs';
import { blocksText } from '../../../../../backend/local/src/stella-documents.js';

// AI-made blocks wait for the user's decision. The waiting marks are a device preference, never block fields:
// normalizeBlocks drops extra fields and the synchronized document schema stays unchanged.
export const pendingKey = memoId => 'ai-pending:' + memoId;        // [{ id, proposalId? }]
export const pendingDocKey = memoId => 'ai-pending-doc:' + memoId; // true while a whole AI-made document waits

const TYPE_LABEL = { paragraph: '텍스트', heading: '제목', bullet: '목록', task: '체크', table: '표' };

/** The line put before a long-press request so the AI sees which block it targets. block: { index, type, text } */
export function targetLine(block) {
  const text = String(block.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return `대상: 현재 문서의 ${block.index + 1}번 블록(${TYPE_LABEL[block.type] ?? block.type}): "${text}"`;
}

/** The AI screen takes a request only for a long-pressed block or an app command; otherwise it shows connection settings. */
export const canAsk = params => !!params?.block || typeof params?.commandRequest === 'string';

/** The long-press request as the rule router and the review check read it: "N번 블록 <input>". */
export const blockRequest = (block, prompt) => `${block.index + 1}번 블록 ${prompt}`;

/**
 * "N번 블록을 X로 수정" for the long-pressed block is the AI's rewrite of that block, not an app command: X is the
 * model's own text, which the command check (values must come from the request) always refuses. It is returned as
 * the block's proposed text so the user previews it and chooses to replace or insert. Other commands stay commands.
 */
export function targetRewrite(command, block) {
  const m = /^(\d+)\s*번\s*블록(?:을|를)?\s*([\s\S]+?)(?:으)?로\s*(?:수정|바꿔\s*줘)$/.exec(String(command ?? '').trim());
  if (!m || !block || Number(m[1]) !== block.index + 1) return null;
  return m[2].trim().replace(/^["“'‘]|["”'’]$/g, '').trim() || null;
}

/** Paragraph blocks from an AI answer, one per non-empty paragraph. */
function answerBlocks(text, newId) {
  const parts = String(text ?? '').split(/\r?\n\s*\r?\n/).map(part => part.trim()).filter(Boolean);
  return parts.map(part => ({ id: newId(), type: 'paragraph', text: part, checked: false }));
}

/** A block for a task or event proposal. */
function proposalBlock(p, newId) {
  const when = [p.date, p.start && (p.end ? `${p.start}~${p.end}` : p.start)].filter(Boolean).join(' ');
  const text = [p.kind === 'event' ? '일정' : '', when, p.title, p.place && `(${p.place})`].filter(Boolean).join(' ');
  return { id: newId(), type: p.kind === 'task' ? 'task' : 'paragraph', text, checked: false };
}

/** Keeps only waiting entries whose block still exists. */
export const livePending = (pending, blocks) => (Array.isArray(pending) ? pending : []).filter(entry => blocks.some(block => block.id === entry.id));

/**
 * Accept keeps the blocks and clears their marks; reject removes the blocks. Other blocks are never touched.
 * Returns { blocks, pending, entries } where entries are the decided waiting entries.
 */
export function decide(blocks, pending, ids, accept) {
  const chosen = new Set(ids);
  const entries = pending.filter(entry => chosen.has(entry.id));
  const rest = pending.filter(entry => !chosen.has(entry.id));
  if (accept) {
    // A "replace" answer removes its target block only when the user accepts; rejecting keeps the original.
    const replaced = new Set(entries.map(entry => entry.replaces).filter(Boolean));
    return { blocks: replaced.size ? blocks.filter(block => !replaced.has(block.id)) : blocks, pending: rest, entries, replaced };
  }
  let next = blocks.filter(block => !entries.some(entry => entry.id === block.id));
  if (!next.length) next = [{ id: 'body', type: 'paragraph', text: '', checked: false }];
  return { blocks: next, pending: rest, entries };
}

function addWaiting(documents, memo, afterId, added, entries, { read, write }) {
  // afterId null = end of the document; insertBlock throws when the target block is gone.
  const next = added.reduce((list, block, i) => insertBlock(list, i ? added[i - 1].id : afterId, block), documents.blocksFor(memo));
  const saved = saveBlocks(documents, memo, next, new Set(added.map(block => block.id)));
  write(pendingKey(memo.id), [...livePending(read(pendingKey(memo.id), []), next), ...entries]);
  return saved;
}

/** Puts an AI answer after the target block as waiting blocks. replace: accepting also removes the target. Refuses when the document changed since the request. */
export function placeAnswer({ store, documents }, { memoId, revision, blockId, text, replace = false }, prefs, newId) {
  const memo = store.getMemo(memoId);
  if (!memo || memo.deletedAt || memo.revision !== revision) throw new Error('문서가 바뀌었습니다. 문서에서 다시 요청해 주세요.');
  const added = answerBlocks(text, newId);
  return addWaiting(documents, memo, blockId, added, added.map(block => replace ? { id: block.id, replaces: blockId } : { id: block.id }), prefs);
}

/**
 * Review → document. A memo proposal becomes a new document waiting as a whole; a task or event proposal from a
 * document becomes a waiting block at its end, decided later with approveProposal or rejection. Returns the memo id to open.
 */
export function placeProposal({ store, documents }, p, prefs, newId) {
  if (p.kind === 'memo') {
    const saved = store.approveProposal(p.id, {});
    prefs.write(pendingDocKey(saved.id), true);
    return saved.id;
  }
  const memo = p.sourceType === 'memo' && store.getMemo(p.sourceId);
  if (!memo || memo.deletedAt) throw new Error('원본 문서를 찾을 수 없습니다.');
  const block = proposalBlock(p, newId);
  return addWaiting(documents, memo, null, [block], [{ id: block.id, proposalId: p.id }], prefs).id;
}

/** True when the proposal already waits as a block in its source document (hidden from the review list). */
export const isPlaced = (p, read) => !!p.sourceId && read(pendingKey(p.sourceId), []).some(entry => entry.proposalId === p.id);

/** Saves blocks at the expected revision and confirms every block outside `changed` is untouched. */
export function saveBlocks(documents, memo, nextBlocks, changed) {
  const kept = list => JSON.stringify(list.filter(block => !changed.has(block.id)));
  if (kept(documents.blocksFor(memo)) !== kept(nextBlocks)) throw new Error('주변 블록이 바뀌었습니다. 문서를 확인해 주세요.');
  return documents.saveContent(memo.id, { title: memo.title, body: blocksText(nextBlocks), blocks: nextBlocks }, memo.revision);
}
