// ============================================================
// Network.js — 인터넷 연결 확인 · 오류 종류 구분 · 오프라인 모드
// ============================================================


const PROBE_URL = 'https://clients3.google.com/generate_204';
const PROBE_TIMEOUT = 4000;

let offlineMode = false;
const listeners = new Set();

export async function isOnline() {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), PROBE_TIMEOUT);
  try {
    await fetch(PROBE_URL, { method: 'GET', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    return true; // 응답이 오기만 하면(상태 코드와 상관없이) 인터넷은 되는 것
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function classifyError(e) {
  const msg = String((e && e.message) || e || '').toLowerCase();
  if (e && e.name === 'AbortError') return 'network';
  if (msg.includes('network') || msg.includes('timeout') || msg.includes('timed out') || msg.includes('failed to fetch') || msg.includes('offline')) return 'network';
  return 'server';
}

export const isOfflineMode = () => offlineMode;
export function setOfflineMode(v) {
  offlineMode = !!v;
  listeners.forEach((fn) => fn());
}
export function subscribeOffline(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
