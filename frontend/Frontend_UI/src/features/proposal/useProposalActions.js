// ============================================================
// useProposalActions.js — AI 제안을 목록에서 바로 처리하는 동작 (홈 카드 · 제안 목록이 함께 씀)
// ============================================================
//   add      : 바로 추가. 날짜가 없거나 같은 항목이 이미 있으면 확인 화면으로 보냄
//   edit     : 확인 화면에서 고쳐서 추가
//   hold     : 보류 (되돌리기 가능)
//   dismiss  : 무시. 4초 동안 되돌릴 수 있게 실제 처리는 잠시 뒤에 함
//   addAll   : 바로 추가할 수 있는 것만 모두 추가

import { useCallback, useEffect, useRef, useState } from 'react';
import { ROUTES } from '../../navigation/routes';
import { approveProposal, findDuplicate, setProposalStatus } from '../../data/proposals/ProposalStore';
import { findOverlap } from '../../data/tasks/TaskStore';
import { useSnackbar } from '../../shared/components/Snackbar';

const UNDO_MS = 4000;

// 바로 추가하지 않고 확인 화면을 거쳐야 하는 이유 (없으면 null)
export function reviewReason(p) {
  if (p.kind === 'memo') return null;
  if (!p.date) return '날짜를 정해 주세요';
  try {
    const dup = findDuplicate(p);
    if (dup) return `이미 있는 “${dup.title}”와 같아요`;
    const clash = p.start ? findOverlap(p) : null;
    if (clash) return `“${clash.title}”와 시간이 겹쳐요`;
  } catch {
    return '내용을 확인해 주세요';
  }
  return null;
}

const failText = (e) => (e && e.code === 'source_changed' ? '원본 메모가 바뀌었어요. 메모를 다시 분석해 주세요' : '추가하지 못했어요. 확인 화면에서 다시 시도해 주세요');

export function useProposalActions(navigation, snackOptions) {
  const snack = useSnackbar(snackOptions);
  const [hidden, setHidden] = useState(() => new Set()); // 무시를 눌러 잠시 숨긴 제안
  const pending = useRef(new Map()); // id → 무시 확정 타이머

  const commitDismiss = useCallback((id) => {
    clearTimeout(pending.current.get(id));
    pending.current.delete(id);
    try { setProposalStatus(id, 'rejected'); } catch { /* 이미 처리된 제안 */ }
    setHidden((s) => { const n = new Set(s); n.delete(id); return n; });
  }, []);
  // 화면을 떠나면 기다리던 '무시'를 바로 확정
  useEffect(() => () => { for (const id of [...pending.current.keys()]) commitDismiss(id); }, [commitDismiss]);

  const openSaved = (saved) =>
    saved.kind === 'memo' ? navigation.navigate(ROUTES.MemoEdit, { memoId: saved.id }) : navigation.navigate(ROUTES.TaskEdit, { taskId: saved.id });

  const edit = useCallback((p) => navigation.navigate(ROUTES.ProposalConfirm, { id: p.id }), [navigation]);

  const add = (p) => {
    if (reviewReason(p)) return edit(p);
    try {
      const saved = approveProposal(p.id, {});
      snack.show(saved.kind === 'memo' ? `“${p.title}” 메모로 저장했어요` : `“${p.title}”을(를) 추가했어요`, { label: '보기', onPress: () => openSaved(saved) });
    } catch (e) {
      snack.show(failText(e));
    }
  };

  const hold = (p) => {
    try {
      setProposalStatus(p.id, 'hold');
      snack.show('보류했어요', { label: '되돌리기', onPress: () => { try { setProposalStatus(p.id, 'pending'); } catch { /* 이미 처리됨 */ } } });
    } catch (e) {
      snack.show('보류하지 못했어요');
    }
  };

  const dismiss = (p) => {
    setHidden((s) => new Set(s).add(p.id));
    pending.current.set(p.id, setTimeout(() => commitDismiss(p.id), UNDO_MS));
    snack.show('제안을 무시했어요', {
      label: '되돌리기',
      onPress: () => {
        clearTimeout(pending.current.get(p.id));
        pending.current.delete(p.id);
        setHidden((s) => { const n = new Set(s); n.delete(p.id); return n; });
      },
    });
  };

  const addAll = (list) => {
    let added = 0;
    let left = 0;
    for (const p of list) {
      if (reviewReason(p)) { left += 1; continue; }
      try { approveProposal(p.id, {}); added += 1; } catch { left += 1; }
    }
    if (!added) snack.show('바로 추가할 수 있는 제안이 없어요. 하나씩 확인해 주세요');
    else snack.show(left ? `${added}건 추가했어요 · ${left}건은 확인이 필요해요` : `${added}건 모두 추가했어요`);
  };

  return { add, edit, hold, dismiss, addAll, hidden, snack };
}
