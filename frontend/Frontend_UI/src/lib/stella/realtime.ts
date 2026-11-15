// 공유 공간 실시간 변경 신호 (Supabase Realtime, 비공개 채널)
//
//  서버는 공간에 변경이 생기면 "바뀌었다"는 신호만 보내요. 데이터는 신호에 없고, 앱이 sync_pull로 받아 와요.
//    주제: 'workspace:<공간 id>'
//    'changed' → { workspaceId, lastSeq }  기록 저장, 멤버 참여·역할 변경·내보내기
//    'closed'  → { workspaceId }           공간 삭제
//  그 공간의 ACTIVE 멤버만 구독할 수 있어요(서버 권한). 앱은 이 주제로 신호를 보낼 수 없어요.
//
//  보통은 watchWorkspace 하나만 쓰면 돼요:
//    const stop = watchWorkspace(supabase, ctx, { onPulled: () => 화면새로고침() });
//    ... 공간 화면을 떠날 때 stop()
//  - 신호가 오면 알아서 pullWorkspace로 받아 SQLite에 반영 (여러 신호가 몰려도 한 번에 묶어서 받음)
//  - 연결되거나 다시 연결될 때 바로 한 번, 5초 뒤에 한 번 더 받음 (끊긴 동안 놓친 신호 대비)
//    ※ 한동안 아무도 연결하지 않아 Realtime 서버가 쉬고 있었다면, 첫 연결 뒤 1~2초 동안은
//      "연결됨"이어도 DB 신호가 아직 안 와요(서버가 DB 변경 읽기를 막 시작하는 중). 5초 뒤 받기가 이 틈을 메워요.
//  - 신호는 "빨리 알려주는 장치"일 뿐이에요. 앱이 앞으로 나올 때·당겨서 새로고침할 때도 syncNow를 부르세요.
//
//  이 파일은 react-native를 쓰지 않아서 Node(검증 도구)에서도 그대로 돌아요. client는 앱의 supabase를 넘기세요.
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSyncStatus, pullWorkspace, type PullOutcome, type SyncContext } from './local-sync';

export type WorkspaceSignal =
  | { type: 'changed'; workspaceId: string; lastSeq: number }
  | { type: 'closed'; workspaceId: string };

/** connected: 구독됨(다시 연결 포함) · denied: 권한 없음(멤버 아님·공간 삭제) · error: 연결 문제(자동 재시도) · disconnected: 끊김 */
export type WorkspaceChannelStatus = 'connected' | 'denied' | 'error' | 'disconnected';

export interface SubscribeHandlers {
  onSignal: (signal: WorkspaceSignal) => void;
  onStatus?: (status: WorkspaceChannelStatus, detail?: string) => void;
}

/** 공간 주제 이름 (서버와 같게 소문자) */
export function workspaceTopic(workspaceId: string): string {
  return `workspace:${workspaceId.toLowerCase()}`;
}

const DENIED = /unauthori[sz]ed|permission|not allowed|denied/i;

/**
 * 공간 신호 구독. 반환값을 부르면 구독 해제.
 * 신호만 받고 싶을 때 쓰고, 보통은 watchWorkspace를 쓰세요.
 */
export function subscribeWorkspace(client: SupabaseClient, workspaceId: string, h: SubscribeHandlers): () => void {
  const topic = workspaceTopic(workspaceId);
  let stopped = false;
  let channel: ReturnType<SupabaseClient['channel']> | null = null;

  const start = async () => {
    // 비공개 채널은 로그인 토큰이 있어야 구독됨
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      h.onStatus?.('denied', 'AUTH_REQUIRED: 로그인이 필요합니다');
      return;
    }
    await client.realtime.setAuth(token);
    if (stopped) return;

    channel = client.channel(topic, { config: { private: true } });
    channel
      .on('broadcast', { event: 'changed' }, (msg) => {
        const p = (msg.payload ?? {}) as { workspace_id?: string; last_seq?: number | string };
        const lastSeq = Number(p.last_seq);
        if (!Number.isFinite(lastSeq)) return;
        h.onSignal({ type: 'changed', workspaceId: p.workspace_id ?? workspaceId, lastSeq });
      })
      .on('broadcast', { event: 'closed' }, (msg) => {
        const p = (msg.payload ?? {}) as { workspace_id?: string };
        h.onSignal({ type: 'closed', workspaceId: p.workspace_id ?? workspaceId });
      })
      .subscribe((status, err) => {
        if (stopped) return;
        if (status === 'SUBSCRIBED') h.onStatus?.('connected');
        else if (status === 'CHANNEL_ERROR') {
          const detail = err?.message ?? '';
          h.onStatus?.(DENIED.test(detail) ? 'denied' : 'error', detail);
        } else if (status === 'TIMED_OUT') h.onStatus?.('error', 'TIMED_OUT');
        else if (status === 'CLOSED') h.onStatus?.('disconnected');
      });
  };

  start().catch((e: unknown) => {
    if (!stopped) h.onStatus?.('error', e instanceof Error ? e.message : String(e));
  });

  return () => {
    stopped = true;
    if (channel) void client.removeChannel(channel);
  };
}

export interface WatchOptions {
  /** 신호로 받아 온 뒤 (화면 새로고침용) */
  onPulled?: (outcome: PullOutcome) => void;
  onStatus?: (status: WorkspaceChannelStatus, detail?: string) => void;
  onError?: (error: unknown) => void;
  /** 신호가 몰릴 때 묶는 시간 (기본 150ms) */
  delayMs?: number;
  /** 연결(재연결 포함) 뒤 한 번 더 받기까지 기다리는 시간 (기본 5000ms, 0이면 안 함) */
  catchUpMs?: number;
}

/**
 * 신호를 받으면 자동으로 pullWorkspace → 기기 SQLite에 반영. 반환값을 부르면 멈춤.
 *   - 이미 받은 순번 이하의 신호는 무시
 *   - 공간이 닫히면(CLOSED: 나감·내보내짐·삭제) 스스로 멈춤
 */
export function watchWorkspace(client: SupabaseClient, ctx: SyncContext, opts: WatchOptions = {}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  const catchUpMs = opts.catchUpMs ?? 5000;

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(run, opts.delayMs ?? 150);
  };

  const run = async () => {
    timer = null;
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      const outcome = await pullWorkspace(ctx);
      if (!stopped) opts.onPulled?.(outcome);
      if (outcome.status === 'CLOSED') stop();
    } catch (e) {
      opts.onError?.(e);
    } finally {
      running = false;
      if (again && !stopped) { again = false; schedule(); }
    }
  };

  const unsubscribe = subscribeWorkspace(client, ctx.workspaceId, {
    onSignal: (s) => {
      if (s.type === 'closed') { schedule(); return; }
      getSyncStatus(ctx.db, ctx.workspaceId)
        .then((st) => { if (st.lastSeq === null || st.lastSeq < s.lastSeq) schedule(); })
        .catch(() => schedule());
    },
    onStatus: (status, detail) => {
      opts.onStatus?.(status, detail);
      // 연결(재연결 포함)되면 놓친 것을 받고, 권한이 없으면 받아 보면서 공간을 닫음
      if (status === 'connected' || status === 'denied') schedule();
      // 연결 직후 서버가 DB 신호를 아직 못 읽는 틈 대비: 조금 뒤 한 번 더
      if (status === 'connected' && catchUpMs > 0 && !stopped) {
        if (catchUpTimer) clearTimeout(catchUpTimer);
        catchUpTimer = setTimeout(() => { catchUpTimer = null; schedule(); }, catchUpMs);
      }
    },
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (catchUpTimer) clearTimeout(catchUpTimer);
    unsubscribe();
  }
  return stop;
}
