const KIND = '(할\\s*일|일정)';
const DATE = '(\\d{4}-\\d{2}-\\d{2}|오늘|내일|모레|어제)';
const kindOf = word => word === '일정' ? 'event' : 'task';
const named = value => value.trim().replace(/^["“](.*)["”]$/u, '$1').trim();

export function dayOffset(today, offset) {
  const day = new Date(`${today}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== today) return null;
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

export function taskDate(value, today) {
  const offset = { 오늘: 0, 내일: 1, 모레: 2, 어제: -1 }[value];
  return offset === undefined ? dayOffset(value, 0) : dayOffset(today, offset);
}

const ADD = new RegExp('^' + KIND + '\\s*추가\\s+' + DATE + '(?:\\s+(\\d{2}:\\d{2}))?\\s*[:：]\\s*(.+)$', 'u');
const ADD_NATURAL = new RegExp('^' + DATE + '(?:에)?\\s+' + KIND + '(?:으로|로)\\s+(.+?)(?:을|를)?\\s+추가해\\s*(?:줘|주세요)[.!?]?$', 'u');
const STATUS = new RegExp('^' + KIND + '\\s*완료(\\s*취소)?\\s*[:：]\\s*(.+)$', 'u');
const STATUS_NATURAL = new RegExp('^(.+?)\\s+' + KIND + '(?:을|를)?\\s*완료(?:\\s*(취소))?\\s*(?:처리)?\\s*해\\s*(?:줘|주세요)[.!?]?$', 'u');

export function parseTaskAction(text, today) {
  const explicit = ADD.exec(text);
  const natural = ADD_NATURAL.exec(text);
  if (explicit || natural) {
    const [kindWord, dateWord, start, rawTitle] = explicit ? explicit.slice(1) : [natural[2], natural[1], '', natural[3]];
    const kind = kindOf(kindWord);
    const title = named(rawTitle);
    const date = taskDate(dateWord, today);
    if (!date || !title || title.length > 200 || (start && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(start))) {
      return { error: '제목, 날짜와 시간을 확인해 주세요.' };
    }
    return { action: 'create', kind, fields: { kind, title, date, ...(start && { start }) } };
  }
  const explicitStatus = STATUS.exec(text);
  const naturalStatus = STATUS_NATURAL.exec(text);
  if (!explicitStatus && !naturalStatus) return null;
  const [word, undo, title] = explicitStatus ? explicitStatus.slice(1) : [naturalStatus[2], naturalStatus[3], naturalStatus[1]];
  return { action: 'change', kind: kindOf(word), title: named(title), fields: { status: undo ? '진행 전' : '완료' } };
}
