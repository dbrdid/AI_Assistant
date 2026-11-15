"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FAVORITES_MAX_PER_CALL = void 0;
exports.favoriteAction = favoriteAction;
exports.setNoteFavorites = setNoteFavorites;
exports.listNoteFavorites = listNoteFavorites;
exports.listNoteFavoritesByWorkspace = listNoteFavoritesByWorkspace;
exports.favoriteErrorMessage = favoriteErrorMessage;
const errors_1 = require("./errors");
exports.FAVORITES_MAX_PER_CALL = 500;
/** 선택한 메모가 전부 즐겨찾기면 'remove'(해제), 하나라도 아니면 'add' — 화면 규칙 그대로 */
function favoriteAction(selected) {
    return selected.length > 0 && selected.every((m) => !!m.favorite) ? 'remove' : 'add';
}
/** 즐겨찾기 켜기·끄기. 500개 넘으면 나눠서 보냄. 반환: 바뀐 개수 + 이 공간의 내 즐겨찾기 전체 */
async function setNoteFavorites(client, workspaceId, noteIds, favorite) {
    const ids = [...new Set(noteIds.filter(Boolean))];
    if (!workspaceId)
        throw new errors_1.SyncError('INVALID_REQUEST', '공유 공간에서만 서버에 저장해요 (개인 공간은 기기에)');
    if (ids.length === 0)
        throw new errors_1.SyncError('INVALID_REQUEST', '메모를 하나 이상 골라 주세요');
    let changed = 0;
    let all = [];
    for (let i = 0; i < ids.length; i += exports.FAVORITES_MAX_PER_CALL) {
        const { data, error } = await client.rpc('set_note_favorites', {
            p_workspace_id: workspaceId, p_note_ids: ids.slice(i, i + exports.FAVORITES_MAX_PER_CALL), p_favorite: favorite,
        });
        if (error)
            throw (0, errors_1.toSyncError)(error);
        const r = data;
        changed += r.changed;
        all = r.note_ids;
    }
    return { changed, noteIds: all };
}
/** 내 즐겨찾기 메모 id. workspaceId를 안 주면 내가 멤버인 모든 공유 공간 */
async function listNoteFavorites(client, workspaceId) {
    const { data, error } = await client.rpc('list_note_favorites', { p_workspace_id: workspaceId ?? null });
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return new Set((data ?? []).map((r) => r.note_id));
}
/** 공간별로 묶어서 (모든 공간을 한 번에 받을 때) */
async function listNoteFavoritesByWorkspace(client) {
    const { data, error } = await client.rpc('list_note_favorites', { p_workspace_id: null });
    if (error)
        throw (0, errors_1.toSyncError)(error);
    const out = new Map();
    for (const r of (data ?? [])) {
        if (!out.has(r.workspace_id))
            out.set(r.workspace_id, new Set());
        out.get(r.workspace_id).add(r.note_id);
    }
    return out;
}
/** 오류 → 화면 문구 */
function favoriteErrorMessage(err) {
    const code = err?.code ?? '';
    const text = {
        NOT_FOUND: '이 공간에 없는 메모가 섞여 있어요. 동기화한 뒤 다시 시도해 주세요',
        FORBIDDEN: '이 공간의 멤버가 아니에요',
        INVALID_REQUEST: '메모를 하나 이상 골라 주세요',
        NETWORK: '인터넷 연결을 확인해 주세요',
    };
    return text[code] ?? '즐겨찾기를 저장하지 못했어요. 잠시 후 다시 시도해 주세요';
}
