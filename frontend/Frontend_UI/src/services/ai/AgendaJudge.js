// ============================================================
// AgendaJudge.js — 변경된 안건이 "논의됨 / 미논의" 인지 AI 가 판단 (서버 AI 게이트웨이 /agenda/judge)
// ============================================================
// 회의 자료 = 그날 이 프로젝트에 연결된 회의 메모:
//   제목에 '회의'가 들어간 메모, 또는 녹음을 글자로 바꿔 만든 메모(제목이 '녹음 '으로 시작)
//   그날 만들었거나 고친 것만. 회의 자료 자체는 판단 대상에서 빼요(자기 자신을 근거로 '논의됨'이 되지 않게).
// 회의 자료가 없으면 서버를 부르지 않아요 (이번 달 판단 횟수를 쓰지 않음).
import { toKey } from '../../features/calendar/utils/DateUtils';
import { agendaJudgeErrorMessage, judgeAgendaForDevice } from '../../integration/runtime';

export const isMeetingNote = (memo) => /회의/.test(memo?.title ?? '') || /^녹음\s/.test(memo?.title ?? '');
const onDay = (ms, day) => !!ms && toKey(new Date(ms)) === day;

/** 그날 프로젝트의 회의 메모 (회의 자료) */
export function meetingNotesFor(project, memos, day) {
  const linked = new Set(project?.links?.memos ?? []); // 프로젝트에 연결된 메모 id 목록
  return memos.filter((m) => linked.has(m.id) && isMeetingNote(m) && (onDay(m.createdAt, day) || onDay(m.updatedAt, day)));
}

/**
 * { judged: { [change.key]: 'discussed' | 'open' }, note, meetings }
 *   note: 화면 아래에 보여 줄 안내 (판단하지 않았거나 못 한 이유). 판단했으면 빈 값
 */
export async function judgeDiscussion({ project, day, changes, memos }) {
  const notes = meetingNotesFor(project, memos, day);
  const noteKeys = new Set(notes.map((m) => `memo:${m.id}`));
  const items = changes.filter((c) => !noteKeys.has(c.key));
  if (!notes.length) return { judged: {}, meetings: 0, note: '그날 회의 메모가 없어 논의 여부는 판단하지 않았어요.' };
  if (!items.length) return { judged: {}, meetings: notes.length, note: '' };
  try {
    const r = await judgeAgendaForDevice({
      changes: items,
      discussions: notes.map((m) => ({ id: m.id, kind: /^녹음\s/.test(m.title ?? '') ? 'TRANSCRIPT' : 'MEETING_NOTE', title: m.title ?? '', text: m.body ?? '' })),
      projectTitle: project?.title ?? null,
      date: day,
    });
    return { judged: r.judged, meetings: notes.length, note: '' };
  } catch (e) {
    const code = e?.code ?? '';
    const consent = code === 'CONSENT_REQUIRED' || code === 'TRANSMISSION_DENIED';
    return {
      judged: {}, meetings: notes.length,
      note: consent ? 'AI 설정에서 외부 AI로 보내기를 허용하면 논의 여부를 판단해 드려요.' : agendaJudgeErrorMessage(e),
    };
  }
}
