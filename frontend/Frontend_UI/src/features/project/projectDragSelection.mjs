export function projectsInDragRange(projectIds, layouts, anchorId, contentY) {
  const anchor = projectIds.indexOf(anchorId);
  if (anchor < 0) return [];
  let end = anchor;
  let nearest = Infinity;
  projectIds.forEach((id, index) => {
    const row = layouts.get(id);
    if (!row) return;
    const distance = Math.max(row.y - contentY, contentY - row.y - row.height, 0);
    if (distance < nearest) {
      nearest = distance;
      end = index;
    }
  });
  return projectIds.slice(Math.min(anchor, end), Math.max(anchor, end) + 1);
}
