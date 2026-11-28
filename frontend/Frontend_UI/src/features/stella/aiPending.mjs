import { insertBlock, moveBlock } from '../../../../../backend/local/src/document-blocks.mjs';
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
/**
 * AI가 쓴 Markdown을 실제 블록으로: # 제목, - [ ] 체크리스트, - · 1. 목록, | 표 |, 나머지는 문단(빈 줄로 나눔).
 * 표는 첫 줄의 칸 수에 맞추고 구분선(|---|)은 건너뛴다. 1~50행, 1~20열을 넘으면 넘는 부분은 버린다.
 */
export function markdownBlocks(text, newId) {
  const blocks = [];
  let paragraph = [], table = null;
  const block = (type, value, extra = {}) => blocks.push({ id: newId(), type, text: value, checked: false, ...extra });
  const flush = () => {
    if (paragraph.length) { block('paragraph', paragraph.join('\n')); paragraph = []; }
    if (table) {
      const columns = Math.min(20, table[0].length);
      const rows = table.slice(0, 50).map(row => Array.from({ length: columns }, (_, i) => (row[i] ?? '').replace(/\*\*(.+?)\*\*/g, '$1')));
      blocks.push({ id: newId(), type: 'table', text: '', checked: false, rows });
      table = null;
    }
  };
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').replace(/```[a-z]*\n?/gi, '').split('\n')) {
    const line = raw.trim();
    if (/^\|.*\|$/.test(line)) {
      if (paragraph.length) { const keep = table; table = null; flush(); table = keep; }
      if (/^\|[\s:|-]+\|$/.test(line)) continue; // 표 구분선
      (table ??= []).push(line.slice(1, -1).split('|').map(cell => cell.trim()));
      continue;
    }
    if (table) flush();
    if (!line) { flush(); continue; }
    let m;
    if ((m = /^#{1,6}\s+(.+)$/.exec(line))) { flush(); block('heading', m[1].replace(/\*\*/g, '')); }
    else if ((m = /^[-*•]\s+\[( |x|X)\]\s*(.*)$/.exec(line))) { flush(); block('task', m[2], { checked: m[1] !== ' ' }); }
    else if ((m = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line))) { flush(); block('bullet', m[1]); }
    else paragraph.push(line);
  }
  flush();
  return blocks.map(b => b.type === 'table' ? b : { ...b, text: b.text.replace(/\*\*(.+?)\*\*/g, '$1') });
}

function answerBlocks(text, newId) {
  return markdownBlocks(text, newId);
}

/** AI가 쓴 글 전체로 새 문서를 블록 단위로 만든다. 문서 전체가 "AI가 만든 문서"로 표시되어 수용 또는 거절을 기다린다. */
export function createAiDocument({ store, documents }, { title, text, pending = true }, prefs, newId) {
  const blocks = markdownBlocks(text, newId);
  if (!blocks.length) throw new Error('문서로 만들 내용이 없습니다.');
  const memo = store.addMemo({ title: String(title ?? '').trim().slice(0, 200), body: blocksText(blocks) });
  const saved = documents.saveContent(memo.id, { title: memo.title, body: blocksText(blocks), blocks }, memo.revision);
  if (pending) prefs.write(pendingDocKey(saved.id), true);
  return saved.id;
}

/** A block for a task or event proposal. */
function proposalBlock(p, newId) {
  const when = [p.date, p.start && (p.end ? `${p.start}~${p.end}` : p.start)].filter(Boolean).join(' ');
  const text = [p.kind === 'event' ? '일정' : '', when, p.title, p.place && `(${p.place})`].filter(Boolean).join(' ');
  return { id: newId(), type: p.kind === 'task' ? 'task' : 'paragraph', text, checked: false };
}

const sameBlock = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Drop a preview if its target was independently edited or removed. */
export const livePending = (pending, blocks) => (Array.isArray(pending) ? pending : []).filter(entry =>
  blocks.some(block => block.id === entry.id && (!entry.original || sameBlock(entry.original, block))) &&
  (entry.beforeId == null || blocks.some(block => block.id === entry.beforeId))
);

export function previewOrder(blocks, pending) {
  return pending.reduce((list, entry) => 'beforeId' in entry ? moveBlock(list, entry.id, entry.beforeId) : list, blocks);
}

/**
 * Apply the chosen edits, or discard their previews and remove any legacy inserted proposals.
 * Returns { blocks, pending, entries } where entries are the decided waiting entries.
 */
export function decide(blocks, pending, ids, accept) {
  const chosen = new Set(ids);
  const entries = livePending(pending, blocks).filter(entry => chosen.has(entry.id));
  const rest = pending.filter(entry => !chosen.has(entry.id));
  if (accept) {
    // A "replace" answer removes its target block only when the user accepts; rejecting keeps the original.
    // A "deletes" mark removes the marked block itself when accepted.
    const removed = new Set([...entries.map(entry => entry.replaces), ...entries.filter(entry => entry.deletes).map(entry => entry.id)].filter(Boolean));
    const edits = new Map(entries.filter(entry => entry.preview).map(entry => [entry.id, entry.preview]));
    const replaced = new Set([...removed, ...edits.keys(), ...[...edits.values()].flat().map(block => block.id),
      ...entries.filter(entry => 'beforeId' in entry).map(entry => entry.id)]);
    const ordered = previewOrder(blocks, entries);
    let next = replaced.size ? ordered.flatMap(block => removed.has(block.id) ? [] : edits.get(block.id) ?? [block]) : blocks;
    if (!next.length) next = [{ id: 'body', type: 'paragraph', text: '', checked: false }];
    return { blocks: next, pending: rest, entries, replaced };
  }
  // 거절: 새로 넣은 블록은 빼고, 삭제 표시만 붙은 기존 블록은 그대로 둔다
  const removed = new Set(entries.filter(entry => !entry.deletes && !entry.original).map(entry => entry.id));
  let next = removed.size ? blocks.filter(block => !removed.has(block.id)) : blocks;
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

/** Stage rewrites on the target, and place explicitly requested additions after it. */
export function placeAnswer({ store, documents }, { memoId, revision, blockId, text, replace = false }, prefs, newId) {
  const memo = store.getMemo(memoId);
  if (!memo || memo.deletedAt || memo.revision !== revision) throw new Error('문서가 바뀌었습니다. 문서에서 다시 요청해 주세요.');
  const added = answerBlocks(text, newId);
  if (!replace) return addWaiting(documents, memo, blockId, added, added.map(block => ({ id: block.id })), prefs);
  if (!added.length) throw new Error('바뀌는 내용이 없습니다.');
  const blocks = documents.blocksFor(memo);
  const target = blocks.find(block => block.id === blockId);
  if (!target) throw new Error('원본 블록을 찾을 수 없습니다.');
  const preview = [{ ...added[0], id: blockId }, ...added.slice(1)];
  writeWaiting(memo, blocks, [{ id: blockId, original: target, preview }], prefs);
  return memo;
}

/**
 * Review → document. A memo proposal becomes a new document waiting as a whole; a task or event proposal from a
 * document becomes a waiting block at its end, decided later with approveProposal or rejection. Returns the memo id to open.
 */
export function placeProposal({ store, documents }, p, prefs, newId) {
  if (p.kind === 'memo') {
    let saved = store.approveProposal(p.id, {});
    // 요약 속 목록, 체크리스트, 표도 실제 블록으로
    const blocks = markdownBlocks(saved.body, newId);
    if (blocks.length > 1 || blocks[0]?.type !== 'paragraph') saved = documents.saveContent(saved.id, { title: saved.title, body: blocksText(blocks), blocks }, saved.revision);
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

/**
 * AI 앱 작업이 바꾼 블록을 문서 안의 대기 제안으로: 바로 저장하지 않고, 바뀐 곳을 강조해 문서에서 수용·거절한다.
 * original: 지금 블록, next: 작업을 적용한 결과. 바뀐 블록은 새 판을 원래 블록 바로 아래에(수용하면 대체),
 * 새 블록은 그 자리에, 지운 블록은 그대로 두고 '수용하면 삭제' 표시, 옮긴 블록은 새 자리에 사본(수용하면 원래 자리 것을 대체).
 */
function writeWaiting(memo, blocks, entries, { read, write }) {
  const ids = new Set(entries.map(entry => entry.id));
  const waiting = livePending(read(pendingKey(memo.id), []), blocks).filter(entry => !ids.has(entry.id));
  write(pendingKey(memo.id), [...waiting, ...entries]);
}

export function proposeBlocks(documents, memo, original, next, prefs) {
  const byId = new Map(original.map(block => [block.id, block]));
  const nextIds = new Set(next.map(block => block.id));
  const result = original.slice();
  const entries = new Map();
  const insertAfter = (afterId, block) => {
    const at = afterId == null ? 0 : result.findIndex(item => item.id === afterId) + 1;
    result.splice(at, 0, block);
  };
  // 옮기기: 같은 블록들, 같은 내용, 순서만 다름
  const kept = next.filter(block => byId.has(block.id));
  const orderChanged = kept.some((block, i) => block.id !== original.filter(item => nextIds.has(item.id))[i]?.id);
  if (orderChanged) {
    const base = original.filter(item => nextIds.has(item.id));
    const i = kept.findIndex((block, k) => block.id !== base[k].id);
    const without = id => list => list.filter(item => item.id !== id).map(item => item.id).join();
    const moved = without(kept[i].id)(kept) === without(kept[i].id)(base) ? kept[i] : base[i];
    const position = next.findIndex(block => block.id === moved.id);
    entries.set(moved.id, { id: moved.id, original: byId.get(moved.id), beforeId: next[position + 1]?.id ?? null });
  }
  next.forEach((block, i) => {
    const before = byId.get(block.id);
    if (!before) {   // 새 블록: 결과에서 바로 앞 블록 뒤에
      const previous = next.slice(0, i).reverse().find(item => result.some(r => r.id === item.id));
      insertAfter(previous?.id ?? null, block);
      entries.set(block.id, { id: block.id });
    } else if (!sameBlock(before, block)) {
      entries.set(block.id, { ...entries.get(block.id), id: block.id, original: before, preview: [block] });
    }
  });
  for (const block of original) if (!nextIds.has(block.id)) entries.set(block.id, { id: block.id, original: block, deletes: true });
  if (!entries.size) throw new Error('바뀌는 내용이 없습니다.');
  const changed = new Set(next.filter(block => !byId.has(block.id)).map(block => block.id));
  const saved = changed.size ? saveBlocks(documents, memo, result, changed) : memo;
  writeWaiting(memo, result, [...entries.values()], prefs);
  return saved;
}
