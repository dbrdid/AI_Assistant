import { runtime, useValue } from '../hooks';
export const useProposals = () => useValue(() => runtime().store.getProposals());
export const pendingOf = items => items.filter(p => p.status === 'pending' || p.status === 'hold');
export const getProposal = id => runtime().store.getProposal(id);
export const findDuplicate = fields => runtime().store.findDuplicate(fields);
export const approveProposal = (...args) => runtime().store.approveProposal(...args);
export const setProposalStatus = (...args) => runtime().store.setProposalStatus(...args);
export function addProposals(items) {
  if (items.some(p => p.sourceType === 'memo' && !Number.isSafeInteger(p.sourceRevision))) throw new Error('요청 당시 메모 버전이 필요합니다');
  return runtime().store.addProposals(items);
}
