import { runtime, runtimeSubscribe, useValue } from '../hooks';
export const PRIORITIES = ['낮음','보통','높음'];
export const STATUSES = ['진행 전','진행 중','완료','취소'];
export const ALARMS = ['없음','정시','10분 전','1시간 전','2시간 전','하루 전'];
export const getTasks = () => runtime().store.getTasks();
export const useTasks = () => useValue(getTasks);
export const subscribeTasks = runtimeSubscribe;
export const getTask = id => runtime().store.getTask(id);
export const addTask = fields => runtime().store.addTask(fields);
export const updateTask = (...args) => runtime().store.updateTask(...args);
export const deleteTask = id => runtime().store.deleteTask(id);
export const toggleDone = id => runtime().store.toggleDone(id);
export const findOverlap = (...args) => runtime().store.findOverlap(...args);
export const shortDate = value => { const date = typeof value === 'string' ? value : value?.date; return date ? `${Number(date.slice(5,7))}/${Number(date.slice(8,10))}` : ''; };
export const tagText = (t, today) => ({ done: '완료', overdue: '초과', today: '오늘', soon: '임박', upcoming: '예정' })[classify(t, today)];
export function classify(t, today = new Date().toISOString().slice(0,10)) {
  if (t.status === '완료') return 'done'; if (t.date < today) return 'overdue'; if (t.date === today) return 'today';
  return (Date.parse(t.date) - Date.parse(today)) / 86400000 <= 3 ? 'soon' : 'upcoming';
}
export const searchTasks = (items, query = '') => (Array.isArray(items) ? items : getTasks()).filter(t => `${t.title} ${t.desc}`.includes(query));
