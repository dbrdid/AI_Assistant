// AI chat history. Kept on this device only (per account and workspace): answers quote memo and task excerpts,
// and personal records never leave the device except for the question being asked.
//   Pinned chats are listed first and are never dropped when the list is over MAX_CHATS.
import { readPreference, scoped, useValue, writePreference, maybeRuntime } from '../hooks';

export const MAX_CHATS = 50;
const MAX_MESSAGES = 100;
const EMPTY = Object.freeze([]);
const key = () => scoped('ai-chats');
// readPreference caches the first fallback for a key: always read with the same one.
export const getChats = () => (maybeRuntime() ? readPreference(key(), EMPTY) ?? EMPTY : EMPTY);
export const useChats = () => useValue(getChats);
export const getChat = id => getChats().find(c => c.id === id) ?? null;
// Display order: pinned first (most recently pinned on top), then most recently updated
export const sortChats = chats => chats.slice().sort((a, b) =>
  (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

const titleOf = messages => {
  const first = messages.find(m => m.role === 'user')?.text ?? '';
  return first.replace(/\s+/g, ' ').trim().slice(0, 40) || '새 대화';
};
// Only what the screen needs to show the conversation again (no in-flight or attachment payloads).
const clean = m => ({
  id: m.id, role: m.role, text: m.text, error: !!m.error,
  attachments: (m.attachments ?? []).map(a => ({ id: a.id, name: a.name, kind: a.kind })),
  sources: (m.sources ?? []).map(s => ({ id: s.id, type: s.type, title: s.title, route: s.route ?? null })),
});

function write(chats) {
  const pinned = chats.filter(c => c.pinnedAt);
  const rest = chats.filter(c => !c.pinnedAt).slice(0, Math.max(0, MAX_CHATS - pinned.length));
  writePreference(key(), [...pinned, ...rest].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
}

// titleSource: 'question' (first question, until the AI title arrives) | 'ai' (made from the conversation) | 'user' (renamed)
export function saveChat(id, messages) {
  const done = messages.filter(m => m.role === 'user' || m.done || m.error).map(clean).slice(-MAX_MESSAGES);
  if (!done.length) return;
  const before = getChat(id);
  const keep = before && before.titleSource && before.titleSource !== 'question';
  const chat = {
    id, title: keep ? before.title : titleOf(done), titleSource: keep ? before.titleSource : 'question',
    updatedAt: Date.now(), messages: done, pinnedAt: before?.pinnedAt ?? null,
  };
  write([chat, ...getChats().filter(c => c.id !== id)]);
}

export const TITLE_MAX = 40;
/** Rename. An AI title never replaces one the user typed. Returns false when nothing changed. */
export function setChatTitle(id, title, source = 'user') {
  const chat = getChat(id);
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  if (!chat || !clean || (source === 'ai' && chat.titleSource === 'user')) return false;
  write(getChats().map(c => (c.id === id ? { ...c, title: clean, titleSource: source } : c)));
  return true;
}

/** Pin or unpin. A chat that has not been saved yet is saved first (messages of the screen). */
export function setPinned(id, pinned, messages = []) {
  if (!getChat(id)) saveChat(id, messages);
  if (!getChat(id)) return false;
  write(getChats().map(c => (c.id === id ? { ...c, pinnedAt: pinned ? Date.now() : null } : c)));
  return true;
}
export const deleteChat = id => writePreference(key(), getChats().filter(c => c.id !== id));
export const deleteAllChats = () => writePreference(key(), EMPTY);
