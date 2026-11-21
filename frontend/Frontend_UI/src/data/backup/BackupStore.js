// 개인 작업 공간을 백업하고 복원합니다(공유 작업 공간은 백업이 아니라 동기화로 복구됩니다).
//   기기에서 암호화(AES-256-GCM, 계정 키는 서버에 보관)한 뒤 서버의 백업 버킷에 업로드합니다.
//   복원 전에 현재 상태를 자동 백업으로 저장한 다음 개인 작업 공간을 교체합니다.
import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { emitRuntime, list, maybeRuntime, readPreference, runtime, saveList, scoped, useValue, writePreference } from '../hooks';
import { supabase } from '../../lib/stella/supabase';
import * as api from '../../lib/stella/backup';

export const MAX_BACKUPS = 10;
const EMPTY = Object.freeze([]);
const EMPTY_OBJECT = Object.freeze({});
const EMPTY_LINKS = Object.freeze({ memos: EMPTY_OBJECT, files: EMPTY_OBJECT });
const PAYLOAD_FORMAT = 1;

const deps = () => ({
  newId: Crypto.randomUUID,
  randomBytes: n => Crypto.getRandomBytes(n),
  // 웹에서는 attachments.ts가 WebCrypto를 사용해 직접 해시를 계산합니다.
  digest: Platform.OS === 'web' ? undefined : bytes => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  deviceName: Platform.OS,
});

// ---------------------------------------------------------------------
// 서버 목록을 화면에서 사용할 동기 스냅샷으로 변환합니다.
// ---------------------------------------------------------------------
let cache = { session: null, order: 'new', raw: EMPTY, rows: EMPTY };
const toRow = b => ({
  id: b.id, createdAt: Date.parse(b.created_at) || 0, auto: !!b.auto,
  counts: { memos: b.counts?.memos ?? 0, tasks: b.counts?.tasks ?? 0, projects: b.counts?.projects ?? 0 },
});

async function load() {
  const { session, order } = cache;
  try {
    const raw = await api.listBackups(supabase, order);
    if (cache.session !== session || cache.order !== order) return;
    cache = { ...cache, raw, rows: Object.freeze(raw.map(toRow)) };
    emitRuntime();
  } catch (error) {
    console.warn('[backup] 백업 목록을 불러오지 못했습니다', error);
  }
}
function snapshot(order) {
  const rt = maybeRuntime();
  if (!rt) return EMPTY;
  if (cache.session !== rt.session.id || cache.order !== order) {
    cache = { session: rt.session.id, order, raw: EMPTY, rows: EMPTY };
    void load();
  }
  return cache.rows;
}
export const useBackups = (order = 'new') => useValue(() => snapshot(order));

// ---------------------------------------------------------------------
// 백업에 포함되는 항목: 로컬 스토어의 개인 기록과 기기 전용 프로젝트 데이터
// ---------------------------------------------------------------------
function personalData(rt) {
  return {
    format: PAYLOAD_FORMAT,
    store: rt.store.exportAll(),
    prefs: {
      projects: list('projects'),
      // ProjectStore/AgendaStore와 동일하게 readPreference는 키마다 처음 본 대체값을 캐시합니다.
      projectLinks: readPreference(scoped('project-links'), EMPTY_LINKS),
      agenda: readPreference(scoped('agenda-snapshots'), EMPTY_OBJECT),
    },
  };
}
function countsOf(rt) {
  const c = rt.store.counts();
  return { memos: c.memos, tasks: c.tasks, projects: list('projects').length };
}
function personalOnly() {
  const rt = runtime();
  return rt.store.getCurrentWorkspace().personal ? rt : null;
}
const failed = error => ({ ok: false, reason: 'failed', message: api.backupErrorMessage(error) });

export async function createBackup(auto = false) {
  const rt = personalOnly();
  if (!rt) return { ok: false, reason: 'not-personal' };
  try {
    const r = await api.createBackup(supabase, {
      data: personalData(rt), counts: countsOf(rt), kind: auto ? 'AUTO' : 'MANUAL', keep: MAX_BACKUPS, deps: deps(),
    });
    await load();
    return { ok: true, dropped: r.removed };
  } catch (error) {
    console.warn('[backup] 백업 실패', error);
    return failed(error);
  }
}

export async function restoreBackup(id) {
  const rt = personalOnly();
  if (!rt) return { ok: false, reason: 'not-personal' };
  const backup = cache.raw.find(b => b.id === id);
  if (!backup) return { ok: false, reason: 'failed', message: '백업을 찾을 수 없어요. 목록을 다시 열어 주세요' };
  try {
    const r = await api.restoreBackup(supabase, {
      backup, currentData: personalData(rt), currentCounts: countsOf(rt), keep: MAX_BACKUPS, deps: deps(),
      apply: data => {
        if (maybeRuntime() !== rt || !rt.store.getCurrentWorkspace().personal) throw new Error('계정이나 공간이 바뀌어서 복원하지 않았어요');
        if (data?.format !== PAYLOAD_FORMAT || !data.store) throw Object.assign(new Error('백업 형식이 다릅니다'), { code: 'BACKUP_CORRUPT' });
        rt.store.importAll(data.store);
        saveList('projects', Array.isArray(data.prefs?.projects) ? data.prefs.projects : []);
        if (data.prefs?.projectLinks) writePreference(scoped('project-links'), data.prefs.projectLinks);
        if (data.prefs?.agenda) writePreference(scoped('agenda-snapshots'), data.prefs.agenda);
      },
    });
    await load();
    return { ok: true, safety: !!r.safety };
  } catch (error) {
    console.warn('[backup] 복원 실패', error);
    return failed(error);
  }
}

export async function deleteBackup(id) {
  try {
    await api.deleteBackup(supabase, id);
    await load();
    return true;
  } catch (error) {
    console.warn('[backup] 삭제 실패', error);
    return false;
  }
}
