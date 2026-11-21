export function visibleMemoTree(memos, collapsed) {
  const byId = new Map(memos.map(memo => [memo.id, memo]));
  const childrenByParent = new Map();
  for (const memo of memos) {
    const parent = byId.get(memo.parentMemoId);
    const parentId = parent && parent.workspaceId === memo.workspaceId ? parent.id : null;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(memo);
  }

  const rows = [];
  const stack = (childrenByParent.get(null) ?? []).map(memo => ({ memo, depth: 0 })).reverse();
  while (stack.length) {
    const { memo, depth } = stack.pop();
    const children = childrenByParent.get(memo.id) ?? [];
    rows.push({ memo, depth, hasChildren: children.length > 0 });
    if (collapsed.has(memo.id)) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ memo: children[index], depth: depth + 1 });
    }
  }
  return rows;
}
