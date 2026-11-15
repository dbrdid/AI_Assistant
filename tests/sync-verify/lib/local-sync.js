"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupLocalSync = setupLocalSync;
exports.saveLocal = saveLocal;
exports.flushOutbox = flushOutbox;
exports.resolveConflict = resolveConflict;
exports.discardOutbox = discardOutbox;
exports.pullWorkspace = pullWorkspace;
exports.resyncWorkspace = resyncWorkspace;
exports.syncNow = syncNow;
exports.listLocal = listLocal;
exports.getLocal = getLocal;
exports.getSyncStatus = getSyncStatus;
exports.listOutbox = listOutbox;
exports.sameValue = sameValue;
exports.mergeText = mergeText;
exports.mergeStrokes = mergeStrokes;
exports.listConflicts = listConflicts;
exports.getSyncAccount = getSyncAccount;
exports.bindSyncAccount = bindSyncAccount;
exports.clearLocalSync = clearLocalSync;
// =====================================================================
// 기기 SQLite 동기화 (공유 공간) — 보낼 목록 · 받은 변경 반영 · 전체 재동기화
//   React Native 의존 없음. 기기 DB(SqlDb)와 서버 호출(SyncTransport)을 넘겨받아 동작합니다.
//     앱:   expoSqliteDb(await SQLite.openDatabaseAsync('stella.db')) + supabaseTransport
//     검증: node:sqlite + pg / supabase-js (stella-sync-verify)
//
//  규칙
//   1) 저장은 먼저 기기에: saveLocal → 보낼 목록에 넣고 화면에는 바로 반영 (오프라인이어도 됨)
//   2) 보내기는 순서대로 하나씩. 한 번 보낸 묶음은 같은 operation_id + 같은 ops로만 다시 보냄
//      → 응답을 못 받고 재전송해도 서버가 처음 결과를 돌려줘서 중복 저장이 안 됨
//   3) 충돌·거절이 나면 그 묶음에서 멈춤 (뒤 묶음이 앞 묶음에 기대는 경우가 있어서)
//      → resolveConflict('keep_mine' | 'use_server') 또는 discardOutbox로 풀기
//   4) 받기·전체 재동기화는 "서버 사본"만 바꿈. 안 보낸 내 수정은 서버 사본 위에 다시 얹어 보여줌
//      → 전체 재동기화를 해도 안 보낸 수정은 지워지지 않음
//   5) revision은 커지는 쪽만 반영 (늦게 도착한 옛 값으로 덮지 않음)
//   6) 받은 데이터와 커서는 같은 트랜잭션에 저장 (중간에 앱이 꺼져도 어긋나지 않음)
//   7) 기기 저장소(backend/local)가 넘기는 묶음은 handoffKey로 한 번만 받음 (넘긴 직후 앱이 꺼져 다시 넘겨도 중복 없음)
//   8) 기기 DB는 한 계정 것. 계정이 바뀌면 bindSyncAccount가 남은 기록·보낼 목록을 지움 (앞사람 수정이 뒷사람 이름으로 안 올라감)
//   9) 충돌은 먼저 스스로 합쳐 봄 (resolveConflict 'merge'): 서로 다른 칸을 고쳤거나, 본문의 다른 줄·다른 획을 고쳤으면 둘 다 살림
//      같은 칸·같은 줄을 양쪽에서 고친 경우만 사용자에게 물음 ('keep_mine' | 'use_server' | 'keep_both')
// =====================================================================
const errors_1 = require("./errors");
// ---------------------------------------------------------------------
// 기기 DB 테이블
// ---------------------------------------------------------------------
async function setupLocalSync(db) {
    await db.exec(`
    create table if not exists stella_sync_state (
      workspace_id text primary key,
      last_seq     integer not null default 0,     -- 여기까지 받음 (다음 pull의 after_seq)
      auth_epoch   integer not null default 0,
      status       text    not null default 'ACTIVE',  -- ACTIVE | CLOSED
      updated_at   text    not null
    );
    create table if not exists stella_records (
      workspace_id    text not null,
      entity          text not null,
      key             text not null,               -- id, 연결은 "{a}:{b}", 멤버는 account_id
      server_revision integer,                     -- 마지막으로 받은 서버 revision
      server_data     text,                        -- 마지막으로 받은 서버 행(JSON). 서버에 없으면 null
      local_data      text,                        -- 안 보낸 내 수정을 얹은 행(JSON). 보낼 게 없으면 null
      local_removed   integer not null default 0,  -- 안 보낸 연결 해제
      pending         integer not null default 0,  -- 이 기록을 건드린 보낼 묶음 수
      conflict        integer not null default 0,
      primary key (workspace_id, entity, key)
    );
    create table if not exists stella_outbox (
      seq          integer primary key autoincrement,  -- 보낼 순서
      workspace_id text not null,
      operation_id text not null unique,
      intent       text not null,                   -- LocalChange[] (JSON)
      ops          text,                            -- 처음 보낼 때 고정한 SyncOp[] (재전송은 이 값 그대로)
      status       text not null default 'PENDING', -- PENDING | CONFLICT | FAILED
      attempts     integer not null default 0,
      last_error   text,
      conflicts    text,
      created_at   text not null,
      base         text                             -- ops를 고정할 때 서버 사본에 있던 값 (내가 바꾼 칸만). 충돌 때 합치는 기준
    );
    create index if not exists stella_outbox_ws on stella_outbox (workspace_id, seq);
    create table if not exists stella_handoffs (
      key          text primary key,                -- 기기 저장소가 넘긴 묶음의 표시 (saveLocal의 handoffKey)
      operation_id text not null,
      created_at   text not null
    );
    create table if not exists stella_sync_meta (
      key   text primary key,                       -- 'account' = 이 기기 DB를 쓰는 계정
      value text not null
    );
  `);
    // 이전 버전으로 만든 기기 DB에는 base 칸이 없음
    const cols = await db.all('pragma table_info(stella_outbox)');
    if (!cols.some((c) => c.name === 'base'))
        await db.exec('alter table stella_outbox add column base text');
}
const LINK_FIELDS = {
    note_projects: ['note_id', 'project_id'],
    project_participants: ['project_id', 'account_id'],
    note_attachments: ['note_id', 'asset_id'],
    project_files: ['project_id', 'asset_id'],
};
function changeKey(c) {
    if (c.kind === 'link' || c.kind === 'unlink') {
        const [a, b] = LINK_FIELDS[c.entity];
        return `${String(c.data[a])}:${String(c.data[b])}`;
    }
    return c.id;
}
const tag = (entity, key) => `${entity}|${key}`;
const nowOf = (ctx) => (ctx.now ?? (() => new Date().toISOString()))();
function newIdOf(ctx) {
    if (ctx.newId)
        return ctx.newId();
    const c = globalThis.crypto;
    if (c?.randomUUID)
        return c.randomUUID();
    throw new errors_1.SyncError('INVALID_REQUEST', 'newId를 넘겨주세요 (예: expo-crypto의 randomUUID)');
}
const parse = (s) => (s == null ? null : JSON.parse(s));
// 같은 기기 DB의 트랜잭션은 한 줄로, 같은 공간의 보내기·받기도 한 줄로
const queues = new Map();
function serial(key, fn) {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    queues.set(key, next.catch(() => undefined));
    return next;
}
const tx = (db, fn) => serial(db, () => db.transaction(fn));
const syncLock = (ctx, fn) => serial(`sync|${ctx.workspaceId}`, fn);
async function loadOutbox(db, ws) {
    return db.all('select * from stella_outbox where workspace_id = ? order by seq', [ws]);
}
function touched(rows) {
    const out = new Map();
    for (const r of rows) {
        for (const c of JSON.parse(r.intent)) {
            const key = changeKey(c);
            out.set(tag(c.entity, key), { entity: c.entity, key });
        }
    }
    return out;
}
/** 서버 사본 저장. revision이 있으면 커지는 쪽만 반영 */
async function putServer(db, ws, entity, key, revision, data) {
    const cur = await db.get('select * from stella_records where workspace_id = ? and entity = ? and key = ?', [ws, entity, key]);
    if (cur && cur.server_revision != null && revision != null && cur.server_revision > revision)
        return;
    await db.run(`insert into stella_records (workspace_id, entity, key, server_revision, server_data)
     values (?, ?, ?, ?, ?)
     on conflict (workspace_id, entity, key) do update set server_revision = excluded.server_revision, server_data = excluded.server_data`, [ws, entity, key, revision, data == null ? null : JSON.stringify(data)]);
}
/** 서버 사본 + 아직 안 보낸 수정(보낼 목록 순서대로) → 화면에 보일 값 */
async function rebuild(db, ws, entity, key, outbox) {
    const cur = await db.get('select * from stella_records where workspace_id = ? and entity = ? and key = ?', [ws, entity, key]);
    let data = parse(cur?.server_data ?? null);
    let removed = false;
    let pending = 0;
    let conflict = false;
    for (const r of outbox) {
        let hit = false;
        for (const c of JSON.parse(r.intent)) {
            if (c.entity !== entity || changeKey(c) !== key)
                continue;
            hit = true;
            switch (c.kind) {
                case 'create':
                    data = { ...(data ?? {}), ...c.data, id: c.id };
                    removed = false;
                    break;
                case 'update':
                    data = { ...(data ?? { id: c.id }), ...c.data };
                    break;
                case 'delete':
                    data = { ...(data ?? { id: c.id }), deleted_at: data?.deleted_at ?? r.created_at };
                    break;
                case 'restore':
                    data = { ...(data ?? { id: c.id }), deleted_at: null, deleted_by: null };
                    break;
                case 'purge':
                    data = null;
                    removed = true;
                    break;
                case 'link':
                    data = { ...c.data };
                    removed = false;
                    break;
                case 'unlink':
                    data = null;
                    removed = true;
                    break;
            }
        }
        if (hit) {
            pending++;
            if (r.status === 'CONFLICT')
                conflict = true;
        }
    }
    if (pending === 0) {
        if (!cur)
            return;
        if (cur.server_data == null) {
            await db.run('delete from stella_records where workspace_id = ? and entity = ? and key = ?', [ws, entity, key]);
            return;
        }
        await db.run(`update stella_records set local_data = null, local_removed = 0, pending = 0, conflict = 0
        where workspace_id = ? and entity = ? and key = ?`, [ws, entity, key]);
        return;
    }
    await db.run(`insert into stella_records (workspace_id, entity, key, local_data, local_removed, pending, conflict)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict (workspace_id, entity, key) do update set
       local_data = excluded.local_data, local_removed = excluded.local_removed,
       pending = excluded.pending, conflict = excluded.conflict`, [ws, entity, key, data == null ? null : JSON.stringify(data), removed ? 1 : 0, pending, conflict ? 1 : 0]);
}
async function rebuildAll(db, ws, keys, outbox) {
    const ob = outbox ?? (await loadOutbox(db, ws));
    for (const k of keys)
        await rebuild(db, ws, k.entity, k.key, ob);
}
async function setState(db, ws, lastSeq, authEpoch, status, at) {
    await db.run(`insert into stella_sync_state (workspace_id, last_seq, auth_epoch, status, updated_at) values (?, ?, ?, ?, ?)
     on conflict (workspace_id) do update set last_seq = excluded.last_seq, auth_epoch = excluded.auth_epoch,
       status = excluded.status, updated_at = excluded.updated_at`, [ws, lastSeq, authEpoch, status, at]);
}
// 서버가 거절한 것(다시 보내도 같은 결과) — 그 외(네트워크·로그인 만료·서버 일시 오류)는 나중에 같은 요청으로 재전송
const REJECTED = new Set([
    'FORBIDDEN', 'INVALID_REQUEST', 'OPERATION_ID_REUSED', 'NOT_FOUND', 'REFERENCE_NOT_FOUND',
    'CHECK_FAILED', 'REQUIRED_FIELD', 'INVALID_FORMAT', 'DUPLICATE',
]);
function asSyncError(e) {
    if (e instanceof errors_1.SyncError)
        return e;
    return new errors_1.SyncError('NETWORK', e instanceof Error ? e.message : String(e));
}
// ---------------------------------------------------------------------
// 1. 기기에 저장 (보낼 목록에 넣기)
// ---------------------------------------------------------------------
/** 사용자의 수정 묶음을 기기에 저장하고 보낼 목록에 넣음. 반환 = operation_id */
/** 넘겨받은 묶음 표시는 이만큼 지나면 지움 (다시 넘어올 수 있는 건 넘긴 직후 앱이 꺼졌을 때뿐) */
const HANDOFF_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 저장 1번 = 보낼 묶음 1개. 돌려주는 값은 operation_id.
 * handoffKey: 다른 저장소(backend/local의 보낼 목록)에서 넘겨받는 묶음의 고유 표시.
 *   같은 표시로 다시 부르면 아무것도 더하지 않고 처음의 operation_id를 돌려줌 → "넘김 → 앱 꺼짐 → 다시 넘김"에도 한 번만 저장
 */
async function saveLocal(ctx, changes, opts = {}) {
    if (changes.length === 0 || changes.length > 100) {
        throw new errors_1.SyncError('INVALID_REQUEST', '한 번에 1~100개까지 저장할 수 있습니다');
    }
    const seen = new Set();
    for (const c of changes) {
        const t = tag(c.entity, changeKey(c));
        if (seen.has(t))
            throw new errors_1.SyncError('INVALID_REQUEST', `같은 대상을 한 묶음에 두 번 넣을 수 없습니다 (${t})`);
        seen.add(t);
    }
    const key = opts.handoffKey;
    if (key !== undefined && (typeof key !== 'string' || !key || key.length > 200)) {
        throw new errors_1.SyncError('INVALID_REQUEST', 'handoffKey는 1~200자 문자열');
    }
    let operationId = newIdOf(ctx);
    const ws = ctx.workspaceId;
    await tx(ctx.db, async () => {
        const at = nowOf(ctx);
        if (key !== undefined) {
            const done = await ctx.db.get('select operation_id from stella_handoffs where key = ?', [key]);
            if (done) {
                operationId = done.operation_id;
                return;
            } // 이미 받은 묶음
            await ctx.db.run('insert into stella_handoffs (key, operation_id, created_at) values (?, ?, ?)', [key, operationId, at]);
            const t = Date.parse(at);
            if (Number.isFinite(t)) {
                await ctx.db.run('delete from stella_handoffs where created_at < ?', [new Date(t - HANDOFF_KEEP_MS).toISOString()]);
            }
        }
        await ctx.db.run('insert into stella_outbox (workspace_id, operation_id, intent, created_at) values (?, ?, ?, ?)', [ws, operationId, JSON.stringify(changes), at]);
        await rebuildAll(ctx.db, ws, changes.map((c) => ({ entity: c.entity, key: changeKey(c) })));
    });
    return operationId;
}
// ---------------------------------------------------------------------
// 2. 보내기
// ---------------------------------------------------------------------
async function buildOps(db, ws, intent) {
    const ops = [];
    const base = {}; // 수정 op의 index → 그때 서버 사본에 있던 값 (내가 바꾼 칸만)
    for (const c of intent) {
        if (c.kind === 'link' || c.kind === 'unlink') {
            ops.push({ entity: c.entity, op: c.kind === 'link' ? 'UPSERT' : 'DELETE', data: c.data });
            continue;
        }
        if (c.kind === 'create') {
            ops.push({ entity: c.entity, op: 'UPSERT', id: c.id, data: c.data });
            continue;
        }
        const rec = await db.get('select server_revision, server_data from stella_records where workspace_id = ? and entity = ? and key = ?', [ws, c.entity, c.id]);
        const rev = rec?.server_revision;
        if (rev == null)
            throw new errors_1.SyncError('NOT_FOUND', `서버에 없는 기록은 수정·삭제할 수 없습니다 (${c.entity} ${c.id})`);
        if (c.kind === 'update') {
            const server = parse(rec?.server_data ?? null) ?? {};
            const was = {};
            for (const f of Object.keys(c.data))
                was[f] = server[f] ?? null;
            base[ops.length] = was;
        }
        ops.push(c.kind === 'update'
            ? { entity: c.entity, op: 'UPSERT', id: c.id, base_revision: rev, data: c.data }
            : { entity: c.entity, op: c.kind === 'restore' ? 'RESTORE' : c.kind === 'purge' ? 'PURGE' : 'DELETE', id: c.id, base_revision: rev, data: {} });
    }
    return { ops, base };
}
/** 보낸 결과(ACCEPTED)를 서버 사본에 임시 반영 (정확한 행은 다음 pull로 옴) */
async function applyAccepted(db, ws, ops, results, at) {
    for (const r of results) {
        const o = ops[r.index];
        if (!o || r.entity === 'agenda_transitions')
            continue;
        if (r.key) { // 연결
            await putServer(db, ws, o.entity, r.key, null, o.op === 'DELETE' ? null : (o.data ?? {}));
            continue;
        }
        if (!r.id)
            continue;
        if (r.purged) {
            await putServer(db, ws, o.entity, r.id, null, null);
            continue;
        } // 영구 삭제: 서버 사본도 지움
        const cur = await db.get('select * from stella_records where workspace_id = ? and entity = ? and key = ?', [ws, o.entity, r.id]);
        const prev = parse(cur?.server_data ?? null) ?? {};
        const next = { ...prev, ...(o.data ?? {}), id: r.id };
        if (r.revision != null)
            next.revision = r.revision;
        if (r.version != null)
            next.version = r.version;
        if (r.deleted)
            next.deleted_at = prev.deleted_at ?? at;
        else if (o.op === 'RESTORE') {
            next.deleted_at = null;
            next.deleted_by = null;
        }
        await putServer(db, ws, o.entity, r.id, r.revision ?? null, next);
    }
}
async function flushInner(ctx) {
    const { db, transport, workspaceId: ws } = ctx;
    let sent = 0;
    for (;;) {
        const row = await db.get('select * from stella_outbox where workspace_id = ? order by seq limit 1', [ws]);
        if (!row)
            return { status: 'DONE', sent };
        if (row.status === 'CONFLICT') {
            return { status: 'CONFLICT', sent, outboxSeq: row.seq, conflicts: JSON.parse(row.conflicts ?? '[]') };
        }
        if (row.status === 'FAILED') {
            return { status: 'BLOCKED', sent, outboxSeq: row.seq, code: (row.last_error ?? '').split(':')[0], error: row.last_error ?? '' };
        }
        // 처음 보낼 때 ops를 만들어 고정 (보내기 "전에" 저장 → 응답을 못 받아도 재전송은 같은 내용)
        let ops;
        if (row.ops) {
            ops = JSON.parse(row.ops);
        }
        else {
            try {
                const built = await buildOps(db, ws, JSON.parse(row.intent));
                ops = built.ops;
                row.base = JSON.stringify(built.base);
            }
            catch (e) {
                const err = asSyncError(e);
                await db.run(`update stella_outbox set status = 'FAILED', last_error = ? where seq = ?`, [`${err.code}: ${err.message}`, row.seq]);
                return { status: 'BLOCKED', sent, outboxSeq: row.seq, code: err.code, error: err.message };
            }
            await db.run('update stella_outbox set ops = ?, base = ? where seq = ?', [JSON.stringify(ops), row.base ?? null, row.seq]);
        }
        let receipt;
        try {
            receipt = await transport.push(ws, row.operation_id, ops, ctx.deviceId ?? null);
        }
        catch (e) {
            const err = asSyncError(e);
            if (REJECTED.has(err.code)) {
                await tx(db, async () => {
                    await db.run(`update stella_outbox set status = 'FAILED', attempts = attempts + 1, last_error = ? where seq = ?`, [`${err.code}: ${err.message}`, row.seq]);
                    await rebuildAll(db, ws, touched([row]).values());
                });
                return { status: 'BLOCKED', sent, outboxSeq: row.seq, code: err.code, error: err.message };
            }
            await db.run('update stella_outbox set attempts = attempts + 1, last_error = ? where seq = ?', [`${err.code}: ${err.message}`, row.seq]);
            return { status: 'OFFLINE', sent, error: err.message, code: err.code, attempts: row.attempts + 1 };
        }
        if (receipt.status === 'ACCEPTED') {
            await tx(db, async () => {
                await applyAccepted(db, ws, ops, receipt.results, nowOf(ctx));
                await db.run('delete from stella_outbox where seq = ?', [row.seq]);
                await rebuildAll(db, ws, touched([row]).values());
            });
            sent++;
            continue;
        }
        // CONFLICT: 서버 현재 값을 서버 사본에 넣고, 내 수정은 그대로 둔 채 멈춤
        const conflicts = receipt.conflicts;
        await tx(db, async () => {
            await db.run(`update stella_outbox set status = 'CONFLICT', conflicts = ?, attempts = attempts + 1 where seq = ?`, [JSON.stringify(conflicts), row.seq]);
            for (const c of conflicts) {
                if (c.server) {
                    const rev = typeof c.server.revision === 'number' ? c.server.revision : null;
                    await putServer(db, ws, c.entity, c.id, rev, c.server);
                }
            }
            await rebuildAll(db, ws, touched([row]).values());
        });
        return { status: 'CONFLICT', sent, outboxSeq: row.seq, conflicts };
    }
}
/** 보낼 목록을 순서대로 보냄. 충돌·거절·오프라인이면 그 자리에서 멈춤 */
function flushOutbox(ctx) {
    return syncLock(ctx, () => flushInner(ctx));
}
/**
 * 충돌 해결
 *   keep_mine : 서버 최신 값 위에 내가 바꾼 필드만 다시 적용해서 새 요청으로 보냄 (다음 flush 때)
 *   use_server: 내 수정을 버리고 서버 값으로
 *   이미 휴지통에 간 기록(DELETED)·없는 기록(NOT_FOUND)은 keep_mine 불가 → use_server
 *   복구(restore): 아직 휴지통에 있으면 keep_mine으로 다시 복구, 이미 복구됐으면(NOT_DELETED) use_server
 */
async function resolveConflict(ctx, outboxSeq, choice) {
    const { db, workspaceId: ws } = ctx;
    await syncLock(ctx, () => tx(db, async () => {
        const row = await db.get('select * from stella_outbox where seq = ? and workspace_id = ?', [outboxSeq, ws]);
        if (!row || row.status !== 'CONFLICT')
            throw new errors_1.SyncError('NOT_FOUND', '충돌 상태인 보낼 묶음이 없습니다');
        if (choice === 'use_server') {
            await db.run('delete from stella_outbox where seq = ?', [row.seq]);
        }
        else {
            const conflicts = JSON.parse(row.conflicts ?? '[]');
            let intent = JSON.parse(row.intent); // ops와 순서가 같음
            const blocked = conflicts.find((c) => {
                if (c.reason !== 'REVISION_MISMATCH')
                    return true;
                const restoring = intent[c.index]?.kind === 'restore' || intent[c.index]?.kind === 'purge';
                return restoring ? !c.server?.deleted_at : Boolean(c.server?.deleted_at);
            });
            if (blocked) {
                const why = blocked.reason === 'REVISION_MISMATCH'
                    ? (blocked.server?.deleted_at ? '이미 휴지통에 있는 기록' : '다른 기기에서 이미 복구된 기록')
                    : blocked.reason;
                throw new errors_1.SyncError('CANNOT_KEEP', `${why}: 이 충돌은 서버 값을 써야 합니다 (use_server)`);
            }
            if (choice === 'merge' || choice === 'keep_both') {
                const merged = mergeIntent(intent, conflicts, parseBase(row.base), choice === 'keep_both');
                if (merged.unresolved.length) {
                    throw new errors_1.SyncError('CANNOT_MERGE', `같은 칸을 양쪽에서 고쳤어요 (${merged.unresolved.map((u) => `${u.entity}.${u.field}`).join(', ')}): 고를 수 있는 것은 keep_mine·use_server·keep_both`, { fields: merged.unresolved });
                }
                intent = merged.intent;
            }
            await db.run(`update stella_outbox set status = 'PENDING', intent = ?, ops = null, base = null, conflicts = null, attempts = 0, last_error = null,
                operation_id = ? where seq = ?`, [JSON.stringify(intent), newIdOf(ctx), row.seq]);
        }
        await rebuildAll(db, ws, touched([row]).values());
    }));
}
/** 보낼 묶음 버리기 (거절된 묶음 정리, 사용자가 수정 취소) */
async function discardOutbox(ctx, outboxSeq) {
    const { db, workspaceId: ws } = ctx;
    await syncLock(ctx, () => tx(db, async () => {
        const row = await db.get('select * from stella_outbox where seq = ? and workspace_id = ?', [outboxSeq, ws]);
        if (!row)
            return;
        await db.run('delete from stella_outbox where seq = ?', [row.seq]);
        await rebuildAll(db, ws, touched([row]).values());
    }));
}
// ---------------------------------------------------------------------
// 3. 받기 · 전체 재동기화
// ---------------------------------------------------------------------
async function applyChange(db, ws, ch, me) {
    if (ch.entity === 'workspace_members') {
        await putServer(db, ws, 'workspace_members', ch.key, null, ch.data);
        return !!me && ch.key === me && ch.data?.status !== 'ACTIVE';
    }
    if (ch.op === 'DELETE')
        await putServer(db, ws, ch.entity, ch.key, null, null); // 연결 해제
    else
        await putServer(db, ws, ch.entity, ch.key, ch.revision, ch.data);
    return false;
}
const SNAPSHOT_TABLES = [
    'projects', 'project_members', 'project_invites', 'project_participants', 'input_sources', 'source_text_versions', 'notes', 'note_projects',
    'note_attachments', 'project_files', 'assets', 'tasks', 'events', 'meetings', 'agenda_items', 'agenda_transitions',
];
function snapshotKey(entity, row) {
    const f = LINK_FIELDS[entity];
    return f ? `${String(row[f[0]])}:${String(row[f[1]])}` : String(row.id);
}
async function closeWorkspace(ctx) {
    const st = await getState(ctx.db, ctx.workspaceId);
    await setState(ctx.db, ctx.workspaceId, st?.last_seq ?? 0, st?.auth_epoch ?? 0, 'CLOSED', nowOf(ctx));
}
async function resyncInner(ctx) {
    const { db, transport, workspaceId: ws } = ctx;
    let snap;
    try {
        snap = await transport.snapshot(ws);
    }
    catch (e) {
        const err = asSyncError(e);
        if (err.code === 'FORBIDDEN') {
            await closeWorkspace(ctx);
            return { status: 'CLOSED' };
        }
        if (!REJECTED.has(err.code))
            return { status: 'OFFLINE', error: err.message, code: err.code };
        throw err;
    }
    await tx(db, async () => {
        const outbox = await loadOutbox(db, ws);
        // 서버 사본을 통째로 바꿈. 안 보낸 수정은 보낼 목록에 그대로 있으니 아래에서 다시 얹음
        await db.run('delete from stella_records where workspace_id = ?', [ws]);
        for (const entity of SNAPSHOT_TABLES) {
            for (const row of (snap[entity] ?? [])) {
                const rev = typeof row.revision === 'number' ? row.revision : null;
                await putServer(db, ws, entity, snapshotKey(entity, row), rev, row);
            }
        }
        for (const m of snap.members) {
            await putServer(db, ws, 'workspace_members', m.account_id, null, { workspace_id: ws, ...m });
        }
        await rebuildAll(db, ws, touched(outbox).values(), outbox);
        await setState(db, ws, snap.as_of_seq, snap.auth_epoch, 'ACTIVE', nowOf(ctx));
    });
    return { status: 'RESYNCED', lastSeq: snap.as_of_seq };
}
async function pullInner(ctx, limit) {
    const { db, transport, workspaceId: ws } = ctx;
    const st = await getState(db, ws);
    if (!st)
        return resyncInner(ctx); // 처음 들어온 공간
    if (st.status === 'CLOSED')
        return { status: 'CLOSED' };
    let seq = st.last_seq;
    let applied = 0;
    for (;;) {
        let res;
        try {
            res = await transport.pull(ws, seq, limit);
        }
        catch (e) {
            const err = asSyncError(e);
            if (err.code === 'FORBIDDEN') {
                await closeWorkspace(ctx);
                return { status: 'CLOSED' };
            }
            if (!REJECTED.has(err.code))
                return applied > 0 ? { status: 'OK', applied, lastSeq: seq } : { status: 'OFFLINE', error: err.message, code: err.code };
            throw err;
        }
        if (res.status === 'SNAPSHOT_REQUIRED')
            return resyncInner(ctx);
        const ok = res;
        let closed = false;
        await tx(db, async () => {
            const outbox = await loadOutbox(db, ws);
            const pend = touched(outbox);
            for (const ch of ok.changes) {
                if (await applyChange(db, ws, ch, ctx.myAccountId))
                    closed = true;
                await rebuild(db, ws, ch.entity, ch.key, pend.has(tag(ch.entity, ch.key)) ? outbox : []);
            }
            await setState(db, ws, ok.next_seq, ok.auth_epoch, closed ? 'CLOSED' : 'ACTIVE', nowOf(ctx)); // 데이터와 커서를 함께
        });
        applied += ok.changes.length;
        seq = ok.next_seq;
        if (closed)
            return { status: 'CLOSED' };
        if (!ok.has_more)
            return { status: 'OK', applied, lastSeq: seq };
    }
}
/** 바뀐 것 받기. 처음이거나 커서가 오래됐으면 자동으로 전체 재동기화 */
function pullWorkspace(ctx, opts = {}) {
    return syncLock(ctx, () => pullInner(ctx, opts.limit ?? 500));
}
/** 전체 다시 받기 (안 보낸 수정은 유지) */
function resyncWorkspace(ctx) {
    return syncLock(ctx, () => resyncInner(ctx));
}
/** 보내고 받기 한 번에 (앱 켤 때, 당겨서 새로고침, 네트워크가 돌아왔을 때) */
function syncNow(ctx, opts = {}) {
    return syncLock(ctx, async () => {
        const flush = await flushInner(ctx);
        // 보내기가 막혀도(충돌·거절) 받기는 시도: 다른 사람 변경을 보여주고, 내가 공간에서 빠졌는지도 확인
        const pull = await pullInner(ctx, opts.limit ?? 500);
        return { flush, pull };
    });
}
// ---------------------------------------------------------------------
// 4. 화면용 읽기
// ---------------------------------------------------------------------
function toLocal(r) {
    if (r.pending > 0) {
        if (r.local_removed || r.local_data == null)
            return null;
        return { entity: r.entity, key: r.key, data: JSON.parse(r.local_data), pending: true, conflict: !!r.conflict, serverRevision: r.server_revision };
    }
    if (r.server_data == null)
        return null;
    return { entity: r.entity, key: r.key, data: JSON.parse(r.server_data), pending: false, conflict: false, serverRevision: r.server_revision };
}
/** 화면에 보일 기록 목록 (안 보낸 내 수정 포함). 휴지통은 includeDeleted로 */
async function listLocal(db, workspaceId, entity, opts = {}) {
    const rows = await db.all('select * from stella_records where workspace_id = ? and entity = ? order by key', [workspaceId, entity]);
    const out = [];
    for (const r of rows) {
        const v = toLocal(r);
        if (!v)
            continue;
        if (!opts.includeDeleted && v.data.deleted_at)
            continue;
        out.push(v);
    }
    return out;
}
async function getLocal(db, workspaceId, entity, key) {
    const r = await db.get('select * from stella_records where workspace_id = ? and entity = ? and key = ?', [workspaceId, entity, key]);
    return r ? toLocal(r) : null;
}
async function getState(db, ws) {
    return db.get('select last_seq, auth_epoch, status, updated_at from stella_sync_state where workspace_id = ?', [ws]);
}
/** 동기화 상태 (배지·배너용) */
async function getSyncStatus(db, workspaceId) {
    const st = await getState(db, workspaceId);
    const c = await db.get(`select count(*) as pending,
            coalesce(sum(case when status = 'CONFLICT' then 1 else 0 end), 0) as conflict,
            coalesce(sum(case when status = 'FAILED' then 1 else 0 end), 0) as failed
       from stella_outbox where workspace_id = ?`, [workspaceId]);
    const head = await db.get('select last_error, attempts from stella_outbox where workspace_id = ? order by seq limit 1', [workspaceId]);
    return {
        lastSeq: st?.last_seq ?? null,
        authEpoch: st?.auth_epoch ?? null,
        state: st?.status ?? 'NEW',
        pending: Number(c?.pending ?? 0), // 아직 안 보낸 묶음
        conflicts: Number(c?.conflict ?? 0), // 사용자 선택이 필요한 묶음
        failed: Number(c?.failed ?? 0), // 서버가 거절한 묶음
        lastError: head?.last_error ?? null, // 맨 앞 묶음의 마지막 오류 "CODE: 설명" (없으면 null)
        attempts: Number(head?.attempts ?? 0), // 맨 앞 묶음을 보낸 횟수 (계속 실패하면 커짐)
    };
}
/** 보낼 목록 (충돌 화면 등에서 사용) */
async function listOutbox(db, workspaceId) {
    const rows = await loadOutbox(db, workspaceId);
    return rows.map((r) => ({
        seq: r.seq,
        operationId: r.operation_id,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        changes: JSON.parse(r.intent),
        conflicts: r.conflicts ? JSON.parse(r.conflicts) : [],
        createdAt: r.created_at,
    }));
}
// ---------------------------------------------------------------------
// 4-1. 충돌 합치기
// ---------------------------------------------------------------------
/** 여러 줄 글 칸: 줄 단위로 합침 (그 밖의 글 칸은 한 줄이라 통째로 비교) */
const MULTILINE_FIELDS = new Set(['body', 'description']);
/** 줄 비교표 크기 한도. 넘으면 바뀐 부분 전체를 한 덩어리로 봄 (결과는 맞고, 덜 잘게 합칠 뿐) */
const DIFF_CELLS = 4_000_000;
/** 값 비교 (객체 키 순서 무시: 서버 jsonb는 키 순서를 바꿈) */
function sameValue(a, b) {
    if (a === b)
        return true;
    if (a == null || b == null)
        return a == null && b == null;
    if (typeof a !== 'object' || typeof b !== 'object')
        return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
            return false;
        return a.every((v, i) => sameValue(v, b[i]));
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && sameValue(a[k], b[k]));
}
/** base → other의 바뀐 구간들 (앞에서부터, 서로 떨어져 있음) */
function lineEdits(base, other) {
    let head = 0;
    while (head < base.length && head < other.length && base[head] === other[head])
        head++;
    let tail = 0;
    while (tail < base.length - head && tail < other.length - head && base[base.length - 1 - tail] === other[other.length - 1 - tail])
        tail++;
    const a = base.slice(head, base.length - tail), b = other.slice(head, other.length - tail);
    if (a.length === 0 && b.length === 0)
        return [];
    if (a.length === 0 || b.length === 0 || a.length * b.length > DIFF_CELLS)
        return [{ s: head, e: head + a.length, lines: b }];
    // 가장 긴 공통 줄 (뒤에서부터 채움)
    const w = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
        }
    }
    const edits = [];
    let i = 0, j = 0, cur = null;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            cur = null;
            i++;
            j++;
            continue;
        }
        if (!cur) {
            cur = { s: head + i, e: head + i, lines: [] };
            edits.push(cur);
        }
        if (j < b.length && (i === a.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j]))
            cur.lines.push(b[j++]);
        else {
            i++;
            cur.e = head + i;
        }
    }
    return edits;
}
/**
 * 글 세 갈래 합치기 (줄 단위). base에서 mine·theirs가 각각 고친 것을 합침.
 *   서로 다른 줄을 고쳤으면 둘 다 반영 (바로 옆줄이어도). 같은 자리에 둘 다 새 줄만 넣었으면 내 줄 다음에 상대 줄 (잃는 글 없음).
 *   같은 줄을 다르게 고쳤으면 clean = false. union이면 그 구간을 "내 것, 그다음 상대 것"으로 둘 다 넣음.
 */
function mergeText(base, mine, theirs, union = false) {
    if (mine === theirs)
        return { text: mine, clean: true };
    if (base === theirs)
        return { text: mine, clean: true };
    if (base === mine)
        return { text: theirs, clean: true };
    const o = base.split('\n');
    const a = lineEdits(o, mine.split('\n')), b = lineEdits(o, theirs.split('\n'));
    const out = [];
    let pos = 0, i = 0, j = 0, clean = true;
    const version = (edits, s, e) => {
        const lines = [];
        let p = s;
        for (const ed of edits) {
            lines.push(...o.slice(p, ed.s), ...ed.lines);
            p = ed.e;
        }
        lines.push(...o.slice(p, e));
        return lines;
    };
    const sameLines = (m, t) => m.length === t.length && m.every((l, k) => l === t[k]);
    while (i < a.length || j < b.length) {
        const x = a[i], y = b[j];
        if (x && y && x.s === x.e && y.s === y.e && x.s === y.s && sameLines(x.lines, y.lines)) { // 같은 자리에 같은 줄을 넣음: 한 번만
            out.push(...o.slice(pos, x.s), ...x.lines);
            pos = x.e;
            i++;
            j++;
            continue;
        }
        if (!(x && y && x.s < y.e && y.s < x.e)) {
            // 고친 줄이 겹치지 않음: 앞선 것부터. 같은 자리면 새 줄만 넣은 쪽 먼저, 둘 다 새 줄만 넣었으면 내 것 다음에 상대 것
            const mineFirst = !y || (x && (x.s < y.s || (x.s === y.s && x.e <= y.e)));
            const ed = mineFirst ? x : y;
            out.push(...o.slice(pos, ed.s), ...ed.lines);
            pos = ed.e;
            if (mineFirst)
                i++;
            else
                j++;
            continue;
        }
        // 같은 줄을 양쪽에서 고침: 이어지는 구간을 한 덩어리로
        let s = Math.min(x.s, y.s), e = Math.max(x.e, y.e);
        const mineGroup = [], theirGroup = [];
        for (;;) {
            if (i < a.length && (a[i].s < e || mineGroup.length === 0)) {
                s = Math.min(s, a[i].s);
                e = Math.max(e, a[i].e);
                mineGroup.push(a[i++]);
                continue;
            }
            if (j < b.length && (b[j].s < e || theirGroup.length === 0)) {
                s = Math.min(s, b[j].s);
                e = Math.max(e, b[j].e);
                theirGroup.push(b[j++]);
                continue;
            }
            break;
        }
        const m = version(mineGroup, s, e), t = version(theirGroup, s, e);
        out.push(...o.slice(pos, s));
        if (sameLines(m, t))
            out.push(...m); // 둘이 똑같이 고침
        else if (union)
            out.push(...m, ...t); // 둘 다 남기기: 내 것 다음에 상대 것
        else {
            clean = false;
            out.push(...m);
        }
        pos = e;
    }
    out.push(...o.slice(pos));
    return { text: out.join('\n'), clean };
}
/** 손글씨 합치기 (획 id 기준): 상대가 둔 순서에 내가 지운 획은 빼고, 내가 고친 획은 내 것으로, 내가 새로 그린 획은 뒤에 붙임 */
function mergeStrokes(base, mine, theirs) {
    const list = (v) => (Array.isArray(v) ? v : []);
    const byId = (v) => new Map(v.map((s) => [String(s.id), s]));
    const o = byId(list(base)), m = byId(list(mine)), t = byId(list(theirs));
    const out = [];
    for (const s of list(theirs)) {
        const id = String(s.id);
        if (o.has(id) && !m.has(id))
            continue; // 내가 지움
        const my = m.get(id);
        out.push(my && o.has(id) && sameValue(o.get(id), s) && !sameValue(my, s) ? my : s); // 나만 고친 획은 내 것
    }
    for (const s of list(mine))
        if (!t.has(String(s.id)) && !o.has(String(s.id)))
            out.push(s); // 내가 새로 그림
    return out;
}
function parseBase(text) {
    return text ? JSON.parse(text) : null;
}
/** 수정 1건의 칸별 합치기. unresolved = 양쪽이 다르게 고쳐서 스스로 못 합친 칸 */
function mergeFields(was, mine, server, union) {
    const data = {};
    const unresolved = [];
    for (const f of Object.keys(mine)) {
        const m = mine[f], t = server[f] ?? null;
        const known = was != null && f in was;
        const o = known ? was[f] : undefined;
        if (sameValue(m, t) || (known && sameValue(o, t))) {
            data[f] = m;
            continue;
        } // 상대는 이 칸을 안 고침
        if (known && sameValue(o, m)) {
            data[f] = t;
            continue;
        }
        if (f === 'strokes' && Array.isArray(m) && Array.isArray(t)) {
            data[f] = mergeStrokes(known ? o : [], m, t);
            continue;
        }
        if (MULTILINE_FIELDS.has(f) && typeof m === 'string' && typeof t === 'string' && (!known || typeof o === 'string' || o == null)) {
            if (!known) { // 기준을 모름: 둘 다 남기는 것만 가능
                if (union) {
                    data[f] = `${m}\n${t}`;
                    continue;
                }
                unresolved.push(f);
                continue;
            }
            const r = mergeText(typeof o === 'string' ? o : '', m, t, union);
            if (r.clean || union) {
                data[f] = r.text;
                continue;
            }
            unresolved.push(f);
            continue;
        }
        if (union) {
            data[f] = m;
            continue;
        } // 한 줄 칸·숫자·날짜: 둘 다 둘 수 없어 내 값
        unresolved.push(f);
    }
    return { data, unresolved };
}
function mergeIntent(intent, conflicts, base, union) {
    const next = intent.slice();
    const unresolved = [];
    for (const c of conflicts) {
        const ch = intent[c.index];
        if (!ch || ch.kind !== 'update' || !c.server)
            continue; // 삭제·복구 충돌은 위에서 걸렀고, 남은 것은 그대로 다시 보냄
        const r = mergeFields(base?.[c.index] ?? null, ch.data, c.server, union);
        for (const field of r.unresolved)
            unresolved.push({ entity: c.entity, id: c.id, field });
        next[c.index] = { ...ch, data: r.data };
    }
    return { intent: next, unresolved };
}
/** 충돌 화면용: 멈춘 묶음마다 어떤 기록의 어떤 칸이 어떻게 다른지 (fields = 양쪽이 다르게 고쳐서 사용자가 골라야 하는 칸) */
async function listConflicts(db, workspaceId) {
    const rows = (await loadOutbox(db, workspaceId)).filter((r) => r.status === 'CONFLICT');
    return rows.map((row) => {
        const intent = JSON.parse(row.intent);
        const conflicts = JSON.parse(row.conflicts ?? '[]');
        const base = parseBase(row.base);
        let canKeep = true;
        const items = conflicts.map((c) => {
            const ch = intent[c.index];
            const serverDeleted = Boolean(c.server?.deleted_at);
            const restoring = ch?.kind === 'restore' || ch?.kind === 'purge';
            if (c.reason !== 'REVISION_MISMATCH' || (restoring ? !serverDeleted : serverDeleted))
                canKeep = false;
            const fields = [];
            if (ch?.kind === 'update' && c.server) {
                const was = base?.[c.index] ?? null;
                for (const field of mergeFields(was, ch.data, c.server, false).unresolved) {
                    fields.push({ field, base: was && field in was ? was[field] : undefined, mine: ch.data[field], server: c.server[field] ?? null });
                }
            }
            return { entity: c.entity, id: c.id, kind: (ch?.kind ?? 'update'), reason: c.reason, serverDeleted, fields };
        });
        return { outboxSeq: row.seq, mergeable: canKeep && items.every((it) => it.fields.length === 0), canKeep, items };
    });
}
// ---------------------------------------------------------------------
// 5. 계정 (기기 DB는 한 계정 것)
// ---------------------------------------------------------------------
const SYNC_TABLES = ['stella_outbox', 'stella_records', 'stella_sync_state', 'stella_handoffs'];
async function wipe(db) {
    const n = await db.get('select count(*) as n from stella_outbox');
    for (const t of SYNC_TABLES)
        await db.run(`delete from ${t}`);
    return Number(n?.n ?? 0);
}
/** 이 기기 DB에 묶인 계정 (없으면 null) */
async function getSyncAccount(db) {
    const r = await db.get(`select value from stella_sync_meta where key = 'account'`);
    return r?.value ?? null;
}
/**
 * 로그인 직후(첫 동기화 전에) 부르세요. 이 기기 DB를 쓰는 계정을 적어 둡니다.
 *   같은 계정 → 그대로. 다른 계정 → 앞 계정의 공유 공간 기록·보낼 목록을 모두 지우고 새 계정으로.
 *   droppedOutbox = 지워진 안 보낸 묶음 수 (앞 계정이 못 보낸 수정. 다른 계정 이름으로 올리지 않으려고 버림)
 * 동기화가 도는 중에는 부르지 마세요 (backend/local의 다리는 첫 동기화 전에 한 번 부릅니다).
 */
async function bindSyncAccount(db, accountId) {
    if (typeof accountId !== 'string' || !accountId)
        throw new errors_1.SyncError('INVALID_REQUEST', 'accountId가 필요합니다');
    return tx(db, async () => {
        const bound = await getSyncAccount(db);
        if (bound === accountId)
            return { cleared: false, droppedOutbox: 0 };
        const droppedOutbox = bound === null ? 0 : await wipe(db);
        await db.run(`insert into stella_sync_meta (key, value) values ('account', ?) on conflict (key) do update set value = excluded.value`, [accountId]);
        return { cleared: bound !== null, droppedOutbox };
    });
}
/** 로그아웃·탈퇴: 기기에 남은 공유 공간 기록·보낼 목록·계정 표시를 모두 지움. 안 보낸 묶음 수를 돌려줌 (먼저 getSyncStatus로 알려 주세요) */
async function clearLocalSync(db) {
    return tx(db, async () => {
        const droppedOutbox = await wipe(db);
        await db.run(`delete from stella_sync_meta where key = 'account'`);
        return { droppedOutbox };
    });
}
