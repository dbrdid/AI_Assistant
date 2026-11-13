import { createHash } from 'node:crypto';
import { SERVER_ERRORS } from '../contracts/errors.js';

/**
 * A business error of contracts/errors.js: code is the contract's PT<status>, message the reason, so
 * serverError(error.code, error.message) recognises it exactly as it recognised the PostgreSQL raise.
 */
export class RpcError extends Error {
  constructor(reason) {
    if (!Object.hasOwn(SERVER_ERRORS, reason)) throw new Error(`Unknown contract reason ${reason}`);
    super(reason);
    this.name = 'RpcError';
    this.code = SERVER_ERRORS[reason].sqlstate;
  }
}
export function fail(reason) { throw new RpcError(reason); }

/** A fault that is not a business decision (unknown RPC, missing permission): callers treat it as a server error. */
export class RpcFault extends Error {
  constructor(code, message) { super(message); this.name = 'RpcFault'; this.code = code; }
}

export const MAX_BIGINT = 9223372036854775807n;
export const PAGE_BUDGET = 4194304;
// Trash window (F27), in microseconds: 720 hours.
export const TRASH_RETENTION_US = 720 * 3600 * 1_000_000;

const UUID_INPUT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgreSQL's uuid input syntax: 32 hex digits, an optional hyphen after any group of four, optional braces.
const UUID_LOOSE = /^(\{)?((?:[0-9a-f]{4}-?){7}[0-9a-f]{4})(\})?$/i;

export function isUuid(value) { return typeof value === 'string' && UUID_INPUT.test(value); }
/** PostgreSQL's uuid cast: any accepted spelling to the canonical lowercase form, or null when it is not a uuid. */
export function uuidCast(value) {
  if (typeof value !== 'string') return null;
  const m = UUID_LOOSE.exec(value);
  if (!m || !!m[1] !== !!m[3]) return null;
  const hex = m[2].replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** JSON with object keys sorted at every level: equal values (jsonb equality) give equal text. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}
export function sha256(text) { return createHash('sha256').update(text, 'utf8').digest(); }
export function byteLength(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
/** Characters as PostgreSQL's length() counts them (code points, not UTF-16 units). */
export function charLength(text) { return [...text].length; }

/** Microseconds since the epoch as UTC text with six fractional digits (2026-11-10T01:02:03.456789Z). */
export function utcText(us) {
  if (us === null || us === undefined) return null;
  const ms = Math.floor(us / 1000);
  return `${new Date(ms).toISOString().slice(0, 23)}${String(us - ms * 1000).padStart(3, '0')}Z`;
}

/* ---------- arguments ----------
 * Each RPC declares its parameters as [name, type, default?]. Callers pass named arguments (as PostgREST did) or,
 * in tests, positional ones. A name the RPC does not have, or a required one left out, is a fault (PostgreSQL's
 * 42883: no such function). A value of the wrong JSON type is invalid_request: there is no PostgREST cast layer.
 */
const REQUIRED = Symbol('required');
export const required = REQUIRED;

function parseInteger(value, min, max) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value >= min && value <= max ? value : fail('invalid_request');
  if (typeof value === 'string' && /^-?[0-9]{1,19}$/.test(value)) {
    const n = BigInt(value);
    if (n < BigInt(min) || n > BigInt(max)) fail('invalid_request');
    return Number(n);
  }
  return fail('invalid_request');
}
const TYPES = {
  uuid: value => uuidCast(value) ?? fail('invalid_request'),
  text: value => typeof value === 'string' ? value : fail('invalid_request'),
  boolean: value => typeof value === 'boolean' ? value : fail('invalid_request'),
  integer: value => parseInteger(value, -2147483648, 2147483647),
  // Values beyond 2^53 cannot occur in practice; refusing them keeps every counter an exact JS number.
  bigint: value => parseInteger(value, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  json: value => value,
  // Checked inside the RPC (after the access check), as PostgreSQL did for array shape and null elements.
  'uuid[]': value => Array.isArray(value) ? value : fail('invalid_request'),
};

export function bindArguments(spec, args) {
  const bound = {};
  if (Array.isArray(args)) {
    if (args.length > spec.params.length) throw new RpcFault('42883', `function ${spec.name} does not exist`);
    spec.params.forEach(([name], i) => { if (i < args.length) bound[name] = args[i]; });
  } else if (isPlainObject(args)) {
    for (const key of Object.keys(args)) {
      if (!spec.params.some(([name]) => name === key)) throw new RpcFault('42883', `function ${spec.name} does not exist`);
      bound[key] = args[key];
    }
  } else if (args !== undefined) {
    throw new RpcFault('42883', `function ${spec.name} does not exist`);
  }
  const out = {};
  for (const [name, type, fallback = REQUIRED] of spec.params) {
    if (!Object.hasOwn(bound, name)) {
      if (fallback === REQUIRED) throw new RpcFault('42883', `function ${spec.name} does not exist`);
      out[name] = fallback;
    } else {
      const value = bound[name];
      out[name] = value === null || value === undefined ? null : TYPES[type](value);
    }
  }
  return out;
}

/* ---------- query helpers ---------- */
export function queries(db) {
  const cache = new Map();
  const prepare = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    get: (sql, ...params) => { const row = prepare(sql).get(...params); return row ? { ...row } : undefined; },
    all: (sql, ...params) => prepare(sql).all(...params).map(row => ({ ...row })),
    // Early loop exit closes the SQLite iterator instead of materialising the full result set.
    *iterate(sql, ...params) {
      for (const row of prepare(sql).iterate(...params)) yield { ...row };
    },
    run: (sql, ...params) => prepare(sql).run(...params).changes,
  };
}

/* ---------- access (private.role_rank, acl_rank, folder_rank, document_rank) ---------- */
export function lockWorkspace(ctx, w) {
  // Subject first, so a call without one cannot tell existing workspaces from missing ones.
  if (!ctx.uid) fail('unauthenticated');
  return ctx.q.get('select * from workspaces where id=?', w) ?? fail('forbidden');
}
export function roleRank(ctx, w, uid = ctx.uid) {
  if (!uid || !w) return 0;
  const row = ctx.q.get('select role from members where workspace_id=? and user_id=?', w, uid);
  return row ? { owner: 3, editor: 2, viewer: 1 }[row.role] : 0;
}
export function aclRank(acl, uid) {
  if (acl === null || acl === undefined) return 2;
  const grant = uid ? JSON.parse(acl)[uid] : undefined;
  return grant === 'editor' ? 2 : grant === 'viewer' ? 1 : 0;
}
export function folderRank(ctx, w, f, uid = ctx.uid) {
  let r = Math.min(roleRank(ctx, w, uid), 2);
  const seen = new Set();
  while (f !== null && f !== undefined) {
    if (seen.has(f) || seen.size >= 128) return 0;
    seen.add(f);
    const x = ctx.q.get('select acl,parent_id from folders where workspace_id=? and id=?', w, f);
    if (!x) return 0;
    r = Math.min(r, aclRank(x.acl, uid));
    f = x.parent_id;
  }
  return r;
}
export function documentRank(ctx, w, d, uid = ctx.uid) {
  const x = ctx.q.get('select folder_id,acl from documents where workspace_id=? and id=?', w, d);
  if (!x) return 0;
  return Math.min(folderRank(ctx, w, x.folder_id, uid), aclRank(x.acl, uid));
}
export function requireOwner(ctx, w) { if (roleRank(ctx, w) !== 3) fail('forbidden'); }

/* ---------- audit and signals ---------- */
export function audit(ctx, w, action, target, { anonymous = false } = {}) {
  ctx.q.run(`insert into audit(workspace_id,actor_id,action,target_id,head,access_epoch,recorded_at)
    select id,?,?,?,head,access_epoch,? from workspaces where id=?`, anonymous ? null : ctx.uid, action, target ?? null, ctx.now(), w);
}
const SIGNAL = `insert into user_signals(user_id,workspace_id) values(?,?)
  on conflict(user_id,workspace_id) do update set generation=generation+1`;
/** Signals every member, plus extra (a removed member, an invitee or a cancelled offeree) when it has an account. */
export function signal(ctx, w, extra = null) {
  for (const { user_id } of ctx.q.all('select user_id from members where workspace_id=? order by user_id', w)) ctx.q.run(SIGNAL, user_id, w);
  if (extra && !ctx.q.get('select 1 from members where workspace_id=? and user_id=?', w, extra)
      && ctx.q.get('select 1 from users where id=?', extra)) ctx.q.run(SIGNAL, extra, w);
}

/* ---------- shared validation ---------- */
export function checkLimit(limit) { if (limit === null || limit < 1 || limit > 500) fail('invalid_limit'); }
/** A positive bigint as canonical decimal text (versions, revisions). */
export function isVersionText(value) { return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_BIGINT; }
/** next_id of a keyset page: the last returned id when the extra row shows that more exist. */
export function nextId(rows, limit, key = 'id') { return rows.length > limit ? rows[limit - 1][key] : null; }
