// Backup and restore of the personal workspace (shared workspaces come back through sync, not backups).
//   The device encrypts (AES-256-GCM, account key kept by the server) and uploads to the server's backups bucket.
//   Restore first saves the current state as an automatic backup, then replaces the personal workspace.
import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { emitRuntime, list, maybeRuntime, readPreference, runtime, scoped, useValue } from '../hooks';
import { restorePersonalData } from '../../integration/runtime';
import { supabase } from '../../lib/stella/supabase';
import * as api from '../../lib/stella/backup';
import { exportProjectTablePreferences, prepareProjectTablePreferences } from '../projects/projectTablePreferences.mjs';

export const MAX_BACKUPS = 10;
const EMPTY = Object.freeze([]);
const EMPTY_OBJECT = Object.freeze({});
const EMPTY_LINKS = Object.freeze({ memos: EMPTY_OBJECT, files: EMPTY_OBJECT });
const PAYLOAD_FORMAT = 1;

const deps = () => ({
  newId: Crypto.randomUUID,
  randomBytes: n => Crypto.getRandomBytes(n),
  // Web: attachments.ts hashes with WebCrypto itself
  digest: Platform.OS === 'web' ? undefined : bytes => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  deviceName: Platform.OS,
});

// ---------------------------------------------------------------------
// List (server) → synchronous snapshot for the screen
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
    if (cache.session !== session || cache.order !== order || maybeRuntime()?.session !== session) return;
    cache = { ...cache, raw, rows: Object.freeze(raw.map(toRow)) };
    emitRuntime();
  } catch (error) {
    console.warn('[backup] 백업 목록을 불러오지 못했습니다', error);
  }
}
function snapshot(order) {
  const rt = maybeRuntime();
  if (!rt) return EMPTY;
  if (cache.session !== rt.session || cache.order !== order) {
    cache = { session: rt.session, order, raw: EMPTY, rows: EMPTY };
    void load();
  }
  return cache.rows;
}
export const useBackups = (order = 'new') => useValue(() => snapshot(order));

// ---------------------------------------------------------------------
// What a backup holds: the local store's personal records + device-only project data
// ---------------------------------------------------------------------
function personalData(rt) {
  const projects = list('projects');
  return {
    format: PAYLOAD_FORMAT,
    store: rt.store.exportAll(),
    prefs: {
      projects,
      projectTables: exportProjectTablePreferences(projects, (key, fallback) => readPreference(scoped(key), fallback)),
      // Same fallbacks as ProjectStore/AgendaStore: readPreference caches the first fallback it sees for a key
      projectLinks: readPreference(scoped('project-links'), EMPTY_LINKS),
      agenda: readPreference(scoped('agenda-snapshots'), EMPTY_OBJECT),
    },
  };
}
function countsOf(rt) {
  const c = rt.store.counts();
  return { memos: c.memos, tasks: c.tasks, projects: list('projects').length };
}
function backupContents(data) {
  const { exportedAt, ...records } = data.store;
  return JSON.stringify({ records, prefs: data.prefs });
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
  const backup = cache.session === rt.session ? cache.raw.find(b => b.id === id) : null;
  if (!backup) return { ok: false, reason: 'failed', message: '백업을 찾을 수 없어요. 목록을 다시 열어 주세요' };
  try {
    const currentData = personalData(rt);
    const safetySnapshot = backupContents(currentData);
    const r = await api.restoreBackup(supabase, {
      backup, currentData, currentCounts: countsOf(rt), keep: MAX_BACKUPS, deps: deps(),
      apply: data => {
        if (maybeRuntime() !== rt || !rt.store.getCurrentWorkspace().personal) {
          throw new api.BackupError('RESTORE_CONTEXT_CHANGED', '복원 중 계정이나 공간이 바뀌었어요');
        }
        if (backupContents(personalData(rt)) !== safetySnapshot) {
          throw new api.BackupError('RESTORE_DATA_CHANGED', '복원 중 개인 공간의 기록이 바뀌었어요');
        }
        if (data?.format !== PAYLOAD_FORMAT || !data.store) throw Object.assign(new Error('백업 형식이 다릅니다'), { code: 'BACKUP_CORRUPT' });
        const projects = Array.isArray(data.prefs?.projects) ? data.prefs.projects : [];
        let tablePreferences;
        try {
          tablePreferences = prepareProjectTablePreferences(projects, data.prefs?.projectTables);
        } catch {
          throw Object.assign(new Error('프로젝트 표 백업 형식이 다릅니다'), { code: 'BACKUP_CORRUPT' });
        }
        const preferences = [['projects', projects], ...tablePreferences];
        if (data.prefs?.projectLinks) preferences.push(['project-links', data.prefs.projectLinks]);
        if (data.prefs?.agenda) preferences.push(['agenda-snapshots', data.prefs.agenda]);
        restorePersonalData(data.store, preferences.map(([key, value]) => [scoped(key), value]));
      },
    });
    await load();
    return { ok: true, safety: !!r.safety };
  } catch (error) {
    console.warn('[backup] 복원 실패', error);
    if (maybeRuntime() === rt) await load();
    return failed(error);
  }
}

export async function deleteBackup(id) {
  if (cache.session !== maybeRuntime()?.session || !cache.raw.some(backup => backup.id === id)) return false;
  try {
    await api.deleteBackup(supabase, id);
    await load();
    return true;
  } catch (error) {
    console.warn('[backup] 삭제 실패', error);
    return false;
  }
}
