const KIND = '(할\\s*일|일정)';
const ISO_DATE = '(\\d{4}-\\d{2}-\\d{2})';
const REL_DATE = '(오늘|내일|모레|글피|어제)';
const EXPLICIT_DATE = '(\\d{4}-\\d{2}-\\d{2}|오늘|내일|모레|글피|어제)';
const WEEKDAY = '(?:(이번|다음|다다음)\\s*주\\s*)?(월|화|수|목|금|토|일)요일';
const MONTH_DAY = '(?:(\\d{4})\\s*년\\s*)?(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일';
const TIME_24 = '(?<![\\d:])(\\d{1,2}):(\\d{2})(?![\\d:])';
const TIME_KO = '(오전|오후|아침|점심|낮|저녁|밤|새벽)?\\s*(?<!\\d)(\\d{1,2})\\s*시(?!간|즌|리즈)(?:\\s*(반)|\\s*(\\d{1,2})\\s*분)?';

const kindOf = word => (word === '일정' ? 'event' : word ? 'task' : null);
const named = value => String(value ?? '').trim().replace(/^["“](.*)["”]$/u, '$1').trim();
const pad2 = n => String(n).padStart(2, '0');
const WEEKDAY_INDEX = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };
const REL_OFFSET = { 어제: -1, 오늘: 0, 내일: 1, 모레: 2, 글피: 3 };

export function dayOffset(today, offset) {
  const day = new Date(`${today}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== today) return null;
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

export function taskDate(value, today) {
  if (!value) return null;
  const offset = REL_OFFSET[value];
  if (offset !== undefined) return dayOffset(today, offset);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return dayOffset(value, 0);
  const md = new RegExp(`^${MONTH_DAY}$`, 'u').exec(value.trim());
  if (md) {
    const year = md[1] ? Number(md[1]) : Number(String(today).slice(0, 4));
    const iso = `${String(year).padStart(4, '0')}-${pad2(Number(md[2]))}-${pad2(Number(md[3]))}`;
    return dayOffset(iso, 0);
  }
  const wd = new RegExp(`^${WEEKDAY}$`, 'u').exec(value.trim());
  if (wd) {
    const base = new Date(`${today}T00:00:00Z`);
    if (!Number.isFinite(base.getTime()) || base.toISOString().slice(0, 10) !== today) return null;
    const dow = (base.getUTCDay() + 6) % 7;
    const target = WEEKDAY_INDEX[wd[2]];
    let delta;
    if (wd[1] === '이번') delta = target - dow;
    else if (wd[1] === '다음') delta = 7 - dow + target;
    else if (wd[1] === '다다음') delta = 14 - dow + target;
    else {
      delta = target - dow;
      if (delta <= 0) delta += 7;
    }
    return dayOffset(today, delta);
  }
  return null;
}

function parseKoreanTime(meridiem, rawHour, half, rawMinute) {
  let hour = Number(rawHour);
  const minute = half ? 30 : Number(rawMinute ?? 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (/^(?:오전|아침|새벽)$/u.test(meridiem)) hour = hour === 12 ? 0 : hour;
    else if (/^(?:낮|점심)$/u.test(meridiem)) hour = hour >= 10 ? hour : hour + 12;
    else hour = hour === 12 ? 12 : hour + 12;
  } else {
    if (hour < 0 || hour > 23) return null;
    if (hour >= 1 && hour <= 7) hour += 12;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

function parseClockTime(rawHour, rawMinute) {
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function extractDateToken(body, today) {
  const patterns = [
    new RegExp(`(?:^|\\s)${ISO_DATE}(?:에|까지|부터)?(?=\\s|$)`, 'u'),
    new RegExp(`(?:^|\\s)(${MONTH_DAY})(?:에|까지|부터)?(?=\\s|$)`, 'u'),
    new RegExp(`(?:^|\\s)(${WEEKDAY})(?:에|까지|부터)?(?=\\s|$)`, 'u'),
    new RegExp(`(?:^|\\s)${REL_DATE}(?:에|까지|부터)?(?=\\s|$)`, 'u'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (!match) continue;
    const raw = match[1];
    const resolved = taskDate(raw, today);
    const rest = `${body.slice(0, match.index)} ${body.slice(match.index + match[0].length)}`.replace(/\s+/gu, ' ').trim();
    return { found: true, date: resolved, rest };
  }
  return { found: false, date: null, rest: body };
}

function extractTimeToken(body) {
  const clock = new RegExp(`(?:^|\\s)${TIME_24}(?:에|부터|까지)?(?=\\s|$)`, 'u').exec(body);
  if (clock) {
    const start = parseClockTime(clock[1], clock[2]);
    const rest = `${body.slice(0, clock.index)} ${body.slice(clock.index + clock[0].length)}`.replace(/\s+/gu, ' ').trim();
    return { found: true, start, rest };
  }
  const ko = new RegExp(`(?:^|\\s)${TIME_KO}(?:에|부터|까지)?(?=\\s|$)`, 'u').exec(body);
  if (ko) {
    const start = parseKoreanTime(ko[1], ko[2], ko[3], ko[4]);
    const rest = `${body.slice(0, ko.index)} ${body.slice(ko.index + ko[0].length)}`.replace(/\s+/gu, ' ').trim();
    return { found: true, start, rest };
  }
  return { found: false, start: '', rest: body };
}

const ADD_EXPLICIT = new RegExp('^' + KIND + '\\s*추가\\s+' + EXPLICIT_DATE + '(?:\\s+(\\d{2}:\\d{2}))?\\s*[:：]\\s*(.+)$', 'u');
const STATUS_EXPLICIT = new RegExp('^' + KIND + '\\s*완료(\\s*취소)?\\s*[:：]\\s*(.+)$', 'u');
const CREATE_ENDING = /\s*(?:(?:추가|등록|생성|기록)(?:해\s*(?:줘|주세요|요)?|해)?|(?:만들어|잡아|넣어)\s*(?:줘|주세요|요)?)[.!]*$/u;
const QUESTION_OR_OTHER = /[?？]$|(?:있어|있나|있니|있나요|뭐야|보여|알려|찾아|검색|삭제|지워|없애|열어)/u;
const STATUS_WITH_KIND = new RegExp('^(.+?)\\s+' + KIND + '(?:을|를)?\\s*완료(?:\\s*(취소))?\\s*(?:처리)?\\s*(?:해\\s*(?:줘|주세요|요)?|해)?[.!]*$', 'u');
const STATUS_SHORT = /^(.+?)\s+(?:완료(?:\s*(취소))?(?:\s*처리)?(?:\s*해\s*(?:줘|주세요|요)?)?|끝났어|끝냈어)[.!]*$/u;

function cleanTitle(raw) {
  return named(raw)
    .replace(/^(?:으로|로|에|을|를)\s+/u, '')
    .replace(/(?:을|를)$/u, '')
    .trim();
}

export function parseTaskAction(input, today) {
  const text = String(input ?? '').normalize('NFC').trim();
  if (!text) return null;

  const explicit = ADD_EXPLICIT.exec(text);
  if (explicit) {
    const [kindWord, dateWord, start, rawTitle] = explicit.slice(1);
    const kind = kindOf(kindWord);
    const title = named(rawTitle);
    const date = taskDate(dateWord, today);
    if (!date || !title || title.length > 200 || (start && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(start))) {
      return { error: '제목, 날짜와 시간을 확인해 주세요.' };
    }
    return { action: 'create', kind, fields: { kind, title, date, ...(start && { start }) } };
  }

  const explicitStatus = STATUS_EXPLICIT.exec(text);
  if (explicitStatus) {
    const [word, undo, title] = explicitStatus.slice(1);
    return { action: 'change', kind: kindOf(word), title: named(title), fields: { status: undo ? '진행 전' : '완료' } };
  }

  if (QUESTION_OR_OTHER.test(text)) return null;

  const statusWithKind = STATUS_WITH_KIND.exec(text);
  if (statusWithKind) {
    const [, rawTitle, word, undo] = statusWithKind;
    const title = cleanTitle(rawTitle);
    if (title) return { action: 'change', kind: kindOf(word), title, fields: { status: undo ? '진행 전' : '완료' } };
  }

  if (!/프로젝트|문서|메모/u.test(text) && !CREATE_ENDING.test(text)) {
    const shortStatus = STATUS_SHORT.exec(text);
    if (shortStatus) {
      const title = cleanTitle(shortStatus[1]);
      if (title && !/^(?:할\s*일|일정)$/u.test(title)) {
        return { action: 'change', kind: null, title, fields: { status: shortStatus[2] ? '진행 전' : '완료' } };
      }
    }
  }

  if (!CREATE_ENDING.test(text)) return null;
  if (/프로젝트|문서|메모/u.test(text) && !new RegExp(KIND, 'u').test(text)) return null;

  const body = text.replace(CREATE_ENDING, '').trim();
  const kindMatch = new RegExp(`(?:^|\\s)${KIND}(?:으로|로|에|을|를)?(?=\\s|$)`, 'u').exec(body);
  if (!kindMatch) return null;
  const kind = kindOf(kindMatch[1]);
  const withoutKind = `${body.slice(0, kindMatch.index)} ${body.slice(kindMatch.index + kindMatch[0].length)}`.replace(/\s+/gu, ' ').trim();

  const datePart = extractDateToken(withoutKind, today);
  if (datePart.found && !datePart.date) return { error: '제목, 날짜와 시간을 확인해 주세요.' };
  const timePart = extractTimeToken(datePart.rest);
  if (timePart.found && !timePart.start) return { error: '제목, 날짜와 시간을 확인해 주세요.' };

  const title = cleanTitle(timePart.rest);
  const date = datePart.date ?? dayOffset(today, 0);
  if (!date || !title || title.length > 200) return { error: '제목, 날짜와 시간을 확인해 주세요.' };
  return { action: 'create', kind, fields: { kind, title, date, ...(timePart.start && { start: timePart.start }) } };
}

export function taskActionFromPlan(planned, today) {
  if (!planned || typeof planned !== 'object') return null;
  const title = named(planned.title);
  if (!title || title.length > 200) return null;
  if (planned.op === 'create') {
    const kind = planned.kind === 'event' ? 'event' : 'task';
    const date = planned.date ? dayOffset(planned.date, 0) : dayOffset(today, 0);
    const start = planned.start && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(planned.start) ? planned.start : '';
    if (!date) return null;
    return { action: 'create', kind, fields: { kind, title, date, ...(start && { start }) } };
  }
  if (planned.op === 'complete' || planned.op === 'reopen') {
    const kind = planned.kind === 'event' ? 'event' : planned.kind === 'task' ? 'task' : null;
    return { action: 'change', kind, title, fields: { status: planned.op === 'complete' ? '완료' : '진행 전' } };
  }
  return null;
}
