import { Platform } from 'react-native';
import { deleteDatabaseAsync, openDatabaseAsync, openDatabaseSync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { createLocalStore, createBridge } from '../../../../backend/local/src/index.js';
import * as engine from '../lib/stella/local-sync';
import { expoSqliteDb } from '../lib/stella/sqlite-expo';
import { supabaseTransport } from '../lib/stella/sync';
import { supabase } from '../lib/stella/supabase';
import { listMyWorkspaces } from '../lib/stella/workspaces';
import { listNoteFavorites, setNoteFavorites } from '../lib/stella/favorites';
import { createAIService } from './ai-service';
import { CHAT_LIMITS, answerQuery, askAssistant, excerptFor, planQuery, rankRecords, toSources, todayIn } from '../lib/stella/ai-chat';
import { requireTransmission } from '../../../../shared/contracts/ai-policy.js';
import { retryPlan, transcribeErrorMessage, transcribeUploaded, uploadRecording } from '../lib/stella/transcribe';
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
// 로컬 스토어 외부에 데이터(서버 동기화 레코드, 서버 RPC 캐시)를 보관하는 어댑터는 변경 후 이 함수를 호출합니다.
export const emitRuntime = emit;
// 공유 작업 공간 하나를 위한 동기화 엔진 컨텍스트입니다(프로젝트, 팀, 초대는 엔진에 직접 기록).
export function syncContext(serverId) {
  const own = runtime();
  if (!serverId) throw new Error('서버에 연결된 공유 공간이 아닙니다');
  return { db: own.syncDb, transport: supabaseTransport, workspaceId: serverId, myAccountId: own.session.id, newId: randomUUID };
}
export function runtime() { if (!current) throw new Error('로그인과 기기 저장소 초기화가 필요합니다'); return current; }
export const maybeRuntime = () => current;
export function aiPolicy(source) {
  const s = readPreference('settings', {}); const ws = runtime().store.getCurrentWorkspace();
  return { route: s.ai?.route ?? 'external', allowedProviders: s.ai?.allowedProviders ?? [],
    consent: s.ai?.consent ?? {}, timezone: s.setup?.timezone ?? 'Asia/Seoul',
    workspaceId: ws.personal ? null : ws.serverId,
    excluded: s.ai?.transmissionDisabled !== false || Boolean(source && readPreference(`ai-excluded:${source.id}`, false)) };
}

export function readPreference(key, fallback) {
  if (preferenceCache.has(key)) return preferenceCache.get(key);
  const r = current?.db.getFirstSync('select value from integration_preferences where key=?', [key]);
  const value = r ? JSON.parse(r.value) : fallback;
  if (current) preferenceCache.set(key, value);
  return value;
}
export function writePreference(key, value) {
  runtime().db.runSync('insert into integration_preferences(key,value) values(?,?) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
  preferenceCache.set(key, value);
  emit(); return value;
}

export async function gateway(path, body, { route = 'external', signal } = {}) {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('로그인이 필요합니다');
  // functions-js 2.57에는 AbortSignal 옵션이 없으므로 취소 가능한 전송 방식으로 동일한 HTTP 규약을 사용합니다.
  // 헤더가 없으면 게이트웨이는 'external'로 처리합니다. self_hosted일 때만 헤더를 보냅니다. CORS 허용 목록에
  // x-ai-route가 없는 게이트웨이(배포된 v14)는 브라우저 사전 요청에 실패해 웹에서 "Failed to fetch"가 표시됩니다.
  const headers = { 'content-type': 'application/json', apikey: SUPABASE_KEY, authorization: `Bearer ${data.session.access_token}` };
  if (route !== 'external') headers['x-ai-route'] = route;
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/ai-gateway/${path}`, {
      method: 'POST', signal, headers, body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    // 오프라인이거나 요청 도중 엣지 워커가 재시작된 경우입니다(503 응답에 CORS 헤더가 없어 브라우저에는
    // "Failed to fetch"만 표시됩니다). 게이트웨이에서 이미 요청을 집계했을 수 있으므로 여기서는 재시도하지 않습니다.
    throw Object.assign(new Error('AI 서버와 연결이 끊겼어요. 잠시 후 다시 보내 주세요'), { code: 'NETWORK', cause: error });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(payload?.message ?? 'AI 서버 요청에 실패했습니다'), { code: payload?.code ?? 'NETWORK' });
  return payload;
}

// 웹 전용: expo-sqlite의 동기 호출은 짧은 시간 동안 바쁜 대기를 하지만, 워커의 첫 호출은 WebAssembly를 불러오고
// OPFS 파일 풀을 만들어야 하므로 더 오래 걸립니다. 첫 호출이 동기식이면 워커는 계속 실행되더라도
// "Sync operation timeout"이 발생해 이후 호출과 상태가 어긋날 수 있습니다.
// 먼저 비동기 호출로 워커를 시작해 이후 동기 호출 시 준비된 상태가 되도록 합니다.
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
    return opened;
  } catch (error) {
    // 시작에 실패하면 두 핸들을 모두 해제해야 합니다. 그렇지 않으면 다음 시도(예: 대기 중인
    // onAuthStateChange)가 동일한 계정 파일을 다시 열 수 없습니다(웹 OPFS 핸들은 단독으로 사용됨).
    if (current?.db === db) current = null;
    try { db.closeSync(); } catch { /* already closed */ }
    try { syncNative?.closeSync(); } catch { /* already closed */ }
    throw error;
  }
}

async function initSession(user, db, syncNative) {
  db.execSync('create table if not exists integration_preferences(key text primary key,value text not null)');
  const store = createLocalStore({ db, newId: randomUUID });
  store.bindAccount(user.id);
  const session = { id: user.id, generation: ++generation };
  const syncDb = expoSqliteDb(syncNative);
  await engine.setupLocalSync(syncDb);
  // 두 파일 모두 계정별로 관리합니다. 로그인할 때 다른 계정의 대기 중인 DB를 재사용하거나 삭제하지 않습니다.
  await engine.bindSyncAccount(syncDb, user.id);
  const bridge = createBridge({ store, engine, db: syncDb, transport: supabaseTransport, accountId: user.id,
    favorites: { set: (ws, ids, on) => setNoteFavorites(supabase, ws, ids, on), list: ws => listNoteFavorites(supabase, ws) },
    workspaces: { list: async () => (await listMyWorkspaces()).map(m => ({ id: m.workspace.id, name: m.workspace.name,
      description: m.workspace.description, role: m.role })) },
  });
  current = { db, syncNative, syncDb, store, bridge, session, stop: null, ai: null };
  preferenceCache.clear();
  const own = current;
  current.ai = createAIService({ store, gateway, newId: randomUUID,
    getSession: () => current?.session,
    getPolicy: aiPolicy,
  });
  current.stop = bridge.start({ onResult: () => { if (current === own) emit(); } });
  store.subscribe(emit); emit();
  return current;
}

// 채팅 첨부 사진을 텍스트로 변환합니다(클라우드 OCR). 채팅과 동일한 동의 절차를 거치며 로컬 AI는 이미지 모델을 사용하지 않습니다.
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

// 녹음을 텍스트로 변환합니다(게이트웨이 /transcribe, 클라우드 AI 전용). 채팅과 동일한 동의 절차를 거칩니다.
//   job: { uri, seconds, uploadId, requestId, uploaded } — 호출자가 보관해 재시도 시 lib/stella의 절차를 따릅니다.
//   retryPlan: 같은 요청, 같은 업로드로 새 요청, 또는 다시 업로드(newTranscribeJob/nextTranscribeJob 참고).
//   변환에 성공하면 서버가 업로드된 오디오를 삭제합니다(실패한 경우 3일간 보관).
export const newTranscribeJob = (uri, seconds) => ({ uri, seconds, uploadId: randomUUID(), requestId: randomUUID(), uploaded: false });
export function nextTranscribeJob(job, code) {
  const plan = retryPlan(code);
  if (plan === 'new_request_same_upload') return { ...job, requestId: randomUUID() };
  if (plan === 'reupload') return { ...job, uploadId: randomUUID(), requestId: randomUUID(), uploaded: false };
  return job; // same_request이거나 중단합니다(화면에 메시지를 표시하며 사용자는 나중에 다시 시도할 수 있음).
}
async function readAudio(uri) {
  if (Platform.OS === 'web') {
    // 웹의 expo-audio는 blob: URL(대개 audio/webm)에 녹음합니다. 저장소는 ;codecs=opus 같은 MIME 매개변수를 거부합니다.
    const blob = await (await fetch(uri)).blob();
    const type = (blob.type || 'audio/webm').split(';')[0].trim();
    return { bytes: blob, mimeType: type, fileName: `recording.${type.split('/')[1] || 'webm'}` };
  }
  const ext = (uri.split('?')[0].match(/\.(\w+)$/)?.[1] ?? 'm4a').toLowerCase();
  const mime = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/mp4', caf: 'audio/x-caf', wav: 'audio/wav', mp3: 'audio/mpeg', webm: 'audio/webm', ogg: 'audio/ogg' }[ext] ?? 'audio/mp4';
  return { bytes: await new File(uri).bytes(), mimeType: mime, fileName: `recording.${ext}` };
}
/** 성공하면 { text, remainingMinutes, job }을 반환하고, 실패하면 재시도에 사용할 job과 함께 { code, message, job }을 던집니다. */
export async function transcribeForDevice(job) {
  const own = runtime();
  const policy = aiPolicy();
  if (policy.route !== 'external') throw Object.assign(new Error('녹음 변환은 클라우드 AI에서만 쓸 수 있어요'), { code: 'ROUTE_UNSUPPORTED', job });
  requireTransmission(policy.route, [policy], policy.consent);
  let step = job;
  try {
    if (!step.uploaded) {
      const audio = await readAudio(step.uri);
      await uploadRecording(supabase, { uploadId: step.uploadId, ...audio });
      step = { ...step, uploaded: true };
    }
    const r = await transcribeUploaded(supabase, {
      clientRequestId: step.requestId, uploadId: step.uploadId, durationSeconds: Math.max(1, step.seconds || 1), workspaceId: policy.workspaceId,
    });
    if (current !== own) throw Object.assign(new Error('계정이 바뀌었습니다'), { code: 'CANCELLED' });
    return { text: r.text, remainingMinutes: r.remainingMinutes, job: step };
  } catch (e) {
    const code = e?.code ?? 'UNKNOWN';
    throw Object.assign(new Error(code === 'CANCELLED' ? e.message : transcribeErrorMessage(e)), { code, job: nextTranscribeJob(step, code) });
  }
}

// 일정 비교: 변경된 항목을 해당 날짜의 회의 메모에서 논의했는지 확인합니다(게이트웨이 /agenda/judge,
// 클라우드 AI 전용이며 채팅과 동일한 동의 절차를 거침). 같은 입력은 lib/stella의 메모리 캐시에서 결과를 가져옵니다.
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
  for (const a of attached.slice(0, 3)) {
    const text = excerptFor(a.text, keywords, CHAT_LIMITS.sourceChars);
    out.push({ id: a.id, type: 'file', title: a.title.slice(0, 200), date: null, text, workspace_id: a.workspaceId ?? null });
    total += a.title.length + text.length;
  }
  for (const s of toSources(ranked, keywords)) {
    if (out.length >= CHAT_LIMITS.sources || total + s.title.length + s.text.length > CHAT_LIMITS.sourcesTotalChars) break;
    out.push(s); total += s.title.length + s.text.length;
  }
  return out;
}

export async function askFromDevice(question, signal, { history = [], attachments = [] } = {}) {
  const own = runtime(); const generation = own.session.generation;
  const ws = own.store.getCurrentWorkspace().id;
  const policy = aiPolicy();
  requireTransmission(policy.route, [policy], policy.consent);
  const records = [
    ...own.store.getMemos().map(m => ({ id: m.id, type: 'memo', title: m.title, text: m.body, revision: m.revision, date: new Date(m.updatedAt).toISOString() })),
    ...own.store.getTasks().map(t => ({ id: t.id, type: t.kind, title: t.title, text: t.desc, revision: t.revision, date: t.date, status: t.status === '완료' ? 'done' : 'open' })),
  ].filter(r => !aiPolicy(r).excluded).map(r => ({ ...r, workspaceId: policy.workspaceId }));
  const checkSnapshot = () => {
    if (signal?.aborted || current !== own || own.session.generation !== generation) throw new Error('요청이 취소됐습니다');
    if (own.store.getCurrentWorkspace().id !== ws) throw new Error('작업 공간이 바뀌었습니다');
    requireTransmission(policy.route, [aiPolicy()], aiPolicy().consent);
    for (const record of records) {
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
  const attached = attachments.filter(a => a.text).map(a => ({ id: a.id, title: a.name, text: a.text, workspaceId: policy.workspaceId }));
  let answer;
  if (!attached.length) {
    answer = await askAssistant(client, { question, history: turns, newId: randomUUID, timezone: policy.timezone, findRecords: async () => records });
  } else {
    // 사용자가 자료를 제공했으므로 질문에서 기록 검색이 필요하지 않다고 판단되더라도 해당 자료를 바탕으로 답변합니다.
    const plan = await planQuery(client, { clientRequestId: randomUUID(), question, history: turns, timezone: policy.timezone });
    const ranked = plan.intent === 'search' ? rankRecords(records, plan, { today: todayIn(policy.timezone) }) : [];
    const sources = mergeSources(attached, ranked, plan.keywords ?? []);
    const { answer: a } = await answerQuery(client, { clientRequestId: randomUUID(), question, history: turns, timezone: policy.timezone, sources });
    const byId = new Map(sources.map(s => [s.id, s]));
    answer = { text: a.answer, sources: a.used_source_ids.filter(id => byId.has(id)).map(id => ({ id, type: byId.get(id).type, title: byId.get(id).title || '(제목 없음)' })) };
  }
  checkSnapshot();
  if (signal?.aborted || current !== own || own.session.generation !== generation) throw new Error('요청이 취소됐습니다');
  if (own.store.getCurrentWorkspace().id !== ws) throw new Error('작업 공간이 바뀌었습니다');
  const attachedIds = new Set(attached.map(a => a.id));
  for (const ref of answer.sources) {
    if (attachedIds.has(ref.id)) continue; // 첨부 파일은 기기 기록이 아닙니다.
    const before = records.find(r => r.id === ref.id); const after = before?.type === 'memo' ? own.store.getMemo(ref.id) : own.store.getTask(ref.id);
    if (!after || after.revision !== before.revision || aiPolicy(after).excluded) throw new Error('답변에 사용한 원본이 바뀌었습니다. 다시 질문해 주세요');
  }
  requireTransmission(policy.route, [aiPolicy()], aiPolicy().consent);
  return { ...answer, sources: answer.sources.map(s => ({ ...s, route: attachedIds.has(s.id) ? null : s.type === 'memo' ? 'MemoEdit' : 'TaskEdit' })) };
}

// 계정 탈퇴 후 이 계정의 기기 데이터를 삭제합니다(개인 기록은 이곳에만 저장됨). 이후 연결을 닫습니다.
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
  // 원래 계정의 DB가 열려 있는 동안 마운트된 편집기 초안을 저장합니다.
  for (const flush of sessionFlushers) flush({ analyze: false });
  if (requireSynced) {
    const status = await own.bridge.status();
    if (status.unsent > 0 || status.state === 'attention') throw new Error('미전송 변경이나 충돌이 있습니다. 동기화 후 로그아웃해 주세요');
  }
  own.session.generation = ++generation;
  own.ai.cancel(); own.stop?.();
  // DB를 닫기 전에 브리지의 직렬화 작업을 마칩니다. 늦게 도착한 결과가 새 세션에 적용되지 않도록 합니다.
  await own.bridge.refresh('__none__');
  if (current === own) current = null;
  preferenceCache.clear();
  own.db.closeSync(); own.syncNative.closeSync(); emit();
}
