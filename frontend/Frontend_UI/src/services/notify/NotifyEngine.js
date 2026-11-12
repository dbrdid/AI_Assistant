// ============================================================
// NotifyEngine.js — "언제 어떤 알림을 보낼지" 계산해서 예약하고, 알림함에 쌓는 부분
// ============================================================
// 만드는 알림 (설정 > 알림 설정 · AI 및 브리핑 설정 값을 따름)
//   · 일정 알림     : 시간이 있는 일정의 [알림] 설정(정시/10분 전/1시간 전/2시간 전/하루 전)만큼 앞서서
//   · 할 일 마감    : 시간이 없는 할 일·프로젝트 마감일의 [알림] 설정. 마감일 아침 9시 기준
//   · 브리핑        : 일간 브리핑(설정한 시각) / 주간 브리핑(설정한 요일·시각)
//   · 방해 금지 시간: 그 시간에 걸리면 끝나는 시각으로 미룸
// 하는 일
//   1) 앞으로 2주 안의 알림을 기기에 예약 (앱을 꺼 둬도 울림)
//   2) 이미 울릴 시각이 지난 알림(최근 하루)을 앱의 알림함에 쌓음
// 데이터(일정·설정)가 바뀌거나 앱을 다시 열 때, 앱이 켜진 동안은 1분마다 다시 계산해요.

import { AppState } from 'react-native';
import { toKey } from '../../features/calendar/utils/DateUtils';
import { ROUTES } from '../../navigation/routes';
import { addNotice, noticesReady } from '../../data/notices/NoticeStore';
import { getSettings, subscribeSettings, WEEKDAY_NAMES } from '../../data/settings/SettingsStore';
import { getProjects, subscribeProjects } from '../../data/projects/ProjectStore';
import { getTasks, subscribeTasks } from '../../data/tasks/TaskStore';
import { cancelAll, ensurePermission, scheduleAll } from './Notify';

const HORIZON_DAYS = 14;
const OFFSET_MIN = { 없음: null, 정시: 0, '10분 전': 10, '1시간 전': 60, '2시간 전': 120, '하루 전': 1440 };

const parseTime = (hhmm, fallback = '09:00') => {
  const [h, m] = String(hhmm || fallback).split(':').map(Number);
  return { h: Number.isFinite(h) ? h : 9, m: Number.isFinite(m) ? m : 0 };
};
const atOf = (dateKey, hhmm) => {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const { h, m } = parseTime(hhmm);
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
};

// 방해 금지 시간에 걸리면 끝나는 시각으로 미룸
function applyDnd(ms, s) {
  if (!s.notify.dndOn) return ms;
  const d = new Date(ms);
  const mins = d.getHours() * 60 + d.getMinutes();
  const a = parseTime(s.notify.dndStart);
  const b = parseTime(s.notify.dndEnd);
  const start = a.h * 60 + a.m;
  const end = b.h * 60 + b.m;
  const inside = start <= end ? mins >= start && mins < end : mins >= start || mins < end;
  if (!inside) return ms;
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate(), b.h, b.m, 0, 0);
  if (start > end && mins >= start) out.setDate(out.getDate() + 1); // 밤 시간대면 다음 날 아침으로
  return out.getTime();
}

// 앞으로(그리고 최근 하루) 보낼 알림 목록
export function planNotifications(now = Date.now()) {
  const s = getSettings();
  const list = [];
  const from = now - 24 * 3600 * 1000;
  const to = now + HORIZON_DAYS * 24 * 3600 * 1000;
  const push = (it) => {
    const at = applyDnd(it.at, s);
    if (at >= from && at <= to) list.push({ ...it, at });
  };

  getTasks().forEach((t) => {
    if (t.status === '완료') return;
    const off = OFFSET_MIN[t.alarm];
    if (off == null) return;
    if (t.start && s.notify.schedule) {
      push({
        key: `sch:${t.id}:${t.date}:${t.start}:${t.alarm}`,
        kind: 'schedule',
        title: t.title,
        body: off === 0 ? `지금 시작해요${t.place ? ` · ${t.place}` : ''}` : `${t.alarm}에 알려드려요 · ${t.start} 시작${t.place ? ` · ${t.place}` : ''}`,
        at: atOf(t.date, t.start) - off * 60000,
        route: ROUTES.TaskEdit,
        params: { taskId: t.id },
      });
    } else if (!t.start && s.notify.due) {
      push({
        key: `due:${t.id}:${t.date}:${t.alarm}`,
        kind: 'due',
        title: t.title,
        body: `마감일 ${t.date.slice(5).replace('-', '/')}${off >= 1440 ? ' (내일)' : ''}`,
        at: atOf(t.date, '09:00') - off * 60000,
        route: ROUTES.TaskEdit,
        params: { taskId: t.id },
      });
    }
  });

  if (s.notify.due) {
    getProjects().forEach((p) => {
      const off = OFFSET_MIN[p.alarm];
      if (off == null || !p.due || p.status === '완료') return;
      push({
        key: `pdue:${p.id}:${p.due}:${p.alarm}`,
        kind: 'due',
        title: `${p.title || '프로젝트'} 마감`,
        body: `프로젝트 마감일 ${p.due.slice(5).replace('-', '/')}`,
        at: atOf(p.due, '09:00') - off * 60000,
        route: ROUTES.ProjectDetail,
        params: { projectId: p.id },
      });
    });
  }

  if (s.notify.briefing) {
    const today = new Date(now);
    for (let i = -1; i <= HORIZON_DAYS; i += 1) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const key = toKey(d);
      if (s.ai.daily.on) {
        push({ key: `brf-d:${key}`, kind: 'brief', title: '오늘의 브리핑', body: '오늘 브리핑이 준비되었어요', at: atOf(key, s.ai.daily.time), route: ROUTES.Briefing });
      }
      // 월요일=0 … 일요일=6 (WEEKDAY_NAMES 순서) ↔ Date.getDay() (일=0)
      const wd = WEEKDAY_NAMES[(d.getDay() + 6) % 7];
      if (s.ai.weekly.on && s.ai.weekly.day === wd) {
        push({ key: `brf-w:${key}`, kind: 'brief', title: '주간 브리핑', body: '이번 주 브리핑이 준비되었어요', at: atOf(key, s.ai.weekly.time), route: ROUTES.Briefing });
      }
    }
  }
  return list.sort((a, b) => a.at - b.at);
}

let started = false;
let timer = null;
let tick = null;
let unsubs = [];
let appSub = null;
let busy = false;

export async function syncNotifications() {
  if (busy) return;
  busy = true;
  try {
    await noticesReady;
    const now = Date.now();
    const plan = planNotifications(now);
    // 1) 이미 울릴 시각이 지난 것 → 알림함에 쌓기
    plan.filter((p) => p.at <= now).forEach((p) => addNotice({ key: p.key, kind: p.kind, title: p.title, body: p.body, at: p.at, route: p.route, params: p.params }));
    // 2) 앞으로의 것 → 기기에 예약
    await scheduleAll(plan.filter((p) => p.at > now).map((p) => ({ key: p.key, title: p.title, body: p.body, at: p.at, data: { route: p.route, params: p.params } })));
  } finally {
    busy = false;
  }
}
const later = () => {
  clearTimeout(timer);
  timer = setTimeout(syncNotifications, 1500);
};

// 로그인 후 앱을 쓰는 동안 켜 두기
export async function startNotifier() {
  if (started) return;
  started = true;
  await ensurePermission();
  unsubs = [subscribeTasks(later), subscribeProjects(later), subscribeSettings(later)];
  tick = setInterval(syncNotifications, 60000);
  appSub = AppState.addEventListener('change', (st) => st === 'active' && syncNotifications());
  syncNotifications();
}
export async function stopNotifier() {
  started = false;
  clearTimeout(timer);
  clearInterval(tick);
  unsubs.forEach((u) => u());
  unsubs = [];
  if (appSub) appSub.remove();
  appSub = null;
  await cancelAll();
}
