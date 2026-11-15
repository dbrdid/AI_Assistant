// sync_push에 보낼 ops를 만드는 함수 (React Native 의존 없음)
//   - 한 번의 push는 1~100개, 전부 성공하거나 전부 거절 (부분 성공 없음)
//   - ops는 순서대로 적용되므로 "원문 → 원문 버전 → 메모 → 할 일" 처럼 참조 대상이 먼저 오게 보내세요
import type {
  ImmutableEntities, ImmutableEntity, LinkEntities, LinkEntity, RevisionedEntities, RevisionedEntity,
  SourceKind, SyncOp,
} from './types';

export const MAX_OPS_PER_PUSH = 100;

export const op = {
  /** 새로 만들기 (id는 앱이 만든 UUID) */
  create<E extends RevisionedEntity>(entity: E, id: string, data: RevisionedEntities[E]): SyncOp {
    return { entity, op: 'UPSERT', id, data: clean(data) };
  },
  /** 수정: 바꿀 필드만 보내면 됨. baseRevision = 마지막으로 받은 revision */
  update<E extends RevisionedEntity>(entity: E, id: string, baseRevision: number, data: RevisionedEntities[E]): SyncOp {
    return { entity, op: 'UPSERT', id, base_revision: baseRevision, data: clean(data) };
  },
  /** 삭제 (서버에서는 휴지통 처리: deleted_at이 채워짐) */
  remove(entity: RevisionedEntity, id: string, baseRevision: number): SyncOp {
    return { entity, op: 'DELETE', id, base_revision: baseRevision, data: {} };
  },
  /** 휴지통에서 복구 (지금은 메모만). baseRevision = 삭제 후 받은 revision. 내용 수정은 복구 뒤 따로 */
  restore(entity: 'notes', id: string, baseRevision: number): SyncOp {
    return { entity, op: 'RESTORE', id, base_revision: baseRevision, data: {} };
  },
  /** 원문·확정 원문 버전: 만들기만 가능 (수정·삭제 불가) */
  createImmutable<E extends ImmutableEntity>(entity: E, id: string, data: ImmutableEntities[E]): SyncOp {
    return { entity, op: 'UPSERT', id, data: clean(data) };
  },
  /** 연결 (메모↔프로젝트, 프로젝트↔참여자, 메모↔첨부). 이미 연결돼 있으면 unchanged */
  link<E extends LinkEntity>(entity: E, data: LinkEntities[E]): SyncOp {
    return { entity, op: 'UPSERT', data: clean(data) };
  },
  /** 연결 해제 */
  unlink<E extends LinkEntity>(entity: E, data: LinkEntities[E]): SyncOp {
    return { entity, op: 'DELETE', data: clean(data) };
  },
};

/**
 * 원문 + 확정 원문 버전을 한 번에 만드는 ops
 *   예) 녹음 전사문을 사용자가 고쳐서 확정 → sourceOps({ kind:'VOICE', confirmedText, ... })
 *   이후 메모·할 일·일정의 source_version_id에 versionId를 넣으면 "어느 원문에서 나왔는지" 추적됨
 */
export function sourceOps(p: {
  sourceId: string;
  versionId: string;
  kind: SourceKind;
  confirmedText: string;
  originalText?: string | null;   // TEXT면 보통 원문 그대로
  assetId?: string | null;        // 업로드 검증이 끝난 원본 파일 (VOICE·IMAGE·DOCUMENT)
}): SyncOp[] {
  return [
    op.createImmutable('input_sources', p.sourceId, {
      kind: p.kind,
      original_text: p.originalText ?? (p.kind === 'TEXT' ? p.confirmedText : null),
      asset_id: p.assetId ?? null,
    }),
    op.createImmutable('source_text_versions', p.versionId, { source_id: p.sourceId, text: p.confirmedText }),
  ];
}

/** 같은 원문의 수정 확정본(버전 2, 3, ...) */
export function nextSourceVersionOp(p: { sourceId: string; versionId: string; confirmedText: string }): SyncOp {
  return op.createImmutable('source_text_versions', p.versionId, { source_id: p.sourceId, text: p.confirmedText });
}

// undefined 필드는 빼서 보냄 (수정 때 "보낸 필드만 바뀜" 규칙과 맞추기 위해)
function clean<T extends object>(data: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) out[k] = v;
  return out;
}
