// ============================================================
// DateUtils.js — 달력을 그릴 때 필요한 날짜 계산 도구 모음 (음력 변환 포함)
// ============================================================

// 요일 이름. getDay() 가 돌려주는 숫자(0=일요일 ... 6=토요일)를 글자로 바꿀 때 씁니다.
export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
export const WEEKDAYS_LONG = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

// 두 날짜가 "같은 날"인지 비교합니다. (시·분·초는 무시하고 연/월/일만 비교)
export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// 한 달 달력을 "주(일~토) 단위의 표"로 만들어 돌려줍니다.
// 결과 예: [ [null,null,1일,2일,3일,4일,5일], [6일,...,12일], ... ]
//  - 각 줄(주)은 항상 7칸
//  - 그 달에 속하지 않는 빈 칸은 null
export function monthMatrix(year, month) {
  // 그 달 1일이 무슨 요일인지(0~6) → 앞쪽에 빈 칸이 몇 개 필요한지
  const leadingBlanks = new Date(year, month, 1).getDay();
  // 그 달이 며칠까지 있는지. (다음 달 0일 = 이번 달 마지막 날)
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  // 1일 앞의 빈 칸
  for (let i = 0; i < leadingBlanks; i += 1) cells.push(null);
  // 1일 ~ 마지막 날
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(new Date(year, month, d));
  // 마지막 줄이 7칸이 되도록 뒤쪽도 빈 칸으로 채움
  while (cells.length % 7 !== 0) cells.push(null);

  // 7칸씩 잘라서 "주" 단위로 묶기
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ============================================================
// 음력 변환 (양력 → 음력)
// ============================================================
// 기기의 Intl 기능(음력 지원 여부가 기기마다 다름) 대신, 아래 "음력 표"로 직접 계산합니다.
// 그래서 웹/안드로이드/iOS 어디서든 같은 결과가 나옵니다. (지원 범위: 양력 1900-01-31 ~ 2100-12-31)
//
// 표 읽는 법: 숫자 하나 = 음력 1년 (맨 위가 1900년, 한 줄에 8년씩)
//   아래쪽 4비트  : 그 해의 윤달이 몇 월인지 (0 이면 윤달 없음)
//   그 위 12비트  : 1월~12월 각각 큰달(30일)이면 1, 작은달(29일)이면 0
//   맨 위 1비트   : 윤달이 있을 때 그 윤달이 30일이면 1, 29일이면 0
// ※ 표는 ICU 음력 데이터로 만들었고, 1900~2100년 모든 날짜를 대조 검증했습니다.
//   한국천문연구원(공식 음력)과 아주 드물게 하루 차이가 날 수 있습니다.
const LUNAR_START_YEAR = 1900;
const LUNAR_END_YEAR = 2100;
const LUNAR_TABLE = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0,
  0x09ad0, 0x055d2, 0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540,
  0x0d6a0, 0x18da3, 0x095b0, 0x14977, 0x04970, 0x0a4b0, 0x1b0b6, 0x06a50,
  0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, 0x06566, 0x0d4a0,
  0x0ea50, 0x16a95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2,
  0x0a950, 0x0b557, 0x06ca0, 0x0b550, 0x15355, 0x04db0, 0x025b0, 0x18573,
  0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, 0x0aea6, 0x0ab50, 0x04b60, 0x0aae4,
  0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, 0x096d0, 0x04dd5,
  0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x1ad47,
  0x0ab60, 0x09570, 0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58,
  0x05ac0, 0x0ab60, 0x096e5, 0x092e0, 0x0c960, 0x0d954, 0x0d4a0, 0x0da50,
  0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, 0x0a950, 0x0b4a0,
  0x0bca4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x05270, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4f0, 0x05260,
  0x0ea65, 0x0d520, 0x0daa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0,
  0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, 0x0b5a0, 0x056d0, 0x055b2, 0x049b0,
  0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, 0x14b63, 0x09370,
  0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0,
  0x0a6d0, 0x055d4, 0x092d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50,
  0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, 0x0b273, 0x06930, 0x07337, 0x06aa0,
  0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, 0x0e968, 0x0d520,
  0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
];

// 음력 1900년 1월 1일 = 양력 1900년 1월 31일 (계산의 출발점)
const LUNAR_BASE_MS = Date.UTC(1900, 0, 31);
const DAY_MS = 86400000;

// 그 해의 윤달 월(없으면 0)
function leapMonthOf(y) {
  return LUNAR_TABLE[y - LUNAR_START_YEAR] & 15;
}
// 그 해 윤달의 일수(윤달이 없으면 0)
function leapDaysOf(y) {
  if (!leapMonthOf(y)) return 0;
  return LUNAR_TABLE[y - LUNAR_START_YEAR] & 0x10000 ? 30 : 29;
}
// 그 해 m월(윤달 제외)의 일수
function monthDaysOf(y, m) {
  return LUNAR_TABLE[y - LUNAR_START_YEAR] & (0x10000 >> m) ? 30 : 29;
}
// 그 해 전체 일수
function yearDaysOf(y) {
  let sum = leapDaysOf(y);
  for (let m = 1; m <= 12; m += 1) sum += monthDaysOf(y, m);
  return sum;
}

// 양력 Date → 음력 { year, month, day, isLeap }. 지원 범위 밖이면 null.
// 원리: 1900-01-31 로부터 며칠 지났는지(offset)를 구한 뒤, 음력 해 → 달 순서로 일수를 빼 나갑니다.
export function solarToLunar(date) {
  const solarMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  let offset = Math.round((solarMs - LUNAR_BASE_MS) / DAY_MS);
  if (offset < 0) return null;

  // 1) 어느 음력 해인지: 해 길이를 차례로 빼기
  let year = LUNAR_START_YEAR;
  for (; year <= LUNAR_END_YEAR; year += 1) {
    const n = yearDaysOf(year);
    if (offset < n) break;
    offset -= n;
  }
  if (year > LUNAR_END_YEAR) return null;

  // 2) 어느 달인지: 1월부터 달 길이를 빼기. 윤달은 해당 월 바로 뒤에 끼워 넣어 처리
  const leapMonth = leapMonthOf(year);
  let month = 1;
  let isLeap = false;
  for (; month <= 12; month += 1) {
    const n = monthDaysOf(year, month);
    if (offset < n) break; // 이 달(평달)에 속함
    offset -= n;
    if (month === leapMonth) {
      const ln = leapDaysOf(year);
      if (offset < ln) { // 바로 뒤의 윤달에 속함
        isLeap = true;
        break;
      }
      offset -= ln;
    }
  }
  return { year, month, day: offset + 1, isLeap };
}

// 화면에 보여줄 글자로 바꾸기. 예: "음력 9월 24일", 윤달이면 "음력 윤4월 3일". 범위 밖이면 null.
export function formatLunar(date) {
  const l = solarToLunar(date);
  if (!l) return null;
  return `음력 ${l.isLeap ? '윤' : ''}${l.month}월 ${l.day}일`;
}
// ============================================================
// 날짜 글자("2026-10-15") 변환 도구 — 일정/할 일의 날짜를 저장·비교할 때 씁니다
// ============================================================
const pad2 = (n) => String(n).padStart(2, '0');
// Date → "2026-10-15"
export function toKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// "2026-10-15" → Date (그날 0시)
export function fromKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
// n 일 뒤(음수면 앞)의 날짜
export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
// aKey 에서 bKey 까지 며칠인가 (b 가 더 뒤면 양수)
export function diffDays(aKey, bKey) {
  const a = fromKey(aKey);
  const b = fromKey(bKey);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}
