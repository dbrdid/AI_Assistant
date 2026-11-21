import { useSyncExternalStore } from 'react';
import { runtime, runtimeSubscribe, readPreference, writePreference } from '../integration/runtime';

export const useValue = getter => useSyncExternalStore(runtimeSubscribe, getter, getter);
export const scoped = name => `${runtime().store.getCurrentWorkspace().id}:${name}`;
const EMPTY = Object.freeze([]);
export const list = name => readPreference(scoped(name), EMPTY);
export function saveList(name, values) { return writePreference(scoped(name), values); }
let lastAccessSet;
let visibleLists = new WeakMap();
export function accessibleRecords(records) {
  const closedSpaces = runtime().closedSpaces;
  if (closedSpaces !== lastAccessSet) {
    lastAccessSet = closedSpaces;
    visibleLists = new WeakMap();
  }
  if (!closedSpaces.size) return records;
  // External store snapshots must retain their identity until the rows or access change.
  if (!visibleLists.has(records)) visibleLists.set(records, records.filter(record => !closedSpaces.has(record.workspaceId)));
  return visibleLists.get(records);
}
export { runtime, runtimeSubscribe, readPreference, writePreference };
export { maybeRuntime, emitRuntime, syncContext } from '../integration/runtime';
