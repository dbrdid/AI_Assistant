// 공유 공간 동기화
//
//  [올리기] pushChanges(workspaceId, ops, { operationId })
//    - operationId는 "한 번의 저장 시도"마다 새로 만들고, 실패해서 재전송할 때는 같은 값을 다시 쓰세요.
//      (같은 operationId + 같은 ops면 서버가 처음 결과를 그대로 돌려줘서 중복 저장이 안 됩니다)
//      → 앱의 SQLite 보낼 목록(outbox)에 ops와 operationId를 함께 저장해 두면 됩니다.
//    - ACCEPTED: results[i].revision을 기기 DB에 저장 (다음 수정의 base_revision)
//    - CONFLICT : 아무것도 저장 안 됨. conflicts[i].server(서버 현재 값)를 보여주고 사용자가 고른 뒤 새 operationId로 재시도
//
//  [받기] 처음 공간에 들어갈 때 getSnapshot → as_of_seq 저장
//         이후 pullAll(workspaceId, lastSeq) → 바뀐 것만 받아 기기 DB에 반영, 마지막 seq 저장
//         SNAPSHOT_REQUIRED가 오면 getSnapshot부터 다시
//
//  [멤버] 참여·역할 변경·나가기·내보내기도 pull에 entity='workspace_members'로 옴 (data = MemberChangeData)
//         내가 나갔거나 내보내졌으면 pull/snapshot이 FORBIDDEN → 기기에서 공간을 닫고 목록에서 빼기
//  [권한] auth_epoch가 바뀌면 멤버·역할이 바뀐 것 → listMembers 다시 불러오기
import { MAX_OPS_PER_PUSH } from './ops';
import { SyncError, toSyncError } from './errors';
import { supabase } from './supabase';
import type { Json } from './database.types';
import type { ChangeItem, PullResult, PushReceipt, Snapshot, SyncOp } from './types';
import type { SyncTransport } from './local-sync';

export async function pushChanges(
  workspaceId: string,
  ops: SyncOp[],
  opts: { operationId: string; deviceId?: string | null },
): Promise<PushReceipt> {
  if (ops.length === 0) throw new SyncError('INVALID_REQUEST', 'ops가 비어 있습니다');
  if (ops.length > MAX_OPS_PER_PUSH) {
    throw new SyncError('INVALID_REQUEST', `한 번에 ${MAX_OPS_PER_PUSH}개까지 보낼 수 있습니다 (현재 ${ops.length}개)`);
  }
  const { data, error } = await supabase.rpc('sync_push', {
    p_workspace_id: workspaceId,
    p_operation_id: opts.operationId,
    p_ops: ops as unknown as Json,
    p_device_id: opts.deviceId ?? undefined,
  });
  if (error) throw toSyncError(error);
  return data as unknown as PushReceipt;
}

export async function pullChanges(workspaceId: string, afterSeq: number, limit = 500): Promise<PullResult> {
  const { data, error } = await supabase.rpc('sync_pull', {
    p_workspace_id: workspaceId,
    p_after_seq: afterSeq,
    p_limit: limit,
  });
  if (error) throw toSyncError(error);
  return data as unknown as PullResult;
}

/**
 * afterSeq 이후 변경을 끝까지 받기 (has_more가 false가 될 때까지 반복)
 *   onBatch에서 기기 DB에 반영하고 나서 다음 묶음을 받으므로, 중간에 앱이 꺼져도 마지막 seq부터 이어 받으면 됩니다.
 */
export async function pullAll(
  workspaceId: string,
  afterSeq: number,
  onBatch: (changes: ChangeItem[], nextSeq: number) => Promise<void> | void,
): Promise<{ status: 'OK'; lastSeq: number; authEpoch: number } | { status: 'SNAPSHOT_REQUIRED' }> {
  let seq = afterSeq;
  for (;;) {
    const res = await pullChanges(workspaceId, seq);
    if (res.status === 'SNAPSHOT_REQUIRED') return { status: 'SNAPSHOT_REQUIRED' };
    if (res.changes.length > 0) await onBatch(res.changes, res.next_seq);
    seq = res.next_seq;
    if (!res.has_more) return { status: 'OK', lastSeq: seq, authEpoch: res.auth_epoch };
  }
}

/** 공간 전체 (처음 들어갈 때, 오래 안 열어서 SNAPSHOT_REQUIRED일 때) */
export async function getSnapshot(workspaceId: string): Promise<Snapshot> {
  const { data, error } = await supabase.rpc('sync_snapshot', { p_workspace_id: workspaceId });
  if (error) throw toSyncError(error);
  return data as unknown as Snapshot;
}

/** local-sync.ts(기기 SQLite 동기화)가 쓰는 서버 연결 */
export const supabaseTransport: SyncTransport = {
  push: (workspaceId, operationId, ops, deviceId) => pushChanges(workspaceId, ops, { operationId, deviceId }),
  pull: (workspaceId, afterSeq, limit) => pullChanges(workspaceId, afterSeq, limit),
  snapshot: (workspaceId) => getSnapshot(workspaceId),
};

/** ACCEPTED 결과에서 엔티티 id → 새 revision (기기 DB 갱신용) */
export function revisionsFrom(receipt: PushReceipt): Map<string, number> {
  const map = new Map<string, number>();
  if (receipt.status === 'ACCEPTED') {
    for (const r of receipt.results) if (r.id && r.revision != null) map.set(r.id, r.revision);
  }
  return map;
}
