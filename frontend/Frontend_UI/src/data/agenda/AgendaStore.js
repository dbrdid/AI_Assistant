// Agenda compare: what changed in a project's linked memos, tasks and files from one day to the next.
//   Each time the screen opens, today's state of every project is recorded (per workspace, on this device, 30 days).
//   A day is compared with the most recent earlier record. With no earlier record, items created or edited that
//   day are listed by their timestamps.
import { list, maybeRuntime, readPreference, runtimeSubscribe, scoped, writePreference } from '../hooks';
import { getProjects } from '../projects/ProjectStore';
import { memoTitle } from '../memos/MemoStore';
import { toKey } from '../../features/calendar/utils/DateUtils';

export const subscribeAgenda = runtimeSubscribe;
const KEEP_DAYS = 30;
const EMPTY = Object.freeze({});
// readPreference caches the first fallback it is given for a key, so never trust the shape of a missing value.
const readSnaps = () => readPreference(scoped('agenda-snapshots'), EMPTY) ?? EMPTY;
const dayOf = ms => (ms ? toKey(new Date(ms)) : '');

function itemsOf(rt, project) {
  const out = {};
  const memos = new Map(rt.store.getMemos().map(m => [m.id, m]));
  for (const id of project.links.memos) {
    const m = memos.get(id);
    if (m) out[`memo:${id}`] = { kind: 'memo', id, title: memoTitle(m), body: m.body ?? '', createdAt: m.createdAt, updatedAt: m.updatedAt };
  }
  for (const id of project.links.tasks) {
    const t = rt.store.getTask(id);
    if (t && !t.deletedAt) {
      const when = `${t.date}${t.start ? ` ${t.start}` : ''} · ${t.status}`;
      out[`task:${id}`] = { kind: 'task', id, title: t.title, body: t.desc ? `${when}\n${t.desc}` : when, createdAt: t.createdAt, updatedAt: t.updatedAt };
    }
  }
  const files = new Map(list('files').map(f => [f.id, f]));
  for (const id of project.links.files) {
    const f = files.get(id);
    if (f) out[`file:${id}`] = { kind: 'file', id, title: f.name, body: '', createdAt: f.createdAt, updatedAt: f.createdAt };
  }
  return out;
}

export function captureNow() {
  const rt = maybeRuntime();
  if (!rt) return;
  const snaps = readSnaps();
  const today = toKey(new Date());
  const now = Object.fromEntries(getProjects().map(p => [p.id, itemsOf(rt, p)]));
  if (JSON.stringify(snaps[today]) === JSON.stringify(now)) return;
  const days = [...Object.keys(snaps).filter(d => d !== today), today].sort().slice(-KEEP_DAYS);
  writePreference(scoped('agenda-snapshots'), Object.fromEntries(days.map(d => [d, d === today ? now : snaps[d]])));
}

export function daysFor(projectId) {
  const snaps = readSnaps();
  const today = toKey(new Date());
  return [...new Set([...Object.keys(snaps).filter(d => snaps[d]?.[projectId]), today])].sort();
}

const change = (key, status, before, after) => {
  const titleChanged = !!before && !!after && before.title !== after.title;
  const bodyChanged = !!before && !!after && before.body !== after.body;
  const cur = after ?? before;
  return {
    key, kind: cur.kind, id: cur.id, status, title: cur.title,
    titleBefore: before?.title ?? '', bodyBefore: before?.body ?? '', bodyAfter: after?.body ?? '',
    titleChanged, bodyChanged, hasBefore: !!before,
  };
};

export function computeChanges(project, day) {
  const rt = maybeRuntime();
  if (!rt || !project) return { changes: [], basis: 'none', prevDay: null };
  const snaps = readSnaps();
  const today = toKey(new Date());
  const after = day === today ? itemsOf(rt, project) : snaps[day]?.[project.id] ?? {};
  const prevDay = Object.keys(snaps).filter(d => d < day && snaps[d]?.[project.id]).sort().pop() ?? null;
  const changes = [];
  if (prevDay) {
    const before = snaps[prevDay][project.id];
    for (const [key, item] of Object.entries(after)) {
      if (!before[key]) changes.push(change(key, 'added', null, item));
      else if (before[key].title !== item.title || before[key].body !== item.body) changes.push(change(key, 'changed', before[key], item));
    }
    for (const [key, item] of Object.entries(before)) if (!after[key]) changes.push(change(key, 'removed', item, null));
    return { changes, basis: 'snapshot', prevDay };
  }
  for (const [key, item] of Object.entries(after)) {
    if (dayOf(item.createdAt) === day) changes.push(change(key, 'added', null, item));
    else if (dayOf(item.updatedAt) === day) changes.push({ ...change(key, 'changed', null, item), hasBefore: false });
  }
  return { changes, basis: 'timestamp', prevDay: null };
}
