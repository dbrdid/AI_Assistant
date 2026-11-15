/**
 * React hooks over a store, without importing React here (this folder has no React dependency):
 *
 *   import { useSyncExternalStore } from 'react';
 *   export const { useMemos, useTasks, useProposals, useWorkspaces } = createHooks(useSyncExternalStore, store);
 *
 * useWorkspaces returns { list, current }, the shape WorkspaceScreen reads.
 */
export function createHooks(useSyncExternalStore, store) {
  if (typeof useSyncExternalStore !== 'function') throw new TypeError("Pass React's useSyncExternalStore");
  const hook = (subscribe, getSnapshot) => () => useSyncExternalStore(subscribe, getSnapshot);
  return Object.freeze({
    useMemos: hook(store.subscribeMemos, store.getMemos),
    useTrashedMemos: hook(store.subscribeMemos, store.getTrashedMemos),
    useTasks: hook(store.subscribeTasks, store.getTasks),
    useProposals: hook(store.subscribeProposals, store.getProposals),
    useWorkspaces: hook(store.subscribeWorkspaces, store.getWorkspaceState),
  });
}
