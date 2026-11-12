// ============================================================
// Holidays.js — 대한민국 공휴일 계산 (캘린더에서 빨간색으로 표시)
// ============================================================

import { addDays, solarToLunar, toKey } from './DateUtils';

// [월, 일, 이름, 대체공휴일 적용 여부]
const FIXED = [
  [1, 1, '신정', false],
  [3, 1, '삼일절', true],
  [5, 5, '어린이날', true],
  [6, 6, '현충일', false],
  [8, 15, '광복절', true],
  [10, 3, '개천절', true],
  [10, 9, '한글날', true],
  [12, 25, '성탄절', true],
];

// 해마다 직접 추가하는 날 (선거일 등)
const EXTRA = {
  '2026-06-03': '지방선거일',
};

const cache = {};

export function getHolidays(year) {
  if (cache[year]) return cache[year];
  const map = {};
  const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
  const put = (d, name) => {
    const k = toKey(d);
    if (map[k]) return;
    map[k] = name;
  };

  const needSub = []; // 대체공휴일이 필요한 것: { after: 이 날짜 다음부터 찾음, name }

  // 1) 양력 고정 공휴일
  FIXED.forEach(([m, d, name, sub]) => {
    const dt = new Date(year, m - 1, d);
    put(dt, name);
    if (sub && isWeekend(dt)) needSub.push({ after: dt, name });
  });
  Object.keys(EXTRA).forEach((k) => {
    if (k.startsWith(`${year}-`)) map[k] = EXTRA[k];
  });

  // 2) 음력 기준 공휴일: 1년의 모든 날을 음력으로 바꿔 보며 찾음
  const blocks = []; // 설날/추석 3일 연휴
  for (let dt = new Date(year, 0, 1); dt.getFullYear() === year; dt = addDays(dt, 1)) {
    const l = solarToLunar(dt);
    if (!l || l.isLeap) continue;
    if (l.month === 1 && l.day === 1) blocks.push({ name: '설날', days: [addDays(dt, -1), dt, addDays(dt, 1)] });
    else if (l.month === 8 && l.day === 15) blocks.push({ name: '추석', days: [addDays(dt, -1), dt, addDays(dt, 1)] });
    else if (l.month === 4 && l.day === 8) {
      put(dt, '부처님오신날');
      if (isWeekend(dt)) needSub.push({ after: dt, name: '부처님오신날' });
    }
  }
  blocks.forEach((b) => {
    // 연휴가 일요일이거나 다른 공휴일과 겹치면 대체공휴일 (put 하기 전에 겹침을 확인)
    const overlap = b.days.some((d) => d.getDay() === 0 || map[toKey(d)]);
    b.days.forEach((d, i) => put(d, i === 1 ? b.name : `${b.name} 연휴`));
    if (overlap) needSub.push({ after: b.days[2], name: b.name });
  });

  // 3) 대체공휴일: 날짜순으로, 다음 "주말도 공휴일도 아닌 날"
  needSub
    .sort((a, b) => a.after - b.after)
    .forEach(({ after, name }) => {
      let d = addDays(after, 1);
      while (isWeekend(d) || map[toKey(d)]) d = addDays(d, 1);
      put(d, `${name} 대체공휴일`);
    });

  cache[year] = map;
  return map;
}
