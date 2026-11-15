// ============================================================
// trash.ts — 공유 공간 휴지통 (#32, 11/15)
//   대상: 메모·할 일·일정·프로젝트·회의·안건·프로젝트 팀원 (서버의 "버전 있는 기록" 7가지)
//   복구: 공간 멤버(편집 가능) 누구나. 팀장이 있는 프로젝트·그 팀원은 팀장·관리자만 (#30)
//   영구 삭제: 공간 관리자(OWNER) 또는 휴지통으로 보낸 사람. 연결(메모↔프로젝트·첨부·즐겨찾기 등)은 같이 지워지고,
//              가리키던 할 일·일정·회의는 남고 연결만 끊김
//   30일이 지나면 서버가 자동으로 영구 삭제 (매일 03:17)
//   쓰기는 전부 local-sync의 saveLocal로 (오프라인에서도 보낼 목록에 쌓임)
// RN 의존 없음
// ============================================================

import type { LocalChange } from './local-sync';
import type { RevisionedEntity } from './types';

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_ENTITIES = ['notes', 'tasks', 'events', 'projects', 'meetings', 'agenda_items', 'project_members'] as const;
export type TrashEntity = (typeof TRASH_ENTITIES)[number];

export interface TrashItem {
  entity: TrashEntity;
  id: string;
  title: string;
  deletedAt: string;
  deletedBy: string | null;
  daysLeft: number;          // 자동 영구 삭제까지 남은 날 (0 = 오늘 밤)
  data: Record<string, unknown>;
}

const DAY = 24 * 60 * 60 * 1000;

/** 자동 영구 삭제까지 남은 날 (올림, 0 이상) */
export function trashDaysLeft(deletedAt: string, now: Date = new Date()): number {
  const left = new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * DAY - now.getTime();
  return Math.max(0, Math.ceil(left / DAY));
}

const titleOf = (entity: TrashEntity, d: Record<string, unknown>): string =>
  String((entity === 'projects' || entity === 'project_members' ? d.name : d.title) ?? '').trim() || '(제목 없음)';

/**
 * 기기 기록(listLocal 결과)에서 휴지통 목록 만들기. 최근에 지운 것부터
 *   rows: { entity: { data }[] } — 예: { notes: await listLocal(db, ws, 'notes', { includeDeleted: true }), tasks: ... }
 *   listLocal은 기본으로 휴지통 기록을 빼고 주므로 includeDeleted: true를 꼭 넣으세요
 */
export function trashItems(
  rows: Partial<Record<TrashEntity, { data: unknown }[]>>,
  now: Date = new Date(),
): TrashItem[] {
  const out: TrashItem[] = [];
  for (const entity of TRASH_ENTITIES) {
    for (const r of rows[entity] ?? []) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      if (!d.deleted_at || !d.id) continue;
      const deletedAt = String(d.deleted_at);
      out.push({
        entity, id: String(d.id), title: titleOf(entity, d), deletedAt,
        deletedBy: (d.deleted_by as string | null) ?? null, daysLeft: trashDaysLeft(deletedAt, now), data: d,
      });
    }
  }
  return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
}

/** 영구 삭제 버튼을 보일지 (서버 규칙과 같음: 관리자 또는 지운 사람. 프로젝트·팀원은 canManageProject도 함께 확인) */
export function canPurge(p: { me: string; myRole: string; item: Pick<TrashItem, 'deletedBy'> }): boolean {
  if (p.myRole === 'OWNER') return true;
  return p.myRole === 'EDITOR' && p.item.deletedBy === p.me;
}

/** 복구 버튼 (멤버면 됨. 프로젝트·팀원은 canManageProject로 따로 확인) */
export function canRestore(myRole: string): boolean {
  return myRole === 'OWNER' || myRole === 'EDITOR';
}

/** saveLocal에 넣을 변경 */
export const trashChanges = {
  remove: (items: { entity: TrashEntity; id: string }[]): LocalChange[] =>
    items.map((i) => ({ kind: 'delete', entity: i.entity as RevisionedEntity, id: i.id })),
  restore: (items: { entity: TrashEntity; id: string }[]): LocalChange[] =>
    items.map((i) => ({ kind: 'restore', entity: i.entity as RevisionedEntity, id: i.id })),
  purge: (items: { entity: TrashEntity; id: string }[]): LocalChange[] =>
    items.map((i) => ({ kind: 'purge', entity: i.entity as RevisionedEntity, id: i.id })),
};

/** 충돌 이유 → 화면 문구 (보낸 뒤 충돌로 돌아온 경우. 정리는 resolveConflict(use_server)) */
export function trashConflictMessage(reason: string | undefined): string {
  switch (reason) {
    case 'PURGE_NOT_ALLOWED': return '영구 삭제는 공간 관리자나 휴지통으로 보낸 사람만 할 수 있어요';
    case 'NOT_PROJECT_LEADER': return '프로젝트 팀장만 할 수 있어요';
    case 'NOT_DELETED': return '다른 사람이 먼저 복구했어요';
    case 'NOT_FOUND': return '이미 영구 삭제된 항목이에요';
    case 'REVISION_MISMATCH': return '다른 사람이 먼저 바꿨어요. 목록을 새로 받아 주세요';
    default: return '처리하지 못했어요. 잠시 뒤 다시 시도해 주세요';
  }
}

/** 화면 안내 문구 ("30일이 지나면 자동으로 영구 삭제돼요" + 남은 날) */
export function trashNoticeText(item: Pick<TrashItem, 'daysLeft'>): string {
  return item.daysLeft === 0 ? '오늘 자동으로 영구 삭제돼요' : `${item.daysLeft}일 뒤 자동으로 영구 삭제돼요`;
}
