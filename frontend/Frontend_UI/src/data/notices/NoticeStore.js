import { randomUUID } from 'expo-crypto';
import { list, saveList, useValue } from '../hooks';
export const noticesReady = Promise.resolve();
export const useNotices = () => useValue(() => list('notices'));
export function addNotice(input) {
  const rows = list('notices');
  if (input.key && rows.some(n => n.key === input.key)) return rows.find(n => n.key === input.key);
  const notice = { ...input, id: randomUUID(), read: false, at: input.at ?? Date.now() };
  saveList('notices', [notice, ...rows].slice(0, 300)); return notice;
}
export const clearNotices = () => saveList('notices', []);
export const removeNotice = id => saveList('notices', list('notices').filter(n => n.id !== id));
export const markRead = id => saveList('notices', list('notices').map(n => n.id === id ? { ...n, read: true } : n));
export const markAllRead = () => saveList('notices', list('notices').map(n => ({ ...n, read: true })));
