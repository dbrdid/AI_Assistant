// 백업·복원 (#31, 화면 BackupScreen 기준) — 개인 공간 기록을 기기에서 암호화해서 클라우드에. React Native 의존 없음
//   서버: backup_key · backup_register · list_backups + 기존 첨부 업로드(assets, purpose BACKUP, backups 버킷)
//   암호화: AES-256-GCM (@noble/ciphers, 순수 JS라 Hermes에서도 돌아감). 키는 계정마다 하나, 서버에 보관 (11/15 결정)
//           → 새 기기에서도 로그인만 하면 복원. 파일은 암호화돼서 저장소만으로는 못 읽음 (DB 관리자는 이론상 가능)
//   파일 모양: "STB1"(4바이트) + nonce(12바이트) + 암호문(+태그 16바이트). 추가 인증 데이터 = 'stella-backup:' + assetId
//             (다른 백업 파일과 바꿔치기하면 풀리지 않음). 속 내용 = JSON { format, created_at, counts, data }
//
//   [백업하기] 개인 공간일 때만 (화면: not-personal 안내)
//     const r = await createBackup(supabase, { data: 개인 기록(JSON으로 바꿀 수 있는 값), counts: { memos, tasks, projects }, deps });
//     r.removed → 보관 개수(keep, 기본 10)를 넘어서 지운 오래된 백업 수 ("가장 오래된 백업 n개는 지워졌어요")
//   [목록] await listBackups(supabase, 'new' | 'old')  → [{ id, created_at, auto, counts, size_bytes }]
//   [복원하기] await restoreBackup(supabase, { backup, currentData, currentCounts, apply, deps })
//     ① 고른 백업을 받아서 풀어 봄(손상·키 불일치면 여기서 멈춤) → ② 지금 상태를 "자동" 백업으로 → ③ apply(data)로 기기에 적용
//     r.safety → 남겨 둔 자동 백업 ("복원 전 상태는 자동 백업으로 남겨 뒀어요")
//   [삭제] await deleteBackup(supabase, id)
//   deps: { newId, randomBytes: (n) => Crypto.getRandomBytes(n), digest: (b) => Crypto.digest(SHA256, b) } (expo-crypto)
import type { SupabaseClient } from '@supabase/supabase-js';
import { gcm } from '@noble/ciphers/aes';
import { deleteAttachment, downloadAttachment, uploadAttachment, MAX_ATTACHMENT_BYTES } from './attachments';
import { toSyncError } from './errors';

export const BACKUP_FORMAT = 1;
export const BACKUP_DEFAULT_KEEP = 10;
export const BACKUP_MIME = 'application/octet-stream';
const MAGIC = [0x53, 0x54, 0x42, 0x31];   // "STB1"
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class BackupError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
    this.name = 'BackupError';
  }
}

export type BackupCounts = Record<string, number>;
export interface BackupInfo {
  id: string;                 // = 백업 파일(asset) id
  kind: 'MANUAL' | 'AUTO';
  auto: boolean;              // 화면 "자동" 표시
  created_at: string;
  counts: BackupCounts;       // { memos, tasks, projects, ... }
  size_bytes: number;
  sha256: string;
  format_version: number;
  device_name: string | null;
  app_version: string | null;
  bucket_id: string;
  object_path: string;
}
export interface BackupPayload<T = unknown> {
  format: number;
  created_at: string;
  counts: BackupCounts;
  data: T;
}
export interface BackupDeps {
  newId: () => string;
  /** 무작위 바이트. 앱: (n) => Crypto.getRandomBytes(n) (expo-crypto) */
  randomBytes: (n: number) => Uint8Array;
  /** SHA-256. 앱: (b) => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, b) (Node·웹은 생략 가능) */
  digest?: (bytes: Uint8Array) => Promise<ArrayBuffer>;
  deviceName?: string | null;
  appVersion?: string | null;
  now?: () => Date;
}

// ---------------------------------------------------------------------
// base64 (Hermes에 Buffer가 없어서 직접)
// ---------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return out;
}
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) | (B64.indexOf(clean[i + 3] ?? 'A') & 63);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.slice(0, o);
}

// ---------------------------------------------------------------------
// 키 · 암호화
// ---------------------------------------------------------------------
/** 내 백업 키 (32바이트). 처음이면 기기에서 만든 키를 서버에 저장 (두 기기가 동시에 만들어도 하나로) */
export async function getBackupKey(client: SupabaseClient, randomBytes: BackupDeps['randomBytes']): Promise<Uint8Array> {
  const candidate = randomBytes(32);
  if (!(candidate instanceof Uint8Array) || candidate.length !== 32) throw new BackupError('INVALID_REQUEST', 'randomBytes(32)가 32바이트를 돌려줘야 합니다');
  const { data, error } = await client.rpc('backup_key', { p_new_key: bytesToBase64(candidate) });
  if (error) throw toSyncError(error);
  const key = base64ToBytes((data as { key: string }).key);
  if (key.length !== 32) throw new BackupError('BACKUP_KEY_INVALID', '백업 키가 올바르지 않아요');
  return key;
}

const aadOf = (assetId: string) => new TextEncoder().encode(`stella-backup:${assetId}`);

/** 평문 → 백업 파일 바이트 */
export function encryptBackup(key: Uint8Array, plain: Uint8Array, assetId: string, randomBytes: BackupDeps['randomBytes']): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = gcm(key, nonce, aadOf(assetId)).encrypt(plain);
  const out = new Uint8Array(MAGIC.length + NONCE_BYTES + ct.length);
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  out.set(ct, MAGIC.length + NONCE_BYTES);
  return out;
}

/** 백업 파일 바이트 → 평문. 손상됐거나 키·파일 id가 다르면 BACKUP_CORRUPT */
export function decryptBackup(key: Uint8Array, file: Uint8Array, assetId: string): Uint8Array {
  if (file.length < MAGIC.length + NONCE_BYTES + TAG_BYTES || MAGIC.some((b, i) => file[i] !== b)) {
    throw new BackupError('BACKUP_CORRUPT', '백업 파일 형식이 아니에요');
  }
  const nonce = file.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  try {
    return gcm(key, nonce, aadOf(assetId)).decrypt(file.subarray(MAGIC.length + NONCE_BYTES));
  } catch (e) {
    throw new BackupError('BACKUP_CORRUPT', '백업 파일을 풀 수 없어요 (손상됐거나 다른 계정의 백업)', e);
  }
}

// ---------------------------------------------------------------------
// 백업 · 목록 · 복원 · 삭제
// ---------------------------------------------------------------------
function cleanCounts(c: BackupCounts | null | undefined): BackupCounts {
  const out: BackupCounts = {};
  for (const [k, v] of Object.entries(c ?? {})) if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(0, Math.round(v));
  return out;
}

/** 백업하기. 반환: 새 백업 + 보관 개수를 넘어서 지운 오래된 백업 수 */
export async function createBackup<T>(
  client: SupabaseClient,
  p: { data: T; counts?: BackupCounts; kind?: 'MANUAL' | 'AUTO'; keep?: number; deps: BackupDeps },
): Promise<{ backup: BackupInfo; removed: number; removeFailed: string[] }> {
  const { deps } = p;
  const counts = cleanCounts(p.counts);
  const payload: BackupPayload<T> = { format: BACKUP_FORMAT, created_at: (deps.now?.() ?? new Date()).toISOString(), counts, data: p.data };
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  if (plain.length + MAGIC.length + NONCE_BYTES + TAG_BYTES > MAX_ATTACHMENT_BYTES) {
    throw new BackupError('TOO_LARGE', '백업이 50MB를 넘어요. 오래된 기록을 정리한 뒤 다시 시도해 주세요');
  }
  const key = await getBackupKey(client, deps.randomBytes);
  const assetId = deps.newId();
  const file = encryptBackup(key, plain, assetId, deps.randomBytes);

  await uploadAttachment(client, {
    workspaceId: null, purpose: 'BACKUP', assetId, bytes: file, mimeType: BACKUP_MIME, name: 'stella-backup', digest: deps.digest,
  });
  const { data, error } = await client.rpc('backup_register', {
    p_asset_id: assetId, p_kind: p.kind ?? 'MANUAL', p_counts: counts,
    p_device_name: deps.deviceName ?? null, p_app_version: deps.appVersion ?? null,
    p_keep: p.keep ?? BACKUP_DEFAULT_KEEP, p_format_version: BACKUP_FORMAT,
  });
  if (error) throw toSyncError(error);
  const r = data as { backup: BackupInfo; remove_asset_ids: string[] };
  // 보관 개수를 넘은 오래된 백업 지우기 (실패해도 백업 자체는 성공: 다음 백업 때 다시 지움)
  const removeFailed: string[] = [];
  for (const id of r.remove_asset_ids ?? []) {
    try { await deleteAttachment(client, id); } catch { removeFailed.push(id); }
  }
  return { backup: r.backup, removed: (r.remove_asset_ids ?? []).length - removeFailed.length, removeFailed };
}

/** 내 백업 목록 ('new' 최신순 / 'old' 오래된순) */
export async function listBackups(client: SupabaseClient, order: 'new' | 'old' = 'new'): Promise<BackupInfo[]> {
  const { data, error } = await client.rpc('list_backups', { p_order: order });
  if (error) throw toSyncError(error);
  return (data ?? []) as BackupInfo[];
}

/** 백업 하나를 받아서 풀기 (기기에 적용하지는 않음) */
export async function readBackup<T = unknown>(
  client: SupabaseClient,
  backup: Pick<BackupInfo, 'id' | 'bucket_id' | 'object_path'>,
  deps: Pick<BackupDeps, 'randomBytes'>,
): Promise<BackupPayload<T>> {
  const file = await downloadAttachment(client, backup);
  const key = await getBackupKey(client, deps.randomBytes);
  const plain = decryptBackup(key, file, backup.id);
  let payload: BackupPayload<T>;
  try {
    payload = JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    throw new BackupError('BACKUP_CORRUPT', '백업 내용을 읽을 수 없어요', e);
  }
  if (!payload || typeof payload !== 'object' || typeof payload.format !== 'number') {
    throw new BackupError('BACKUP_CORRUPT', '백업 내용을 읽을 수 없어요');
  }
  if (payload.format > BACKUP_FORMAT) throw new BackupError('BACKUP_TOO_NEW', '더 새 버전 앱에서 만든 백업이에요. 앱을 업데이트해 주세요');
  return payload;
}

/**
 * 복원하기: ① 고른 백업을 받아 풀어 봄 → ② 지금 상태를 자동 백업 → ③ apply(data)
 *   ①에서 실패하면 아무것도 안 바뀜. ②가 실패하면 적용하지 않고 오류 (skipSafety: true면 ② 없이)
 */
export async function restoreBackup<T>(
  client: SupabaseClient,
  p: {
    backup: Pick<BackupInfo, 'id' | 'bucket_id' | 'object_path'>;
    currentData: unknown;
    currentCounts?: BackupCounts;
    apply: (data: T, payload: BackupPayload<T>) => Promise<void> | void;
    deps: BackupDeps;
    keep?: number;
    skipSafety?: boolean;
  },
): Promise<{ restored: BackupPayload<T>; safety: BackupInfo | null }> {
  const restored = await readBackup<T>(client, p.backup, p.deps);
  let safety: BackupInfo | null = null;
  if (!p.skipSafety) {
    try {
      // 자동 백업이 고른 백업을 지우지 않게 보관 개수를 하나 늘려서 계산
      safety = (await createBackup(client, { data: p.currentData, counts: p.currentCounts, kind: 'AUTO', keep: Math.min(50, (p.keep ?? BACKUP_DEFAULT_KEEP) + 1), deps: p.deps })).backup;
    } catch (e) {
      throw new BackupError('SAFETY_BACKUP_FAILED', '복원 전에 지금 상태를 저장하지 못해서 복원하지 않았어요', e);
    }
  }
  await p.apply(restored.data, restored);
  return { restored, safety };
}

/** 백업 삭제 (본인 것만) */
export async function deleteBackup(client: SupabaseClient, backupId: string): Promise<void> {
  await deleteAttachment(client, backupId);
}

/** 오류 → 화면 문구 */
export function backupErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  const text: Record<string, string> = {
    QUOTA_EXCEEDED: '백업 용량이 가득 찼어요. 오래된 백업을 지우고 다시 시도해 주세요',
    TOO_LARGE: '백업이 50MB를 넘어요. 오래된 기록을 정리한 뒤 다시 시도해 주세요',
    BACKUP_CORRUPT: '백업 파일을 풀 수 없어요 (손상됐거나 다른 계정의 백업)',
    BACKUP_TOO_NEW: '더 새 버전 앱에서 만든 백업이에요. 앱을 업데이트해 주세요',
    SAFETY_BACKUP_FAILED: '복원 전에 지금 상태를 저장하지 못해서 복원하지 않았어요. 저장 공간을 확인해 주세요',
    NOT_FOUND: '백업을 찾을 수 없어요',
    NETWORK: '인터넷 연결을 확인해 주세요',
    UPLOAD_FAILED: '백업 파일을 올리지 못했어요. 잠시 후 다시 시도해 주세요',
  };
  return text[code] ?? '백업하지 못했어요. 저장 공간이 부족할 수 있어요. 오래된 백업을 지우고 다시 시도해 주세요.';
}

