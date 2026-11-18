import { useSyncExternalStore } from 'react';
import { runtime, runtimeSubscribe, readPreference, writePreference } from '../integration/runtime';

export const useValue = getter => useSyncExternalStore(runtimeSubscribe, getter, getter);
export const scoped = name => `${runtime().store.getCurrentWorkspace().id}:${name}`;
const EMPTY = Object.freeze([]);
export const list = name => readPreference(scoped(name), EMPTY);
export function saveList(name, values) { return writePreference(scoped(name), values); }
export { runtime, runtimeSubscribe, readPreference, writePreference };
export { maybeRuntime, emitRuntime, syncContext } from '../integration/runtime';
