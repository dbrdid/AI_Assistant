import { runtime, useValue, readPreference, writePreference } from '../hooks';
import { ROUTES } from '../../navigation/routes';
export const TYPE_INFO = { memo: { label: '메모', icon: '📝', route: ROUTES.MemoEdit }, task: { label: '일정', icon: '✓', route: ROUTES.TaskEdit }, event: { label: '일정', icon: '◷', route: ROUTES.TaskEdit }, project: { label: '프로젝트', icon: '▣', route: ROUTES.ProjectDetail }, file: { label: '파일', icon: '📄', route: ROUTES.Files } };
export const STORAGE_INFO = { local: { icon: '▣', label: '기기', desc: '이 기기에 저장된 파일' }, cloud: { icon: '☁', label: '클라우드', desc: '서버 첨부 연결은 통합 검증 전입니다' } };
export const getMemos = () => runtime().store.getMemos();
export const useMemos = () => useValue(getMemos);
export const useTrashedMemos = () => useValue(() => runtime().store.getTrashedMemos());
export const getMemo = id => runtime().store.getMemo(id);
export const addMemo = input => runtime().store.addMemo(input);
export const updateMemo = (...args) => runtime().store.updateMemo(...args);
export const attachPhoto = (...args) => runtime().store.attachPhoto(...args);
export const detachPhoto = (...args) => runtime().store.detachPhoto(...args);
export const trashMemo = id => runtime().store.trashMemo(id);
export const trashMemos = ids => runtime().store.trashMemos(ids);
export const restoreMemos = ids => runtime().store.restoreMemos(ids);
export const deleteMemoForever = id => runtime().store.deleteMemoForever(id);
export const deleteMemosForever = ids => runtime().store.deleteMemosForever(ids);
export const setFavorites = (ids, value) => runtime().store.setFavorites(ids, value);
export const memoTitle = memo => memo?.title || memo?.body?.split('\n')[0]?.slice(0, 60) || '제목 없는 메모';
export const formatMD = value => { const d = new Date(value); return `${d.getMonth()+1}.${d.getDate()}`; };
export const searchTerms = query => String(query ?? '').trim().split(/\s+/).filter(Boolean);
export function highlightParts(text, terms) {
  const s = String(text ?? ''); if (!terms?.length) return [{ text: s, hit: false }];
  const pattern = new RegExp(`(${terms.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return s.split(pattern).filter(Boolean).map(part => ({ text: part, hit: terms.some(t => part.toLowerCase() === t.toLowerCase()) }));
}
export function searchApp(query) {
  const terms = searchTerms(query); if (!terms.length) return [];
  const s = runtime().store;
  const rows = [...s.getMemos().map(m => ({ ...m, type: 'memo', title: memoTitle(m), text: m.body })),
    ...s.getTasks().map(t => ({ ...t, type: 'task', text: t.desc }))];
  return rows.filter(r => terms.every(t => `${r.title}\n${r.text}`.toLowerCase().includes(t.toLowerCase())));
}
export const openParams = (type, id) => type === 'file' ? { focusId: id } : type === 'task' || type === 'event' ? { id, taskId: id } : { id, memoId: id };
export const getRecentSearches = () => readPreference('recent-searches', []);
export const clearRecentSearches = () => writePreference('recent-searches', []);
export const addRecentSearch = q => writePreference('recent-searches', [q, ...getRecentSearches().filter(x => x !== q)].slice(0, 15));
// Asynchronous cloud QA is connected by AiChatScreen; local search never pretends to be generated AI.
export const answerFromApp = query => ({ text: '검색한 기록을 확인해 주세요.', sources: searchApp(query) });
