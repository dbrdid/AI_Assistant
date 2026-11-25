import { documentTree } from '../../../../backend/local/src/stella-documents.js';
import { memoReferenceIds } from '../features/memo/utils/memoReferences.mjs';

const EMPTY = Object.freeze({});
const MAX_COORDINATE = 100000;
function anchorsForStorage(value) {
  if (value == null) return null;
  const anchor = point => {
    if (!point || !['left', 'right', 'top', 'bottom'].includes(point.side) || !Number.isFinite(point.offset) || point.offset < 0 || point.offset > 1) throw new Error('연결 위치가 올바르지 않습니다.');
    return { side: point.side, offset: point.offset };
  };
  const result = { source: anchor(value.source), target: anchor(value.target) };
  if (value.via !== undefined) {
    if (!Array.isArray(value.via) || value.via.length > 32) throw new Error('연결 경로가 올바르지 않습니다.');
    result.via = value.via.map(point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > MAX_COORDINATE || Math.abs(point.y) > MAX_COORDINATE) throw new Error('연결 경로가 범위를 벗어났습니다.');
      return { x: point.x, y: point.y };
    });
  }
  return result;
}

// Existing memo hierarchy and Markdown remain authoritative. Only diagram layout is device-local.
export function createDocumentWorkspace({ content, store, read, write, isActive = () => true, isClosed = () => false }) {
  let snapshot;
  function workspace(edit = false) {
    if (!isActive()) throw new Error('계정이 바뀌었습니다. 문서를 다시 열어 주세요.');
    const current = store.getCurrentWorkspace();
    if (isClosed(current.id)) throw new Error('이 공간의 접근 권한이 종료되었습니다.');
    if (edit && !current.personal && current.roleCode === 'VIEWER') throw new Error('보기 전용 공간입니다.');
    return current;
  }
  function listDocuments() {
    const current = workspace();
    const memos = store.getMemos();
    const positions = read(`stella-document-positions:${current.id}`, EMPTY);
    const metadata = content?.listDocuments();
    const order = read(`stella-document-order:${current.id}`, EMPTY);
    if (snapshot?.memos === memos && snapshot.positions === positions && snapshot.workspaceId === current.id && snapshot.metadata === metadata && snapshot.order === order) return snapshot.rows;
    const visible = memos.filter(memo => (memo.workspaceId == null || memo.workspaceId === current.id) && memo.deletedAt == null);
    const ids = new Set(visible.map(memo => memo.id));
    const rows = documentTree(visible.map(memo => ({ ...memo, parentId: ids.has(memo.parentMemoId) ? memo.parentMemoId : null, taskIds: memo.taskIds ?? [], order: order[memo.id] ?? metadata?.find(item => item.id === memo.id)?.order ?? memo.createdAt, ...(positions[memo.id] ?? {}) })));
    snapshot = { memos, positions, metadata, order, workspaceId: current.id, rows };
    return rows;
  }
  function requireMemo(id) {
    const memo = listDocuments().find(item => item.id === id);
    if (!memo) throw new Error('현재 공간에서 문서를 찾을 수 없습니다.');
    return memo;
  }
  // Derived, rebuildable link index: bodies are parsed only when they change, and unchanged inputs reuse the result.
  const references = new Map();
  let linkSnapshot;
  function referencesOf(doc) {
    const cached = references.get(doc.id);
    if (cached?.body === doc.body) return cached.ids;
    const ids = memoReferenceIds(doc.body);
    references.set(doc.id, { body: doc.body, ids });
    return ids;
  }
  function links() {
    const current = workspace();
    const docs = listDocuments(), stored = read(`stella-document-links:${current.id}`, EMPTY);
    if (linkSnapshot?.docs === docs && linkSnapshot.stored === stored) return linkSnapshot.rows;
    const ids = new Set(docs.map(doc => doc.id));
    for (const id of references.keys()) if (!ids.has(id)) references.delete(id);
    const manual = Object.values(stored).filter(link => ids.has(link.source) && ids.has(link.target));
    const sources = docs.flatMap(doc => [...referencesOf(doc)].filter(id => id !== doc.id && ids.has(id)).map(target => ({ source: doc.id, target, kind: 'source' })));
    linkSnapshot = { docs, stored, rows: [...sources, ...manual] };
    return linkSnapshot.rows;
  }
  function savePosition(id, x, y) {
    const current = workspace(true);
    requireMemo(id);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) throw new Error('문서 위치가 범위를 벗어났습니다.');
    const key = `stella-document-positions:${current.id}`;
    write(key, { ...read(key, EMPTY), [id]: { x, y } });
  }
  function setLink(source, target, linked, anchors = null) {
    const current = workspace(true);
    requireMemo(source); requireMemo(target);
    if (source === target) throw new Error('같은 문서는 연결할 수 없습니다.');
    const normalized = anchorsForStorage(anchors);
    const ids = [source, target].sort(), pair = JSON.stringify(ids);
    const key = `stella-document-links:${current.id}`, values = { ...read(key, EMPTY) };
    if (linked) {
      const positioned = source === ids[0] || !normalized ? normalized : { source: normalized.target, target: normalized.source, ...(normalized.via ? { via: [...normalized.via].reverse() } : {}) };
      values[pair] = { source: ids[0], target: ids[1], kind: 'manual', anchors: positioned ?? values[pair]?.anchors ?? null };
    } else delete values[pair];
    write(key, values);
  }
  function contentCall(method, edit, ...args) { workspace(edit); if (!content) throw new Error('문서 저장소를 사용할 수 없습니다.'); return content[method](...args); }
  function moveDocument(id, parentId = null, beforeId = null) {
    const current = workspace(true), docs = listDocuments(); requireMemo(id); if (parentId) requireMemo(parentId);
    const siblings = docs.filter(item => item.parentId === parentId && item.id !== id);
    const index = beforeId == null ? siblings.length : siblings.findIndex(item => item.id === beforeId);
    if (index < 0) throw new Error('이동할 순서가 없습니다.');
    store.setMemoParent(id, parentId);
    siblings.splice(index, 0, { id });
    const key = 'stella-document-order:' + current.id;
    write(key, { ...read(key, EMPTY), ...Object.fromEntries(siblings.map((item, position) => [item.id, position])) });
    return store.getMemo(id);
  }
  return { listDocuments, links, savePosition, setLink, moveDocument,
    blocksFor: memo => contentCall('blocksFor', false, requireMemo(memo.id)),
    saveContent: (...args) => contentCall('saveContent', true, ...args),
    createVersion: (...args) => contentCall('createVersion', true, ...args),
    listVersions: (...args) => contentCall('listVersions', false, ...args),
    restoreVersion: (...args) => contentCall('restoreVersion', true, ...args),
    original: (...args) => contentCall('original', false, ...args),
    trash: id => { workspace(true); requireMemo(id); return contentCall('trash', true, id); }
  };
}
