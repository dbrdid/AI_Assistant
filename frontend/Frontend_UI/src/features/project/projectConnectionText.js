export function noConnectionText({ kind, allCount, candidateCount, linkedCount }) {
  if (kind !== 'memos') return '연결할 수 있는 항목이 없어요';
  if (allCount === 0) return '현재 공간에 메모가 없어요';
  if (candidateCount === 0 && linkedCount > 0) return '모든 메모가 이미 프로젝트에 연결되어 있어요';
  return '연결할 수 있는 메모가 없어요';
}

export function applyPendingMemoLinks(serverLinks, pending) {
  const overrides = pending && typeof pending === 'object' ? pending : {};
  let links = (serverLinks ?? []).filter(link => overrides[link.note_id] === undefined);
  for (const [noteId, projectId] of Object.entries(overrides)) {
    if (projectId) links = [...links.filter(link => link.note_id !== noteId), { note_id: noteId, project_id: projectId }];
  }
  return links;
}

export function queuePendingMemoLinks(pending, noteIds, projectId) {
  const next = pending && typeof pending === 'object' ? { ...pending } : {};
  for (const noteId of noteIds) next[noteId] = projectId;
  return next;
}

export function unresolvedPendingMemoLinkIds(pending, noteIds, projectId) {
  const queued = pending && typeof pending === 'object' ? pending : {};
  return noteIds.filter(noteId => Object.prototype.hasOwnProperty.call(queued, noteId)
    && queued[noteId] === projectId);
}

export function isReferenceNoteProjectFailure(row) {
  if (!row || row.status !== 'FAILED') return false;
  if (!String(row.lastError ?? '').includes('REFERENCE_NOT_FOUND')) return false;
  return (row.changes ?? []).some(change => change?.entity === 'note_projects'
    && (change?.kind === 'link' || change?.kind === 'unlink'));
}
