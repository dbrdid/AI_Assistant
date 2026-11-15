import { list, useValue, runtimeSubscribe } from '../hooks';
// Read-only until project screen commands are converted to the asynchronous server contract.
// Throwing is intentional: no local-only success may masquerade as a shared server write.
const unavailable = () => { throw new Error('프로젝트 편집은 서버 동기화 연결 후 사용할 수 있습니다'); };
export const PROJECT_STATUSES = ['진행 전','진행 중','완료','보류'];
export const MONTHLY_INVITES = 0;
export const getProjects = () => list('projects');
export const useProjects = () => useValue(getProjects);
export const subscribeProjects = runtimeSubscribe;
export const getProject = id => getProjects().find(p => p.id === id) ?? null;
export const projectOf = (kind, id) => getProjects().find(p => kind === 'memo' ? p.links?.memos?.[id] : p.links?.[kind === 'task' ? 'tasks' : 'files']?.includes(id)) ?? null;
export const addProject = unavailable;
export const updateProject = unavailable;
export const deleteProject = unavailable;
export const linkItems = unavailable;
export const unlinkItems = unavailable;
export const setItemProject = unavailable;
export const addInvite = unavailable;
export const moveMembers = unavailable;
export const removeMembers = unavailable;
export const updateMember = unavailable;
export const invitesLeft = () => 0;
export const isEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
