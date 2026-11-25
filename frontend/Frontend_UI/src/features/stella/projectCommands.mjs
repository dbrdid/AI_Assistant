import { ROUTES } from '../../navigation/routes.js';

// Kept apart from appCommands.mjs, whose prompt, grammar and file hash are frozen for the S22 evaluation.
export const projectExamples = ['프로젝트 만들기: 신제품 출시', '프로젝트 상태 변경: 신제품 출시 / 진행 중', '할 일 프로젝트 연결: 포스터 제출 / 신제품 출시'];
export const PROJECT_STATUSES = ['진행 전', '진행 중', '완료', '보류'];

const CREATE = /^(?:새\s*)?프로젝트\s*(?:만들기|생성|추가)\s*[:：]\s*(.+)$/;
const CREATE_NATURAL = /^(.+?)(?:이)?라는\s*(?:새\s*)?프로젝트(?:를|을)?\s*(?:만들어|생성해|추가해)\s*(?:줘|주세요)?[.!]?$/;
const STATUS = /^프로젝트\s*상태\s*변경\s*[:：]\s*(.+?)\s*\/\s*(.+)$/;
const LINK = /^할\s*일\s*프로젝트\s*연결\s*[:：]\s*(.+?)\s*\/\s*(.+)$/;
const squash = text => String(text ?? '').replace(/\s+/g, '');

// Clear project requests skip the model, like routeCommand does for documents.
export function routeProjectCommand(input) {
  const request = String(input ?? '').trim();
  const found = CREATE.exec(request) || CREATE_NATURAL.exec(request);
  return found ? { command: '프로젝트 만들기: ' + found[1].trim() } : {};
}

export function isProjectCommand(input) {
  const text = String(input ?? '').trim();
  return CREATE.test(text) || STATUS.test(text) || LINK.test(text);
}

/**
 * Returns a single-use approval, or null when the text is not a project command.
 * tools: { getProjects, addProject, updateProject, getTasks, getTask, setTaskProject, canWrite }
 * originalRequest: set for model output; every value must then appear in the user's own words.
 */
export function planProjectCommand(tools, input, originalRequest) {
  const request = String(input ?? '').trim();
  if (!isProjectCommand(request)) return null;
  const said = originalRequest == null ? null : squash(originalRequest);
  const stated = value => {
    if (said !== null && !said.includes(squash(value))) throw new Error('요청에 없는 값(' + value + ')이 포함되어 실행하지 않았습니다.');
    return value;
  };
  const one = (items, title, what) => {
    const found = items.filter(item => item.title === title);
    if (found.length !== 1) throw new Error(what + ' “' + title + '”을(를) 하나로 특정할 수 없습니다.');
    return found[0];
  };
  let used = false;
  const proposal = (summary, apply) => ({ summary, approve() {
    if (used) throw new Error('이미 처리한 요청입니다.');
    used = true;
    if (!tools.canWrite()) throw new Error('이 공간에서 프로젝트를 바꿀 권한이 없거나 공간이 바뀌었습니다.');
    return apply();
  } });

  let match = CREATE.exec(request);
  if (match) {
    const title = stated(match[1].trim());
    if (title.length > 100) throw new Error('프로젝트 이름은 100자 이내로 입력해 주세요.');
    if (tools.getProjects().some(project => project.title === title)) throw new Error('같은 이름의 프로젝트가 이미 있습니다.');
    return proposal('새 프로젝트 만들기 · ' + title, () => {
      const created = tools.addProject({ title, status: '진행 전' });
      if (!created?.id) throw new Error('프로젝트를 만들지 못했습니다.');
      return { route: ROUTES.ProjectDetail, params: { projectId: created.id } };
    });
  }
  match = STATUS.exec(request);
  if (match) {
    const project = one(tools.getProjects(), stated(match[1].trim()), '프로젝트');
    const status = stated(match[2].trim());
    if (!PROJECT_STATUSES.includes(status)) throw new Error('상태는 ' + PROJECT_STATUSES.join(', ') + ' 중 하나로 입력해 주세요.');
    return proposal('프로젝트 상태 변경 · ' + project.title + '\n' + (project.status || '없음') + ' → ' + status, () => {
      if (!tools.updateProject(project.id, { status })) throw new Error('프로젝트 상태를 바꾸지 못했습니다.');
      return { route: ROUTES.ProjectDetail, params: { projectId: project.id } };
    });
  }
  match = LINK.exec(request);
  const task = one(tools.getTasks().filter(item => item.kind === 'task'), stated(match[1].trim()), '할 일');
  const project = one(tools.getProjects(), stated(match[2].trim()), '프로젝트');
  return proposal('할 일을 프로젝트에 연결 · ' + task.title + ' → ' + project.title, () => {
    tools.setTaskProject(task.id, project.id);
    if (tools.getTask(task.id)?.projectId !== project.id) throw new Error('연결 결과가 요청과 달라 확인이 필요합니다.');
    return { route: ROUTES.ProjectDetail, params: { projectId: project.id } };
  });
}
