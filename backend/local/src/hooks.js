/**
 * 이 폴더에 React 의존성을 추가하지 않고 스토어에 React 훅을 연결합니다:
 *
 *   import { useSyncExternalStore } from 'react';
 *   export const { useMemos, useTasks, useProposals, useWorkspaces } = createHooks(useSyncExternalStore, store);
 *
 * useWorkspaces는 WorkspaceScreen이 사용하는 형태인 { list, current }를 반환합니다.
 */
export function createHooks(useSyncExternalStore, store) {
  if (typeof useSyncExternalStore !== 'function') throw new TypeError("Pass React's useSyncExternalStore");
  const hook = (subscribe, getSnapshot) => () => useSyncExternalStore(subscribe, getSnapshot);
  return Object.freeze({
    useMemos: hook(store.subscribeMemos, store.getMemos),
    useTrashedMemos: hook(store.subscribeMemos, store.getTrashedMemos),
    useTasks: hook(store.subscribeTasks, store.getTasks),
    useTrashedTasks: hook(store.subscribeTasks, store.getTrashedTasks),
    useProposals: hook(store.subscribeProposals, store.getProposals),
    useWorkspaces: hook(store.subscribeWorkspaces, store.getWorkspaceState),
  });
}
