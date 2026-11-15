import { fail } from './errors.js';

/**
 * 길이 한도. 서버(Supabase) check 제약과 같은 값이라, 기기에서 통과한 값은 서버에서도 통과합니다.
 *   notes.title 200 · tasks/events.title 200 · assignee_name 100 · location 200
 *   workspaces.name 60 · description 120 · notes.strokes 1MiB(서버가 저장하는 모양 기준)
 */
export const LIMITS = Object.freeze({
  id: 200,
  memoTitle: 200,
  body: 100_000,
  strokesBytes: 1_048_576,
  title: 200,
  assignee: 100,
  short: 200,
  label: 50,
  desc: 10_000,
  evidence: 2_000,
  workspaceName: 60,
  workspaceDesc: 120,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = value => typeof value === 'string' && UUID.test(value);

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 허용한 키만 가진 일반 객체인지 */
export function onlyKeys(value, allowed, field = 'input') {
  if (!isPlainObject(value)) fail('invalid_input', field);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('invalid_input', key);
  return value;
}

export function text(value, field, max, { required = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('invalid_input', field);
  return value;
}

export function bool(value, field) {
  if (typeof value !== 'boolean') fail('invalid_input', field);
  return value;
}

/** 조회용 id: 문자열이면 됨 (없는 id는 not_found로 답하기 위해 형식은 보지 않음) */
export function id(value, field = 'id') {
  if (typeof value !== 'string' || !value || value.length > LIMITS.id) fail('invalid_input', field);
  return value;
}

/** 서버로 갈 수 있는 id: UUID만 */
export function uuid(value, field = 'id') {
  if (!isUuid(value)) fail('invalid_input', field);
  return value.toLowerCase();
}

export function optionalUuid(value, field) {
  return value === null || value === undefined || value === '' ? null : uuid(value, field);
}

/** 서로 다른 id 목록 (주어진 순서 유지) */
export function idList(value, field) {
  if (!Array.isArray(value)) fail('invalid_input', field);
  const seen = new Set();
  for (const item of value) {
    id(item, field);
    if (seen.has(item)) fail('invalid_input', field);
    seen.add(item);
  }
  return [...value];
}

/** 실제로 있는 날짜 YYYY-MM-DD (2026-02-30은 거절) */
export function dateKey(value, field = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_input', field);
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (y < 1000 || t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) fail('invalid_input', field);
  return value;
}

export function optionalDateKey(value, field = 'date') {
  return value === '' ? '' : dateKey(value, field);
}

/** ''(시간 없음) 또는 24시간 HH:MM */
export function timeOfDay(value, field) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('invalid_input', field);
  return value;
}

const utf8Length = s => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
};

/**
 * 손글씨 획. 서버 private.valid_note_strokes와 같은 규칙:
 *   획마다 id 1~100자 · c(색) 1~64자 · w(굵기) 0 초과 100 이하 · p(점) 1~10,000개, 점은 [x, y] 숫자 2개
 *   전체 크기는 서버가 저장하는 모양(jsonb 글자: 쉼표·콜론 뒤에 빈칸)으로 1MiB까지
 * JSON 글자로 돌려줍니다.
 */
export function strokesJson(value, field = 'strokes') {
  if (!Array.isArray(value)) fail('invalid_input', field);
  for (const s of value) {
    if (!isPlainObject(s)) fail('invalid_input', field);
    if (typeof s.id !== 'string' || s.id.length < 1 || s.id.length > 100) fail('invalid_input', field);
    if (typeof s.c !== 'string' || s.c.length < 1 || s.c.length > 64) fail('invalid_input', field);
    if (typeof s.w !== 'number' || !Number.isFinite(s.w) || s.w <= 0 || s.w > 100) fail('invalid_input', field);
    if (!Array.isArray(s.p) || s.p.length < 1 || s.p.length > 10_000) fail('invalid_input', field);
    for (const point of s.p) {
      if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) fail('invalid_input', field);
    }
  }
  let json;
  try { json = JSON.stringify(value); } catch { fail('invalid_input', field); }
  if (typeof json !== 'string') fail('invalid_input', field);
  // jsonb::text는 쉼표·콜론마다 빈칸 하나를 더하므로 그만큼 더해서 잰다 (글자 안의 쉼표까지 세어 조금 넉넉히 막음)
  let separators = 0;
  for (let i = 0; i < json.length; i++) if (json[i] === ',' || json[i] === ':') separators++;
  if (utf8Length(json) + separators > LIMITS.strokesBytes) fail('invalid_input', field);
  return json;
}

export function positiveInt(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_input', field);
  return value;
}
