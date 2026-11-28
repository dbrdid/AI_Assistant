export const PROJECT_STATUSES = ['진행 전', '진행 중', '완료', '보류'];

const dateKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
const titleKey = value => value.normalize('NFC').toLowerCase().replace(/\s+/gu, '');

export function filterProjects(rows, { from, before, status, title } = {}) {
  const matches = rows.filter(row => !row.deletedAt &&
    (!status || row.status === status) &&
    ((!from && !before) || (dateKey(row.due) && (!from || row.due >= from) && (!before || row.due < before))));
  if (from || before) matches.sort((left, right) => left.due.localeCompare(right.due) || left.title.localeCompare(right.title, 'ko'));
  if (!title) return matches;
  const key = titleKey(title);
  const exact = matches.filter(row => titleKey(row.title) === key);
  return exact.length ? exact : matches.filter(row => titleKey(row.title) === key + '프로젝트');
}

export function projectSnapshot(project) {
  return { id: project.id, title: project.title, status: project.status,
    updatedAt: project.updatedAt ?? null, revision: project.revision ?? null };
}

export function verifyProjectSnapshot(project, expected) {
  if (!project || (expected && Object.entries(projectSnapshot(project)).some(([key, value]) => value !== expected[key]))) {
    throw Object.assign(new Error('프로젝트가 바뀌었어요. 다시 열어서 최신 상태를 확인해 주세요.'), { code: 'PROJECT_CONFLICT' });
  }
}
