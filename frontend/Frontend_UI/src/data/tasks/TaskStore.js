import { accessibleRecords, runtime, runtimeSubscribe, useValue } from '../hooks';
import { getProject, itemAccessOf } from '../projects/ProjectStore';
import { filterTasks, validateTaskSchedule, verifyTaskSnapshot } from './taskOperations.mjs';
export const PRIORITIES = ['낮음','보통','높음'];
export const STATUSES = ['진행 전','진행 중','완료','취소'];
export const ALARMS = ['없음','정시','10분 전','1시간 전','2시간 전','하루 전'];
export const getTasks = () => runtime().store.getTasks();
export const queryTasks = filters => filterTasks(getTasks(), filters);
export const useTasks = () => useValue(getTasks);
// 모든 공간의 일정·할 일 (항목마다 workspaceId) + 그 항목의 공간에서 고치기
export const getAllTasks = () => accessibleRecords(runtime().store.getAllTasks());
export const useAllTasks = () => useValue(getAllTasks);
export const taskIn = (t, action, ...args) => runtime().store.inWorkspace(t.workspaceId, action, ...args);
export const subscribeTasks = runtimeSubscribe;
export const getTask = id => runtime().store.getTask(id);
export const addTask = fields => runtime().store.addTask(fields);
export const updateTask = (...args) => runtime().store.updateTask(...args);
export const deleteTask = id => runtime().store.deleteTask(id);
export const toggleDone = id => runtime().store.toggleDone(id);
export const findOverlap = (...args) => runtime().store.findOverlap(...args);

export const taskScope = () => {
  const rt = runtime();
  return { accountId: rt.session.id, workspaceId: rt.store.getCurrentWorkspace().id };
};

export async function saveTask(fields, { scope, id, expected, creationId, projectId } = {}) {
  const own = runtime();
  const assertScope = () => {
    const workspace = own.store.getCurrentWorkspace();
    if (runtime() !== own || scope?.accountId !== own.session.id || scope?.workspaceId !== workspace.id || own.closedSpaces.has(workspace.id)) {
      throw new Error('항목을 열었던 공간에서 다시 시도해 주세요.');
    }
    if (!workspace.personal && workspace.roleCode === 'VIEWER') {
      throw Object.assign(new Error('보기 전용 공간이라 저장할 수 없어요.'), { code: 'read_only' });
    }
    return workspace;
  };
  const space = assertScope();
  if (id && ['view', 'unknown'].includes(await itemAccessOf('task', id))) {
    throw Object.assign(new Error('이 항목은 보기 전용이에요.'), { code: 'read_only' });
  }
  assertScope();
  const before = id ? own.store.getTask(id) : null;
  if (id) verifyTaskSnapshot(before, expected);
  if (!id && creationId) {
    const saved = own.store.getTask(creationId);
    if (saved) return { task: saved, status: space.personal ? 'saved' : 'pending' };
  }
  const values = typeof fields.title === 'string' ? { ...fields, title: fields.title.trim() } : { ...fields };
  if (projectId !== undefined) {
    const project = projectId ? getProject(projectId) : null;
    if (projectId && !project) throw new Error('현재 공간에서 연결할 프로젝트를 찾을 수 없어요.');
    values.projectId = projectId;
    values.project = project?.title ?? '';
  }
  if (!id || ['date', 'endDate', 'start', 'end'].some(key => key in values)) {
    const error = validateTaskSchedule({ ...before, ...values });
    if (error) throw new Error(error);
  }
  const task = id
    ? own.store.updateTask(id, values, { expectedRevision: before.revision })
    : own.store.addTask(values, creationId ? { creationId } : undefined);
  return { task, status: space.personal ? 'saved' : 'pending' };
}
export const shortDate = value => { const date = typeof value === 'string' ? value : value?.date; return date ? `${Number(date.slice(5,7))}/${Number(date.slice(8,10))}` : ''; };
export const tagText = (t, today) => ({ done: '완료', overdue: '초과', today: '오늘', soon: '임박', upcoming: '예정' })[classify(t, today)];
// 마지막 날짜: 여러 날 일정이면 끝 날짜, 아니면 날짜
export const lastDate = t => t.endDate || t.date;
// 그날(key)에 걸쳐 있는 항목인가 (여러 날 일정은 시작~끝 사이 모든 날)
export const occursOn = (t, key) => t.date === key || (!!t.endDate && t.date <= key && key <= t.endDate);
// 'YYYY-MM-DD' 를 n일 옮긴 날짜 (현지 날짜 기준)
export function shiftKey(key, n) {
  const d = new Date(Number(key.slice(0,4)), Number(key.slice(5,7)) - 1, Number(key.slice(8,10)) + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// 오늘은 현지 날짜 (toISOString은 UTC라 한국에서 오전 9시 전에는 어제가 됨)
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export function classify(t, today = localToday()) {
  if (t.status === '완료') return 'done'; if (lastDate(t) < today) return 'overdue'; if (occursOn(t, today)) return 'today';
  return (Date.parse(t.date) - Date.parse(today)) / 86400000 <= 3 ? 'soon' : 'upcoming';
}
export const searchTasks = (items, query = '') => (Array.isArray(items) ? items : getTasks()).filter(t => `${t.title} ${t.desc}`.includes(query));
