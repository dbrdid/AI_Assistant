export function selectChatSources({ attachments, records, fileVaultOnly }) {
  if (!fileVaultOnly) return { attachments, records };
  return {
    attachments,
    records: [],
  };
}

export function chatAttachmentsForTurn(question, current, retained) {
  if (!/첨부(?:한|했던|된|파일|물)|(?:보낸|올린|고른|이|그|아까)\s*(?:파일|자료|첨부)/u.test(question)) return current;
  const newIds = new Set(current.map(file => file.id));
  return [...current, ...retained.filter(file => !newIds.has(file.id))];
}

export function chatCatalogRecords({ memos, tasks, projects, files, dateOf }) {
  const projectsByLink = new Map();
  for (const project of projects) {
    for (const [kind, ids] of Object.entries(project.links)) {
      for (const id of ids) {
        const key = `${kind}:${id}`;
        if (!projectsByLink.has(key)) projectsByLink.set(key, []);
        projectsByLink.get(key).push(project.title);
      }
    }
  }
  const dates = item => ({ createdDate: dateOf(item.createdAt), updatedDate: dateOf(item.updatedAt) });
  return [
    ...memos.map(memo => ({
      id: memo.id, type: 'memo', title: memo.title || memo.body.split('\n')[0].slice(0, 60), text: memo.body,
      revision: memo.revision, date: dateOf(memo.updatedAt), ...dates(memo), projects: projectsByLink.get(`memos:${memo.id}`),
    })),
    ...tasks.map(task => ({
      id: task.id, type: task.kind, title: task.title, text: task.desc ?? '', revision: task.revision,
      date: task.date, status: task.status === '완료' ? 'done' : 'open', ...dates(task),
      projects: projectsByLink.get(`tasks:${task.id}`), people: task.assignee ? [task.assignee] : undefined,
    })),
    ...projects.map(project => ({
      id: project.id, type: 'project', title: project.title, text: '', date: dateOf(project.updatedAt ?? project.createdAt),
      ...dates(project), projects: [project.title],
    })),
    ...files.map(file => ({
      id: file.id, type: 'file', title: file.name, text: '', date: dateOf(file.createdAt),
      ...dates(file), projects: projectsByLink.get(`files:${file.id}`),
    })),
  ];
}
