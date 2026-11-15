// 원격 Supabase 사용자 (앱과 같은 방식: supabase-js + 이메일 로그인)
const { createClient } = require('@supabase/supabase-js');
const { toSyncError } = require('../lib/errors.js');

async function remoteUser(url, key, email, password) {
  const c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${email} 로그인 실패: ${error.message}`);

  const rpc = async (name, args) => {
    const { data: out, error: err } = await c.rpc(name, args);
    if (err) throw toSyncError(err);
    return out;
  };
  return {
    email,
    accountId: data.user.id,
    rpc,
    select: async (table, column, value) => {
      const { data: rows, error: err } = await c.from(table).select('*').eq(column, value);
      if (err) throw toSyncError(err);
      return rows;
    },
    transport: () => ({
      push: (ws, operationId, ops, deviceId) =>
        rpc('sync_push', { p_workspace_id: ws, p_operation_id: operationId, p_ops: ops, p_device_id: deviceId ?? undefined }),
      pull: (ws, afterSeq, limit) => rpc('sync_pull', { p_workspace_id: ws, p_after_seq: afterSeq, p_limit: limit ?? 500 }),
      snapshot: (ws) => rpc('sync_snapshot', { p_workspace_id: ws }),
    }),
    client: c,   // Realtime 구독용 (같은 로그인 세션)
    close: async () => { await c.removeAllChannels(); await c.auth.signOut(); },
  };
}

module.exports = { remoteUser };
