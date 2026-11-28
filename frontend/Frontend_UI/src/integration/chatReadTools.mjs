import { rankSearchRows, searchTerms, memoTitle } from '../data/memos/memoSearch.mjs';
import { filterProjects } from '../data/projects/projectOperations.mjs';
import { filterTasks } from '../data/tasks/taskOperations.mjs';
import { dayOffset, taskDate } from '../features/ai/taskChatIntent.mjs';

const WEEK = /(?<![\p{L}\p{N}])(?:(다음|이번|지난|저번)\s*주|다음\s*즈)/u;
const PROJECT = /프로젝트/u;
const LOOKUP = /알려|보여|찾|목록|조회|검색|어떤|뭐|있/u;
const CHANGE = /만들어|만들기|생성해|삭제|수정해|바꿔|추가해|옮겨|연결해/u;
const READ_LIMIT = 12;

function weekRange(today, offset) {
  const start = new Date(`${today}T00:00:00Z`);
  if (!Number.isFinite(start.getTime())) return null;
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7) + offset * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { from: start.toISOString().slice(0, 10), before: end.toISOString().slice(0, 10) };
}

function projectWeek(question) {
  if (!PROJECT.test(question) || CHANGE.test(question)) return null;
  const period = WEEK.exec(question);
  if (!period || WEEK.test(question.slice(period.index + period[0].length))
    || !/마감|기한|(?:다음|이번|지난|저번)\s*(?:주|즈)(?:에|의|인)?\s*프로젝트/u.test(question)) return null;
  const word = period[1] ?? '다음';
  return { word, offset: word === '다음' ? 1 : word === '이번' ? 0 : -1 };
}

export function planChatReadTool(question, history, today) {
  const text = question.normalize('NFC').trim();
  const direct = projectWeek(text);
  const followUp = !CHANGE.test(text) && /^(?:그\s*(?:프로젝트(?:들)?|목록)|같은\s*프로젝트(?:들)?)(?:을|를)?(?:\s|[?!]|$)/u.test(text);
  const previous = followUp ? history.filter(turn => turn.role === 'user').at(-1) : null;
  const period = direct ?? (previous && projectWeek(previous.text));
  if (period && !/(?:문서|메모|일정|할\s*일|파일|담당|완료|진행|제외|빼고|중에서|프로젝트\s*(?:에|의|이름))/u.test(text)) {
    const range = weekRange(today, period.offset);
    if (range) return { name: 'list_projects', args: { ...range, label: period.word + ' 주' } };
  }
  const project = !CHANGE.test(text) && /^(.+?)\s*프로젝트(?:를|을)?\s*(?:열어|상세\s*(?:보여|알려))\s*(?:줘|주세요)[.!?]?$/u.exec(text);
  if (project) return { name: 'get_project', args: { title: project[1].trim() } };
  const related = /^(.+?)\s*프로젝트(?:에|의)\s*연결된\s*(?:항목|기록)(?:을)?\s*(?:보여|알려|찾아)\s*(?:줘|주세요)[.!?]?$/u.exec(text);
  if (related) return { name: 'get_related_entities', args: { title: related[1].trim() } };
  const file = /^(.+?)\s+파일(?:을|를)?\s*(?:열어|찾아|보여)\s*(?:줘|주세요)[.!?]?$/u.exec(text);
  if (file) return { name: 'find_files', args: { title: file[1].trim() } };

  const item = !CHANGE.test(text) && /^(.+?)\s+(할\s*일|일정)(?:을|를)?\s*(?:열어|상세\s*보여)\s*(?:줘|주세요)[.!?]?$/u.exec(text);
  if (item) return { name: 'get_task_item', args: { kind: item[2] === '일정' ? 'event' : 'task', title: item[1].trim() } };
  const list = !CHANGE.test(text) && /^(?:(오늘|내일|모레|어제|(?:이번|다음|지난)\s*주|\d{4}-\d{2}-\d{2})(?:의|에)?\s+)?(?:(미완료|완료한)\s+)?(할\s*일|일정)(?:을|를)?\s*(?:목록|보여\s*(?:줘|주세요)|알려\s*(?:줘|주세요)|조회)[.!?]?$/u.exec(text);
  if (list) {
    const [, period, status, word] = list;
    const week = period && WEEK.exec(period);
    const day = period && !week ? taskDate(period, today) : null;
    if (!period || week || day) {
      const range = week ? weekRange(today, week[1] === '다음' ? 1 : week[1] === '지난' ? -1 : 0)
        : day ? { from: day, before: dayOffset(day, 1) } : {};
      const kind = word === '일정' ? 'event' : 'task';
      return { name: kind === 'event' ? 'list_events' : 'list_tasks', args: { kind, ...range, status: status === '미완료' ? 'open' : status ? '완료' : undefined } };
    }
  }

  if (!CHANGE.test(text) && LOOKUP.test(text)) {
    const search = /^(.+?)\s*(?:의\s+)?(?:문서|메모)(?:를|을)?\s*(?:안에서\s+)?(?:찾아\s*(?:줘|주세요)|검색(?:\s*해\s*(?:줘|주세요))?)[.!?]?$/u.exec(text);
    const terms = search ? searchTerms(search[1]) : [];
    if (terms.length && !/^(?:이|그|저|아까|방금|모든|관련)$/u.test(terms.join(' '))) {
      return { name: 'search_documents', args: { terms } };
    }
  }
  return null;
}

const shortDate = value => `${Number(value.slice(5, 7))}월 ${Number(value.slice(8, 10))}일`;
const projectSource = ({ id, title }) => ({ id, type: 'project', title, route: 'ProjectDetail' });
const taskSource = ({ id, kind, title }) => ({ id, type: kind, title, route: 'TaskEdit' });
const fileSource = ({ id, name }) => ({ id, type: 'file', title: name, route: 'Files' });
const memoSource = memo => ({ id: memo.id, type: 'memo', title: memoTitle(memo), route: 'MemoEdit' });
const taskSummary = task => `${shortDate(task.date)}${task.start ? ' ' + task.start : ''}, ${task.status}`;
function listTaskItems(filters, { queryTasks }) {
  const items = queryTasks(filters);
  const visible = items.slice(0, READ_LIMIT);
  const label = filters.kind === 'event' ? '일정' : '할 일';
  const lines = visible.map(row => `- ${row.title} (${taskSummary(row)})`);
  if (visible.length < items.length) lines.push(`외 ${items.length - visible.length}개`);
  return { text: items.length ? `${label} ${items.length}개를 찾았어요.\n${lines.join('\n')}`
    : `현재 공간에 조건에 맞는 ${label}이 없어요.`, sources: visible.map(taskSource) };
}

const tools = {
  list_projects({ from, before, label }, { queryProjects }) {
    const projects = queryProjects({ from, before });
    const visible = projects.slice(0, READ_LIMIT);
    const lines = visible.map(row => `- ${row.title} (${shortDate(row.due)}${row.status ? ', ' + row.status : ''})`);
    if (projects.length > visible.length) lines.push(`외 ${projects.length - visible.length}개`);
    return {
      text: projects.length ? `${label}에 마감되는 프로젝트는 총 ${projects.length}개예요.\n${lines.join('\n')}`
        : `현재 공간에 ${label} 마감인 프로젝트가 없어요.`,
      sources: visible.map(projectSource),
    };
  },
  get_project({ title }, { queryProjects }) {
    const projects = queryProjects({ title });
    if (!projects.length) return null;
    const [project] = projects;
    return {
      text: projects.length > 1 ? '이름이 같은 프로젝트가 있어요. 아래에서 골라 주세요.'
        : `${project.title}\n상태: ${project.status || '미정'}\n마감: ${project.due ? shortDate(project.due) : '미정'}`,
      sources: projects.slice(0, READ_LIMIT).map(projectSource),
    };
  },
  list_tasks: listTaskItems,
  list_events: listTaskItems,
  get_task_item(filters, { queryTasks }) {
    const items = queryTasks(filters);
    return { text: items.length > 1 ? '이름이 같은 항목이 있어요. 아래에서 골라 주세요.'
      : items.length ? `${items[0].title}\n${taskSummary(items[0])}` : '현재 공간에서 해당 항목을 찾지 못했어요.',
      sources: items.slice(0, READ_LIMIT).map(taskSource) };
  },
  search_documents({ terms }, { readMemos }) {
    const rows = readMemos().map(memo => ({ id: memo.id, title: memoTitle(memo), text: memo.body ?? '' }));
    const matches = rankSearchRows(rows, terms).slice(0, READ_LIMIT);
    if (!matches.length) return null;
    return {
      text: '제목이나 내용이 일치하는 문서를 찾았어요.',
      sources: matches.map(({ id, title }) => ({ id, type: 'memo', title, route: 'MemoEdit' })),
    };
  },
  find_files({ title }, { readFiles }) {
    const files = readFiles();
    const index = new Map(files.map(file => [file.id, file]));
    const matches = rankSearchRows(files.map(file => ({ id: file.id, title: file.name })), searchTerms(title));
    if (!matches.length) return null;
    return { text: `파일 ${matches.length}개를 찾았어요.`, sources: matches.slice(0, READ_LIMIT).map(row => fileSource(index.get(row.id))) };
  },
  get_related_entities({ title }, { queryProjects, queryTasks, readMemos, readFiles }) {
    const projects = queryProjects({ title });
    if (projects.length !== 1) return tools.get_project({ title }, { queryProjects });
    const { links } = projects[0];
    const included = (kind, row) => links?.[kind]?.includes(row.id);
    const sources = [
      ...readMemos().filter(row => included('memos', row)).map(memoSource),
      ...['task', 'event'].flatMap(kind => queryTasks({ kind }).filter(row => included('tasks', row)).map(taskSource)),
      ...readFiles().filter(row => included('files', row)).map(fileSource),
    ];
    return {
      text: sources.length ? `연결된 항목 ${sources.length}개를 찾았어요.` : '현재 공간에 볼 수 있는 연결 항목이 없어요.',
      sources: sources.slice(0, READ_LIMIT),
    };
  },
};

export function executeChatReadTool(plan, services) {
  if (!plan || !Object.hasOwn(tools, plan.name) || !services.canRead()) return null;
  if (plan.name === 'list_projects' && (!/^\d{4}-\d{2}-\d{2}$/u.test(plan.args?.from)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(plan.args?.before) || plan.args.from >= plan.args.before)) return null;
  if (plan.name === 'search_documents' && (!Array.isArray(plan.args?.terms) || !plan.args.terms.length
    || !plan.args.terms.every(term => typeof term === 'string' && term.trim()))) return null;
  if (['get_project', 'get_related_entities', 'find_files'].includes(plan.name)
    && (typeof plan.args?.title !== 'string' || !plan.args.title.trim())) return null;
  if (['list_tasks', 'list_events', 'get_task_item'].includes(plan.name)) {
    if (!['task', 'event'].includes(plan.args?.kind)) return null;
    if (plan.name === 'get_task_item' && (typeof plan.args.title !== 'string' || !plan.args.title.trim())) return null;
  }
  const allowed = row => !row.deletedAt && (!row.workspaceId || row.workspaceId === services.workspaceId) && !services.isExcluded(row.id);
  const result = tools[plan.name](plan.args, {
    readMemos: () => services.getMemos().filter(allowed),
    readFiles: () => (services.getFiles?.() ?? []).filter(allowed),
    queryProjects: filters => (services.queryProjects?.(filters) ?? filterProjects(services.getProjects(), filters)).filter(allowed),
    queryTasks: filters => (services.queryTasks?.(filters) ?? filterTasks(services.getTasks(), filters)).filter(allowed),
  });
  return result && services.canRead() ? { ...result, toolResult: true } : null;
}
