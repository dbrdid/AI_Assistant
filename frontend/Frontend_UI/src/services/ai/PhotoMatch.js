// ============================================================
// PhotoMatch.js — 방금 찍은 사진이 어울리는 곳 추천
// ============================================================


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
