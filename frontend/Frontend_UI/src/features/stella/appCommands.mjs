import { blocksText, normalizeBlocks } from '../../../../../backend/local/src/stella-documents.js';
import { insertBlock, moveBlock } from './blockCommands.mjs';
import { ROUTES } from '../../navigation/routes.js';
import { originalEvidence, statedTimes, verifiedStart } from '../../integration/recordEvidence.mjs';

// Only routes that can open without a record ID. Opening a screen never confirms its form.
export const screens = {
  홈: ROUTES.Home, 문서: ROUTES.Memos, '문서 관계': ROUTES.Relations, '작업 검토': ROUTES.Proposals,
  '로컬 AI': ROUTES.LocalModel, 'AI 채팅': ROUTES.Ai, 검색: ROUTES.Search, 오늘: ROUTES.Today,
  캘린더: ROUTES.Calendar, '할 일': ROUTES.Tasks, 브리핑: ROUTES.Briefing, 프로젝트: ROUTES.Projects,
  즐겨찾기: ROUTES.Favorites, 파일: ROUTES.Files, 휴지통: ROUTES.Trash, 알림: ROUTES.Notices,
  '공간 전환': ROUTES.Workspace, '새 공간': ROUTES.WorkspaceCreate, '공유 공간': ROUTES.Spaces,
  '안건 비교': ROUTES.AgendaCompare, '빠른 입력': ROUTES.QuickInput, '문서 가져오기': ROUTES.AdvancedMemos,
  백업: ROUTES.Backup, 설정: ROUTES.Settings, 계정: ROUTES.Account, 보안: ROUTES.Security,
  'AI 설정': ROUTES.AiSettings, 'AI 이용량': ROUTES.AiUsage, '알림 설정': ROUTES.NotificationSettings,
  구독: ROUTES.Subscription, 더보기: ROUTES.More
};
const types = { 문단: 'paragraph', 본문: 'paragraph', 제목: 'heading', 목록: 'bullet', 체크: 'task', 표: 'table' };
export const examples = ['문서 만들기: 회의록', '제목 블록 추가: 결정 사항', '2번 블록을 다음 회의로 수정', '2번 블록을 1번으로 이동', '표 블록 추가', '1번 블록의 1행 2열 수정: 담당자', '1번 블록 삭제', '즐겨찾기에 추가', '현재 버전 저장', '캘린더 열어줘',
  '문서 제목 변경: 주간 회의', '2번 블록 복제', '2번 블록 체크', '할 일 추가 2026-11-27: 포스터 제출', '일정 추가 2026-12-02 15:00: 낭독회',
  '상위 문서 변경: 회의록', '최상위로 이동', '문서 연결: 회의록', '문서 연결 해제: 회의록'];
export function commandPrompt(input) {
  return 'Convert the Korean request to ONE exact Korean app command. Output only the command. Replace example values with the requested values. No markdown, quotation marks, explanations or polite endings. Return 지원불가 for ambiguous, unsupported or compound requests. Appends are at the end of the selected document.\n' +
    'Allowed output examples:\n' + examples.join('\n') + '\nBlock types: ' + Object.keys(types).join(', ') + '\nScreens: ' + Object.keys(screens).join(', ') +
    '\n입력: 맨 아래에 다음 주 계획이라는 제목을 하나 넣어줘.\n출력: 제목 블록 추가: 다음 주 계획' +
    '\n입력: 네 번째 블록을 두 번째 자리로 옮겨 줘.\n출력: 4번 블록을 2번으로 이동' +
    '\n입력: ' + input + '\n출력:';
}

const ADD_VERB = '(?:을|를)?\\s*(?:하나\\s*|한\\s*개\\s*)?(?:추가(?:해\\s*(?:줘|주세요))?|생성(?:해\\s*(?:줘|주세요))?|넣어\\s*(?:줘|주세요)|만들어\\s*(?:줘|주세요))[.!]?$';
const AT_END = '^(?:(?:문서\\s*)?(?:맨\\s*)?(?:아래|끝|뒤)에\\s*)?';
const NAMED_HEADING = new RegExp(AT_END + '(.+?)라는\\s*제목(?:\\s*블록)?' + ADD_VERB);
const DIRECT_HEADING = new RegExp(AT_END + '(.+?)\\s+제목\\s*블록' + ADD_VERB);
const NOT_AT_END = /(?:\d+\s*번(?:째)?|[첫두세네]\s*번째)\s*(?:블록)?\s*(?:의\s*)?(?:앞|뒤|위|아래|사이)|맨\s*(?:위|앞|처음)/;
const COMPOUND = /(?:추가|삭제|수정|이동|생성|변경)하고|넣고|만들고|바꾸고|옮기고|지우고|그리고/;
const COMMAND_VALUE = /^((?:할 일|일정)\s*추가\s+\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?\s*[:：]\s*|[^:：]*[:：]\s*)(.+)$/s;
const EDIT_VALUE = /^(\d+\s*번\s*블록(?:을|를)?\s*)(.+?)((?:으)?로\s*(?:수정|바꿔\s*줘))$/;

function requestedHeading(request, command) {
  const named = NAMED_HEADING.exec(request)?.[1];
  const title = (named ?? DIRECT_HEADING.exec(request)?.[1])?.trim().replace(/(["”'’])이$/, '$1').replace(/^["“'‘]|["”'’]$/g, '');
  if (title && /(?:앞|뒤|위|아래|사이|끝|중간)에\s/.test(title)) throw new Error('제목을 확정할 수 없습니다. 문서 끝에 추가하려면 “제목 블록 추가: 제목” 형식으로 입력해 주세요.');
  if (!title || !named || !title.endsWith('이')) return title || null;
  // "기록이라는" and "고양이라는" read alike, so the particle is removed only when the model's value confirms it.
  const compact = value => value.replace(/\s+/g, '');
  const value = compact(COMMAND_VALUE.exec(command)?.[2] ?? '');
  const confirmed = [title, title.slice(0, -1)].find(item => compact(item) === value);
  if (!confirmed) throw new Error('제목을 확정할 수 없습니다. “제목 블록 추가: 제목” 형식으로 입력해 주세요.');
  return confirmed;
}

function checkSchedule(request, command) {
  const planned = /^(?:할 일|일정)\s*추가\s+(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}:\d{2}))?\s*[:：]/.exec(command);
  if (!planned) return;
  const iso = /\d{4}-\d{2}-\d{2}/.exec(request)?.[0];
  const stated = /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(request);
  if (!iso && !stated) throw new Error('할 일이나 일정의 날짜를 월과 일로 알려 주세요.');
  if ((iso && iso !== planned.slice(1, 4).join('-')) || (stated && ((stated[1] && stated[1] !== planned[1]) || +stated[2] !== +planned[2] || +stated[3] !== +planned[3]))) {
    throw new Error('요청의 날짜와 해석한 날짜가 다릅니다. 다시 확인해 주세요.');
  }
  const start = planned[4] ?? '';
  if (verifiedStart(start, request) !== start || (start && !statedTimes(request).length)) throw new Error('요청의 시각과 해석한 시각이 다릅니다. 다시 확인해 주세요.');
}

const ORDINALS = { 첫: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const blockNumbers = text => [...text.matchAll(/(\d+|(?<![가-힣\d])(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열))\s*번/g)].map(m => ORDINALS[m[1]] ?? Number(m[1]));
const BLOCK_ACTIONS = [[/체크 해제$/, /해제|풀어/], [/체크$/, /^(?!.*해제).*(?:체크|완료)/s], [/삭제$/, /삭제|지우|지워|없애|제거/], [/복제$/, /복제|복사/],
  [/(?:이동|옮겨\s*줘)$/, /이동|옮기|옮겨/], [/(?:수정|바꿔\s*줘)(?:\s*[:：].*)?$/s, /수정|바꾸|바꿔|변경|고쳐/]];

function checkBlockTarget(request, command) {
  if (!/^\d+\s*번\s*블록/.test(command)) return;
  const said = BLOCK_ACTIONS.find(([action]) => action.test(command))?.[1];
  if ((said && !said.test(request)) || String(blockNumbers(request)) !== String(blockNumbers(command))) throw new Error('요청한 블록 또는 작업과 해석 결과가 다릅니다. 다시 확인해 주세요.');
}

const BLOCK_ADD_INTENT = new RegExp(AT_END + '(?:빈\\s*)?(문단|본문|제목|목록|체크|표)(?:\\s*블록)?(?:(?:으)?로)?' + ADD_VERB);

function matchesModelAction(request, command, value) {
  // Remove the verified payload so words inside a title cannot authorize another operation.
  const intent = (value ? request.replace(value, ' ').replace(/^\s*(?:을|를|이라는|라는)\s*/, '') : request).trim();
  const block = /^(문단|본문|제목|목록|체크|표)\s*블록\s*(?:추가|생성)/.exec(command);
  if (block) {
    const wanted = BLOCK_ADD_INTENT.exec(intent)?.[1];
    return types[wanted] === types[block[1]];
  }
  // Opening the calendar already shows the current month. Other periods need a distinct action.
  if (command === '캘린더 열어줘' && /^이번\s*달\s+/.test(intent))
    return routeCommand(intent.replace(/^이번\s*달\s+/, '')).command === command;
  if (!value) return false;
  if (/^(?:새\s*)?문서\s*(?:만들기|생성|추가)/.test(command))
    return /^(?:새\s*)?문서(?:를)?\s*(?:좀\s*|새로\s*)?(?:만들|추가|생성)/.test(intent);
  if (/^문서 제목 변경/.test(command))
    return /문서\s*(?:제목|이름)/.test(intent) && /변경|바꿔|수정/.test(intent);
  if (/^상위 문서 변경/.test(command))
    return /상위\s*문서/.test(intent) && /변경|바꿔|이동|옮겨/.test(intent);
  if (/^문서 연결/.test(command))
    return /문서/.test(intent) && /연결/.test(intent) && command.startsWith('문서 연결 해제') === /해제/.test(intent);
  const schedule = /^(할 일|일정)\s*추가/.exec(command);
  if (schedule) {
    const kind = schedule[1] === '할 일' ? /할\s*일/ : /일정/;
    return kind.test(intent) && /추가|등록|넣어|잡아|만들|생성/.test(intent);
  }
  return false;
}

// Model output is untrusted: its action must fit the request, and saved values must be the request's own spelling.
function verifyModelCommand(original, output) {
  const request = original.trim();
  if (output.trim() === '지원불가') throw new Error('요청을 하나의 앱 작업으로 확정할 수 없습니다. 대상과 작업을 구체적으로 알려 주세요.');
  if (COMPOUND.test(request)) throw new Error('지원하는 작업과 대상을 확인해 주세요. 복합 요청은 한 번에 하나씩 검토할 수 있습니다.');
  if (NOT_AT_END.test(request) && (NAMED_HEADING.test(request) || DIRECT_HEADING.test(request) || /블록\s*(?:추가|생성)/.test(output))) {
    throw new Error('블록 추가는 문서 끝만 지원합니다. 위치를 지정하려면 추가한 뒤 이동해 주세요.');
  }
  const heading = requestedHeading(request, output);
  const command = heading ? '제목 블록 추가: ' + heading : output;
  // When the rules can read the request, the model may not disagree with them.
  const routed = routeCommand(request).command;
  if (routed && routed.replace(/\s+/g, '') !== command.replace(/\s+/g, '')) throw new Error('요청한 블록 또는 작업과 해석 결과가 다릅니다. 다시 확인해 주세요.');
  checkSchedule(request, command);
  checkBlockTarget(request, command);
  const edit = EDIT_VALUE.exec(command), field = edit ? [edit[1], edit[2], edit[3]] : COMMAND_VALUE.exec(command)?.slice(1).concat('');
  const value = field && originalEvidence(request, field[1]);
  if (field && !value) throw new Error('요청 원문에 없는 값은 저장할 수 없습니다. 다시 확인해 주세요.');
  if (!routed && !heading && request !== command && !matchesModelAction(request, command, value))
    throw new Error('요청한 작업 또는 블록 내용과 해석 결과가 다릅니다. 다시 확인해 주세요.');
  if (!field) return command;
  if (!routed && evidenceCoverage(request, value) < EVIDENCE_THRESHOLD) throw new Error('요청의 일부가 작업에 반영되지 않았습니다. 저장할 값을 “제목 블록 추가: 제목”처럼 정확히 알려 주세요.');
  return field[0] + value + field[2];
}

// Set only by ai/eval/calibrate-command.mjs from the calibration set; a test keeps the two equal.
export const EVIDENCE_THRESHOLD = 0.84;
const NON_VALUE = /^(?:문서|이름|제목|블록|문단|본문|목록|체크|표|상위|하나|한|개|맨|아래|끝|뒤|새|할|일|일정|오늘|내일|모레|좀|부탁해|부탁합니다|줘|주세요|(?:추가|생성|수정|변경|등록|연결|해제)(?:해)?(?:줘|주세요)?|(?:넣어|만들어|바꿔|고쳐|적어|잡아)(?:줘|주세요)?|만들기)$/;
const SCHEDULE_TEXT = /\d{4}-\d{2}-\d{2}|(?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일(?:까지|에)?|(?:오전|오후|아침|저녁|밤|새벽|낮)?\s*\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?(?:에|부터)?|\d{1,2}:\d{2}/g;
// Share of the request's content words that the saved value carries; a low share means the command dropped part of the request.
export function evidenceCoverage(request, value) {
  const size = text => text.replace(/[\s"'“”‘’.,!?:：]/g, '').length;
  const rest = request.replace(value, ' ').replace(SCHEDULE_TEXT, ' ').replace(/(?:\d+|첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*번(?:째)?|\d+\s*[행열]/g, ' ')
    .split(/[\s"'“”‘’.,!?:：]+/).map(word => word.replace(/(?:이라는|라는|으로|에서|에|을|를|로|의|은|는|이|가|와|과)$/, '')).filter(word => word && !NON_VALUE.test(word));
  return size(value) / (size(value) + size(rest.join('')));
}

const quoted = text => JSON.stringify(text);
// GBNF for llama.rn. It narrows the output shape only; planCommand still validates every value.
export const commandGrammar = [
  'root ::= "지원불가" | screen " 열어줘" | "문서 만들기: " value | "문서 제목 변경: " value | kind " 블록 추가" (": " value)? | n "번 블록 " ("삭제" | "복제" | "체크" | "체크 해제") | n "번 블록을 " n "번으로 이동" | n "번 블록을 " value "로 수정" | n "번 블록의 " n "행 " n "열 수정: " value | ("할 일" | "일정") " 추가 " date (" " time)? ": " value | "즐겨찾기에 추가" | "즐겨찾기 해제" | "현재 버전 저장" | "최상위로 이동" | ("상위 문서 변경" | "문서 연결" | "문서 연결 해제") ": " value',
  'screen ::= ' + Object.keys(screens).map(quoted).join(' | '),
  'kind ::= ' + Object.keys(types).map(quoted).join(' | '),
  'n ::= [1-9] [0-9]? [0-9]?',
  'date ::= [0-9] [0-9] [0-9] [0-9] "-" [0-9] [0-9] "-" [0-9] [0-9]',
  'time ::= [0-9] [0-9] ":" [0-9] [0-9]',
  'value ::= [^\\r\\n]+',
].join('\n') + '\n';

const NUMBER = '(\\d+|첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\\s*번(?:째)?';
const verb = stems => '(?:' + stems + ')(?:\\s*(?:줘|주세요))?[.!]?$';
const BLOCK_RULES = [
  [new RegExp('^' + NUMBER + '\\s*블록(?:을|를)?\\s*' + verb('삭제(?:해)?|지워|없애|제거(?:해)?')), n => n + '번 블록 삭제'],
  [new RegExp('^' + NUMBER + '\\s*블록(?:을|를)?\\s*' + verb('복제(?:해)?|복사(?:해)?')), n => n + '번 블록 복제'],
  [new RegExp('^' + NUMBER + '\\s*블록(?:을|를)?\\s*' + verb('체크\\s*해제(?:해)?|체크\\s*풀어')), n => n + '번 블록 체크 해제'],
  [new RegExp('^' + NUMBER + '\\s*블록(?:을|를)?\\s*' + verb('체크(?:해)?|완료(?:\\s*처리)?(?:해)?')), n => n + '번 블록 체크'],
];
const MOVE_RULE = new RegExp('^' + NUMBER + '\\s*블록(?:을|를)?\\s*' + NUMBER + '(?:\\s*자리)?(?:으)?로\\s*' + verb('이동(?:해)?|옮겨'));
const EDIT_RULE = new RegExp('^' + NUMBER + '\\s*블록(?:의)?\\s*(?:내용)?(?:을|를)?\\s*(.+?)(?:으)?로\\s*' + verb('수정(?:해)?|바꿔|변경(?:해)?|고쳐'));
const CELL_RULE = new RegExp('^' + NUMBER + '\\s*블록(?:의)?\\s*(\\d+)\\s*행\\s*(\\d+)\\s*열(?:을|를)?\\s*(.+?)(?:으)?로\\s*' + verb('수정(?:해)?|바꿔|변경(?:해)?|고쳐'));
const SCREEN_RULE = new RegExp('^(.+?)(?:\\s*화면)?(?:(?:으)?로\\s*(?:가|이동(?:해)?)|(?:을|를)?\\s*(?:열어|보여))(?:\\s*(?:줘|주세요))?[.!]?$');
const FAVORITE_RULE = new RegExp('^즐겨찾기(?:에서|에)?\\s*' + '(추가|해제)(?:해)?(?:\\s*(?:줘|주세요))?[.!]?$');
const VERSION_RULE = new RegExp('^(?:현재\\s*)?버전\\s*' + verb('저장(?:해)?'));
const TOP_RULE = new RegExp('^(?:이\\s*문서를\\s*)?최상위로\\s*' + verb('이동(?:해)?|옮겨'));
const NEEDS_TARGET = /삭제|지워|없애|제거|수정|바꿔|고쳐|이동|옮겨|복제|복사|체크/;
const NO_TARGET = /(?:^|\s)(?:그|이|저)(?:거|것|걸)|(?:^|\s)(?:그|이|저)\s*블록|^블록/;
const blockNumber = word => ORDINALS[word] ?? Number(word);

// Clear requests skip the model. The result is still passed to planCommand with the original request.
export function routeCommand(input) {
  const request = String(input ?? '').trim();
  if (!request || request.length > 2000) return { clarify: '요청은 1~2,000자로 입력해 주세요.' };
  if (COMPOUND.test(request)) return { clarify: '복합 요청은 한 번에 하나씩 입력해 주세요.' };
  for (const [rule, command] of BLOCK_RULES) {
    const found = rule.exec(request);
    if (found) return { command: command(blockNumber(found[1])) };
  }
  let found = MOVE_RULE.exec(request);
  if (found) return { command: blockNumber(found[1]) + '번 블록을 ' + blockNumber(found[2]) + '번으로 이동' };
  found = CELL_RULE.exec(request);
  if (found) return { command: blockNumber(found[1]) + '번 블록의 ' + found[2] + '행 ' + found[3] + '열 수정: ' + found[4].trim() };
  found = EDIT_RULE.exec(request);
  if (found) {
    if (new RegExp('^' + NUMBER + '(?:\\s*자리)?$').test(found[2].trim())) return { clarify: '블록을 옮길지 내용을 바꿀지 알려 주세요.' };
    return { command: blockNumber(found[1]) + '번 블록을 ' + found[2].trim() + '로 수정' };
  }
  if (TOP_RULE.test(request)) return { command: '최상위로 이동' };
  if (VERSION_RULE.test(request)) return { command: '현재 버전 저장' };
  found = FAVORITE_RULE.exec(request);
  if (found) return { command: found[1] === '추가' ? '즐겨찾기에 추가' : '즐겨찾기 해제' };
  found = SCREEN_RULE.exec(request);
  if (found && Object.hasOwn(screens, found[1].trim())) return { command: found[1].trim() + ' 열어줘' };
  if (NAMED_HEADING.test(request) || DIRECT_HEADING.test(request)) {
    if (NOT_AT_END.test(request)) return { clarify: '블록 추가는 문서 끝만 지원합니다. 위치를 지정하려면 추가한 뒤 이동해 주세요.' };
    try {
      const title = requestedHeading(request, '');
      return title ? { command: '제목 블록 추가: ' + title } : {};
    } catch { return {}; }
  }
  if (NEEDS_TARGET.test(request) && NO_TARGET.test(request) && !blockNumbers(request).length) return { clarify: '어느 블록인지 번호로 알려 주세요.' };
  return {};
}

// 여러 작업 요청("…추가하고 …", "그리고", 쉼표)을 작업별 조각으로 나눈다. 각 작업은 자기 조각에 대해 같은 검사를 받는다.
export function splitRequest(request) {
  // "추가하고" → "추가해줘"처럼 조각 끝을 요청 모양으로 되돌려 같은 검사를 그대로 받게 한다
  const ending = { 만들: '만들어줘', 넣: '넣어줘', 바꾸: '바꿔줘', 바꿔: '바꿔줘', 옮기: '옮겨줘' };
  return String(request).replace(/(추가|생성|등록|만들|넣|바꾸|바꿔|수정|삭제|이동|변경|옮기|체크)(?:하|해)?고\s+/g, (_, verb) => (ending[verb] ?? verb + '해줘') + '\n')
    .replace(/\s*그리고\s*|[,，]\s*/g, '\n').split('\n').map(part => part.trim()).filter(Boolean);
}

// Produces a single-use approval bound to the current account, workspace and document revision.
export function planCommand(rt, input, memoId, newId, originalRequest) {
  const typed = input.trim();
  if (!typed || typed.length > 2000) throw new Error('요청은 1~2,000자로 입력해 주세요.');
  const request = originalRequest ? verifyModelCommand(originalRequest, typed) : typed;
  const workspace = rt.store.getCurrentWorkspace();
  let used = false;
  function proposal(summary, apply, memo, readOnly = false) {
    return { summary, approve(current) {
      if (used) throw new Error('이미 처리한 요청입니다.');
      used = true;
      if (current !== rt || rt.store.getCurrentWorkspace().id !== workspace.id || rt.closedSpaces.has(workspace.id)) throw new Error('계정 또는 공간이 바뀌었습니다.');
      if (!readOnly && !rt.store.getCurrentWorkspace().personal && rt.store.getCurrentWorkspace().roleCode === 'VIEWER') throw new Error('보기 전용 공간입니다.');
      if (memo) {
        const latest = rt.store.getMemo(memo.id);
        if (!latest || latest.deletedAt != null || latest.revision !== memo.revision) throw new Error('문서가 바뀌었습니다. 요청을 다시 검토해 주세요.');
      }
      return apply();
    }};
  }
  let match = /^(.+?)(?:\s*화면)?(?:을|를)?\s*(?:열기|열어\s*줘|보여\s*줘)$/.exec(request);
  if (match && Object.hasOwn(screens, match[1])) return proposal(match[1] + ' 화면 열기', () => ({ route: screens[match[1]] }), null, true);
  match = /^(?:새\s*)?문서\s*(?:만들기|생성|추가)\s*[:：]\s*(.+)$/.exec(request);
  if (match) {
    const title = match[1].trim();
    return proposal('새 문서 만들기 · ' + title, () => {
      const created = rt.store.addMemo({ title });
      return { route: ROUTES.MemoEdit, params: { memoId: created.id } };
    });
  }
  match = /^(할 일|일정)\s*추가\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s*[:：]\s*(.+)$/.exec(request);
  if (match) {
    const [, kind, date, start, title] = match;
    return proposal(request, () => {
      const wanted = { kind: kind === '일정' ? 'event' : 'task', date, start: start || '', title };
      const task = rt.store.addTask(wanted);
      if (Object.keys(wanted).some(key => task[key] !== wanted[key])) {
        rt.store.deleteTask(task.id);
        throw new Error('저장 값이 요청과 달라 저장을 되돌렸습니다.');
      }
      return { route: ROUTES.TaskEdit, params: { taskId: task.id } };
    });
  }
  const memo = rt.documents.listDocuments().find(item => item.id === memoId);
  if (!memo) throw new Error('편집할 문서를 선택하거나 “문서 만들기: 제목” 또는 “캘린더 열어줘”처럼 요청해 주세요.');
  const label = memo.title || '제목 없는 문서';
  const review = (detail, apply) => proposal(label + '\n' + detail, apply, memo);
  if (request === '최상위로 이동') return review(request, () => { rt.documents.moveDocument(memo.id); });
  match = /^(상위 문서 변경|문서 연결|문서 연결 해제)\s*[:：]\s*(.+)$/.exec(request);
  if (match) {
    const [, action, title] = match;
    const targets = rt.documents.listDocuments().filter(item => item.title === title);
    if (targets.length !== 1) throw new Error('현재 공간에서 해당 제목의 문서를 하나로 특정할 수 없습니다.');
    const target = targets[0];
    if (target.id === memo.id) throw new Error('다른 문서를 지정해 주세요.');
    return review(request, () => {
      const current = rt.store.getMemo(target.id);
      if (!current || current.deletedAt != null || current.revision !== target.revision) throw new Error('대상 문서가 바뀌었습니다.');
      if (action === '상위 문서 변경') rt.documents.moveDocument(memo.id, target.id);
      else rt.documents.setLink(memo.id, target.id, action === '문서 연결');
    });
  }
  if (request === '현재 버전 저장') return review(request, () => { rt.documents.createVersion(memo.id, memo.revision); });
  if (/^즐겨찾기(?:에)?\s*(추가|해제)$/.test(request)) return review(request, () => { rt.store.setFavorites([memo.id], request.endsWith('추가')); });
  const blocks = rt.documents.blocksFor(memo);
  // Compares the whole document so a change to any neighboring block is caught, then restores the reviewed content.
  function commit(title, next) {
    rt.documents.saveContent(memo.id, { title, blocks: next, body: blocksText(next) }, memo.revision);
    const saved = rt.store.getMemo(memo.id);
    if (saved.title === title && JSON.stringify(rt.documents.blocksFor(saved)) === JSON.stringify(next)) return;
    rt.documents.saveContent(memo.id, { title: memo.title, blocks, body: blocksText(blocks) }, saved.revision);
    throw new Error('저장 값이 요청과 달라 원래 내용으로 되돌렸습니다.');
  }
  match = /^문서 제목 변경\s*[:：]\s*(.+)$/.exec(request);
  if (match) {
    const title = match[1].trim();
    return review(request, () => commit(title, blocks));
  }
  function pick(number) {
    const block = blocks[Number(number) - 1];
    if (!block) throw new Error(number + '번 블록이 없습니다.');
    return block;
  }
  function save(detail, next) {
    const checked = normalizeBlocks(next);
    return review(detail, () => {
      if (JSON.stringify(rt.documents.blocksFor(memo)) !== JSON.stringify(blocks)) throw new Error('블록이 바뀌었습니다. 다시 검토해 주세요.');
      commit(memo.title, checked);
    });
  }
  match = /^(\d+)\s*번\s*블록\s*(복제|체크|체크 해제)$/.exec(request);
  if (match) {
    const block = pick(match[1]);
    if (match[2] === '복제') return save(request + '\n' + blocksText([block]), insertBlock(blocks, block.id, { ...block, id: newId() }));
    if (block.type !== 'task') throw new Error('체크 블록을 선택해 주세요.');
    return save(request + '\n' + block.text, blocks.map(item => item === block ? { ...block, checked: match[2] === '체크' } : item));
  }
  match = /^(문단|본문|제목|목록|체크|표)\s*블록\s*(?:추가|생성)(?:\s*[:：]\s*(.+))?$/.exec(request);
  if (match) {
    const type = types[match[1]], text = match[2] || '';
    if (type === 'table' && text) throw new Error('표를 먼저 추가한 뒤 셀을 지정해 주세요.');
    return save(request, insertBlock(blocks, null, { id: newId(), type, text, checked: false }));
  }
  match = /^(\d+)\s*번\s*블록(?:을|를)?\s*(\d+)\s*번(?:째)?(?:으)?로\s*(?:이동|옮겨\s*줘)$/.exec(request);
  if (match) {
    const block = pick(match[1]), destination = pick(match[2]);
    const remaining = blocks.filter(item => item.id !== block.id);
    return save(request + '\n' + (block.text || block.type), moveBlock(blocks, block.id, remaining[blocks.indexOf(destination)]?.id ?? null));
  }
  match = /^(\d+)\s*번\s*블록(?:의)?\s*(\d+)\s*행\s*(\d+)\s*열\s*수정\s*[:：]\s*(.+)$/.exec(request);
  if (match) {
    const block = pick(match[1]), row = Number(match[2]) - 1, column = Number(match[3]) - 1;
    if (block.type !== 'table' || block.rows[row]?.[column] == null) throw new Error('해당 위치에 표 셀이 없습니다.');
    const rows = block.rows.map((cells, index) => index === row ? cells.map((value, i) => i === column ? match[4] : value) : cells);
    return save(request + '\n기존 값 · ' + block.rows[row][column], blocks.map(item => item === block ? { ...item, rows } : item));
  }
  match = /^(\d+)\s*번\s*블록(?:을|를)?\s*(.+?)(?:으)?로\s*(?:수정|바꿔\s*줘)$/.exec(request);
  if (match) {
    const block = pick(match[1]);
    if (block.type === 'table') throw new Error('표의 행과 열을 지정해 주세요.');
    return save(request + '\n기존 내용 · ' + block.text, blocks.map(item => item === block ? { ...item, text: match[2] } : item));
  }
  match = /^(\d+)\s*번\s*블록(?:을|를)?\s*삭제$/.exec(request);
  if (match) {
    const block = pick(match[1]);
    return save(request + '\n' + blocksText([block]), blocks.filter(item => item !== block));
  }
  throw new Error('지원하는 작업과 대상을 확인해 주세요. 복합 요청은 한 번에 하나씩 검토할 수 있습니다.');
}
