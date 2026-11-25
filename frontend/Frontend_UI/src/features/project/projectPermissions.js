export function isWorkspaceOwner(workspace) {
  if (!workspace || workspace.personal) return false;
  const role = String(workspace.roleCode ?? workspace.role ?? '').trim().toUpperCase();
  return role === 'OWNER' || role === '관리자';
}

export function canManageProjectItems({ workspace, projectLeader }) {
  if (!workspace) return false;
  if (workspace.personal) return true;
  return isWorkspaceOwner(workspace) || !!projectLeader;
}

export function canLinkProjectItems(workspace) {
  if (!workspace) return false;
  if (workspace.personal) return true;
  const role = String(workspace.roleCode ?? workspace.role ?? '').trim().toUpperCase();
  return role === 'OWNER' || role === '관리자' || role === 'EDITOR' || role === '멤버';
}
