import { fail } from './errors.js';
import { isPlainObject } from './validate.js';

/**
 * 기기 값 ↔ 서버(Supabase) 값 변환. 네트워크 코드는 없고 순수 함수입니다.
 *
 *   메모(memos)      ↔ notes   : 빈 제목 '' ↔ null
 *   일정·할 일(tasks) ↔ tasks / events (kind로 정함)
 *     날짜 'YYYY-MM-DD' + 시간 'HH:MM' (기기 시간대) ↔ due_at / start_at / end_at (ISO 시점)
 *     중요도·상태·알림 글자 ↔ priority(0~3) · status(TODO…) · reminder_minutes(분)
 *     assignee ↔ assignee_name, place ↔ location, desc ↔ description, projectId ↔ project_id, 연결된 메모 ↔ note_id
 */

// ---------------------------------------------------------------------
// 시간: 현지 날짜·시각 + 시간대 ↔ ISO 8601 (fe/stella/convert.ts의 localToIso와 같은 계산)
// ---------------------------------------------------------------------
const FIXED_OFFSETS = { 'Asia/Seoul': 540, 'Asia/Tokyo': 540, UTC: 0, 'Etc/UTC': 0 };

function offsetMinutes(utcMs, tz) {
  if (tz in FIXED_OFFSETS) return FIXED_OFFSETS[tz];   // 서머타임 없는 시간대는 Intl 없이 (Hermes 호환)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = t => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');

export function localToIso(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = (time || '00:00').split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let off = offsetMinutes(wall, tz);
  off = offsetMinutes(wall - off * 60000, tz);          // 서머타임 경계 보정
  return `${date}T${pad(h)}:${pad(mi)}:00${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** 서버 시점 → 기기 시간대의 { date, time, ms } */
export function isoToLocal(iso, tz) {
  const ms = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  if (!Number.isFinite(ms)) fail('invalid_input', 'time');
  const t = new Date(ms + offsetMinutes(ms, tz) * 60000);
  return {
    date: `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    ms,
  };
}

export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 손글씨를 늘 같은 키 순서(id, c, w, p, 나머지)의 JSON 글자로. 서버(jsonb)는 키 순서를 바꿔 돌려주므로 비교·저장 전에 맞춤 */
export function canonStrokes(strokes) {
  const list = typeof strokes === 'string' ? JSON.parse(strokes) : strokes;
  return JSON.stringify(list.map(s => {
    const { id, c, w, p, ...rest } = s;
    const out = { id, c, w, p };
    for (const key of Object.keys(rest).sort()) out[key] = rest[key];
    return out;
  }));
}

const toMs = value => (value === null || value === undefined ? null : (value instanceof Date ? value.getTime() : Date.parse(value)));

// ---------------------------------------------------------------------
// 화면 글자 ↔ 서버 값. 화면 쪽 목록(TaskStore의 PRIORITIES·ALARMS)과 다르면 createLocalStore({ labels })로 바꿉니다.
// ---------------------------------------------------------------------
export const DEFAULT_LABELS = Object.freeze({
  priority: Object.freeze({ 낮음: 1, 보통: 2, 높음: 3 }),
  priorityNone: '보통',                                   // 서버 priority 0(정하지 않음)을 화면에 보일 글자
  status: Object.freeze({ '진행 전': 'TODO', '진행 중': 'IN_PROGRESS', 완료: 'DONE', 취소: 'CANCELED' }),
  // 프로젝트 진행 상태 (서버 progress_status). 보관 여부(status: ACTIVE·ARCHIVED)와는 다른 칸
  projectStatus: Object.freeze({ '진행 전': 'TODO', '진행 중': 'IN_PROGRESS', 완료: 'DONE', 보류: 'ON_HOLD', 취소: 'CANCELED' }),
  alarm: Object.freeze({ 없음: null, 정시: 0, '5분 전': 5, '10분 전': 10, '30분 전': 30, '1시간 전': 60, '하루 전': 1440, '이틀 전': 2880, '일주일 전': 10080 }),
});
const ALARM_UNIT = { 분: 1, 시간: 60, 일: 1440, 주: 10080 };
const MAX_REMINDER = 525600;

export function createServerMap({ timezone = 'Asia/Seoul', labels = {} } = {}) {
  const priority = { ...DEFAULT_LABELS.priority, ...(labels.priority ?? {}) };
  const priorityNone = labels.priorityNone ?? DEFAULT_LABELS.priorityNone;
  const status = { ...DEFAULT_LABELS.status, ...(labels.status ?? {}) };
  const alarm = { ...DEFAULT_LABELS.alarm, ...(labels.alarm ?? {}) };
  const projectStatus = { ...DEFAULT_LABELS.projectStatus, ...(labels.projectStatus ?? {}) };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const labelOf = (o, code) => Object.keys(o).find(k => o[k] === code);

  const map = {
    timezone,
    /** 글자 → 0~3. 모르는 글자는 undefined */
    priorityCode: label => (has(priority, label) ? priority[label] : undefined),
    priorityLabel: code => labelOf(priority, code) ?? priorityNone,
    statusCode: label => (has(status, label) ? status[label] : undefined),
    statusLabel: code => labelOf(status, code) ?? labelOf(status, 'TODO'),
    /** 글자 → 분 또는 null(알림 없음). 모르는 글자는 undefined. 'N분 전'·'N시간 전'·'N일 전'·'N주 전'은 목록에 없어도 읽음 */
    alarmMinutes(label) {
      if (has(alarm, label)) return alarm[label];
      const m = /^(\d{1,6})\s*(분|시간|일|주)\s*전$/.exec(label);
      if (!m) return undefined;
      const minutes = Number(m[1]) * ALARM_UNIT[m[2]];
      return minutes <= MAX_REMINDER ? minutes : undefined;
    },
    alarmLabel(minutes) {
      if (minutes === null || minutes === undefined) return labelOf(alarm, null) ?? '없음';
      const known = labelOf(alarm, minutes);
      if (known !== undefined) return known;
      if (minutes % 1440 === 0) return `${minutes / 1440}일 전`;
      if (minutes % 60 === 0) return `${minutes / 60}시간 전`;
      return `${minutes}분 전`;
    },

    /** 메모 행 → notes data */
    noteData: row => ({ title: row.title === '' ? null : row.title, body: row.body, strokes: typeof row.strokes === 'string' ? JSON.parse(row.strokes) : row.strokes }),

    taskEntity: row => (row.kind === 'event' ? 'events' : 'tasks'),

    /** 일정·할 일 행(+ 연결된 메모 id) → tasks / events data. 서버가 받을 수 없는 값이면 invalid_input */
    taskData(row, noteId = null) {
      const p = map.priorityCode(row.priority);
      if (p === undefined) fail('invalid_input', 'priority');
      const s = map.statusCode(row.status);
      if (s === undefined) fail('invalid_input', 'status');
      const reminder = map.alarmMinutes(row.alarm);
      if (reminder === undefined) fail('invalid_input', 'alarm');
      const base = {
        title: row.title, description: row.description || null, status: s, priority: p, reminder_minutes: reminder,
        assignee_name: row.assignee || null, location: row.place || null, note_id: noteId ?? null, project_id: row.project_id ?? null,
      };
      if (row.kind !== 'event') {
        return { ...base, due_at: row.date ? localToIso(row.date, row.start_time || null, timezone) : null, all_day: !!row.date && !row.start_time };
      }
      if (!row.date) fail('invalid_input', 'date');
      const endDay = row.end_date || row.date;
      let startAt, endAt;
      if (row.start_time) {
        startAt = localToIso(row.date, row.start_time, timezone);
        endAt = row.end_time ? localToIso(endDay, row.end_time, timezone) : (endDay !== row.date ? localToIso(endDay, row.start_time, timezone) : startAt);
      } else {
        startAt = localToIso(row.date, null, timezone);
        endAt = localToIso(addDays(endDay, 1), null, timezone);   // 하루 종일: 끝나는 날 다음 날 0시까지
      }
      if (Date.parse(endAt) < Date.parse(startAt)) fail('invalid_input', 'end');   // 서버 events_time_order
      return { ...base, start_at: startAt, end_at: endAt, all_day: !row.start_time, timezone };
    },

    /** 서버 tasks / events 행 → 기기 칸 (noteId는 연결할 메모) */
    taskFromServer(entity, s) {
      const common = {
        id: s.id, title: s.title, description: s.description ?? '', priority: map.priorityLabel(s.priority ?? 0), status: map.statusLabel(s.status),
        alarm: map.alarmLabel(s.reminder_minutes), assignee: s.assignee_name ?? '', place: s.location ?? '', project_id: s.project_id ?? null,
        noteId: s.note_id ?? null, created_at: toMs(s.created_at), updated_at: toMs(s.updated_at), deleted_at: toMs(s.deleted_at),
      };
      if (entity === 'tasks') {
        const due = s.due_at ? isoToLocal(s.due_at, timezone) : null;
        return { ...common, kind: 'task', date: due ? due.date : '', end_date: '', start_time: due && !s.all_day ? due.time : '', end_time: '' };
      }
      const start = isoToLocal(s.start_at, timezone), end = isoToLocal(s.end_at, timezone);
      if (s.all_day) {
        const last = end.ms > start.ms ? addDays(end.date, end.time === '00:00' ? -1 : 0) : start.date;
        return { ...common, kind: 'event', date: start.date, end_date: last !== start.date ? last : '', start_time: '', end_time: '' };
      }
      return {
        ...common, kind: 'event', date: start.date, end_date: end.date !== start.date ? end.date : '',
        start_time: start.time, end_time: end.ms === start.ms || (end.date !== start.date && end.time === start.time) ? '' : end.time,
      };
    },

    /**
     * 프로젝트 편집 화면의 값 { title, due, priority, status, alarm, assignee, place, desc } → 서버 projects data.
     * 준 칸만 바꿔 줌 (수정 때는 바뀐 칸만 넘기면 됨). 프로젝트는 이 저장소에 없고 local-sync로 바로 저장함.
     */
    projectData(form) {
      if (!isPlainObject(form)) fail('invalid_input', 'project');
      const out = {};
      if ('title' in form) out.name = typeof form.title === 'string' && form.title.trim() && form.title.length <= 100 ? form.title : fail('invalid_input', 'title');
      if ('due' in form) out.due_date = form.due === '' || form.due === null ? null : (/^\d{4}-\d{2}-\d{2}$/.test(form.due) ? form.due : fail('invalid_input', 'due'));
      if ('priority' in form) out.priority = map.priorityCode(form.priority) ?? fail('invalid_input', 'priority');
      if ('status' in form) out.progress_status = has(projectStatus, form.status) ? projectStatus[form.status] : fail('invalid_input', 'status');
      if ('alarm' in form) { const m = map.alarmMinutes(form.alarm); out.reminder_minutes = m === undefined ? fail('invalid_input', 'alarm') : m; }
      if ('assignee' in form) out.assignee_name = form.assignee || null;
      if ('place' in form) out.location = form.place || null;
      if ('desc' in form) out.description = form.desc || null;
      return out;
    },
    /** 서버 projects 행 → 프로젝트 화면 값 */
    projectFromServer: s => ({
      id: s.id, title: s.name, due: s.due_date ?? '', priority: map.priorityLabel(s.priority ?? 0), status: labelOf(projectStatus, s.progress_status) ?? '진행 전',
      alarm: map.alarmLabel(s.reminder_minutes), assignee: s.assignee_name ?? '', place: s.location ?? '', desc: s.description ?? '',
    }),

    /** 서버 notes 행 → 기기 칸 */
    noteFromServer: s => ({
      id: s.id, title: s.title ?? '', body: s.body ?? '', strokes: canonStrokes(s.strokes ?? []),
      created_at: toMs(s.created_at), updated_at: toMs(s.updated_at), deleted_at: toMs(s.deleted_at),
    }),

    /** 바뀐 키만 (수정은 바꾼 칸만 보내야 다른 사람이 바꾼 칸을 덮지 않음) */
    diff(before, after) {
      const out = {};
      for (const key of Object.keys(after)) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
      return out;
    },

    /**
     * Supabase ai-gateway /analyze 초안(draft.tasks, draft.events) → addProposals 입력.
     * source는 { sourceType, sourceId, sourceTitle, sourceRevision } (메모에서 분석했으면 sourceType 'memo')
     */
    proposalsFromAnalyze(draft, source = {}) {
      if (!isPlainObject(draft) || !Array.isArray(draft.tasks) || !Array.isArray(draft.events)) fail('invalid_input', 'draft');
      const items = [];
      for (const t of draft.tasks) {
        items.push({
          kind: 'task', title: t.title ?? '', date: t.due_date ?? '', start: t.due_time ?? '', assignee: t.assignee_name ?? '',
          body: t.description ?? '', evidence: t.evidence ?? '', priority: t.priority > 0 ? map.priorityLabel(t.priority) : '', ...source,
        });
      }
      for (const e of draft.events) {
        const timed = !e.all_day && !!e.start_time;
        items.push({
          kind: 'event', title: e.title ?? '', date: e.date ?? '', endDate: e.end_date && e.end_date !== e.date ? e.end_date : '',
          start: timed ? e.start_time : '', end: timed ? e.end_time ?? '' : '', place: e.location ?? '',
          body: e.description ?? '', evidence: e.evidence ?? '', ...source,
        });
      }
      return items;
    },
  };
  return Object.freeze(map);
}
