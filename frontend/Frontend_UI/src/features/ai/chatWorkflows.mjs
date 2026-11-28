import { planChatReadTool } from '../../integration/chatReadTools.mjs';

export function planProjectBrief(question, today, { queryProjects, queryTasks, isExcluded }) {
  const match = /^(다음|이번|지난)\s*주(?:에)?\s*(?:마감(?:되(?:는|고)|인)?\s*)프로젝트(?:를\s*찾아서|의)\s*(?:미완료\s*(?:업무|할\s*일))\s*(?:를|을)?\s*(?:정리하고|모아|정리해서)\s*(.*?)\s*문서(?:로|를)?\s*만들어\s*(?:줘|주세요)[.!?]?$/u.exec(question);
  if (!match) return null;
  const period = planChatReadTool(`${match[1]} 주 마감 프로젝트를 알려줘`, [], today)?.args;
  if (!period) return null;
  const projects = queryProjects({ from: period.from, before: period.before }).filter(project => !isExcluded(project.id));
  if (!projects.length) return { text: '현재 공간에서 해당 기간에 마감되는 프로젝트를 찾지 못했어요.' };
  const projectIds = new Set(projects.map(project => project.id));
  const tasks = queryTasks({ kind: 'task', status: 'open' }).filter(task => projectIds.has(task.projectId) && !isExcluded(task.id));
  if (projects.length + tasks.length > 80) return { text: '초안에 들어갈 항목이 80개를 넘어요. 기간이나 프로젝트 범위를 좁혀 주세요.' };
  const sections = projects.map(project => ({
    project: { id: project.id, title: project.title, due: project.due, updatedAt: project.updatedAt },
    tasks: tasks.filter(task => task.projectId === project.id).map(task => ({ id: task.id, title: task.title, date: task.date, revision: task.revision })),
  }));
  const title = (match[2].trim() || `${match[1]} 주 마감 프로젝트 준비`).slice(0, 100);
  const text = [
    `# ${title}`,
    ...sections.flatMap(section => [`## ${oneLine(section.project.title)} (${section.project.due})`,
      ...(section.tasks.length ? section.tasks.map(task => `- [ ] ${oneLine(task.title)} (${task.date})`) : ['미완료 할 일 없음'])]),
  ].join('\n\n');
  return { text, title, sections };
}

const oneLine = text => text.replace(/\s+/gu, ' ').trim();
