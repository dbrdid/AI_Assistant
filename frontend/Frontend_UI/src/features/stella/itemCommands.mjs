// AI가 쓸 수 있는 앱 작업 (추가분): 일정·할 일 완료·수정·삭제, 블록 종류 바꾸기, 표 행·열 추가.
// appCommands.mjs는 S22 평가 때문에 고정이라 따로 둔다 (projectCommands.mjs와 같은 방식).
// 모델이 만든 명령은 원래 요청에 들어 있는 값만 쓸 수 있고(stated), 요청한 동작과 명령이 맞아야 한다(intent).
// 모든 작업은 검토 화면에서 사용자가 승인해야 실행되고, 한 번만 실행된다.
import { ROUTES } from '../../navigation/routes.js';
import { blocksText } from '../../../../../backend/local/src/stella-documents.js';

export const itemExamples = [
  '할 일 완료: 포스터 제출', '할 일 완료 취소: 포스터 제출', '일정 삭제: 낭독회', '할 일 이름 변경: 포스터 제출 / 포스터 최종 제출',
  '일정 날짜 변경: 낭독회 / 2026-12-03 16:00', '할 일 우선순위 변경: 포스터 제출 / 높음', '할 일 알림 변경: 포스터 제출 / 10분 전',
  '2번 블록 종류 변경: 체크', '1번 블록 표 행 추가', '1번 블록 표 열 추가',
];
const PRIORITIES = ['낮음', '보통', '높음'];
const ALARMS = ['없음', '정시', '10분 전', '1시간 전', '2시간 전', '하루 전'];
const BLOCK_TYPES = { 문단: 'paragraph', 본문: 'paragraph', 제목: 'heading', 목록: 'bullet', 체크: 'task' };
const KIND = '(할 일|일정)';
const RULES = {
  done: new RegExp('^' + KIND + '\\s*완료(\\s*취소)?\\s*[:：]\\s*(.+)$'),
  remove: new RegExp('^' + KIND + '\\s*삭제\\s*[:：]\\s*(.+)$'),
  rename: new RegExp('^' + KIND + '\\s*이름\\s*변경\\s*[:：]\\s*(.+?)\\s*/\\s*(.+)$'),
  date: new RegExp('^' + KIND + '\\s*날짜\\s*변경\\s*[:：]\\s*(.+?)\\s*/\\s*(\\d{4}-\\d{2}-\\d{2})(?:\\s+(\\d{2}:\\d{2}))?$'),
  priority: new RegExp('^' + KIND + '\\s*우선순위\\s*변경\\s*[:：]\\s*(.+?)\\s*/\\s*(' + PRIORITIES.join('|') + ')$'),
  alarm: new RegExp('^' + KIND + '\\s*알림\\s*변경\\s*[:：]\\s*(.+?)\\s*/\\s*(' + ALARMS.join('|') + ')$'),
  blockType: /^(\d+)\s*번\s*블록\s*종류\s*변경\s*[:：]\s*(문단|본문|제목|목록|체크)$/,
  tableAdd: /^(\d+)\s*번\s*블록\s*표\s*(행|열)\s*추가$/,
};
// 모델 명령의 동작이 사용자가 말한 동작과 맞는지 (예: 완료를 부탁했는데 삭제를 내놓으면 거절)
const INTENT = {
  done: /완료|끝냈|끝났|했어|했음|체크/, undone: /취소|되돌|다시|안\s*했|미완료/, remove: /삭제|지워|지우|없애|빼/,
  rename: /이름|제목|바꿔|바꾸|변경|수정|고쳐/, date: /날짜|시간|미뤄|미루|옮겨|당겨|바꿔|변경|수정|로|에/, priority: /우선순위|중요|급|높|낮|보통/,
  alarm: /알림|알려|알람/, blockType: /종류|바꿔|바꾸|변경|로|으로/, tableAdd: /추가|넣어|늘려|만들/,
};
const squash = text => String(text ?? '').replace(/\s+/g, '');

/**
 * 고른 블록에 대한 분명한 요청은 모델 없이 바로 명령으로: "체크로 바꿔줘" → "N번 블록 종류 변경: 체크", 표에 "행 추가" → "N번 블록 표 행 추가".
 * target: { index, type } (블록 AI 시트의 블록)
 */
export function routeItemCommand(input, target) {
  const request = String(input ?? '').trim();
  if (!target) return {};
  const n = target.index + 1;
  const type = /(문단|본문|제목|목록|체크)(?:\s*블록)?\s*(?:으)?로\s*(?:바꿔|바꾸|변경|전환|만들어)/.exec(request);
  if (type && target.type !== 'table') return { command: n + '번 블록 종류 변경: ' + type[1] };
  const add = /(행|열)(?:\s*(?:을|를|하나|한\s*개))*\s*(?:추가|넣어|늘려)/.exec(request);
  if (add && target.type === 'table') return { command: n + '번 블록 표 ' + add[1] + ' 추가' };
  return {};
}

export function isItemCommand(input) {
  const text = String(input ?? '').trim();
  return Object.values(RULES).some(rule => rule.test(text));
}

/**
 * 승인 한 번짜리 제안 또는 null (이 모듈의 명령이 아니면).
 * rt: 앱 런타임(store, documents). memoId: 블록 작업의 대상 문서. originalRequest: 모델 명령일 때 사용자의 원래 요청.
 * canWrite(): 지금 공간에서 고칠 수 있는지.
 */
// 문서 만들기: '회의록 만들어줘', 'X에 대한 문서 만들어줘'처럼 '문서'로 시작하지 않는 요청도 받는다.
// 제목은 요청 원문에 그대로 있어야 하고, 제목을 뺀 나머지는 '만들어 줘' 같은 만들기 표현뿐이어야 한다.
const DOCUMENT_COMMAND = /^(?:새\s*)?문서\s*(?:만들기|생성|추가)\s*[:：]\s*(.+)$/;
const DOCUMENT_INTENT = /^(?:이라는|라는|이란|란)?(?:에|에서)?(?:대한|관한|관련된|관련한|관련)?(?:새)?(?:문서|페이지|노트|메모|글)?(?:를|을|하나|한개)?(?:좀|새로)?(?:만들어|만들|생성해|생성|추가해|추가|작성해|작성|써)(?:줘|주세요|줄래|봐|봐줘)?[.!?]?$/;
export function planDocumentCommand(rt, input, { originalRequest, canWrite }) {
  const m = DOCUMENT_COMMAND.exec(String(input ?? '').trim());
  if (!m || originalRequest == null) return null;
  const title = m[1].trim(), said = squash(originalRequest).replace(/["'“”‘’]/g, ''), wanted = squash(title).replace(/["'“”‘’]/g, '');
  // 맞지 않으면 null: 기존 검사(appCommands)가 그대로 판단한다
  if (!wanted || !said.includes(wanted) || !DOCUMENT_INTENT.test(said.replace(wanted, ''))) return null;
  let used = false;
  return { summary: '새 문서 만들기, ' + title, approve() {
    if (used) throw new Error('이미 처리한 요청입니다.');
    used = true;
    if (!canWrite()) throw new Error('이 공간에서 바꿀 권한이 없거나 공간이 바뀌었습니다.');
    const created = rt.store.addMemo({ title });
    return { route: ROUTES.MemoEdit, params: { memoId: created.id } };
  } };
}

export function planItemCommand(rt, input, { memoId, originalRequest, canWrite }) {
  const request = String(input ?? '').trim();
  if (!isItemCommand(request)) return null;
  const said = originalRequest == null ? null : squash(originalRequest);
  const stated = value => {
    if (said !== null && !said.includes(squash(value))) throw new Error('요청에 없는 값(' + value + ')이 포함되어 실행하지 않았습니다.');
    return value;
  };
  const intends = action => {
    if (said !== null && !INTENT[action].test(originalRequest)) throw new Error('요청한 작업과 해석 결과가 다릅니다. 다시 확인해 주세요.');
  };
  // 날짜·시간은 사용자가 '12월 3일', '12/3', '오후 4시'처럼 말해도 같은 값으로 본다
  const dateStated = (date, time) => {
    if (said === null) return;
    const [, m, d] = date.split('-').map(Number);
    if (![date, `${m}월${d}일`, `${m}/${d}`].some(form => said.includes(form))) throw new Error('요청에 없는 날짜(' + date + ')라 실행하지 않았습니다.');
    if (time) {
      const [h, min] = time.split(':').map(Number);
      const h12 = h % 12 || 12;
      const forms = [time, `${h}시`, `${h12}시`].map(form => form + (min && !form.includes(':') ? `${min}분` : ''));
      if (!forms.some(form => said.includes(form)) && !(min === 30 && said.includes(`${h12}시반`))) throw new Error('요청에 없는 시간(' + time + ')이라 실행하지 않았습니다.');
    }
  };
  let used = false;
  const proposal = (summary, apply, task) => ({ summary, ...(task && { taskId: task.id }), approve() {
    if (used) throw new Error('이미 처리한 요청입니다.');
    used = true;
    if (!canWrite()) throw new Error('이 공간에서 바꿀 권한이 없거나 공간이 바뀌었습니다.');
    return apply();
  } });
  const findTask = (kind, title) => {
    const wanted = kind === '일정' ? 'event' : 'task';
    const found = rt.store.getTasks().filter(task => task.kind === wanted && task.title === stated(title.trim()));
    if (found.length !== 1) throw new Error(kind + ' “' + title + '”을(를) 하나로 특정할 수 없습니다.');
    return found[0];
  };
  // 저장 뒤 값이 요청과 같은지 확인 (다르면 원래 값으로 되돌림)
  const patchTask = (task, patch) => {
    const before = rt.store.getTask(task.id);
    if (!before || before.revision !== task.revision) throw new Error('항목이 바뀌었습니다. 요청을 다시 검토해 주세요.');
    const after = rt.store.updateTask(task.id, patch, { expectedRevision: task.revision });
    if (Object.keys(patch).some(key => after[key] !== patch[key])) {
      rt.store.updateTask(task.id, Object.fromEntries(Object.keys(patch).map(key => [key, before[key]])));
      throw new Error('저장 값이 요청과 달라 원래대로 되돌렸습니다.');
    }
    return { route: ROUTES.TaskEdit, params: { taskId: task.id } };
  };

  let m = RULES.done.exec(request);
  if (m) {
    const undo = !!m[2];
    intends(undo ? 'undone' : 'done');
    const task = findTask(m[1], m[3]);
    return proposal(`${m[1]} ${undo ? '완료 취소' : '완료'}, ${task.title}`, () => patchTask(task, { status: undo ? '진행 전' : '완료' }), task);
  }
  if ((m = RULES.remove.exec(request))) {
    intends('remove');
    const task = findTask(m[1], m[2]);
    return proposal(`${m[1]} 삭제, ${task.title}${task.date ? ' (' + task.date + ')' : ''}`, () => {
      const current = rt.store.getTask(task.id);
      if (!current || current.revision !== task.revision) throw new Error('항목이 바뀌었습니다. 요청을 다시 검토해 주세요.');
      rt.store.deleteTask(task.id);
      return { route: m[1] === '일정' ? ROUTES.Calendar : ROUTES.Tasks };
    }, task);
  }
  if ((m = RULES.rename.exec(request))) {
    intends('rename');
    const task = findTask(m[1], m[2]);
    const title = stated(m[3].trim());
    if (!title || title.length > 200) throw new Error('새 이름은 1~200자로 입력해 주세요.');
    return proposal(`${m[1]} 이름 변경, ${task.title} → ${title}`, () => patchTask(task, { title }), task);
  }
  if ((m = RULES.date.exec(request))) {
    intends('date');
    const task = findTask(m[1], m[2]);
    const [, , , date, start] = m;
    dateStated(date, start);
    const patch = start ? { date, start } : { date };
    return proposal(`${m[1]} 날짜 변경, ${task.title}\n${task.date}${task.start ? ' ' + task.start : ''} → ${date}${start ? ' ' + start : ''}`, () => patchTask(task, patch), task);
  }
  if ((m = RULES.priority.exec(request))) {
    intends('priority');
    const task = findTask(m[1], m[2]);
    const priority = stated(m[3]);
    return proposal(`${m[1]} 우선순위 변경, ${task.title}\n${task.priority} → ${priority}`, () => patchTask(task, { priority }), task);
  }
  if ((m = RULES.alarm.exec(request))) {
    intends('alarm');
    const task = findTask(m[1], m[2]);
    const alarm = stated(m[3]);
    return proposal(`${m[1]} 알림 변경, ${task.title}\n${task.alarm} → ${alarm}`, () => patchTask(task, { alarm }), task);
  }

  // 블록 작업: 지금 문서에서, 검토한 판(revision)이 그대로일 때만
  const memo = rt.documents.listDocuments().find(item => item.id === memoId);
  if (!memo) throw new Error('블록을 바꿀 문서를 먼저 열어 주세요.');
  const blocks = rt.documents.blocksFor(memo);
  const pick = number => {
    const block = blocks[Number(number) - 1];
    if (!block) throw new Error(number + '번 블록이 없습니다.');
    return block;
  };
  const save = (summary, next) => proposal((memo.title || '제목 없는 문서') + '\n' + summary, () => {
    const latest = rt.store.getMemo(memo.id);
    if (!latest || latest.deletedAt != null || latest.revision !== memo.revision) throw new Error('문서가 바뀌었습니다. 요청을 다시 검토해 주세요.');
    rt.documents.saveContent(memo.id, { title: memo.title, blocks: next, body: blocksText(next) }, memo.revision);
    const saved = rt.store.getMemo(memo.id);
    if (JSON.stringify(rt.documents.blocksFor(saved)) !== JSON.stringify(next)) {
      rt.documents.saveContent(memo.id, { title: memo.title, blocks, body: blocksText(blocks) }, saved.revision);
      throw new Error('저장 값이 요청과 달라 원래 내용으로 되돌렸습니다.');
    }
  });
  if ((m = RULES.blockType.exec(request))) {
    intends('blockType');
    const block = pick(m[1]);
    const label = stated(m[2]), type = BLOCK_TYPES[label];
    if (block.type === 'table') throw new Error('표 블록은 종류를 바꿀 수 없습니다.');
    if (block.type === type) throw new Error('이미 ' + label + ' 블록입니다.');
    return save(`${m[1]}번 블록 종류 변경 → ${label}\n${block.text}`, blocks.map(item => item === block ? { ...item, type, checked: false } : item));
  }
  m = RULES.tableAdd.exec(request);
  intends('tableAdd');
  const block = pick(m[1]);
  if (block.type !== 'table') throw new Error(m[1] + '번 블록은 표가 아닙니다.');
  const rows = block.rows;
  if (m[2] === '행' && rows.length >= 50) throw new Error('표는 50행까지 만들 수 있습니다.');
  if (m[2] === '열' && (rows[0]?.length ?? 0) >= 20) throw new Error('표는 20열까지 만들 수 있습니다.');
  const next = m[2] === '행' ? [...rows, rows[0].map(() => '')] : rows.map(row => [...row, '']);
  return save(`${m[1]}번 표에 ${m[2]} 추가 (${rows.length}×${rows[0]?.length ?? 0} → ${next.length}×${next[0].length})`, blocks.map(item => item === block ? { ...item, rows: next } : item));
}
