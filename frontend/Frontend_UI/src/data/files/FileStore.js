import { randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { list, saveList, useValue, runtime } from '../hooks';
export const getFiles = storage => list('files').filter(f => !storage || f.storage === storage);
export const useFiles = () => useValue(() => list('files'));
export async function addAsset(asset, fields = {}) {
  if (!asset?.uri) throw new Error('기기 파일 경로가 필요합니다');
  const id = `local-${randomUUID()}`; const target = new File(Paths.document, `${id}-${(asset.name ?? 'file').replace(/[^\w.가-힣-]/g, '_')}`);
  new File(asset.uri).copy(target);
  const row = { ...fields, id, storage: 'local', name: asset.name ?? fields.name ?? '파일', title: asset.name ?? fields.name ?? '파일',
    uri: target.uri, size: target.size, kind: fields.kind ?? '문서', createdAt: Date.now() };
  saveList('files', [row, ...list('files')]); return row;
}
export const addPhoto = value => addAsset(typeof value === 'string' ? { uri: value, name: '사진.jpg' } : value, { kind: '이미지' });
export const addRecording = (uri, seconds) => addAsset({ uri, name: '녹음.m4a' }, { kind: '녹음', seconds });
export async function deleteFile(id) {
  const row = list('files').find(f => f.id === id); if (!row) return false;
  const store = runtime().store;
  if ([...store.getMemos(), ...store.getTrashedMemos()].some(m => m.photos.includes(id))) throw new Error('메모에 첨부된 파일입니다. 첨부를 해제한 뒤 삭제해 주세요');
  const file = new File(row.uri); if (file.exists) file.delete();
  saveList('files', list('files').filter(f => f.id !== id)); return true;
}
export const checkAsset = asset => ({ ok: Boolean(asset?.uri), reason: asset?.uri ? null : 'missing' });
export async function pickAssets() { const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true }); return r.canceled ? [] : r.assets; }
export async function pickAndAddFiles() { const rows = []; for (const asset of await pickAssets()) rows.push(await addAsset(asset)); return rows; }
