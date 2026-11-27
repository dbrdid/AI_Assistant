import { createStellaDocumentStore, prepareDocumentTables } from '../../../../backend/local/src/stella-documents.js';
import { LOCAL_PREVIEW } from './mode';
import { createDocumentWorkspace } from './documentWorkspace.mjs';
import { AppState, Platform } from 'react-native';
import { deleteDatabaseAsync, openDatabaseAsync, openDatabaseSync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { createLocalStore, createBridge } from '../../../../backend/local/src/index.js';
import * as engine from '../lib/stella/local-sync';
import { expoSqliteDb } from '../lib/stella/sqlite-expo';
import { supabaseTransport } from '../lib/stella/sync';
import { subscribeWorkspace } from '../lib/stella/realtime';
import { supabase } from '../lib/stella/supabase';
import { listMyWorkspaces } from '../lib/stella/workspaces';
import { listNoteFavorites, setNoteFavorites } from '../lib/stella/favorites';
import { createAIService } from './ai-service';
import { CHAT_LIMITS, answerQuery, askAssistant, excerptFor, planQuery, rankRecords, toSources, todayIn } from '../lib/stella/ai-chat';
import { requireTransmission } from '../../../../shared/contracts/ai-policy.js';
import { selectChatSources } from './ChatSourceScope.mjs';
import { retryPlan, transcribeErrorMessage, transcribeUploaded, uploadRecording } from '../lib/stella/transcribe';
import {
  RecordingError, ackRecordingTranscript, createRecording, getRecordingStatus, getRecordingTranscript, isRecordingSettled,
  planSegments, recordingErrorMessage, recordingProgressText, uploadRecordingSegments,
} from '../lib/stella/recordings';
import { agendaJudgeErrorMessage, judgeAgendaDiscussion } from '../lib/stella/agenda-judge';
import { File } from 'expo-file-system';
import { SUPABASE_URL, SUPABASE_KEY } from '../lib/stella/config';

let current = null;
let generation = 0;
const preferenceCache = new Map();
const listeners = new Set();
const sessionFlushers = new Set();
export function registerSessionFlush(flush) { sessionFlushers.add(flush); return () => sessionFlushers.delete(flush); }
export const runtimeSubscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) fn(); };
// Adapters whose data lives outside the local store (server sync records, server RPC caches) call this after they change.
export const emitRuntime = emit;
// Sync-engine context for one shared workspace (projects, team, invites are written to the engine directly).
export function syncContext(serverId) {
  const own = runtime();
  if (!serverId) throw new Error('서버에 연결된 공유 공간이 아닙니다');
  // Hermes에는 globalThis.crypto.randomUUID가 없어 공유 공간 저장(프로젝트 등)이 "newId를 넘겨주세요"로 실패했다
  return { db: own.syncDb, transport: supabaseTransport, workspaceId: serverId, myAccountId: own.session.id, newId: randomUUID };
}
export function runtime() { if (!current) throw new Error('로그인과 기기 저장소 초기화가 필요합니다'); return current; }
export const maybeRuntime = () => current;
export function aiPolicy(source) {
  const s = readPreference('settings', {}); const ws = runtime().store.getCurrentWorkspace();
  return { route: s.ai?.route ?? 'external', allowedProviders: s.ai?.allowedProviders ?? [],
    consent: s.ai?.consent ?? {}, timezone: s.setup?.timezone ?? 'Asia/Seoul',
    confirmMode: s.ai?.confirmMode ?? 'confirm',
    workspaceId: ws.personal ? null : ws.serverId,
    excluded: s.ai?.transmissionDisabled !== false || Boolean(source && readPreference(`ai-excluded:${source.id}`, false)) };
}

// Web only: if browser storage is cleared while the app runs, the open DB handle turns empty.
// Reopen once through a page reload; a repeat within 30 seconds surfaces the original error.
function reloadAfterLostWebStorage(error) {
  if (Platform.OS !== 'web' || !String(error?.message).includes('no such table: integration_preferences')) return false;
  try {
    const key = 'planner.web.storageRecoveryAt';
    if (Date.now() - Number(sessionStorage.getItem(key) || 0) < 30000) return false;
    sessionStorage.setItem(key, String(Date.now()));
    location.reload();
    return true;
  } catch { return false; }
}

export function readPreference(key, fallback) {
  if (preferenceCache.has(key)) return preferenceCache.get(key);
  let r;
  try {
    r = current?.db.getFirstSync('select value from integration_preferences where key=?', [key]);
  } catch (error) {
    if (reloadAfterLostWebStorage(error)) return fallback;
    throw error;
  }
  const value = r ? JSON.parse(r.value) : fallback;
  if (current) preferenceCache.set(key, value);
  return value;
}
export function writePreference(key, value) {
  persistPreference(runtime().db, key, value);
  preferenceCache.set(key, value);
  emit(); return value;
}

function persistPreference(db, key, value) {
  db.runSync('insert into integration_preferences(key,value) values(?,?) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
}

export function restorePersonalData(payload, preferences) {
  return runtime().store.importAll(payload, db => {
    for (const [key, value] of preferences) persistPreference(db, key, value);
    // Store subscribers run after commit. A rollback leaves the cache safe to reload as well.
    for (const [key] of preferences) preferenceCache.delete(key);
  });
}

export async function gateway(path, body, { route = 'external', signal } = {}) {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('로그인이 필요합니다');
  // functions-js 2.57 has no AbortSignal option; use the same HTTP contract with an abortable transport.
  // No header means 'external' on the gateway. Send it only for self_hosted: a gateway whose CORS list lacks
  // x-ai-route (deployed v14) fails the browser preflight, which surfaces as "Failed to fetch" on web.
  const headers = { 'content-type': 'application/json', apikey: SUPABASE_KEY, authorization: `Bearer ${data.session.access_token}` };
  if (route !== 'external') headers['x-ai-route'] = route;
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/ai-gateway/${path}`, {
      method: 'POST', signal, headers, body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    // Offline, or the edge worker was recycled mid-request (its 503 has no CORS headers, so the browser only says
    // "Failed to fetch"). Not retried here: the gateway may already have counted the request.
    throw Object.assign(new Error('AI 서버와 연결이 끊겼어요. 잠시 후 다시 보내 주세요'), { code: 'NETWORK', cause: error });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(payload?.message ?? 'AI 서버 요청에 실패했습니다'), { code: payload?.code ?? 'NETWORK' });
  return payload;
}

// Web only: expo-sqlite's sync calls busy-wait with a short timeout, but the worker's first call
// loads WebAssembly and creates the OPFS file pool, which takes longer. If that first call is sync it
// throws "Sync operation timeout" while the worker finishes anyway, leaving later calls out of step.
// Start the worker with an async call first so every sync call afterwards finds it ready.
let webWarmup = null;
function warmUpWebSQLite() {
  if (Platform.OS !== 'web') return null;
  webWarmup ??= openDatabaseAsync(':memory:').then(db => db.closeAsync())
    .catch(error => { webWarmup = null; throw error; });
  return webWarmup;
}

// ---------------------------------------------------------------------
// 계정별 기기 DB 파일 정리
//   웹의 expo-sqlite는 브라우저 저장소(OPFS)에 파일을 최대 6개까지만 둘 수 있음 (계정 하나에 DB 2개 + 쓰는 동안 임시 파일).
//   탈퇴한 계정의 파일이 남아 있으면 새 계정(예: 탈퇴 후 같은 카카오로 다시 가입 = 새 계정 id)이 DB를 만들지 못함.
// ---------------------------------------------------------------------
const accountDbNames = id => [`planner-${id}.db`, `sync-${id}.db`];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const WEB_ACCOUNTS_KEY = 'planner.web.dbAccounts'; // 이 브라우저에 DB 파일이 있는 계정 id들
// 파일을 새로 만들 자리가 없을 때 expo-sqlite(웹)가 내는 오류들 (만드는 시점에 따라 메시지가 다름)
const isPoolFull = error => /unable to open database file|cannot create file|sqlite3_open_v2/i.test(String(error?.message ?? error));

function webAccounts() {
  try { return JSON.parse(globalThis.localStorage?.getItem(WEB_ACCOUNTS_KEY) || '[]'); } catch { return []; }
}
function rememberWebAccount(id, present) {
  if (Platform.OS !== 'web') return;
  try {
    const next = new Set(webAccounts());
    if (present) next.add(id); else next.delete(id);
    globalThis.localStorage.setItem(WEB_ACCOUNTS_KEY, JSON.stringify([...next]));
  } catch { /* 저장소를 못 써도 정리만 못 할 뿐 */ }
}

// 브라우저에 "이 사이트 데이터를 지우지 말아 달라"고 한 번 요청 (저장 공간이 부족할 때 기기 DB가 지워지지 않게).
//   절전 모드로 연결이 끊기는 것은 막지 못함 → 위의 점검·다시 열기가 맡음
let persistAsked = false;
function requestPersistentStorage() {
  if (Platform.OS !== 'web' || persistAsked) return;
  persistAsked = true;
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.persist !== 'function') return;
  void (async () => {
    try {
      if (await storage.persisted?.()) return;
      if (!(await storage.persist())) console.info('[device-db] 브라우저가 사이트 데이터 보관 요청을 받지 않았어요. 저장 공간이 부족하면 기기 기록이 지워질 수 있어요');
    } catch { /* 지원하지 않는 브라우저 */ }
  })();
}

/** 이 계정의 기기 DB 파일을 지움 (탈퇴 뒤). 이미 없으면 넘어감 */
async function deleteAccountFiles(id) {
  for (const name of accountDbNames(id)) {
    try { await deleteDatabaseAsync(name); } catch { /* 없는 파일 */ }
  }
  rememberWebAccount(id, false);
}

/**
 * (웹) 저장 공간이 가득 찼을 때: 다른 계정의 DB 중 탈퇴로 이미 비워진 것(설정·메모·일정이 하나도 없음)만 지움.
 * 기록이 남아 있는 계정(로그아웃만 한 계정)의 파일은 건드리지 않음. 지운 계정 수를 돌려줌
 */
async function freeWebSpace(exceptId) {
  const candidates = new Set(webAccounts());
  try {
    for (const key of Object.keys(globalThis.localStorage ?? {})) for (const m of key.matchAll(UUID_RE)) candidates.add(m[0].toLowerCase());
  } catch { /* 저장소를 못 읽으면 목록만으로 */ }
  candidates.delete(exceptId.toLowerCase());
  let freed = 0;
  for (const id of candidates) {
    let db;
    try { db = await openDatabaseAsync(`planner-${id}.db`); } catch { continue; } // 파일이 없거나 열 수 없음
    let wiped = false;
    try {
      const has = async table => (await db.getFirstAsync('select count(*) as n from sqlite_master where type=\'table\' and name=?', [table])).n > 0;
      const count = async table => ((await has(table)) ? (await db.getFirstAsync(`select count(*) as n from ${table}`)).n : 0);
      wiped = (await count('integration_preferences')) === 0 && (await count('memos')) === 0 && (await count('tasks')) === 0;
    } catch {
      wiped = false;
    } finally {
      await db.closeAsync().catch(() => {});
    }
    if (wiped) { await deleteAccountFiles(id); freed += 1; }
  }
  return freed;
}

export async function openSession(user, { retried = false } = {}) {
  try {
    return await openSessionOnce(user);
  } catch (error) {
    if (Platform.OS !== 'web' || !isPoolFull(error)) throw error;
    if (!retried && (await freeWebSpace(user.id)) > 0) return openSession(user, { retried: true });
    throw new Error('이 브라우저의 기기 저장 공간이 가득 찼어요. 이 브라우저에서 다른 계정으로 쓰던 기록이 남아 있어서 새 계정의 저장소를 만들 수 없어요. 다른 계정으로 로그인해 정리하거나, 브라우저의 사이트 데이터를 지운 뒤 다시 시도해 주세요.');
  }
}

async function openSessionOnce(user) {
  if (current?.session.id === user.id) return current;
  await closeSession(false);
  if (!/^[0-9a-f-]{36}$/i.test(user.id)) throw new Error('유효한 계정 ID가 필요합니다');
  await warmUpWebSQLite();
  const db = openDatabaseSync(`planner-${user.id}.db`);
  let syncNative = null;
  try {
    syncNative = openDatabaseSync(`sync-${user.id}.db`);
    const opened = await initSession(user, db, syncNative);
    rememberWebAccount(user.id, true);
    requestPersistentStorage();
    return opened;
  } catch (error) {
    // A failed start must release both handles; otherwise the next attempt (e.g. the queued
    // onAuthStateChange) cannot reopen the same account files (web OPFS handles are exclusive).
    if (current?.db === db) current = null;
    try { db.closeSync(); } catch { /* already closed */ }
    try { syncNative?.closeSync(); } catch { /* already closed */ }
    throw error;
  }
}

// 자동 동기화 결과 중 사람이 봐야 하는 것만 콘솔에 남깁니다(막힌 보낼 목록·거절된 연결·오류).
//   예전에는 결과를 버려서, 휴대폰의 보낼 목록이 막혀도 아무 흔적이 없었습니다.
let lastSyncLog = '';
function logSyncProblems(out) {
  const lines = [];
  for (const [workspaceId, r] of Object.entries(out ?? {})) {
    if (r.status === 'ERROR') lines.push(`${workspaceId} ERROR ${r.code}: ${r.error}`);
    if (r.handOff) lines.push(`${workspaceId} 넘기기 막힘 seq=${r.handOff.seq} ${r.handOff.code}: ${r.handOff.error}`);
    const f = r.flush;
    if (f?.status === 'BLOCKED') lines.push(`${workspaceId} 보내기 막힘 seq=${f.outboxSeq} ${f.code}: ${f.error}`);
    if (f?.status === 'CONFLICT') lines.push(`${workspaceId} 충돌 seq=${f.outboxSeq}`);
    for (const l of f?.failedLinks ?? []) lines.push(`${workspaceId} 연결 거절(건너뜀) seq=${l.outboxSeq} ${l.code}: ${l.error}`);
  }
  const text = lines.join('\n');
  if (text && text !== lastSyncLog) console.warn(`[sync]\n${text}`);   // 같은 내용은 다시 찍지 않음 (재시도마다 반복 방지)
  lastSyncLog = text;
}

async function initSession(user, db, syncNative) {
  db.execSync('create table if not exists integration_preferences(key text primary key,value text not null)');
  const store = createLocalStore({ db, newId: randomUUID });
  store.bindAccount(user.id);
  const session = { id: user.id, generation: ++generation };
  const syncDb = expoSqliteDb(syncNative);
  await engine.setupLocalSync(syncDb);
  // Both files are account-scoped. Never reuse or wipe another account's pending DB on sign-in.
  await engine.bindSyncAccount(syncDb, user.id);
  const closedServerIds = new Set(await engine.listClosedWorkspaces(syncDb));
  const closedSpaces = new Set(
    store.getWorkspaces().filter(ws => closedServerIds.has(ws.serverId)).map(ws => ws.id),
  );
  const bridge = createBridge({ store, engine, db: syncDb, transport: supabaseTransport, accountId: user.id,
    onWorkspaceAccess: (id, hasAccess) => {
      if (current?.session !== session || current.closedSpaces.has(id) === !hasAccess) return;
      const next = new Set(current.closedSpaces);
      if (hasAccess) next.delete(id);
      else next.add(id);
      current.closedSpaces = next;
      emit();
    },
    favorites: { set: (ws, ids, on) => setNoteFavorites(supabase, ws, ids, on), list: ws => listNoteFavorites(supabase, ws) },
    workspaces: { list: async () => (await listMyWorkspaces()).map(m => ({ id: m.workspace.id, name: m.workspace.name,
      description: m.workspace.description, role: m.role })) },
  });
  current = { db, syncNative, syncDb, store, bridge, session, stop: null, ai: null, closedSpaces };
  preferenceCache.clear();
  const own = current;
  await prepareDocumentTables(db);
  const documentContent = createStellaDocumentStore({ db, store, notify: emit, tablesReady: true });
  current.documents = createDocumentWorkspace({ content: documentContent, store, read: readPreference, write: writePreference, isActive: () => current === own, isClosed: id => own.closedSpaces.has(id) });
  current.ai = createAIService({ store, gateway, newId: randomUUID,
    getSession: () => current?.session,
    getPolicy: aiPolicy,
  });
  const stopBridge = LOCAL_PREVIEW ? () => {} : bridge.start({ onResult: (out) => { logSyncProblems(out); if (current === own) emit(); } });
  const stopSignals = LOCAL_PREVIEW ? () => {} : watchSharedWorkspaces(own);
  current.stop = () => { stopSignals(); stopBridge(); documentContent.dispose(); };
  store.subscribe(emit); emit();
  return current;
}

function watchSharedWorkspaces(own) {
  const channels = new Map();
  let stopped = false;
  const requestSync = (delay, options) => {
    if (!stopped && current === own) own.bridge.requestSync(delay, options);
  };
  const update = () => {
    if (stopped || current !== own) return;
    const linked = new Set(own.store.getWorkspaces()
      .filter(ws => !ws.personal && ws.serverId && !own.closedSpaces.has(ws.id))
      .map(ws => ws.serverId));
    for (const [id, stop] of channels) {
      if (linked.has(id)) continue;
      stop();
      channels.delete(id);
    }
    for (const id of linked) {
      if (channels.has(id)) continue;
      channels.set(id, subscribeWorkspace(supabase, id, {
        onSignal: () => requestSync(150),
        onStatus: status => {
          if (status === 'denied') requestSync(150);
          if (status === 'connected') requestSync(5000, { expedite: false });
        },
      }));
    }
  };
  const unsubscribe = runtimeSubscribe(update);
  const foreground = AppState.addEventListener('change', state => {
    if (state === 'active') requestSync(0);
  });
  update();
  return () => {
    stopped = true;
    foreground.remove();
    unsubscribe();
    for (const stop of channels.values()) stop();
    channels.clear();
  };
}

// Chat attachment photo → text (cloud OCR). Same consent gate as chat; local AI has no image model here.
export async function ocrForChat(base64, signal) {
  const own = runtime();
  const policy = aiPolicy();
  if (policy.route !== 'external') throw Object.assign(new Error('사진 글자 인식은 클라우드 AI에서만 쓸 수 있어요'), { code: 'ROUTE_UNSUPPORTED' });
  requireTransmission(policy.route, [policy], policy.consent);
  const r = await gateway('ocr', { client_request_id: randomUUID(), images: [{ base64 }], hint: '채팅에 첨부한 사진', workspace_id: policy.workspaceId },
    { route: policy.route, signal });
  if (current !== own || signal?.aborted) throw new Error('요청이 취소됐습니다');
  return r.draft;
}

// Handwriting strokes are sent only through the authenticated gateway, with the same external-AI consent and workspace checks.
export async function handwritingForMemo(lines, sourceId, signal) {
  const own = runtime();
  const source = sourceId ? own.store.getMemo(sourceId) : null;
  const policy = aiPolicy(source);
  const sourceRevision = source?.revision ?? null;
  if (policy.route !== 'external') throw Object.assign(new Error('손글씨 변환은 클라우드 AI에서만 쓸 수 있어요'), { code: 'ROUTE_UNSUPPORTED' });
  requireTransmission(policy.route, [policy], policy.consent);
  const response = await gateway('handwriting', {
    client_request_id: randomUUID(),
    lines,
    workspace_id: policy.workspaceId,
  }, { route: policy.route, signal });
  if (current !== own || signal?.aborted) throw Object.assign(new Error('요청이 취소됐습니다'), { code: 'CANCELLED' });
  const currentSource = sourceId ? own.store.getMemo(sourceId) : null;
  if (sourceRevision !== null && currentSource?.revision !== sourceRevision) {
    throw Object.assign(new Error('메모가 바뀌었습니다. 다시 변환해 주세요'), { code: 'SOURCE_CHANGED' });
  }
  const latest = aiPolicy(currentSource);
  requireTransmission(policy.route, [latest], latest.consent);
  if (!Array.isArray(response?.texts) || response.texts.length !== lines.length
    || !response.texts.every(text => typeof text === 'string')) {
    throw Object.assign(new Error('손글씨 변환 결과를 읽지 못했습니다'), { code: 'INVALID_MODEL_OUTPUT' });
  }
  return response.texts;
}

// Recording → text (gateway /transcribe, cloud AI only). Same consent gate as chat.
//   job: { uri, seconds, uploadId, requestId, uploaded } — kept by the caller so a retry follows lib/stella
//   retryPlan: same request, new request on the same upload, or upload again (see newTranscribeJob/nextTranscribeJob).
//   The server deletes the uploaded audio after a successful transcription (kept 3 days after a failure).
export const newTranscribeJob = (uri, seconds, file = {}) => ({
  uri, seconds, fileName: file.fileName, mimeType: file.mimeType,
  uploadId: randomUUID(), requestId: randomUUID(), uploaded: false,
});
export function nextTranscribeJob(job, code) {
  const plan = retryPlan(code);
  if (plan === 'new_request_same_upload') return { ...job, requestId: randomUUID() };
  if (plan === 'reupload') return { ...job, uploadId: randomUUID(), requestId: randomUUID(), uploaded: false };
  return job; // same_request이거나 중단합니다(화면에 메시지를 표시하며 사용자는 나중에 다시 시도할 수 있음).
}
async function readAudio(uri, fileName, mimeType) {
  if (Platform.OS === 'web') {
    // 웹의 expo-audio는 blob: URL(대개 audio/webm)에 녹음합니다. 저장소는 ;codecs=opus 같은 MIME 매개변수를 거부합니다.
    const blob = await (await fetch(uri)).blob();
    const type = String(mimeType || blob.type || 'audio/webm').split(';')[0].trim();
    return { bytes: blob, mimeType: type, fileName: fileName || `recording.${type.split('/')[1] || 'webm'}` };
  }
  const ext = (String(fileName || uri).split('?')[0].match(/\.(\w+)$/)?.[1] ?? 'm4a').toLowerCase();
  const mime = { flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg', mpeg: 'audio/mpeg', mpga: 'audio/mpga', webm: 'audio/webm', ogg: 'audio/ogg' }[ext]
    ?? String(mimeType || 'audio/mp4').split(';')[0].trim();
  return { bytes: await new File(uri).bytes(), mimeType: mime, fileName: fileName || `recording.${ext}` };
}
/** 성공하면 { text, remainingMinutes, job }을 반환하고, 실패하면 재시도에 사용할 job과 함께 { code, message, job }을 던집니다. */
export async function transcribeForDevice(job, { signal } = {}) {
  const own = runtime();
  const policy = aiPolicy();
  if (policy.route !== 'external') throw Object.assign(new Error('녹음 변환은 클라우드 AI에서만 쓸 수 있어요'), { code: 'ROUTE_UNSUPPORTED', job });
  requireTransmission(policy.route, [policy], policy.consent);
  let step = job;
  try {
    if (signal?.aborted) throw Object.assign(new Error('요청이 취소됐습니다'), { code: 'CANCELLED' });
    if (!step.uploaded) {
      const audio = await readAudio(step.uri, step.fileName, step.mimeType);
      await uploadRecording(supabase, { uploadId: step.uploadId, ...audio });
      step = { ...step, uploaded: true };
    }
    if (signal?.aborted) throw Object.assign(new Error('요청이 취소됐습니다'), { code: 'CANCELLED' });
    const r = await transcribeUploaded(supabase, {
      clientRequestId: step.requestId, uploadId: step.uploadId, durationSeconds: Math.max(1, step.seconds || 1), workspaceId: policy.workspaceId,
    });
    if (current !== own || signal?.aborted) throw Object.assign(new Error('계정이 바뀌었거나 요청이 취소됐습니다'), { code: 'CANCELLED' });
    return { text: r.text, remainingMinutes: r.remainingMinutes, job: step };
  } catch (e) {
    const code = e?.code ?? 'UNKNOWN';
    throw Object.assign(new Error(code === 'CANCELLED' ? e.message : transcribeErrorMessage(e)), { code, job: nextTranscribeJob(step, code) });
  }
}

// ---------------------------------------------------------------------
// 긴 녹음 (휴대폰 앱): 약 2분 구간으로 나눠 stt-recordings 버킷에 올리고, 서버 stt-worker가 구간별로 받아씀
//   한 파일을 통째로 보내는 방식(/transcribe)의 25MB·30분 한도와 Edge Function 시간 한도를 피함.
//   끊기면 같은 job으로 다시 부르면 남은 구간부터 이어서 올림 (createRecording은 같은 id면 기존 녹음을 돌려줌)
//   job: { uri, seconds, recordingId, segments }  segments는 처음 나눌 때 정해져 다시 시도해도 그대로 씀
// ---------------------------------------------------------------------
export const LONG_RECORDING_SECONDS = 10 * 60;   // 이보다 긴 녹음은 구간 방식 (짧은 녹음은 한 번에 보내는 편이 빠름)
let audioSplit;                                    // 네이티브 분할 모듈 (웹·Expo Go에는 없음)
function loadAudioSplit() {
  if (audioSplit !== undefined) return audioSplit;
  try { audioSplit = Platform.OS === 'web' ? null : require('../../modules/stella-audio-split'); }
  catch { audioSplit = null; }
  return audioSplit;
}
/** 이 녹음을 구간 방식으로 보낼 수 있는지 (휴대폰 앱 + 분할 모듈 있음 + 충분히 긴 녹음) */
export const canSplitRecording = seconds => (seconds ?? 0) >= LONG_RECORDING_SECONDS && !!loadAudioSplit();
export const newLongRecordingJob = (uri, seconds) => ({ uri, seconds, recordingId: randomUUID(), segments: null });

export async function transcribeLongRecording(job, { onProgress, signal } = {}) {
  const own = runtime();
  const policy = aiPolicy();
  if (policy.route !== 'external') throw Object.assign(new Error('녹음 변환은 클라우드 AI에서만 쓸 수 있어요'), { code: 'ROUTE_UNSUPPORTED', job });
  requireTransmission(policy.route, [policy], policy.consent);
  const split = loadAudioSplit();
  if (!split) throw Object.assign(new Error('이 앱에서는 긴 녹음을 나눌 수 없어요'), { code: 'SPLIT_UNAVAILABLE', job });
  const stopped = () => signal?.aborted || current !== own;
  let step = job;
  try {
    // 1. 나누기 (처음 한 번만. 다시 시도할 때는 같은 구간 파일을 씀)
    if (!step.segments) {
      onProgress?.({ phase: 'split', text: '녹음을 2분 단위로 나누는 중…' });
      const total = await split.getAudioDuration(step.uri);
      const plan = planSegments(total);
      const files = await split.splitAudio(step.uri, plan.map(p => ({ start: p.startSeconds, duration: p.durationSeconds })));
      step = { ...step, segments: files.map(f => ({ seq: f.seq, uri: f.uri, durationSeconds: f.durationSeconds, sizeBytes: f.sizeBytes })) };
    }
    if (stopped()) throw Object.assign(new Error('요청이 취소됐습니다'), { code: 'CANCELLED' });
    // 2. 서버에 녹음 등록 (월 변환 분과 권한을 서버가 확인)
    const created = await createRecording(supabase, {
      recordingId: step.recordingId, workspaceId: policy.workspaceId,
      segments: step.segments.map(s => ({ seq: s.seq, durationSeconds: s.durationSeconds, sizeBytes: s.sizeBytes, mimeType: 'audio/mp4' })),
    });
    // 3. 구간 올리기 (서버가 확인한 구간의 기기 임시 파일은 바로 지움)
    await uploadRecordingSegments(supabase, {
      recordingId: step.recordingId,
      readSegment: seq => new File(step.segments.find(s => s.seq === seq).uri).bytes(),
      onSegmentConfirmed: seq => { try { const f = new File(step.segments.find(s => s.seq === seq).uri); if (f.exists) f.delete(); } catch { /* 이미 지워짐 */ } },
      onProgress: p => onProgress?.({ phase: 'upload', text: `구간 올리는 중, ${p.total}개 중 ${p.uploaded}개` }),
      shouldStop: stopped,
    });
    if (stopped()) throw Object.assign(new Error('요청이 취소됐습니다'), { code: 'CANCELLED' });
    // 4. 서버 받아쓰기가 끝날 때까지 상태 확인 (앱을 닫아도 서버는 계속 처리)
    let status;
    for (;;) {
      status = await getRecordingStatus(supabase, step.recordingId);
      onProgress?.({ phase: 'process', text: recordingProgressText(status).lines.join('\n') });
      if (isRecordingSettled(status.state)) break;
      if (stopped()) throw Object.assign(new Error('요청이 취소됐습니다'), { code: 'CANCELLED' });
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    if (status.state === 'CANCELED' || status.state === 'FAILED') {
      throw new RecordingError(status.state === 'CANCELED' ? 'CANCELED' : 'FAILED', recordingProgressText(status).lines.join(' '));
    }
    // 5. 전사문 (구간 시각 [12:00] 포함, 실패 구간은 표시만)
    const t = await getRecordingTranscript(supabase, step.recordingId);
    if (current !== own) throw Object.assign(new Error('계정이 바뀌었습니다'), { code: 'CANCELLED' });
    return { text: t.text, complete: t.complete, missing: t.missing.length, remainingMinutes: created.remainingMinutes, job: step };
  } catch (e) {
    const code = e?.code ?? 'UNKNOWN';
    throw Object.assign(new Error(code === 'CANCELLED' ? e.message : (e instanceof RecordingError ? e.message : recordingErrorMessage(e))), { code, job: step });
  }
}
/** 받아 적은 글을 기기에 저장한 뒤 서버의 임시 전사문을 지움 (안 해도 7일 뒤 자동 삭제) */
export async function finishLongRecording(job) {
  if (!job?.recordingId) return;
  try { await ackRecordingTranscript(supabase, job.recordingId); } catch (e) { console.warn('[recording] 서버 전사문을 정리하지 못했어요 (7일 뒤 자동 삭제)', e); }
}

// Agenda compare: was each changed item talked about in that day's meeting notes? (gateway /agenda/judge,
// cloud AI only, same consent gate as chat). Same input is answered from lib/stella's in-memory cache.
export async function judgeAgendaForDevice({ changes, discussions, projectTitle, date }) {
  const own = runtime();
  const policy = aiPolicy();
  if (policy.route !== 'external') throw Object.assign(new Error('안건 판단은 클라우드 AI에서만 쓸 수 있어요'), { code: 'ROUTE_UNSUPPORTED' });
  requireTransmission(policy.route, [policy], policy.consent);
  const ws = policy.workspaceId;
  const r = await judgeAgendaDiscussion(supabase, {
    changes: changes.map(c => ({ ...c, workspaceId: ws })), discussions: discussions.map(d => ({ ...d, workspaceId: ws })),
    newId: randomUUID, projectTitle, date, timezone: policy.timezone,
  });
  if (current !== own) throw Object.assign(new Error('계정이 바뀌었습니다'), { code: 'CANCELLED' });
  return r;
}
export { agendaJudgeErrorMessage };

// 대화 내용을 바탕으로 채팅 제목을 만듭니다(게이트웨이 "organize"가 40자 이하로 생성). 채팅과 동일한 동의 절차를 거치며,
// 월간 organize 한도에 포함됩니다. 출처는 전송하지 않고 질문과 답변 텍스트만 전송합니다.
export async function titleForChat(question, answer, signal) {
  const own = runtime();
  const policy = aiPolicy();
  requireTransmission(policy.route, [policy], policy.consent);
  const text = `채팅 대화의 제목을 정하기 위한 내용입니다.\n\n질문: ${question}\n\n답변: ${answer}`.slice(0, 4000);
  const r = await gateway('organize', { client_request_id: randomUUID(), text, workspace_id: policy.workspaceId }, { route: policy.route, signal });
  if (current !== own || signal?.aborted) throw new Error('요청이 취소됐습니다');
  return String(r.draft?.title ?? '').trim();
}

// 이 기기에서 이미 텍스트로 변환한 첨부 파일을 먼저 넣고, 플래너가 찾은 기기 기록을 뒤에 넣습니다.
function mergeSources(attached, ranked, keywords) {
  const out = [];
  let total = 0;
  const omittedAttachments = [];
  for (const a of attached) {
    const room = CHAT_LIMITS.sourcesTotalChars - total - a.title.length;
    if (out.length >= CHAT_LIMITS.sources || room < 100) {
      omittedAttachments.push({ id: a.id, name: a.title });
      continue;
    }
    const text = excerptFor(a.text, keywords, Math.min(CHAT_LIMITS.sourceChars, room));
    out.push({ id: a.id, type: 'file', title: a.title.slice(0, 200), date: null, text, workspace_id: a.workspaceId ?? null });
    total += a.title.length + text.length;
  }
  for (const s of toSources(ranked, keywords)) {
    if (out.length >= CHAT_LIMITS.sources || total + s.title.length + s.text.length > CHAT_LIMITS.sourcesTotalChars) break;
    out.push(s); total += s.title.length + s.text.length;
  }
  return { sources: out, omittedAttachments };
}

export async function askFromDevice(question, signal, { history = [], attachments = [], fileVaultOnly = false, memoOnly = false } = {}) {
  const own = runtime(); const generation = own.session.generation;
  const ws = own.store.getCurrentWorkspace().id;
  const policy = aiPolicy();
  requireTransmission(policy.route, [policy], policy.consent);
  // 멤버가 아니게 된(닫힌) 공유 공간의 기록은 검색 화면과 같이 AI에도 보내지 않음
  const records = fileVaultOnly || own.closedSpaces?.has(ws) ? [] : [
    ...own.store.getMemos().map(m => ({ id: m.id, type: 'memo', title: m.title || m.body.split('\n')[0].slice(0, 60), text: m.body, revision: m.revision, date: new Date(m.updatedAt).toISOString() })),
    ...(!memoOnly ? own.store.getTasks().map(t => ({ id: t.id, type: t.kind, title: t.title, text: t.desc, revision: t.revision, date: t.date, status: t.status === '완료' ? 'done' : 'open' })) : []),
  ].filter(r => !aiPolicy(r).excluded).map(r => ({ ...r, workspaceId: policy.workspaceId }));
  const attachmentSources = attachments.filter(a => a.text).map(a => ({
    id: a.id, title: a.name, text: a.text, workspaceId: policy.workspaceId, sourceScope: a.sourceScope,
  }));
  const { attachments: attached, records: contextRecords } = selectChatSources({
    attachments: attachmentSources, records, fileVaultOnly,
  });
  const checkSnapshot = () => {
    if (signal?.aborted || current !== own || own.session.generation !== generation) throw new Error('요청이 취소됐습니다');
    if (own.store.getCurrentWorkspace().id !== ws) throw new Error('작업 공간이 바뀌었습니다');
    requireTransmission(policy.route, [aiPolicy()], aiPolicy().consent);
    for (const record of contextRecords) {
      const now = record.type === 'memo' ? own.store.getMemo(record.id) : own.store.getTask(record.id);
      if (!now || now.deletedAt || now.revision !== record.revision) throw new Error('검색 대상 기록이 바뀌었습니다. 다시 질문해 주세요');
      requireTransmission(policy.route, [aiPolicy(now)], aiPolicy().consent);
    }
  };
  const client = { functions: { invoke: async (name, options) => {
    // 질의 플래너가 동의 상태나 출처가 바뀐 뒤 완료될 수 있으므로 각 단계 전에 다시 확인합니다.
    checkSnapshot();
    return { data: await gateway(name.replace(/^ai-gateway\//, ''), options.body, { route: policy.route, signal }), error: null };
  } } };
  const turns = history.filter(t => t.text && (t.role === 'user' || t.role === 'assistant'));
  let answer;
  if (!attached.length) {
    answer = await askAssistant(client, { question, history: turns, newId: randomUUID, timezone: policy.timezone, findRecords: async () => contextRecords });
  } else {
    // 사용자가 자료를 제공했으므로 질문에서 기록 검색이 필요하지 않다고 판단되더라도 해당 자료를 바탕으로 답변합니다.
    const plan = await planQuery(client, { clientRequestId: randomUUID(), question, history: turns, timezone: policy.timezone });
    const ranked = !fileVaultOnly && plan.intent === 'search' ? rankRecords(contextRecords, plan, { today: todayIn(policy.timezone) }) : [];
    const { sources, omittedAttachments } = mergeSources(attached, ranked, plan.keywords ?? []);
    const { answer: a } = await answerQuery(client, { clientRequestId: randomUUID(), question, history: turns, timezone: policy.timezone, sources });
    const byId = new Map(sources.map(s => [s.id, s]));
    answer = {
      text: a.answer,
      sources: a.used_source_ids.filter(id => byId.has(id)).map(id => ({ id, type: byId.get(id).type, title: byId.get(id).title || '(제목 없음)' })),
      attachmentWarnings: omittedAttachments,
    };
  }
  checkSnapshot();
  if (signal?.aborted || current !== own || own.session.generation !== generation) throw new Error('요청이 취소됐습니다');
  if (own.store.getCurrentWorkspace().id !== ws) throw new Error('작업 공간이 바뀌었습니다');
  const attachedIds = new Set(attached.map(a => a.id));
  for (const ref of answer.sources) {
    if (attachedIds.has(ref.id)) continue; // 첨부 파일은 기기 기록이 아닙니다.
    const before = contextRecords.find(r => r.id === ref.id); const after = before?.type === 'memo' ? own.store.getMemo(ref.id) : own.store.getTask(ref.id);
    if (!after || after.revision !== before.revision || aiPolicy(after).excluded) throw new Error('답변에 사용한 원본이 바뀌었습니다. 다시 질문해 주세요');
  }
  requireTransmission(policy.route, [aiPolicy()], aiPolicy().consent);
  return { ...answer, sources: answer.sources.map(s => ({ ...s, route: attachedIds.has(s.id) ? null : s.type === 'memo' ? 'MemoEdit' : 'TaskEdit' })) };
}

export async function recommendMemoForPhoto(photoText, signal) {
  const own = runtime();
  const generation = own.session.generation;
  const workspaceId = own.store.getCurrentWorkspace().id;
  if (aiPolicy().route !== 'external') {
    throw Object.assign(new Error('사진 메모 추천은 클라우드 AI에서 사용할 수 있어요.'), { code: 'ROUTE_UNSUPPORTED' });
  }
  const eligible = own.store.getMemos().filter(m => !m.deletedAt && !aiPolicy(m).excluded);
  if (!eligible.length) return null;

  const prefix = '사진 내용과 의미상 가장 관련 있는 기존 메모를 찾아 주세요. 관련 메모가 없다면 메모를 억지로 고르지 말고 없다고 답하세요.\n\n사진에서 읽은 내용:\n';
  const question = `${prefix}${String(photoText ?? '').trim()}`.slice(0, CHAT_LIMITS.questionChars);
  const result = await askFromDevice(question, signal, { memoOnly: true });
  if (runtime() !== own || own.session.generation !== generation || own.store.getCurrentWorkspace().id !== workspaceId) {
    throw Object.assign(new Error('계정이나 워크스페이스가 바뀌었어요. 다시 시도해 주세요.'), { code: 'CANCELLED' });
  }
  const cited = result.sources.find(source => source.type === 'memo' && eligible.some(m => m.id === source.id));
  if (!cited) return null;

  const memo = own.store.getMemo(cited.id);
  if (!memo || memo.deletedAt || memo.revision === undefined) return null;
  return {
    memoId: memo.id,
    title: memo.title || '제목 없는 메모',
    revision: memo.revision,
    sessionId: own.session.id,
    sessionGeneration: generation,
    workspaceId,
    reason: String(result.text ?? '').trim().slice(0, 320),
  };
}

// After account withdrawal: erase this account's device data (personal records live only here), then close.
export async function wipeSessionData() {
  const own = current;
  if (!own) return;
  own.session.generation = ++generation;
  own.ai.cancel(); own.stop?.(); own.stop = null;
  await own.bridge.refresh('__none__');
  own.store.clearAll();
  own.db.runSync('delete from integration_preferences');
  preferenceCache.clear();
  await engine.clearLocalSync(own.syncDb);
  await closeSession(false);
  // 탈퇴한 계정의 빈 DB 파일까지 지움 (웹은 저장 공간이 작아서, 남겨 두면 새 계정이 DB를 못 만듦)
  await deleteAccountFiles(own.session.id);
}

export async function closeSession(requireSynced = true) {
  const own = current;
  if (!own) return;
  // Persist mounted editor drafts while their original account DB is still open.
  for (const flush of sessionFlushers) flush({ analyze: false });
  if (requireSynced) {
    const status = await own.bridge.status();
    if (status.unsent > 0 || status.state === 'attention') throw new Error('미전송 변경이나 충돌이 있습니다. 동기화 후 로그아웃해 주세요');
  }
  own.session.generation = ++generation;
  own.ai.cancel(); own.stop?.();
  // Drain bridge serialization before closing either database. Late results cannot target a new session.
  await own.bridge.refresh('__none__');
  if (current === own) current = null;
  preferenceCache.clear();
  own.db.closeSync(); own.syncNative.closeSync(); emit();
}
