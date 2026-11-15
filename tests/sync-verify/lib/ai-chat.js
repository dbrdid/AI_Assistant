"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOT_FOUND_TEXT = exports.CHAT_LIMITS = void 0;
exports.trimHistory = trimHistory;
exports.planQuery = planQuery;
exports.containsWord = containsWord;
exports.rankRecords = rankRecords;
exports.excerptFor = excerptFor;
exports.todayIn = todayIn;
exports.toSources = toSources;
exports.answerQuery = answerQuery;
exports.askAssistant = askAssistant;
exports.chatErrorMessage = chatErrorMessage;
const supabase_js_1 = require("@supabase/supabase-js");
const errors_1 = require("./errors");
exports.CHAT_LIMITS = {
    questionChars: 2000,
    historyTurns: 6,
    historyTurnChars: 1000,
    historyTotalChars: 4000,
    sources: 12,
    sourceChars: 2500,
    sourcesTotalChars: 24000,
};
async function invoke(client, path, body) {
    const { data, error } = await client.functions.invoke(`ai-gateway/${path}`, { body });
    if (!error)
        return data;
    if (error instanceof supabase_js_1.FunctionsHttpError) {
        const res = error.context;
        let payload = null;
        try {
            payload = await res.json();
        }
        catch { /* 본문 없음 */ }
        throw new errors_1.AiError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? 'AI 요청이 실패했습니다', res.status, payload);
    }
    if (error instanceof supabase_js_1.FunctionsRelayError || error instanceof supabase_js_1.FunctionsFetchError) {
        throw new errors_1.AiError('NETWORK', '서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요', undefined, error);
    }
    throw new errors_1.AiError('UNKNOWN', String(error?.message ?? error), undefined, error);
}
/** 앞 대화를 서버 한도에 맞게 자름 (최근 것부터 남김) */
function trimHistory(history = []) {
    const out = [];
    let total = 0;
    for (const t of [...history].reverse()) {
        if (out.length >= exports.CHAT_LIMITS.historyTurns)
            break;
        const text = t.text.trim().slice(0, exports.CHAT_LIMITS.historyTurnChars);
        if (!text)
            continue;
        if (total + text.length > exports.CHAT_LIMITS.historyTotalChars)
            break;
        total += text.length;
        out.unshift({ role: t.role, text });
    }
    return out;
}
/** 1단계: 질문 → 검색 조건 */
async function planQuery(client, p) {
    const question = p.question.trim();
    if (!question)
        throw new errors_1.AiError('INVALID_REQUEST', '질문을 입력해 주세요');
    if (question.length > exports.CHAT_LIMITS.questionChars)
        throw new errors_1.AiError('INPUT_TOO_LONG', `질문은 ${exports.CHAT_LIMITS.questionChars}자까지 쓸 수 있어요`);
    const r = await invoke(client, 'query/plan', {
        client_request_id: p.clientRequestId, question, history: trimHistory(p.history),
        timezone: p.timezone ?? 'Asia/Seoul', today: p.today ?? null,
    });
    return r.draft;
}
// ---------------------------------------------------------------------
// 기기 검색 결과 고르기 (순수 함수)
// ---------------------------------------------------------------------
const norm = (s) => s.normalize('NFC').toLowerCase();
const nospace = (s) => s.replace(/\s+/g, '');
/** 낱말이 글에 있는지: 대소문자·띄어쓰기 차이 무시 ("중간 고사" = "중간고사") */
function containsWord(text, word) {
    const t = norm(text), w = norm(word.trim());
    if (!w)
        return false;
    return t.includes(w) || nospace(t).includes(nospace(w));
}
const dayOf = (d) => (d ? String(d).slice(0, 10) : null);
function countHits(text, word) {
    const t = nospace(norm(text)), w = nospace(norm(word));
    if (!w)
        return 0;
    let n = 0;
    for (let i = t.indexOf(w); i >= 0 && n < 5; i = t.indexOf(w, i + w.length))
        n++;
    return n;
}
/**
 * 검색 조건으로 기록을 고르고 순서를 정함
 *   - 종류·기간·상태는 거름 (기간 조건이 있으면 날짜 없는 기록은 뺌)
 *   - 키워드가 있으면 하나 이상 맞아야 함 (제목 3점, 본문 1점), 사람·프로젝트가 맞으면 2점 더
 *   - today: 'soonest'에서 지난 것보다 다가오는 것을 먼저
 */
function rankRecords(records, plan, opts = {}) {
    const types = new Set(plan.types);
    const limit = Math.max(1, Math.min(exports.CHAT_LIMITS.sources, opts.limit ?? plan.limit ?? 8));
    const scored = [];
    for (const r of records) {
        if (types.size > 0 && !types.has(r.type))
            continue;
        const day = dayOf(r.date);
        if (plan.date_from || plan.date_to) {
            if (!day)
                continue;
            if (plan.date_from && day < plan.date_from)
                continue;
            if (plan.date_to && day > plan.date_to)
                continue;
        }
        if (plan.status !== 'any' && (r.type === 'task' || r.type === 'event') && r.status && r.status !== plan.status)
            continue;
        let score = 0;
        let kwHit = false;
        for (const k of plan.keywords) {
            const t = countHits(r.title, k) * 3 + Math.min(countHits(r.text, k), 3)
                + ((r.project && containsWord(r.project, k)) || (r.people ?? []).some((p) => containsWord(p, k)) ? 1 : 0);
            if (t > 0)
                kwHit = true;
            score += t;
        }
        if (plan.keywords.length > 0 && !kwHit)
            continue;
        for (const name of plan.people) {
            if ((r.people ?? []).some((p) => containsWord(p, name)) || containsWord(r.text, name))
                score += 2;
        }
        if (plan.project && r.project && containsWord(r.project, plan.project))
            score += 2;
        scored.push({ r, score, day });
    }
    const byDay = (a, b, dir) => (a === b ? 0 : !a ? 1 : !b ? -1 : a < b ? -dir : dir);
    const today = opts.today ?? null;
    scored.sort((a, b) => {
        switch (plan.sort) {
            case 'newest': return byDay(a.day, b.day, -1) || b.score - a.score;
            case 'oldest': return byDay(a.day, b.day, 1) || b.score - a.score;
            case 'soonest': {
                if (today) {
                    const fa = a.day !== null && a.day >= today, fb = b.day !== null && b.day >= today;
                    if (fa !== fb)
                        return fa ? -1 : 1;
                    if (!fa)
                        return byDay(a.day, b.day, -1) || b.score - a.score; // 지난 것끼리는 최근 것 먼저
                }
                return byDay(a.day, b.day, 1) || b.score - a.score;
            }
            default: return b.score - a.score || byDay(a.day, b.day, -1);
        }
    });
    return scored.slice(0, limit).map((x) => x.r);
}
/** 본문에서 키워드 주변만 잘라 서버에 보낼 발췌 (기본 1,500자) */
function excerptFor(text, keywords, maxChars = 1500) {
    const t = text.trim();
    if (t.length <= maxChars)
        return t;
    const low = norm(t);
    let at = -1;
    for (const k of keywords) {
        const i = low.indexOf(norm(k.trim()));
        if (i >= 0 && (at < 0 || i < at))
            at = i;
    }
    const room = maxChars - 2; // 앞뒤 '…' 자리
    if (at < 0)
        return t.slice(0, room + 1) + '…';
    const start = Math.max(0, Math.min(at - Math.floor(room / 3), t.length - room));
    const body = t.slice(start, start + room);
    return `${start > 0 ? '…' : ''}${body}${start + room < t.length ? '…' : ''}`;
}
/** timezone 기준 오늘 YYYY-MM-DD (Intl이 없으면 기기 날짜) */
function todayIn(timezone = 'Asia/Seoul', now = new Date()) {
    try {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
            .formatToParts(now).map((x) => [x.type, x.value]));
        return `${p.year}-${p.month}-${p.day}`;
    }
    catch {
        const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
        return d.toISOString().slice(0, 10);
    }
}
/** rankRecords 결과 → 서버에 보낼 발췌 (글자 합계 한도 안으로) */
function toSources(records, keywords, perSource = 1500) {
    const out = [];
    let total = 0;
    for (const r of records.slice(0, exports.CHAT_LIMITS.sources)) {
        const title = r.title.slice(0, 200);
        const left = exports.CHAT_LIMITS.sourcesTotalChars - total - title.length;
        if (left < 100)
            break;
        const text = excerptFor(r.text ?? '', keywords, Math.min(perSource, left, exports.CHAT_LIMITS.sourceChars));
        total += title.length + text.length;
        out.push({ id: r.id, type: r.type, title, date: dayOf(r.date), text, workspace_id: r.workspaceId ?? null });
    }
    return out;
}
/** 3단계: 질문 + 발췌 → 답변 */
async function answerQuery(client, p) {
    const r = await invoke(client, 'query/answer', {
        client_request_id: p.clientRequestId, question: p.question.trim(), history: trimHistory(p.history),
        timezone: p.timezone ?? 'Asia/Seoul', today: p.today ?? null, sources: p.sources,
    });
    return { answer: r.draft, remaining: typeof r.remaining === 'number' ? r.remaining : null };
}
exports.NOT_FOUND_TEXT = '관련 기록을 찾지 못했어요. 다른 낱말로 묻거나 기간을 넓혀 보세요.';
/**
 * 질문 하나 처리 (화면에서 이것만 부르면 돼요)
 *   findRecords(plan): 기기 SQLite에서 후보 기록을 가져오는 함수 (조건으로 미리 걸러도 되고, 작은 앱이면 전부 줘도 됨)
 *   newId: 요청마다 새 UUID (ids.ts의 newId)
 *   예) const reply = await askAssistant(supabase, { question, history, newId, findRecords: (plan) => loadChatRecords(db, plan) })
 *       → setMessages(... { text: reply.text, sources: reply.sources })
 */
async function askAssistant(client, p) {
    const plan = await planQuery(client, { clientRequestId: p.newId(), question: p.question, history: p.history, timezone: p.timezone, today: p.today });
    if (plan.intent !== 'search') {
        return { text: plan.reply ?? '', sources: [], kind: 'direct', insufficient: false, followUps: [], plan, remaining: null };
    }
    const today = p.today ?? todayIn(p.timezone);
    const ranked = rankRecords(await p.findRecords(plan), plan, { today });
    if (ranked.length === 0) {
        return { text: exports.NOT_FOUND_TEXT, sources: [], kind: 'not_found', insufficient: true, followUps: [], plan, remaining: null };
    }
    const sources = toSources(ranked, plan.keywords);
    const { answer, remaining } = await answerQuery(client, {
        clientRequestId: p.newId(), question: p.question, history: p.history, timezone: p.timezone, today: p.today, sources,
    });
    const byId = new Map(ranked.map((r) => [r.id, r]));
    const quoteOf = (id) => answer.citations.find((c) => c.source_id === id)?.quote;
    return {
        text: answer.answer,
        sources: answer.used_source_ids.filter((id) => byId.has(id)).map((id) => ({ id, type: byId.get(id).type, title: byId.get(id).title || '(제목 없음)', quote: quoteOf(id) })),
        kind: 'answer',
        insufficient: answer.insufficient,
        followUps: answer.follow_ups,
        plan,
        remaining,
    };
}
function chatErrorMessage(err) {
    const code = err?.code ?? '';
    const map = {
        CONSENT_REQUIRED: 'AI 채팅을 쓰려면 외부 AI 사용에 동의해 주세요',
        QUOTA_EXCEEDED: '이번 달 AI 질문 횟수를 모두 썼어요',
        INPUT_TOO_LONG: '질문이나 대화가 너무 길어요. 줄여서 물어봐 주세요',
        FORBIDDEN: '더 이상 멤버가 아닌 공간의 기록이 섞여 있어요. 동기화한 뒤 다시 물어봐 주세요',
        NETWORK: '인터넷 연결을 확인해 주세요',
        PROVIDER_TIMEOUT: 'AI 응답이 늦어요. 잠시 후 다시 물어봐 주세요',
    };
    return map[code] ?? (err?.message || 'AI가 답하지 못했어요');
}
