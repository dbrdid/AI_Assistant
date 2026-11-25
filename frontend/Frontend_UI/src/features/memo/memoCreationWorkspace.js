export function memoCreationWorkspaceId({ selectedSpace, currentWorkspaceId }) {
  if (selectedSpace && selectedSpace !== 'all') return selectedSpace;
  return currentWorkspaceId;
}
