import { accessibleRecords, maybeRuntime, runtime, useValue, readPreference, writePreference } from '../hooks';
import { listOutbox } from '../../lib/stella/local-sync';
import { ROUTES } from '../../navigation/routes';
import { rankSearchRows, searchTerms } from './memoSearch.mjs';
export { searchTerms } from './memoSearch.mjs';
export const TYPE_INFO = { memo: { label: '메모', icon: '📝', route: ROUTES.MemoEdit }, task: { label: '일정', icon: '✓', route: ROUTES.TaskEdit }, event: { label: '일정', icon: '◷', route: ROUTES.TaskEdit }, project: { label: '프로젝트', icon: '▣', route: ROUTES.ProjectDetail }, file: { label: '파일', icon: '📄', route: ROUTES.Files } };
export const STORAGE_INFO = { local: { icon: '▣', label: '기기', desc: '이 기기에 저장된 파일' }, cloud: { icon: '☁', label: '클라우드', desc: '공유 공간 멤버가 함께 보는 파일' } };
export const getMemos = () => runtime().store.getMemos();
export const useMemos = () => useValue(getMemos);
// 모든 공간의 메모 (항목마다 workspaceId) + 지정한 공간에 쓰기
export const getAllMemos = () => accessibleRecords(runtime().store.getAllMemos());
export const useAllMemos = () => useValue(getAllMemos);
export const memoIn = (workspaceId, action, ...args) => runtime().store.inWorkspace(workspaceId, action, ...args);
export const useTrashedMemos = () => useValue(() => runtime().store.getTrashedMemos());
export const getMemo = id => runtime().store.getMemo(id);
export const listMemoVersions = id => runtime().store.listMemoVersions(id);
export const addMemo = input => runtime().store.addMemo(input);
export const updateMemo = (...args) => runtime().store.updateMemo(...args);
export const setMemoParent = (memoId, parentMemoId) => runtime().store.setMemoParent(memoId, parentMemoId);
export const attachPhoto = (...args) => runtime().store.attachPhoto(...args);
export const detachPhoto = (...args) => runtime().store.detachPhoto(...args);
export const trashMemo = id => runtime().store.trashMemo(id);
export const trashMemos = ids => runtime().store.trashMemos(ids);
export const restoreMemos = ids => runtime().store.restoreMemos(ids);
export const deleteMemoForever = id => runtime().store.deleteMemoForever(id);
export const deleteMemosForever = ids => runtime().store.deleteMemosForever(ids);
export const setFavorites = (ids, value) => runtime().store.setFavorites(ids, value);

export async function findMemoSyncConflict(memoId) {
  const rt = runtime();
  const ws = rt.store.getCurrentWorkspace();
  const canResolve = () => {
    const current = rt.store.getCurrentWorkspace();
    return current.id === ws.id && current.roleCode !== 'VIEWER' && !rt.closedSpaces.has(ws.id);
  };
  if (!ws.serverId || !canResolve()) return null;
  const rows = await listOutbox(rt.syncDb, ws.serverId);
  if (maybeRuntime() !== rt || !canResolve()) return null;
  const row = rows.find(item => {
    if (item.changes.length !== 1) return false;
    const change = item.changes[0];
    if (change.kind !== 'update' || change.entity !== 'notes' || change.id !== memoId) return false;
    if (item.status === 'FAILED') {
      const fields = Object.keys(change.data);
      return fields.length === 1 && fields[0] === 'parent_note_id';
    }
    return item.status === 'CONFLICT' && item.conflicts.length === 1 &&
      item.conflicts[0].reason === 'REVISION_MISMATCH' &&
      item.conflicts[0].server && !item.conflicts[0].server.deleted_at;
  });
  if (!row) return null;
  const isRejectedMove = row.status === 'FAILED';
  return {
    isRejectedMove,
    fields: row.changes[0].data,
    server: row.conflicts[0]?.server,
    resolve: async choice => {
      if (maybeRuntime() !== rt || !canResolve()) throw new Error('이 문서를 수정할 수 있는 공간에서 다시 시도해 주세요.');
      const result = isRejectedMove
        ? await rt.bridge.discard(ws.id, row.seq)
        : await rt.bridge.resolve(ws.id, row.seq, choice);
      if (result?.status === 'OK' && result.flush?.status === 'OFFLINE') {
        rt.bridge.requestSync(0);
        return;
      }
      if (isRejectedMove && result?.status === 'OK' &&
          ['BLOCKED', 'CONFLICT'].includes(result.flush?.status)) return { hasOtherSyncIssues: true };
      if (result?.status !== 'OK' || result.flush?.status !== 'DONE') throw new Error('동기화가 멈췄어요. 상태를 다시 확인해 주세요.');
    },
  };
}
export const memoTitle = memo => memo?.title || memo?.body?.split('\n')[0]?.slice(0, 60) || '제목 없는 메모';
export const formatMD = value => { const d = new Date(value); return `${d.getMonth()+1}.${d.getDate()}`; };
export function highlightParts(text, terms) {
  const s = String(text ?? '').normalize('NFC'); if (!terms?.length) return [{ text: s, hit: false }];
  const longestFirst = [...terms].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(${longestFirst.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return s.split(pattern).filter(Boolean).map(part => ({ text: part, hit: terms.some(t => part.toLowerCase() === t.toLowerCase()) }));
}
export function searchApp(query, sources) {
  const terms = searchTerms(query); if (!terms.length) return [];
  const { store, closedSpaces } = runtime();
  const accessClosed = closedSpaces.has(store.getCurrentWorkspace().id);
  const memos = sources?.memos ?? (accessClosed ? [] : store.getMemos());
  const tasks = sources?.tasks ?? (accessClosed ? [] : store.getTasks());
  const rows = [
    ...memos.map(m => ({ ...m, type: 'memo', title: memoTitle(m), text: m.body })),
    ...tasks.map(t => ({ ...t, type: 'task', text: t.desc })),
    ...(accessClosed ? [] : sources?.projects ?? []).map(p => ({ ...p, type: 'project', text: p.desc })),
    ...(sources?.files ?? []).map(f => ({ ...f, type: 'file', title: f.name, text: f.kind })),
  ];
  return rankSearchRows(rows, terms);
}
export function openParams(type, id) {
  if (type === 'file') return { focusId: id };
  if (type === 'project') return { projectId: id };
  if (type === 'task' || type === 'event') return { id, taskId: id };
  return { id, memoId: id };
}
export const getRecentSearches = () => readPreference('recent-searches', []);
export const clearRecentSearches = () => writePreference('recent-searches', []);
export const addRecentSearch = q => writePreference('recent-searches', [q, ...getRecentSearches().filter(x => x !== q)].slice(0, 15));
// Asynchronous cloud QA is connected by AiChatScreen; local search never pretends to be generated AI.
export const answerFromApp = query => ({ text: '검색한 기록을 확인해 주세요.', sources: searchApp(query) });
