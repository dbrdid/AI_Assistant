"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryAgendaCache = exports.AGENDA_JUDGE_LIMITS = void 0;
exports.agendaInputKey = agendaInputKey;
exports.toAgendaItems = toAgendaItems;
exports.toDiscussions = toDiscussions;
exports.judgeAgendaDiscussion = judgeAgendaDiscussion;
exports.agendaJudgeSummary = agendaJudgeSummary;
exports.agendaJudgeErrorMessage = agendaJudgeErrorMessage;
const supabase_js_1 = require("@supabase/supabase-js");
const errors_1 = require("./errors");
exports.AGENDA_JUDGE_LIMITS = {
    items: 50,
    itemTextChars: 1500,
    titleChars: 200,
    discussions: 10,
    discussionTotalChars: 60000,
};
const memory = new Map();
/** 기본 캐시: 앱이 켜져 있는 동안만 (최근 100개) */
exports.memoryAgendaCache = {
    get: (k) => memory.get(k) ?? null,
    set: (k, v) => {
        memory.set(k, v);
        if (memory.size > 100)
            memory.delete(memory.keys().next().value);
    },
};
/** 입력 지문 (FNV-1a 두 개 → 16자리, crypto 없이) */
function agendaInputKey(payload) {
    const s = JSON.stringify(payload);
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
const cut = (s, n) => (s ? String(s).slice(0, n) : null);
const join = (a, b) => [a?.trim(), b?.trim()].filter(Boolean).join('\n') || null;
/** 화면의 change → 서버 항목 (제목·본문을 이전/이후로 묶음) */
function toAgendaItems(changes) {
    return changes.slice(0, exports.AGENDA_JUDGE_LIMITS.items).map((c) => ({
        key: c.key,
        kind: c.kind,
        status: c.status,
        title: cut(c.title ?? c.titleBefore ?? '', exports.AGENDA_JUDGE_LIMITS.titleChars) ?? '',
        before: c.status === 'added' ? null : cut(join(c.titleBefore, c.bodyBefore), exports.AGENDA_JUDGE_LIMITS.itemTextChars),
        after: c.status === 'removed' ? null : cut(join(c.title, c.bodyAfter), exports.AGENDA_JUDGE_LIMITS.itemTextChars),
        workspace_id: c.workspaceId ?? null,
    }));
}
/** 회의 자료를 합계 한도 안으로 (앞 자료부터 채우고 넘치는 자료는 자름) */
function toDiscussions(ds) {
    const out = [];
    let left = exports.AGENDA_JUDGE_LIMITS.discussionTotalChars;
    let dropped = 0;
    for (const d of ds) {
        const text = (d.text ?? '').trim();
        if (!text)
            continue;
        if (out.length >= exports.AGENDA_JUDGE_LIMITS.discussions || left <= 0) {
            dropped += text.length;
            continue;
        }
        const kept = text.slice(0, left);
        dropped += text.length - kept.length;
        left -= kept.length;
        out.push({ id: d.id, kind: d.kind ?? 'MEMO', title: (d.title ?? '').slice(0, exports.AGENDA_JUDGE_LIMITS.titleChars), text: kept, workspace_id: d.workspaceId ?? null });
    }
    return { discussions: out, droppedChars: dropped };
}
const EMPTY = (truncated = { items: 0, discussionChars: 0 }) => ({ judged: {}, details: {}, fromCache: false, remaining: null, truncated });
/**
 * 판단하기
 *   const r = await judgeAgendaDiscussion(supabase, { changes, discussions, projectTitle: project.title, date: day, newId })
 *   setJudged(r.judged)
 *   (AgendaJudge.js의 judgeDiscussion 자리: 그날 프로젝트에 연결된 회의 메모·녹음 전사문을 discussions로 모아서 넘기면 돼요)
 */
async function judgeAgendaDiscussion(client, p) {
    const items = toAgendaItems(p.changes);
    const { discussions, droppedChars } = toDiscussions(p.discussions);
    const truncated = { items: Math.max(0, p.changes.length - items.length), discussionChars: droppedChars };
    if (items.length === 0 || discussions.length === 0)
        return EMPTY(truncated);
    const body = {
        project_title: p.projectTitle ?? null, date: p.date ?? null, timezone: p.timezone ?? 'Asia/Seoul', items, discussions,
    };
    const cache = p.cache === undefined ? exports.memoryAgendaCache : p.cache;
    const key = agendaInputKey(body);
    const hit = cache ? await cache.get(key) : null;
    if (hit)
        return { ...hit, fromCache: true };
    const { data, error } = await client.functions.invoke('ai-gateway/agenda/judge', {
        body: { client_request_id: p.newId(), ...body },
    });
    if (error) {
        if (error instanceof supabase_js_1.FunctionsHttpError) {
            const res = error.context;
            let payload = null;
            try {
                payload = await res.json();
            }
            catch { /* 본문 없음 */ }
            throw new errors_1.AiError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? '안건을 판단하지 못했습니다', res.status, payload);
        }
        if (error instanceof supabase_js_1.FunctionsRelayError || error instanceof supabase_js_1.FunctionsFetchError) {
            throw new errors_1.AiError('NETWORK', '서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요', undefined, error);
        }
        throw new errors_1.AiError('UNKNOWN', String(error?.message ?? error), undefined, error);
    }
    const list = data.draft;
    const result = {
        judged: Object.fromEntries(list.map((j) => [j.key, j.status])),
        details: Object.fromEntries(list.map((j) => [j.key, j])),
        fromCache: false,
        remaining: typeof data.remaining === 'number' ? data.remaining : null,
        truncated,
    };
    if (cache)
        await cache.set(key, result);
    return result;
}
/** 요약 문구: "논의됨 3 · 미논의 2" */
function agendaJudgeSummary(r) {
    const v = Object.values(r.judged);
    return `논의됨 ${v.filter((x) => x === 'discussed').length} · 미논의 ${v.filter((x) => x === 'open').length}`;
}
function agendaJudgeErrorMessage(err) {
    const code = err?.code ?? '';
    const map = {
        CONSENT_REQUIRED: '안건 자동 판단을 쓰려면 외부 AI 사용에 동의해 주세요',
        QUOTA_EXCEEDED: '이번 달 안건 판단 횟수를 모두 썼어요',
        INPUT_TOO_LONG: '회의 내용이 너무 길어요',
        FORBIDDEN: '더 이상 멤버가 아닌 공간의 기록이 섞여 있어요',
        NETWORK: '인터넷 연결을 확인해 주세요',
    };
    return map[code] ?? (err?.message || '안건을 판단하지 못했어요');
}
