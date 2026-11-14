import { fail } from './errors.js';

// Length limits are generous upper bounds that keep one row small; the screens set their own, shorter limits.
export const LIMITS = Object.freeze({
  id: 200,
  title: 500,
  body: 100_000,
  strokesJson: 2_000_000,
  short: 200,
  label: 50,
  desc: 10_000,
  evidence: 2_000,
  workspaceName: 100,
  workspaceDesc: 500,
});

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Rejects anything but a plain object whose keys are all in `allowed`. */
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

export function id(value, field = 'id') {
  if (typeof value !== 'string' || !value || value.length > LIMITS.id) fail('invalid_input', field);
  return value;
}

/** A list of distinct ids, in the given order. */
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

/** A calendar date as YYYY-MM-DD that actually exists (2026-02-30 is refused). */
export function dateKey(value, field = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_input', field);
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (y < 1000 || t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) fail('invalid_input', field);
  return value;
}

/** '' (no date) or a valid date. */
export function optionalDateKey(value, field = 'date') {
  return value === '' ? '' : dateKey(value, field);
}

/** '' (no time) or HH:MM on a 24-hour clock. */
export function timeOfDay(value, field) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('invalid_input', field);
  return value;
}

/** Handwriting strokes: an array that survives JSON unchanged in meaning; stored as JSON text. */
export function strokesJson(value, field = 'strokes') {
  if (!Array.isArray(value)) fail('invalid_input', field);
  let json;
  try { json = JSON.stringify(value); } catch { fail('invalid_input', field); }
  if (typeof json !== 'string' || json.length > LIMITS.strokesJson) fail('invalid_input', field);
  return json;
}

export function positiveInt(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_input', field);
  return value;
}
