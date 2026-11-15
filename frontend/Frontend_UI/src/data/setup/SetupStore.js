import { readPreference, writePreference } from '../hooks';
export const PURPOSES = [{ id: 'personal', icon: '📝', label: '개인 기록', sub: '메모와 일정' }, { id: 'work', icon: '✓', label: '업무', sub: '할 일과 공유 기록' }, { id: 'study', icon: '📚', label: '학습', sub: '강의와 자료 정리' }];
export const TIMEZONES = [{ id: 'Asia/Seoul', label: '서울', gmt: 'GMT+9' }, { id: 'UTC', label: 'UTC', gmt: 'GMT+0' }];
export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
export const timezoneLabel = id => TIMEZONES.find(t => t.id === id)?.label ?? id;
export const hasPurpose = (value, id) => String(value ?? '').split(',').includes(id);
export const togglePurpose = (value, id) => hasPurpose(value, id) ? String(value).split(',').filter(x => x !== id).join(',') : [value,id].filter(Boolean).join(',');
export const isSetupDone = async () => readPreference('setup-done', false);
export const markSetupDone = async () => writePreference('setup-done', true);
export const createStarterMemos = () => []; // No fabricated user records on onboarding.
