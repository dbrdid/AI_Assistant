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
