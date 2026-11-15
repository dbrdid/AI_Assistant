"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workspaceTopic = workspaceTopic;
exports.subscribeWorkspace = subscribeWorkspace;
exports.watchWorkspace = watchWorkspace;
const local_sync_1 = require("./local-sync");
/** 공간 주제 이름 (서버와 같게 소문자) */
function workspaceTopic(workspaceId) {
    return `workspace:${workspaceId.toLowerCase()}`;
}
const DENIED = /unauthori[sz]ed|permission|not allowed|denied/i;
/**
 * 공간 신호 구독. 반환값을 부르면 구독 해제.
 * 신호만 받고 싶을 때 쓰고, 보통은 watchWorkspace를 쓰세요.
 */
function subscribeWorkspace(client, workspaceId, h) {
    const topic = workspaceTopic(workspaceId);
    let stopped = false;
    let channel = null;
    const start = async () => {
        // 비공개 채널은 로그인 토큰이 있어야 구독됨
        const { data } = await client.auth.getSession();
        const token = data.session?.access_token;
        if (!token) {
            h.onStatus?.('denied', 'AUTH_REQUIRED: 로그인이 필요합니다');
            return;
        }
        await client.realtime.setAuth(token);
        if (stopped)
            return;
        channel = client.channel(topic, { config: { private: true } });
        channel
            .on('broadcast', { event: 'changed' }, (msg) => {
            const p = (msg.payload ?? {});
            const lastSeq = Number(p.last_seq);
            if (!Number.isFinite(lastSeq))
                return;
            h.onSignal({ type: 'changed', workspaceId: p.workspace_id ?? workspaceId, lastSeq });
        })
            .on('broadcast', { event: 'closed' }, (msg) => {
            const p = (msg.payload ?? {});
            h.onSignal({ type: 'closed', workspaceId: p.workspace_id ?? workspaceId });
        })
            .subscribe((status, err) => {
            if (stopped)
                return;
            if (status === 'SUBSCRIBED')
                h.onStatus?.('connected');
            else if (status === 'CHANNEL_ERROR') {
                const detail = err?.message ?? '';
                h.onStatus?.(DENIED.test(detail) ? 'denied' : 'error', detail);
            }
            else if (status === 'TIMED_OUT')
                h.onStatus?.('error', 'TIMED_OUT');
            else if (status === 'CLOSED')
                h.onStatus?.('disconnected');
        });
    };
    start().catch((e) => {
        if (!stopped)
            h.onStatus?.('error', e instanceof Error ? e.message : String(e));
    });
    return () => {
        stopped = true;
        if (channel)
            void client.removeChannel(channel);
    };
}
/**
 * 신호를 받으면 자동으로 pullWorkspace → 기기 SQLite에 반영. 반환값을 부르면 멈춤.
 *   - 이미 받은 순번 이하의 신호는 무시
 *   - 공간이 닫히면(CLOSED: 나감·내보내짐·삭제) 스스로 멈춤
 */
function watchWorkspace(client, ctx, opts = {}) {
    let stopped = false;
    let timer = null;
    let catchUpTimer = null;
    let running = false;
    let again = false;
    const catchUpMs = opts.catchUpMs ?? 5000;
    const schedule = () => {
        if (stopped || timer)
            return;
        timer = setTimeout(run, opts.delayMs ?? 150);
    };
    const run = async () => {
        timer = null;
        if (stopped)
            return;
        if (running) {
            again = true;
            return;
        }
        running = true;
        try {
            const outcome = await (0, local_sync_1.pullWorkspace)(ctx);
            if (!stopped)
                opts.onPulled?.(outcome);
            if (outcome.status === 'CLOSED')
                stop();
        }
        catch (e) {
            opts.onError?.(e);
        }
        finally {
            running = false;
            if (again && !stopped) {
                again = false;
                schedule();
            }
        }
    };
    const unsubscribe = subscribeWorkspace(client, ctx.workspaceId, {
        onSignal: (s) => {
            if (s.type === 'closed') {
                schedule();
                return;
            }
            (0, local_sync_1.getSyncStatus)(ctx.db, ctx.workspaceId)
                .then((st) => { if (st.lastSeq === null || st.lastSeq < s.lastSeq)
                schedule(); })
                .catch(() => schedule());
        },
        onStatus: (status, detail) => {
            opts.onStatus?.(status, detail);
            // 연결(재연결 포함)되면 놓친 것을 받고, 권한이 없으면 받아 보면서 공간을 닫음
            if (status === 'connected' || status === 'denied')
                schedule();
            // 연결 직후 서버가 DB 신호를 아직 못 읽는 틈 대비: 조금 뒤 한 번 더
            if (status === 'connected' && catchUpMs > 0 && !stopped) {
                if (catchUpTimer)
                    clearTimeout(catchUpTimer);
                catchUpTimer = setTimeout(() => { catchUpTimer = null; schedule(); }, catchUpMs);
            }
        },
    });
    function stop() {
        if (stopped)
            return;
        stopped = true;
        if (timer)
            clearTimeout(timer);
        if (catchUpTimer)
            clearTimeout(catchUpTimer);
        unsubscribe();
    }
    return stop;
}
