// 일정 비교: 프로젝트에 연결된 메모, 할 일, 파일이 하루 사이에 어떻게 바뀌었는지 확인합니다.
// 화면을 열 때마다 각 프로젝트의 현재 상태를 기록합니다(작업 공간별, 이 기기에서 30일간 보관).
// 해당 날짜를 그보다 앞선 가장 최근 기록과 비교합니다. 이전 기록이 없으면 그날 생성되거나 수정된 항목을
// 타임스탬프 기준으로 표시합니다.
import { list, maybeRuntime, readPreference, runtimeSubscribe, scoped, writePreference } from '../hooks';
import { getProjects } from '../projects/ProjectStore';
import { memoTitle } from '../memos/MemoStore';
import { toKey } from '../../features/calendar/utils/DateUtils';

export const subscribeAgenda = runtimeSubscribe;
const KEEP_DAYS = 30;
const EMPTY = Object.freeze({});
// readPreference는 키마다 처음 전달된 대체값을 캐시하므로, 값이 없을 때 대체값의 형태가 유효하다고 가정하지 않습니다.
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
