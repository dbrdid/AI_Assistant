import { CryptoDigestAlgorithm, digest, randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { Linking, Platform } from 'react-native';
import { list, saveList, scoped, useValue, runtime, maybeRuntime, runtimeSubscribe, readPreference, writePreference, emitRuntime } from '../hooks';
import * as engine from '../../lib/stella/local-sync';
import { supabase } from '../../lib/stella/supabase';
import { attachmentErrorMessage, deleteAttachment, downloadAttachment, getAttachmentUrl, MAX_ATTACHMENT_BYTES, uploadAttachment } from '../../lib/stella/attachments';
import { describe, extract, readBytes } from '../../services/ai/ChatAttachments';

// 기기 파일('local', 이 파일의 목록)과 클라우드 파일(현재 공유 작업 공간에 업로드한 첨부 파일)을 다룹니다.
//   getFiles('local') / useFiles(): 기기 파일만 반환합니다(메모 사진, 프로젝트 링크, 일정에서 사용).
//   getFiles('cloud') / useCloudFiles(): 동기화 엔진의 `assets` 레코드에서 읽은 공유 작업 공간의 첨부 파일을 반환합니다.
//   서버가 기준 데이터이며 동기화 후 다른 구성원도 확인할 수 있습니다. 개인 공간에는 클라우드 파일이 없습니다.
export const getFiles = storage => (storage === 'cloud' ? getCloudFiles() : localFiles().filter(f => !storage || f.storage === storage));
export const useFiles = () => useValue(localFiles);

// ---------------------------------------------------------------------
// 웹: expo-file-system이 웹을 지원하지 않아서, 기기 파일은 브라우저 파일 저장소(OPFS의 planner-files 폴더)에 둠.
//   목록에는 webName(저장한 파일 이름)을 적고, 화면에는 읽어 들인 파일의 임시 주소(blob:)를 uri로 넘김.
//   (SQLite가 쓰는 6개짜리 파일 묶음과는 다른 폴더라 그 한도와 상관없음)
// ---------------------------------------------------------------------
const WEB = Platform.OS === 'web';
const WEB_DIR = 'planner-files';
const webUrls = new Map(); // webName → blob: 주소 (이 페이지가 열려 있는 동안만)
const webLoading = new Set();
let webVersion = 0;
const webDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(WEB_DIR, { create: true });
function loadWebUrl(name) {
  if (webUrls.has(name) || webLoading.has(name)) return;
  webLoading.add(name);
  (async () => {
    const file = await (await (await webDir()).getFileHandle(name)).getFile();
    webUrls.set(name, URL.createObjectURL(file));
    webVersion += 1;
    emitRuntime();
  })().catch(error => console.warn('[files] 브라우저에 저장한 파일을 읽지 못했습니다', name, error)).finally(() => webLoading.delete(name));
}
let webView = { rows: null, version: -1, out: EMPTY_ROWS() };
function EMPTY_ROWS() { return Object.freeze([]); }
/** 기기 파일 목록. 웹이면 uri를 읽어 들인 임시 주소로 바꿔 줌 (같은 목록이면 같은 배열: useSyncExternalStore용) */
function localFiles() {
  const rows = list('files');
  if (!WEB) return rows;
  if (webView.rows === rows && webView.version === webVersion) return webView.out;
  const out = rows.map(r => {
    if (!r.webName) return r;
    loadWebUrl(r.webName);
    return { ...r, uri: webUrls.get(r.webName) ?? '' };
  });
  webView = { rows, version: webVersion, out };
  return out;
}

// ---------------------------------------------------------------------
// 클라우드 파일
// ---------------------------------------------------------------------
const EMPTY = Object.freeze([]);
const KIND_BY_MIME = [[/^image\//, '이미지'], [/^audio\//, '녹음'], [/pdf$/, 'PDF'], [/presentation|powerpoint/, '슬라이드'], [/sheet|excel|csv/, '표']];
const kindOfMime = mime => KIND_BY_MIME.find(([re]) => re.test(mime ?? ''))?.[1] ?? '문서';
const sharedWorkspace = rt => { const ws = rt?.store.getCurrentWorkspace(); return ws && !ws.personal && ws.serverId ? ws : null; };
export const cloudAvailable = () => !!sharedWorkspace(maybeRuntime());

let cloud = { key: '', rows: EMPTY, texts: null };
let cloudRun = null;
let cloudAgain = false;
const cloudTexts = () => readPreference(scoped('cloud-file-text'), {}) ?? {};
function toCloudRow(a, texts) {
  return {
    id: a.id, storage: 'cloud', asset: a, name: a.original_name || '파일', title: a.original_name || '파일',
    kind: kindOfMime(a.mime_type), mimeType: a.mime_type, size: a.actual_size_bytes ?? a.declared_size_bytes,
    createdAt: Date.parse(a.created_at) || 0, text: texts[a.id] ?? '',
  };
}
function refreshCloud() {
  if (cloudRun) { cloudAgain = true; return cloudRun; }
  cloudRun = (async () => {
    const rt = maybeRuntime(); const ws = sharedWorkspace(rt);
    const key = ws ? `${rt.session.id}:${ws.serverId}` : '';
    const records = ws ? await engine.listLocal(rt.syncDb, ws.serverId, 'assets') : [];
    if (maybeRuntime() !== rt) return;
    const texts = ws ? cloudTexts() : {};
    const rows = records.map(r => r.data)
      .filter(a => a && a.purpose === 'ATTACHMENT' && a.status === 'AVAILABLE' && !a.deleted_at)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map(a => toCloudRow(a, texts));
    const same = cloud.key === key && cloud.texts === texts && JSON.stringify(cloud.rows.map(r => r.asset)) === JSON.stringify(rows.map(r => r.asset));
    if (same) return;
    cloud = { key, rows: Object.freeze(rows), texts };
    emitRuntime();
  })().catch(error => console.warn('[files] 클라우드 파일 목록을 읽지 못했습니다', error)).finally(() => {
    cloudRun = null;
    if (cloudAgain) { cloudAgain = false; void refreshCloud(); }
  });
  return cloudRun;
}
// 런타임 변경(동기화 결과, 작업 공간 전환 등) 후 다시 읽습니다. 여러 요청은 하나로 합칩니다.
let cloudTimer = null;
runtimeSubscribe(() => {
  if (cloudTimer) return;
  cloudTimer = setTimeout(() => { cloudTimer = null; void refreshCloud(); }, 150);
});
export function getCloudFiles() {
  const rt = maybeRuntime(); const ws = sharedWorkspace(rt);
  if (!ws) return EMPTY;
  if (cloud.key !== `${rt.session.id}:${ws.serverId}`) { void refreshCloud(); return EMPTY; }
  return cloud.rows;
}
export const useCloudFiles = () => useValue(getCloudFiles);

const sha256 = Platform.OS === 'web' ? undefined : bytes => digest(CryptoDigestAlgorithm.SHA256, bytes);
/** 파일을 선택해 현재 공유 작업 공간에 업로드합니다. { added, failed: [{ name, message }] }를 반환합니다. */
export async function pickAndUploadCloudFiles() {
  const rt = runtime(); const ws = sharedWorkspace(rt);
  if (!ws) throw new Error('클라우드 파일은 공유 공간에서만 올릴 수 있어요');
  const out = { added: 0, failed: [] };
  for (const asset of await pickAssets()) {
    try {
      const bytes = await readBytes(asset);
      await uploadAttachment(supabase, {
        workspaceId: ws.serverId, assetId: randomUUID(), bytes, name: asset.name ?? '파일',
        mimeType: uploadMimeOf(asset), digest: sha256,
      });
      out.added += 1;
    } catch (e) { out.failed.push({ name: asset.name ?? '파일', message: attachmentErrorMessage(e) }); }
  }
  if (out.added) { await rt.bridge.syncWorkspace(ws.id).catch(() => {}); await refreshCloud(); }
  return out;
}
export function checkCloudAsset(asset) {
  if (!asset?.uri && !(WEB && asset?.file)) return { ok: false, reason: '파일을 읽을 수 없어요' };
  const size = asset.size ?? asset.file?.size;
  if (Number.isFinite(size) && size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: '50MB보다 큰 파일이에요' };
  return { ok: true, reason: null };
}
/** 선택한 기기 파일 하나를 현재 공유 작업 공간에 업로드합니다. */
export async function uploadProjectFile(asset) {
  const rt = runtime(); const ws = sharedWorkspace(rt);
  if (!ws) throw new Error('클라우드 파일은 공유 공간에서만 올릴 수 있어요');
  const check = checkCloudAsset(asset);
  if (!check.ok) throw new Error(check.reason);
  let uploaded;
  try {
    uploaded = await uploadAttachment(supabase, {
      workspaceId: ws.serverId, assetId: randomUUID(), bytes: await readBytes(asset),
      name: asset.name ?? '파일', mimeType: uploadMimeOf(asset), digest: sha256,
    });
  } catch (error) {
    throw new Error(attachmentErrorMessage(error));
  }
  return uploaded;
}
export async function uploadLocalProjectFile(id) {
  const row = localFiles().find(file => file.id === id);
  if (!row) throw new Error('기기 파일을 찾을 수 없어요');
  const asset = { uri: row.uri, name: row.name, mimeType: row.mimeType, size: row.size };
  if (WEB && row.webName) {
    asset.file = await (await webDir()).getFileHandle(row.webName).getFile();
    asset.uri = asset.uri || `local:${row.id}`;
  }
  return uploadProjectFile(asset);
}
/** 클라우드 파일을 브라우저 또는 시스템 뷰어에서 엽니다(구성원 전용 1시간 링크). */
export async function openCloudFile(id) {
  const row = getCloudFiles().find(f => f.id === id);
  if (!row) throw new Error('파일을 찾을 수 없어요');
  try {
    const url = await getAttachmentUrl(supabase, row.asset);
    if (Platform.OS === 'web') window.open(url, '_blank', 'noopener'); else await Linking.openURL(url);
  } catch (e) { throw new Error(attachmentErrorMessage(e)); }
}
/** 모든 구성원의 클라우드 파일을 삭제합니다(업로더 또는 작업 공간 소유자만 가능). */
export async function deleteCloudFile(id) {
  const rt = runtime(); const ws = sharedWorkspace(rt);
  try { await deleteAttachment(supabase, id); } catch (e) { throw new Error(attachmentErrorMessage(e)); }
  const texts = { ...cloudTexts() }; delete texts[id]; writePreference(scoped('cloud-file-text'), texts);
  if (ws) await rt.bridge.syncWorkspace(ws.id).catch(() => {});
  await refreshCloud();
  return true;
}

// ---------------------------------------------------------------------
// 두 종류의 파일에서 내용을 인식합니다. 문서는 서버에서 텍스트를 추출하고(doc-extract), 사진은 클라우드 OCR을 사용합니다
// ("외부 AI로 전송" 동의 필요). 텍스트 파일은 여기서 읽습니다. 추출한 텍스트는 이 기기에만 저장되어 파일 검색에 사용됩니다.
// ---------------------------------------------------------------------
export const RECOGNIZED_MAX = 30000;
/** 텍스트를 반환합니다. 오류가 발생하면 화면에 표시할 메시지와 함께 예외를 던집니다. */
export async function recognizeFile(id) {
  const local = localFiles().find(f => f.id === id); // 웹이면 uri가 읽어 들인 임시 주소
  const remote = local ? null : getCloudFiles().find(f => f.id === id);
  const row = local ?? remote;
  if (!row) throw new Error('파일을 찾을 수 없어요');
  const asset = { uri: row.uri, name: row.name, mimeType: row.mimeType ?? mimeOfName(row.name) };
  const item = describe(asset);
  if (remote) item.bytes = await downloadAttachment(supabase, row.asset).catch(e => { throw new Error(attachmentErrorMessage(e)); });
  const done = await extract(item);
  if (done.status !== 'ready') throw new Error(done.error || '내용을 읽지 못했어요');
  const text = done.text.trim().slice(0, RECOGNIZED_MAX);
  if (local) saveList('files', list('files').map(f => (f.id === id ? { ...f, text, textAt: Date.now() } : f)));
  else { writePreference(scoped('cloud-file-text'), { ...cloudTexts(), [id]: text }); await refreshCloud(); }
  return text;
}
const MIME_BY_EXT = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json' };
const mimeOfName = name => MIME_BY_EXT[(String(name ?? '').split('.').pop() || '').toLowerCase()] ?? '';
const uploadMimeOf = asset => {
  const mime = String(asset?.mimeType ?? '').split(';')[0].trim().toLowerCase();
  const inferred = mimeOfName(asset?.name);
  if (['text/csv', 'text/markdown', 'application/json'].includes(mime)) return 'text/plain';
  if (mime && mime !== 'application/octet-stream' && mime !== 'application/zip') return mime;
  const inferredMime = ['text/csv', 'text/markdown', 'application/json'].includes(inferred) ? 'text/plain' : inferred;
  return inferredMime || mime || 'application/octet-stream';
};
/** 이 파일의 내용을 인식할 수 있는지 확인합니다(사진, PDF·Word·PowerPoint, 일반 텍스트). */
export const canRecognize = f => !!describe({ name: f.name, mimeType: f.mimeType ?? mimeOfName(f.name) }).kind;
export async function addAsset(asset, fields = {}) {
  if (!asset?.uri) throw new Error('기기 파일 경로가 필요합니다');
  const id = `local-${randomUUID()}`;
  const fileName = `${id}-${(asset.name ?? 'file').replace(/[^\w.가-힣-]/g, '_')}`;
  const base = { ...fields, id, storage: 'local', name: asset.name ?? fields.name ?? '파일', title: asset.name ?? fields.name ?? '파일',
    kind: fields.kind ?? '문서', mimeType: asset.mimeType ?? fields.mimeType, createdAt: Date.now() };
  let row;
  if (WEB) {
    // 고른 파일(File 객체) 또는 blob:/data: 주소의 내용을 브라우저 파일 저장소에 복사
    const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
    const handle = await (await webDir()).getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    webUrls.set(fileName, URL.createObjectURL(blob));
    webVersion += 1;
    row = { ...base, webName: fileName, uri: '', size: blob.size };
  } else {
    const target = new File(Paths.document, fileName);
    await new File(asset.uri).copy(target);
    row = { ...base, uri: target.uri, size: target.size };
  }
  saveList('files', [row, ...list('files')]);
  return WEB ? { ...row, uri: webUrls.get(row.webName) } : row;
}
const exportedName = (name, suffix) => {
  const original = (name || 'file').replace(/[\\/]/g, '_');
  if (!suffix) return original;
  const extensionIndex = original.lastIndexOf('.');
  if (extensionIndex <= 0) return `${original} (${suffix})`;
  return `${original.slice(0, extensionIndex)} (${suffix})${original.slice(extensionIndex)}`;
};
async function getBrowserFileName(directory, name) {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = exportedName(name, suffix);
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error?.name === 'NotFoundError') return candidate;
      if (error?.name !== 'TypeMismatchError') throw error;
    }
  }
}
async function saveInBrowser(row) {
  let handle;
  let directory = null;
  let fileName = null;
  try {
    if (typeof window.showDirectoryPicker === 'function') {
      directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      fileName = await getBrowserFileName(directory, row.name);
    } else if (typeof window.showSaveFilePicker === 'function') {
      handle = await window.showSaveFilePicker({ suggestedName: row.name || 'file' });
    } else {
      throw new Error('이 브라우저는 저장 위치 선택을 지원하지 않아요.');
    }
  } catch (error) {
    if (error?.name === 'AbortError' || /cancel/i.test(error?.message || '')) return null;
    throw error;
  }
  let blob;
  if (row.storage === 'cloud') {
    const bytes = await downloadAttachment(supabase, row.asset);
    blob = new Blob([bytes], { type: row.mimeType ?? mimeOfName(row.name) });
  } else {
    blob = row.webName
      ? await (await (await webDir()).getFileHandle(row.webName)).getFile()
      : await (await fetch(row.uri)).blob();
  }
  if (directory) handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return handle.name;
}
export async function downloadFileToDevice(id) {
  const row = localFiles().find(file => file.id === id) ?? getCloudFiles().find(file => file.id === id);
  if (!row) throw new Error('파일을 찾을 수 없어요');
  if (WEB) return saveInBrowser(row);

  let directory;
  try {
    directory = await Directory.pickDirectoryAsync();
  } catch (error) {
    if (error?.name === 'PickerCancelled' || /cancel/i.test(error?.message || '')) return null;
    throw error;
  }
  const existingNames = new Set(directory.list().map(file => file.name));
  let fileName = exportedName(row.name);
  for (let suffix = 1; existingNames.has(fileName); suffix += 1) fileName = exportedName(row.name, suffix);
  const mimeType = row.mimeType ?? mimeOfName(row.name);
  let source = row.uri;
  let temporary = null;
  try {
    if (row.storage === 'cloud') {
      const bytes = await downloadAttachment(supabase, row.asset);
      temporary = new File(Paths.cache, `${randomUUID()}-${(row.name || 'file').replace(/[^\w.-]/g, '_')}`);
      await temporary.write(bytes);
      source = temporary.uri;
    }
    const destination = directory.createFile(fileName, mimeType || null);
    await new File(source).copy(destination, { overwrite: true });
  } finally {
    if (temporary?.exists) temporary.delete();
  }
  return fileName;
}
export const addPhoto = value => addAsset(typeof value === 'string' ? { uri: value, name: '사진.jpg' } : value, { kind: '이미지' });
export const addRecording = (uri, seconds) => addAsset({ uri, name: '녹음.m4a' }, { kind: '녹음', seconds });
export async function deleteFile(id) {
  const row = list('files').find(f => f.id === id); if (!row) return false;
  const store = runtime().store;
  if ([...store.getMemos(), ...store.getTrashedMemos()].some(m => m.photos.includes(id))) throw new Error('메모에 첨부된 파일입니다. 첨부를 해제한 뒤 삭제해 주세요');
  if (row.webName) {
    try { await (await webDir()).removeEntry(row.webName); } catch { /* 이미 없음 */ }
    const url = webUrls.get(row.webName);
    if (url) { URL.revokeObjectURL(url); webUrls.delete(row.webName); }
  } else {
    const file = new File(row.uri); if (file.exists) file.delete();
  }
  saveList('files', list('files').filter(f => f.id !== id)); return true;
}
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 빠른 입력 안내와 같은 20MB
/** 올릴 수 있는 파일인지: { ok, reason } — reason은 화면에 보여 줄 글자 (ok면 null) */
export function checkAsset(asset) {
  if (!asset?.uri) return { ok: false, reason: '파일을 읽을 수 없어요' };
  const size = asset.size ?? asset.file?.size;
  if (Number.isFinite(size) && size > MAX_FILE_BYTES) return { ok: false, reason: '20MB보다 큰 파일이에요' };
  return { ok: true, reason: null };
}
export async function pickAssets() { const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true }); return r.canceled ? [] : r.assets; }
export async function pickAndAddFiles() { const rows = []; for (const asset of await pickAssets()) rows.push(await addAsset(asset)); return rows; }
