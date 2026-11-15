import { runtime, useValue } from '../hooks';
import * as api from '../../lib/stella/workspaces';
export const useWorkspaces = () => useValue(() => runtime().store.getWorkspaceState());
export const getWorkspaces = () => runtime().store.getWorkspaces();
export const switchWorkspace = id => runtime().store.switchWorkspace(id);
export const scopedKey = key => `${runtime().session.id}:${runtime().store.getCurrentWorkspace().id}:${key}`;
export async function createWorkspace(fields) {
  const own = runtime();
  const id = await api.createWorkspace(fields.name, fields.desc);
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다. 공간 목록을 새로 확인해 주세요');
  own.store.upsertServerWorkspace({ id, name: fields.name, description: fields.desc, role: 'OWNER', members: 1 });
  return id;
}
export async function joinWorkspace(value) {
  const own = runtime();
  const r = await api.acceptInvite(typeof value === 'string' ? value : value.code);
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다');
  await own.bridge.syncAll(); return r.workspace_id;
}
export async function deleteWorkspace(id) {
  const own = runtime();
  const ws = getWorkspaces().find(w => w.id === id);
  if (!ws || ws.personal) throw new Error('개인 공간은 삭제할 수 없습니다');
  const status = await own.bridge.status();
  if (status.unsent || status.state === 'attention') throw new Error('미전송 기록과 충돌을 해결한 뒤 나가 주세요');
  if (ws.roleCode === 'OWNER') await api.deleteWorkspace(ws.serverId);
  else await api.leaveWorkspace(ws.serverId);
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다');
  return own.store.deleteWorkspace(id);
}
