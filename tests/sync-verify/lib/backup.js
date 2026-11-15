"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackupError = exports.BACKUP_MIME = exports.BACKUP_DEFAULT_KEEP = exports.BACKUP_FORMAT = void 0;
exports.bytesToBase64 = bytesToBase64;
exports.base64ToBytes = base64ToBytes;
exports.getBackupKey = getBackupKey;
exports.encryptBackup = encryptBackup;
exports.decryptBackup = decryptBackup;
exports.createBackup = createBackup;
exports.listBackups = listBackups;
exports.readBackup = readBackup;
exports.restoreBackup = restoreBackup;
exports.deleteBackup = deleteBackup;
exports.backupErrorMessage = backupErrorMessage;
const aes_1 = require("@noble/ciphers/aes");
const attachments_1 = require("./attachments");
const errors_1 = require("./errors");
exports.BACKUP_FORMAT = 1;
exports.BACKUP_DEFAULT_KEEP = 10;
exports.BACKUP_MIME = 'application/octet-stream';
const MAGIC = [0x53, 0x54, 0x42, 0x31]; // "STB1"
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
class BackupError extends Error {
    code;
    detail;
    constructor(code, message, detail) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.name = 'BackupError';
    }
}
exports.BackupError = BackupError;
// ---------------------------------------------------------------------
// base64 (Hermes에 Buffer가 없어서 직접)
// ---------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(b) {
    let out = '';
    for (let i = 0; i < b.length; i += 3) {
        const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
    }
    return out;
}
function base64ToBytes(s) {
    const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
            | ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) | (B64.indexOf(clean[i + 3] ?? 'A') & 63);
        out[o++] = (n >> 16) & 255;
        if (i + 2 < clean.length)
            out[o++] = (n >> 8) & 255;
        if (i + 3 < clean.length)
            out[o++] = n & 255;
    }
    return out.slice(0, o);
}
// ---------------------------------------------------------------------
// 키 · 암호화
// ---------------------------------------------------------------------
/** 내 백업 키 (32바이트). 처음이면 기기에서 만든 키를 서버에 저장 (두 기기가 동시에 만들어도 하나로) */
async function getBackupKey(client, randomBytes) {
    const candidate = randomBytes(32);
    if (!(candidate instanceof Uint8Array) || candidate.length !== 32)
        throw new BackupError('INVALID_REQUEST', 'randomBytes(32)가 32바이트를 돌려줘야 합니다');
    const { data, error } = await client.rpc('backup_key', { p_new_key: bytesToBase64(candidate) });
    if (error)
        throw (0, errors_1.toSyncError)(error);
    const key = base64ToBytes(data.key);
    if (key.length !== 32)
        throw new BackupError('BACKUP_KEY_INVALID', '백업 키가 올바르지 않아요');
    return key;
}
const aadOf = (assetId) => new TextEncoder().encode(`stella-backup:${assetId}`);
/** 평문 → 백업 파일 바이트 */
function encryptBackup(key, plain, assetId, randomBytes) {
    const nonce = randomBytes(NONCE_BYTES);
    const ct = (0, aes_1.gcm)(key, nonce, aadOf(assetId)).encrypt(plain);
    const out = new Uint8Array(MAGIC.length + NONCE_BYTES + ct.length);
    out.set(MAGIC, 0);
    out.set(nonce, MAGIC.length);
    out.set(ct, MAGIC.length + NONCE_BYTES);
    return out;
}
/** 백업 파일 바이트 → 평문. 손상됐거나 키·파일 id가 다르면 BACKUP_CORRUPT */
function decryptBackup(key, file, assetId) {
    if (file.length < MAGIC.length + NONCE_BYTES + TAG_BYTES || MAGIC.some((b, i) => file[i] !== b)) {
        throw new BackupError('BACKUP_CORRUPT', '백업 파일 형식이 아니에요');
    }
    const nonce = file.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
    try {
        return (0, aes_1.gcm)(key, nonce, aadOf(assetId)).decrypt(file.subarray(MAGIC.length + NONCE_BYTES));
    }
    catch (e) {
        throw new BackupError('BACKUP_CORRUPT', '백업 파일을 풀 수 없어요 (손상됐거나 다른 계정의 백업)', e);
    }
}
// ---------------------------------------------------------------------
// 백업 · 목록 · 복원 · 삭제
// ---------------------------------------------------------------------
function cleanCounts(c) {
    const out = {};
    for (const [k, v] of Object.entries(c ?? {}))
        if (typeof v === 'number' && Number.isFinite(v))
            out[k] = Math.max(0, Math.round(v));
    return out;
}
/** 백업하기. 반환: 새 백업 + 보관 개수를 넘어서 지운 오래된 백업 수 */
async function createBackup(client, p) {
    const { deps } = p;
    const counts = cleanCounts(p.counts);
    const payload = { format: exports.BACKUP_FORMAT, created_at: (deps.now?.() ?? new Date()).toISOString(), counts, data: p.data };
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    if (plain.length + MAGIC.length + NONCE_BYTES + TAG_BYTES > attachments_1.MAX_ATTACHMENT_BYTES) {
        throw new BackupError('TOO_LARGE', '백업이 50MB를 넘어요. 오래된 기록을 정리한 뒤 다시 시도해 주세요');
    }
    const key = await getBackupKey(client, deps.randomBytes);
    const assetId = deps.newId();
    const file = encryptBackup(key, plain, assetId, deps.randomBytes);
    await (0, attachments_1.uploadAttachment)(client, {
        workspaceId: null, purpose: 'BACKUP', assetId, bytes: file, mimeType: exports.BACKUP_MIME, name: 'stella-backup', digest: deps.digest,
    });
    const { data, error } = await client.rpc('backup_register', {
        p_asset_id: assetId, p_kind: p.kind ?? 'MANUAL', p_counts: counts,
        p_device_name: deps.deviceName ?? null, p_app_version: deps.appVersion ?? null,
        p_keep: p.keep ?? exports.BACKUP_DEFAULT_KEEP, p_format_version: exports.BACKUP_FORMAT,
    });
    if (error)
        throw (0, errors_1.toSyncError)(error);
    const r = data;
    // 보관 개수를 넘은 오래된 백업 지우기 (실패해도 백업 자체는 성공: 다음 백업 때 다시 지움)
    const removeFailed = [];
    for (const id of r.remove_asset_ids ?? []) {
        try {
            await (0, attachments_1.deleteAttachment)(client, id);
        }
        catch {
            removeFailed.push(id);
        }
    }
    return { backup: r.backup, removed: (r.remove_asset_ids ?? []).length - removeFailed.length, removeFailed };
}
/** 내 백업 목록 ('new' 최신순 / 'old' 오래된순) */
async function listBackups(client, order = 'new') {
    const { data, error } = await client.rpc('list_backups', { p_order: order });
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return (data ?? []);
}
/** 백업 하나를 받아서 풀기 (기기에 적용하지는 않음) */
async function readBackup(client, backup, deps) {
    const file = await (0, attachments_1.downloadAttachment)(client, backup);
    const key = await getBackupKey(client, deps.randomBytes);
    const plain = decryptBackup(key, file, backup.id);
    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(plain));
    }
    catch (e) {
        throw new BackupError('BACKUP_CORRUPT', '백업 내용을 읽을 수 없어요', e);
    }
    if (!payload || typeof payload !== 'object' || typeof payload.format !== 'number') {
        throw new BackupError('BACKUP_CORRUPT', '백업 내용을 읽을 수 없어요');
    }
    if (payload.format > exports.BACKUP_FORMAT)
        throw new BackupError('BACKUP_TOO_NEW', '더 새 버전 앱에서 만든 백업이에요. 앱을 업데이트해 주세요');
    return payload;
}
/**
 * 복원하기: ① 고른 백업을 받아 풀어 봄 → ② 지금 상태를 자동 백업 → ③ apply(data)
 *   ①에서 실패하면 아무것도 안 바뀜. ②가 실패하면 적용하지 않고 오류 (skipSafety: true면 ② 없이)
 */
async function restoreBackup(client, p) {
    const restored = await readBackup(client, p.backup, p.deps);
    let safety = null;
    if (!p.skipSafety) {
        try {
            // 자동 백업이 고른 백업을 지우지 않게 보관 개수를 하나 늘려서 계산
            safety = (await createBackup(client, { data: p.currentData, counts: p.currentCounts, kind: 'AUTO', keep: Math.min(50, (p.keep ?? exports.BACKUP_DEFAULT_KEEP) + 1), deps: p.deps })).backup;
        }
        catch (e) {
            throw new BackupError('SAFETY_BACKUP_FAILED', '복원 전에 지금 상태를 저장하지 못해서 복원하지 않았어요', e);
        }
    }
    await p.apply(restored.data, restored);
    return { restored, safety };
}
/** 백업 삭제 (본인 것만) */
async function deleteBackup(client, backupId) {
    await (0, attachments_1.deleteAttachment)(client, backupId);
}
/** 오류 → 화면 문구 */
function backupErrorMessage(err) {
    const code = err?.code ?? '';
    const text = {
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
