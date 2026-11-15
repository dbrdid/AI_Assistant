// AI 초안(/analyze 결과)을 사용자가 승인한 뒤 sync_push ops로 바꾸는 함수 (React Native 의존 없음)
//   AI 초안의 날짜·시각은 "현지 시간"(YYYY-MM-DD, HH:MM)이고,
//   DB의 due_at·start_at·end_at은 시점(timestamptz)이라 시간대를 붙여 ISO 문자열로 바꿉니다.
import { op } from './ops';
import type { AnalyzeDraft, MeetingTopicDraft, SyncOp } from './types';

// ---------------------------------------------------------------------
// 현지 날짜·시각 + 시간대 → ISO 8601 (예: 2026-11-13T15:00:00+09:00)
// ---------------------------------------------------------------------
const FIXED_OFFSETS: Record<string, number> = { 'Asia/Seoul': 540, 'Asia/Tokyo': 540, UTC: 0, 'Etc/UTC': 0 };

/** tz에서 utcMs 시점의 UTC 대비 오프셋(분) */
function offsetMinutes(utcMs: number, tz: string): number {
  if (tz in FIXED_OFFSETS) return FIXED_OFFSETS[tz];  // 서머타임 없는 시간대는 Intl 없이 계산 (Hermes 호환)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

function pad(n: number, w = 2) {
  return String(Math.abs(n)).padStart(w, '0');
}

export function localToIso(date: string, time: string | null, tz: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = (time ?? '00:00').split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let off = offsetMinutes(wall, tz);
  off = offsetMinutes(wall - off * 60000, tz);  // 서머타임 경계 보정
  const sign = off >= 0 ? '+' : '-';
  return `${date}T${pad(h)}:${pad(mi)}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi + minutes));
  return { date: t.toISOString().slice(0, 10), time: t.toISOString().slice(11, 16) };
}

// ---------------------------------------------------------------------
// /analyze 초안 → ops
// ---------------------------------------------------------------------
export interface DraftToOpsOptions {
  timezone: string;                       // analyze 응답의 timezone 그대로
  newId: () => string;                    // 새 기록 id 생성기 (ids.ts의 newId)
  noteId?: string | null;                 // 근거 메모 (먼저 만들었거나 같은 push 앞쪽에 있는 메모)
  projectId?: string | null;
  sourceVersionId?: string | null;        // 확정 원문 버전 (sourceOps로 만든 versionId)
  members?: { account_id: string; display_name: string | null; status?: string }[];  // 담당자 이름 → account_id 매칭용 (ACTIVE만 사용)
  taskIndexes?: number[];                 // 사용자가 승인한 할 일 (없으면 전부)
  eventIndexes?: number[];                // 사용자가 승인한 일정 (없으면 전부)
  defaultEventMinutes?: number;           // 종료 시각이 없을 때 기본 길이 (기본 60분)
}

export interface DraftToOpsResult {
  ops: SyncOp[];
  taskIds: string[];
  eventIds: string[];
  warnings: string[];                     // 사용자에게 보여줄 확인 사항
}

export function analyzeDraftToOps(draft: AnalyzeDraft, o: DraftToOpsOptions): DraftToOpsResult {
  const ops: SyncOp[] = [];
  const warnings: string[] = [];
  const taskIds: string[] = [];
  const eventIds: string[] = [];
  const pick = <T>(arr: T[], idx?: number[]) => (idx ? idx.filter((i) => i >= 0 && i < arr.length).map((i) => arr[i]) : arr);
  const findMember = (name: string | null) => {
    if (!name || !o.members) return null;
    const n = name.replace(/\s/g, '');
    // 나간·내보낸 멤버는 담당자로 지정할 수 없음 (서버가 push 전체를 거절)
    return o.members.find((m) => (m.status ?? 'ACTIVE') === 'ACTIVE'
      && m.display_name && m.display_name.replace(/\s/g, '').includes(n))?.account_id ?? null;
  };

  for (const t of pick(draft.tasks, o.taskIndexes)) {
    const id = o.newId();
    const assignee = findMember(t.assignee_name);
    if (t.assignee_name && !assignee) warnings.push(`할 일 "${t.title}": 담당자 "${t.assignee_name}"를 공간 멤버에서 찾지 못해 비워 둡니다`);
    ops.push(op.create('tasks', id, {
      title: t.title,
      description: t.description,
      priority: t.priority,
      due_at: t.due_date ? localToIso(t.due_date, t.due_time, o.timezone) : null,
      all_day: !!t.due_date && !t.due_time,    // 날짜만 있으면 하루 종일 마감
      note_id: o.noteId ?? null,
      project_id: o.projectId ?? null,
      assignee_id: assignee,
      source_version_id: o.sourceVersionId ?? null,
    }));
    taskIds.push(id);
  }

  for (const e of pick(draft.events, o.eventIndexes)) {
    const id = o.newId();
    const allDay = e.all_day || !e.start_time;
    let startAt: string;
    let endAt: string;
    if (allDay) {
      startAt = localToIso(e.date, null, o.timezone);
      endAt = localToIso(addDays(e.end_date ?? e.date, 1), null, o.timezone);  // 종료일 다음 날 0시까지
      if (!e.all_day) warnings.push(`일정 "${e.title}": 시작 시각이 없어 하루 종일 일정으로 저장합니다`);
    } else {
      startAt = localToIso(e.date, e.start_time, o.timezone);
      if (e.end_time) {
        endAt = localToIso(e.end_date ?? e.date, e.end_time, o.timezone);
      } else {
        const end = addMinutes(e.date, e.start_time!, o.defaultEventMinutes ?? 60);
        endAt = localToIso(end.date, end.time, o.timezone);
        warnings.push(`일정 "${e.title}": 종료 시각이 없어 ${o.defaultEventMinutes ?? 60}분으로 잡았습니다`);
      }
    }
    ops.push(op.create('events', id, {
      title: e.title,
      description: e.description,
      location: e.location,
      start_at: startAt,
      end_at: endAt,
      all_day: allDay,
      timezone: o.timezone,
      note_id: o.noteId ?? null,
      project_id: o.projectId ?? null,
      source_version_id: o.sourceVersionId ?? null,
    }));
    eventIds.push(id);
  }

  return { ops, taskIds, eventIds, warnings };
}

// ---------------------------------------------------------------------
// 회의록 안건별 정리(draft.topics) → 회의 안건(agenda_items) ops
//   안건 설명 = 논의 내용(- 줄) + 결정(결정: 줄), 상태는 DISCUSSED(논의함)
//   회의(meetings)는 먼저 만들었거나 같은 push 앞쪽에 있어야 해요
// ---------------------------------------------------------------------
export interface TopicsToAgendaOptions {
  meetingId: string;
  newId: () => string;
  topicIndexes?: number[];      // 사용자가 승인한 안건 (없으면 전부)
  startPosition?: number;       // 이미 있는 안건 뒤에 붙일 때 시작 순서 (기본 0)
}

export function topicDescription(t: MeetingTopicDraft): string {
  const lines = t.points.map((p) => `- ${p}`);
  for (const d of t.decisions) lines.push(`결정: ${d}`);
  return lines.join('\n');
}

export function meetingTopicsToAgendaOps(
  draft: Pick<AnalyzeDraft, 'topics'>,
  o: TopicsToAgendaOptions,
): { ops: SyncOp[]; agendaIds: string[] } {
  const picked = new Set(o.topicIndexes ?? draft.topics.map((_, i) => i));
  const ops: SyncOp[] = [];
  const agendaIds: string[] = [];
  let position = o.startPosition ?? 0;
  draft.topics.forEach((t, i) => {
    if (!picked.has(i)) return;
    const title = t.title.trim().slice(0, 200);   // DB: agenda_items.title 1~200자
    if (!title) return;
    const id = o.newId();
    agendaIds.push(id);
    ops.push(op.create('agenda_items', id, {
      meeting_id: o.meetingId, title, description: topicDescription(t) || null, status: 'DISCUSSED', position: position++,
    }));
  });
  return { ops, agendaIds };
}

/**
 * 정리 노트 본문 (마크다운): 요약 → 주요 개념 → 내용 흐름/안건 → 확인할 점
 *   녹음 정리 결과를 노트(notes.body)로 저장할 때. 전사문(원문)은 input_sources·source_text_versions에 따로 저장
 */
export function analyzeDraftToNoteBody(
  draft: Pick<AnalyzeDraft, 'summary' | 'topics' | 'key_concepts' | 'open_questions'>,
  o: { topicIndexes?: number[]; conceptIndexes?: number[]; includeQuestions?: boolean } = {},
): string {
  const out: string[] = [];
  if (draft.summary.trim()) out.push('## 요약', draft.summary.trim(), '');
  const concepts = (draft.key_concepts ?? []).filter((_, i) => !o.conceptIndexes || o.conceptIndexes.includes(i));
  if (concepts.length) {
    out.push('## 주요 개념');
    for (const c of concepts) out.push(`- **${c.term}**: ${c.explanation}`);
    out.push('');
  }
  const topics = draft.topics.filter((_, i) => !o.topicIndexes || o.topicIndexes.includes(i));
  if (topics.length) {
    out.push('## 내용');
    for (const t of topics) out.push(`### ${t.title}`, topicDescription(t), '');
  }
  if (o.includeQuestions !== false && draft.open_questions.length) {
    out.push('## 확인할 점');
    for (const q of draft.open_questions) out.push(`- ${q}`);
    out.push('');
  }
  return out.join('\n').trim();
}
