// 오늘 일정의 남은 시간 (Notion 캘린더의 "N분 후 예정 / N분 남음"과 같은 정보, 문구는 우리 말투)
// start, end: 'HH:MM' (없으면 종일), nowMinutes: 자정부터 지난 분. 12시간보다 먼 일정과 끝난 일정은 표시하지 않음.
const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const span = (n) => (n >= 60 ? `${Math.floor(n / 60)}시간${n % 60 ? ` ${n % 60}분` : ''}` : `${n}분`);

export function relativeTime(start, end, nowMinutes) {
  const s = minutes(start);
  if (s === null) return null;
  const e = minutes(end);
  if (nowMinutes < s) return s - nowMinutes <= 12 * 60 ? `${span(s - nowMinutes)} 후` : null;
  if (e !== null && e > s && nowMinutes < e) return `진행 중, ${span(e - nowMinutes)} 남음`;
  if (e === null && nowMinutes - s < 60) return '진행 중';
  return null;
}
