// Returns the source's own span. Spacing may differ, but digits never merge and a number never matches inside a longer one.
export function originalEvidence(text, quote) {
  if (typeof text !== 'string' || typeof quote !== 'string') return '';
  const parts = quote.normalize('NFC').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const body = parts.reduce((pattern, part, index) => pattern
    + (index ? (/\d$/.test(parts[index - 1]) && /^\d/.test(part) ? '\\s+' : '\\s*') : '')
    + part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), '');
  const start = /^\d/.test(parts[0]) ? '(?<![\\d][.,]?)' : '';
  const end = /\d$/.test(parts.at(-1)) ? '(?![.,]?\\d)' : '';
  return new RegExp(start + body + end, 'u').exec(text.normalize('NFC'))?.[0] ?? '';
}

// Restores "12 개" to the source's "12개" in model-written fields without touching other wording.
export const sourceSpelling = (text, value) => typeof value !== 'string' ? value
  : value.replace(/\d+\s+[^\s\d]+/gu, part => originalEvidence(text, part) || part);

// Each stated time becomes its possible HH:MM values; a bare "3시" stays ambiguous between 03:00 and 15:00.
export function statedTimes(text) {
  const times = [];
  for (const m of text.matchAll(/(오전|새벽|아침|오후|낮|저녁|밤)?\s*(?:(?<!\d)(\d{1,2})\s*시(?!간|즌|리즈)(?:\s*(반)|\s*(\d{1,2})\s*분)?|(?<![\d:])(\d{1,2}):(\d{2})(?![\d:]))/gu)) {
    const hour = Number(m[2] ?? m[5]), minute = m[3] ? 30 : Number(m[4] ?? m[6] ?? 0);
    if (hour > 24 || minute > 59) continue;
    const format = h => String(h % 24).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    if (hour === 0 || hour > 12) times.push([format(hour)]);
    else if (!m[1]) times.push(m[5]?.length === 2 ? [format(hour)] : [format(hour), format(hour + 12)]);
    else if (/오전|새벽|아침/.test(m[1]) || (m[1] === '밤' && (hour <= 5 || hour === 12))) times.push([format(hour % 12)]);
    else if (m[1] === '낮' && hour >= 10) times.push([format(hour)]);
    else times.push([format(hour % 12 + 12)]);
  }
  return times;
}

// The start to keep, the single time the source states, or null when the source's time cannot be preserved.
export function verifiedStart(start, source) {
  const times = statedTimes(source);
  if (!times.length || /종일/.test(source) || times.some(values => values.includes(start))) return start;
  return times.length === 1 && times[0].length === 1 ? times[0][0] : null;
}

// Warns about, never removes, a time the source does not state; the user decides on the approval card.
export function unstatedTimeWarning({ start, end }, source) {
  if (typeof source !== 'string') return '';
  const stated = new Set(statedTimes(source).flat());
  if (source.includes('정오')) stated.add('12:00');
  if (source.includes('자정')) stated.add('00:00');
  const missing = [...new Set([start, end])].filter(time => time && !stated.has(time));
  return missing.length ? `원문에서 확인되지 않는 시각이에요: ${missing.join(', ')}. 확인하거나 고쳐 주세요` : '';
}

const PERIOD = /오늘|어제|그제|그저께|내일|모레|글피|(?:이번|지난|저번|지지난|다음)\s*(?:주|달|해|분기|학기)|올해|작년|재작년|내년|최근|요즘|\d+\s*(?:년|월|일|주|개월)|\d{4}-\d{2}|\d{1,2}[/.]\d{1,2}|[월화수목금토일]요일|부터|까지|이전|이후|상반기|하반기|주말|평일|일주일|보름|며칠|이달|[한두세네]\s*달|[한두세네]\s*주\s*전/;
const STATUS = /완료|끝|마친|마쳤|남은|남아|밀린|진행|처리|안\s*(?:한|했|된)|못\s*(?:한|했)|해야|예정|다가오/;
const REFERS_BACK = /(?:^|\s)그(?:\s|때)|아까|방금|당시|거기/;
const RECORD_WORD = /파일|자료|기록|문서|메모|일정|할\s*일|회의|첨부/;
const ABSENCE_CLAIM = /없(?:습니다|어요|네요|음|다)|찾(?:을 수 없|지 못)|못 찾/;

// A planner may narrow a search only by what the user said, and may not report a record missing before the search runs.
export function guardPlan(plan, question, history = []) {
  const said = [question, ...(REFERS_BACK.test(question) ? history.filter(turn => turn.role === 'user').map(turn => turn.text) : [])].join('\n');
  const scoped = { ...plan, ...(PERIOD.test(said) ? {} : { date_from: null, date_to: null }), ...(STATUS.test(said) ? {} : { status: 'any' }) };
  if (scoped.intent === 'search' || !RECORD_WORD.test(question) || !ABSENCE_CLAIM.test(scoped.reply ?? '')) return scoped;
  return { ...scoped, intent: 'search', reply: null, types: scoped.types.length || !/파일/.test(question) ? scoped.types : ['file'] };
}

export function locateFile(question, history, keywords, files, types = []) {
  if (!/(파일|자료).{0,10}어디/.test(question) && !(types.length === 1 && types[0] === 'file')) return null;
  const context = [question, ...history.filter(turn => turn.role === 'user').map(turn => turn.text)].join('\n').toLowerCase();
  const terms = keywords.map(term => term.trim().toLowerCase()).filter(term => term && context.includes(term) && !['자료', '파일', '어디', '회의 자료', '그'].includes(term));
  if (!terms.length) return { text: '파일 보관함에서 찾을 파일명이나 회의 이름을 알려 주세요.', sources: [] };
  const hits = files.filter(file => terms.every(term => file.name?.toLowerCase().includes(term))).slice(0, 8);
  return { text: hits.length ? '현재 공간의 기기 파일 보관함에서 찾았습니다.' : '현재 공간의 기기 파일 이름에서 일치하는 항목을 찾지 못했습니다.',
    sources: hits.map(file => ({ id: file.id, type: 'file', route: 'Files', title: file.name })) };
}
