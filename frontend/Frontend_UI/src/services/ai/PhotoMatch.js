// ============================================================
// PhotoMatch.js — 방금 찍은 사진이 어울리는 곳 추천 (★ 지금은 규칙 기반 임시)
// ============================================================
// 지금은 "시간이 가까운 것"으로 추천해요:
//   · 최근 3시간 안에 만들거나 고친 메모  (가까울수록 점수 높음)
//   · 지금 진행 중이거나 곧(1시간 안) 시작하는 일정이 속한 프로젝트
// 서버(AI)가 연결되면 이 함수 안쪽만 "사진 내용 + 메모/음성 요약 내용" 비교로 바꾸면 돼요.
//   반환: [ { type:'memo'|'project', id, title, reason, score } ]  (점수 높은 순, 최대 3개)
// ※ 음성 요약(녹음)은 녹음 기능이 만들어지면 후보에 추가할 수 있어요.

import { toKey } from '../../features/calendar/utils/DateUtils';
import { getMemos, memoTitle } from '../../data/memos/MemoStore';
import { getProject, projectOf } from '../../data/projects/ProjectStore';
import { getTasks } from '../../data/tasks/TaskStore';

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

export function recommendTargets(now = new Date()) {
  const out = [];
  const nowMs = now.getTime();

  getMemos().forEach((m) => {
    const ageMin = (nowMs - (m.updatedAt || 0)) / 60000;
    if (ageMin < 0 || ageMin > 180) return;
    out.push({
      type: 'memo',
      id: m.id,
      title: memoTitle(m),
      reason: ageMin < 30 ? '방금 작성·수정한 메모예요' : `${Math.max(1, Math.round(ageMin / 60))}시간 전에 작성·수정한 메모예요`,
      score: 100 - ageMin / 2,
    });
  });

  const today = toKey(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  getTasks().forEach((t) => {
    if (t.date !== today || !t.start || t.status === '완료') return;
    const s = toMin(t.start);
    const e = t.end ? toMin(t.end) : s + 60;
    const running = nowMin >= s && nowMin <= e;
    const soon = nowMin < s && s - nowMin <= 60;
    if (!running && !soon) return;
    const p = projectOf('tasks', t.id);
    if (!p) return;
    out.push({
      type: 'project',
      id: p.id,
      title: (getProject(p.id) || p).title,
      reason: running ? `'${t.title}' 일정이 진행 중이에요` : `'${t.title}' 일정이 곧 시작해요`,
      score: running ? 95 : 80,
    });
  });

  // 같은 대상은 점수가 높은 것 하나만
  const best = new Map();
  out.forEach((c) => {
    const k = `${c.type}:${c.id}`;
    if (!best.has(k) || best.get(k).score < c.score) best.set(k, c);
  });
  return Array.from(best.values()).sort((a, b) => b.score - a.score).slice(0, 3);
}
