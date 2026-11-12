// ============================================================
// AiExtract.js — 글에서 일정·할 일 후보 찾기 (★ 지금은 "규칙" 방식. AI 서버가 생기면 이 함수만 바꾸면 돼요)
// ============================================================
// extractFromText(text, today=new Date()) → [{ kind:'event'|'task', title, date, start, end, place, assignee, evidence }]
//  - 문장 단위로 보고, "날짜/시간 표현 + 일정·할 일 단서"가 있으면 후보로 만들어요.
//  - evidence(근거)는 후보를 만든 원래 문장이에요.
import { addDays, toKey } from '../../features/calendar/utils/DateUtils';

const EVENT_CUES = ['회의', '미팅', '모임', '만나', '약속', '수업', '시험', '발표', '면접', '세미나', '행사', '진행', '오세요', '모여'];
const TASK_CUES = ['제출', '마감', '준비', '해야', '까지', '끝내', '보내', '신청', '확인해', '작성', '완료'];
const WEEKDAY = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

const p2 = (n) => String(n).padStart(2, '0');

function findDate(s, today) {
  let m = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m) {
    const mo = +m[1], d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    let y = today.getFullYear();
    let cand = new Date(y, mo - 1, d);
    if (cand.getMonth() !== mo - 1) return '';
    if (addDays(cand, 31) < today) cand = new Date(y + 1, mo - 1, d); // 한참 지난 날짜면 내년으로
    return toKey(cand);
  }
  if (/모레/.test(s)) return toKey(addDays(today, 2));
  if (/내일/.test(s)) return toKey(addDays(today, 1));
  if (/오늘/.test(s)) return toKey(today);
  m = s.match(/(다음\s*주|이번\s*주)?\s*([일월화수목금토])요일/);
  if (m) {
    const target = WEEKDAY[m[2]];
    const next = /다음/.test(m[1] || '');
    let diff = (target - today.getDay() + 7) % 7;
    if (next) diff += 7;
    else if (diff === 0 && !/이번/.test(m[1] || '')) diff = 7;
    return toKey(addDays(today, diff));
  }
  return '';
}

function findTime(s) {
  let m = s.match(/(\d{1,2}):(\d{2})/);
  if (m && +m[1] < 24) return `${p2(+m[1])}:${m[2]}`;
  m = s.match(/(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*반)?/);
  if (!m) return '';
  let h = +m[2];
  if (h > 24) return '';
  const min = m[3] ? +m[3] : /시\s*반/.test(m[0]) ? 30 : 0;
  const pm = /오후|저녁|밤/.test(m[1] || '');
  if (pm && h < 12) h += 12;
  if (/오전|아침/.test(m[1] || '') && h === 12) h = 0;
  if (!m[1] && h >= 1 && h <= 6) h += 12; // "3시" 처럼 말하면 보통 오후
  return `${p2(h % 24)}:${p2(min)}`;
}

function findPlace(s) {
  let m = s.match(/(?:장소\s*[:은는]?\s*)([^\s,.]+(?:\s?\d+호)?)/);
  if (m) return m[1];
  m = s.match(/([가-힣A-Za-z0-9]+(?:관|동|실|센터|카페|도서관|강의실)\s?\d*호?)(?:로|에서|에)/);
  if (m) return m[1].trim();
  m = s.match(/([가-힣A-Za-z0-9]+\s?\d+호)/);
  return m ? m[1] : '';
}

const NOUNS = ['회의', '미팅', '모임', '약속', '수업', '시험', '발표', '면접', '면담', '세미나', '행사', '보고서', '과제', '제출', '마감', '준비'];
const STOP = /^(에|에서|까지|부터|쯤|경|에는|도|은|는|이|가|을|를|그리고|그래서|지난번|얘기한|대로|마지막)$/;

function makeTitle(s) {
  const cleaned = s
    .replace(/[“”"']/g, '')
    .replace(/\d{1,2}\s*월\s*\d{1,2}\s*일/g, ' ')
    .replace(/(오전|오후|아침|저녁|밤)?\s*\d{1,2}\s*(시\s*\d{0,2}\s*분?|:\d{2})\s*(쯤|경)?/g, ' ')
    .replace(/(다음\s*주|이번\s*주)?\s*[일월화수목금토]요일|내일|모레|오늘/g, ' ')
    .replace(/(까지|부터|쯤|경)(?=\s|$)/g, ' ')
    .replace(/(?<=[가-힣])(에서|에는|에)(?=\s)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter((w) => !STOP.test(w));
  const i = words.findIndex((w) => NOUNS.some((n) => w.startsWith(n)));
  if (i < 0) return (words.slice(0, 4).join(' ') || '새 일정').slice(0, 30);
  let from = Math.max(0, i - 2);
  let to = i;
  if (/^(제출|마감|준비)/.test(words[i]) === false && words[i + 1] && /^(제출|마감|준비)/.test(words[i + 1])) to = i + 1;
  const title = words.slice(from, to + 1).join(' ').replace(/(을|를|이|가|은|는)\s/g, ' ').replace(/(해야|있어요|합니다).*$/, '').trim();
  return (title || '새 일정').slice(0, 30);
}

export function extractFromText(text, today = new Date()) {
  const out = [];
  const sentences = String(text || '').split(/(?<=[.!?。])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const seen = new Set();
  for (const s of sentences) {
    const date = findDate(s, today);
    const start = findTime(s);
    const isEvent = EVENT_CUES.some((c) => s.includes(c));
    const isTask = TASK_CUES.some((c) => s.includes(c));
    if (!date && !start) {
      const pl = findPlace(s);
      const last = out[out.length - 1];
      if (pl && last && !last.place) last.place = pl;
      continue;
    }
    if (!isEvent && !isTask) continue;
    const kind = isEvent && (start || !isTask) ? 'event' : 'task';
    const item = {
      kind,
      title: makeTitle(s),
      date: date || toKey(today),
      start: kind === 'event' ? start : '',
      end: '',
      place: findPlace(s),
      assignee: '',
      evidence: s.slice(0, 200),
    };
    const k = `${item.kind}|${item.title}|${item.date}|${item.start}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
