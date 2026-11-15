// 로컬 Postgres 사용자 (supabase/tests의 로컬 DB). 로그인 대신 JWT claims를 직접 넣어 같은 RLS·RPC를 탐
const { toSyncError } = require('../lib/errors.js');

function pgClient() {
  const { Client } = require('pg');
  return new Client({
    host: process.env.PGHOST || '/tmp',
    port: Number(process.env.PGPORT || 54329),
    user: process.env.PGUSER || 'postgres',
    database: process.env.PGDATABASE || 'stella',
  });
}

async function localAdmin() {
  const c = pgClient();
  await c.connect();
  return {
    query: (sql, params) => c.query(sql, params),
    /** auth.users에 넣으면 가입 트리거가 계정·프로필·설정을 만듦 (실제 가입과 같은 경로) */
    async createUser(email, name) {
      const r = await c.query(
        `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('name', $2::text)) returning id`,
        [email, name]);
      return r.rows[0].id;
    },
    /** 서버가 오래된 변경을 정리한 상황 → 이 공간의 커서는 전부 SNAPSHOT_REQUIRED */
    async forceSnapshotRequired(ws) {
      await c.query('update public.workspace_sync_heads set min_retained_seq = last_seq where workspace_id = $1', [ws]);
    },
    close: () => c.end(),
  };
}

async function localUser(accountId, email) {
  const c = pgClient();
  await c.connect();
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: accountId, role: 'authenticated' })]);
  await c.query('set role authenticated');

  const rpc = async (name, args) => {
    const keys = Object.keys(args).filter((k) => args[k] !== undefined);
    const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    // uuid 배열(uuid[] 인자)은 그대로 넘기고, 나머지 객체·배열은 jsonb 문자열로
    const uuidArray = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x));
    const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && !uuidArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
    try {
      return (await c.query(sql, vals)).rows[0].r;
    } catch (e) {
      throw toSyncError({ message: e.message, code: e.code });
    }
  };
  return {
    email,
    accountId,
    rpc,
    select: async (table, column, value) => {
      try {
        return (await c.query(`select * from public.${table} where ${column} = $1`, [value])).rows;
      } catch (e) {
        throw toSyncError({ message: e.message, code: e.code });
      }
    },
    transport: () => ({
      push: (ws, operationId, ops, deviceId) =>
        rpc('sync_push', { p_workspace_id: ws, p_operation_id: operationId, p_ops: ops, p_device_id: deviceId ?? undefined }),
      pull: (ws, afterSeq, limit) => rpc('sync_pull', { p_workspace_id: ws, p_after_seq: afterSeq, p_limit: limit ?? 500 }),
      snapshot: (ws) => rpc('sync_snapshot', { p_workspace_id: ws }),
    }),
    close: () => c.end(),
  };
}

module.exports = { localAdmin, localUser };
