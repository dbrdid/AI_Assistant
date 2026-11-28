const titleKey = value => value.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, '');

export function filterTasks(rows, { kind, from, before, title, status } = {}) {
  const key = title && titleKey(title);
  return rows.filter(row => !row.deletedAt && (!kind || row.kind === kind) &&
    (!key || titleKey(row.title) === key) &&
    (!status || (status === 'open' ? !['완료', '취소'].includes(row.status) : row.status === status)) &&
    (!from || (row.endDate || row.date) >= from) && (!before || row.date < before));
}

export function taskSnapshot(task) {
  return { id: task.id, kind: task.kind, title: task.title, date: task.date, status: task.status, revision: task.revision };
}

export function verifyTaskSnapshot(task, expected) {
  if (!task || (expected && Object.entries(taskSnapshot(task)).some(([key, value]) => expected[key] !== value))) {
    throw Object.assign(new Error('항목이 바뀌었어요. 최신 상태를 확인한 뒤 다시 요청해 주세요.'), { code: 'revision_conflict' });
  }
}

export function validateTaskSchedule({ date, endDate, start, end }) {
  if (endDate && endDate <= date) return '끝 날짜는 시작 날짜보다 뒤여야 해요.';
  if (end && !start) return '끝나는 시간만 있을 수 없어요. 시작 시간을 먼저 정해 주세요.';
  if (start && end && end <= start && !endDate) return '끝나는 시간은 시작 시간보다 뒤여야 해요.';
  return '';
}
