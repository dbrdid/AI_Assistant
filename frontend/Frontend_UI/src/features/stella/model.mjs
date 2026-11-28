// A relationship is shown only when the local store contains its memo_tasks link.
export function documentRelations(memos, tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  return memos.map(memo => ({
    memo,
    tasks: [...new Set(memo.taskIds ?? [])].map(id => byId.get(id)).filter(Boolean)
  })).filter(relation => relation.tasks.length > 0);
}
export function filterDocuments(memos, {
  query = '',
  favoritesOnly = false
} = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return memos.filter(memo => (!favoritesOnly || memo.favorite) && terms.every(term => `${memo.title}\n${memo.body}`.toLocaleLowerCase().includes(term)));
}
export function duplicateTitleSet(items, titleOf = item => item?.title ?? '') {
  const counts = new Map();
  for (const item of items ?? []) {
    const key = String(titleOf(item) ?? '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicates = new Set();
  for (const [key, count] of counts) if (count > 1) duplicates.add(key);
  return duplicates;
}

export function formatShortUpdatedAt(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const ref = new Date(now);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const sameDay = date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth() && date.getDate() === ref.getDate();
  if (sameDay) return `${hh}:${mm}`;
  if (date.getFullYear() === ref.getFullYear()) return `${date.getMonth() + 1}월 ${date.getDate()}일 ${hh}:${mm}`;
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
}

export function documentSubtitle(memo, now = Date.now()) {
  const time = formatShortUpdatedAt(memo?.updatedAt, now);
  const title = String(memo?.title ?? '').trim();
  const firstLine = String(memo?.body ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  const excerpt = firstLine && firstLine !== title ? firstLine.slice(0, 28) : '';
  return [time, excerpt].filter(Boolean).join(' · ');
}

export function filterDockEntities({ query = '', titleOnly = false, tasks = [], projects = [], files = [], spaceNames = {} } = {}) {
  const terms = String(query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { tasks: [], projects: [], files: [] };
  const matches = (...fields) => {
    const haystack = fields.filter(Boolean).join('\n').toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  };
  const matchedTasks = [];
  for (const task of tasks) {
    if (task.deletedAt) continue;
    const hit = titleOnly
      ? matches(task.title)
      : matches(task.title, task.place, task.desc, task.assignee, task.date);
    if (!hit) continue;
    const kind = task.kind === 'event' ? 'event' : 'task';
    const meta = [kind === 'event' ? '일정' : '할 일', task.date, task.start, spaceNames[task.workspaceId]].filter(Boolean).join(', ');
    matchedTasks.push({ id: task.id, type: kind, title: task.title, meta, workspaceId: task.workspaceId });
    if (matchedTasks.length >= 12) break;
  }
  const matchedProjects = [];
  for (const project of projects) {
    if (project.deletedAt) continue;
    const hit = titleOnly
      ? matches(project.title)
      : matches(project.title, project.desc, project.place, project.assignee, project.status, project.due);
    if (!hit) continue;
    const meta = ['프로젝트', project.due ? `${project.due} 마감` : null, project.status].filter(Boolean).join(', ');
    matchedProjects.push({ id: project.id, type: 'project', title: project.title, meta });
    if (matchedProjects.length >= 12) break;
  }
  const matchedFiles = [];
  for (const file of files) {
    if (!file?.name || !matches(file.name)) continue;
    matchedFiles.push({ id: file.id, type: 'file', title: file.name, meta: file.storage === 'cloud' ? '클라우드 파일' : '기기 파일' });
    if (matchedFiles.length >= 12) break;
  }
  return { tasks: matchedTasks, projects: matchedProjects, files: matchedFiles };
}

export function connectorPath(a, b) {
  const ac = {
    x: a.x + a.width / 2,
    y: a.y + a.height / 2
  };
  const bc = {
    x: b.x + b.width / 2,
    y: b.y + b.height / 2
  };
  if (Math.abs(ac.x - bc.x) < 1) return `M${ac.x} ${ac.y < bc.y ? a.y + a.height : a.y} V${ac.y < bc.y ? b.y : b.y + b.height}`;
  if (Math.abs(ac.y - bc.y) < 1) return `M${ac.x < bc.x ? a.x + a.width : a.x} ${ac.y} H${ac.x < bc.x ? b.x : b.x + b.width}`;
  const right = ac.x < bc.x;
  const x1 = right ? a.x + a.width : a.x,
    x2 = right ? b.x : b.x + b.width;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${ac.y} H${mid} V${bc.y} H${x2}`;
}
