// AI 채팅 (클라우드 AI 모드) — 팀 서버(로컬 AI 모드)와 같은 2단계
//
//   1) planQuery     질문 → 검색 조건 (키워드·종류·기간·상태·사람·프로젝트·정렬)   ai-gateway/query/plan   (질문 횟수에 안 들어감)
//   2) 앱이 기기에서 기록을 찾음 → rankRecords로 고르고 발췌를 만듦 (기록은 서버에 없음, 개인 기록은 기기에만)
//   3) answerQuery   질문 + 발췌(최대 12개) → 답변 + 출처                            ai-gateway/query/answer (질문 1회)
//   askAssistant가 1~3을 한 번에 하고, 화면(AiChatScreen)이 쓰는 { text, sources: [{ id, type, title }] }로 돌려줘요
//     - 인사·감사(chitchat)나 기록과 무관한 질문(unsupported)은 1단계 답으로 끝 (질문 횟수 안 씀)
//     - 기기에서 찾은 기록이 없으면 2단계를 부르지 않음 (질문 횟수 안 씀)
//     - 출처는 서버가 "인용 구절이 그 기록에 실제로 있는지" 확인한 것만 와요
//
//   외부 AI 동의(consents EXTERNAL_AI)가 있어야 해요. 질문·발췌는 서버에 저장되지 않아요 (ai_requests엔 해시·토큰 수만)
//   이 파일은 react-native를 쓰지 않아요
import type { SupabaseClient } from '@supabase/supabase-js';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { AiError } from './errors';

export const CHAT_LIMITS = {
  questionChars: 2000,
  historyTurns: 6,
  historyTurnChars: 1000,
  historyTotalChars: 4000,
  sources: 12,
  sourceChars: 2500,
  sourcesTotalChars: 24000,
} as const;

export type ChatRecordType = 'memo' | 'task' | 'event' | 'project' | 'meeting' | 'file';

export interface QueryPlan {
  intent: 'search' | 'chitchat' | 'unsupported';
  reply: string | null;
  keywords: string[];
  types: ChatRecordType[];
  date_from: string | null;   // YYYY-MM-DD (그날 포함)
  date_to: string | null;
  status: 'any' | 'open' | 'done';
  people: string[];
  project: string | null;
  sort: 'relevance' | 'newest' | 'oldest' | 'soonest';
  limit: number;
}

/** 기기에서 찾은 기록 하나 (앱이 SQLite 행에서 만듦) */
export interface ChatRecord {
  id: string;
  type: ChatRecordType;
  title: string;
  /** 본문·설명·전사문·추출한 문서 글자 */
  text: string;
  /** 대표 날짜: 할 일 = 마감, 일정 = 시작, 회의 = 회의 날짜, 나머지 = 수정 시각 (ISO 또는 YYYY-MM-DD) */
  date?: string | null;
  /** 할 일·일정: 'open' 안 끝남 / 'done' 끝남 */
  status?: 'open' | 'done' | null;
  /** 담당자·참석자 이름 */
  people?: string[];
  /** 프로젝트·공간 이름 */
  project?: string | null;
  /** 공유 공간 기록이면 공간 id (서버가 지금도 멤버인지 확인), 개인 기록이면 생략 */
  workspaceId?: string | null;
}

export interface ChatTurn { role: 'user' | 'assistant'; text: string }

export interface ChatAnswer {
  answer: string;
  insufficient: boolean;
  citations: { source_id: string; quote: string }[];
  follow_ups: string[];
  used_source_ids: string[];
  dropped_citations: number;
}

/** 화면에 그대로 쓰는 결과 (AiChatScreen의 answerFromApp 자리) */
export interface AssistantReply {
  text: string;
  sources: { id: string; type: ChatRecordType; title: string; quote?: string }[];
  kind: 'answer' | 'direct' | 'not_found';
  insufficient: boolean;
  followUps: string[];
  plan: QueryPlan;
  /** 이번 달 남은 질문 수 (답변까지 간 경우만) */
  remaining: number | null;
}

type GatewayOk<T> = { ok: true; request_id: string; draft: T; remaining?: number; today?: string };

async function invoke<T>(client: SupabaseClient, path: string, body: Record<string, unknown>): Promise<GatewayOk<T>> {
  const { data, error } = await client.functions.invoke<GatewayOk<T>>(`ai-gateway/${path}`, { body });
  if (!error) return data as GatewayOk<T>;
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response;
    let payload: { code?: string; message?: string } | null = null;
    try { payload = await res.json(); } catch { /* 본문 없음 */ }
    throw new AiError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? 'AI 요청이 실패했습니다', res.status, payload);
  }
  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    throw new AiError('NETWORK', '서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요', undefined, error);
  }
  throw new AiError('UNKNOWN', String((error as Error)?.message ?? error), undefined, error);
}

/** 앞 대화를 서버 한도에 맞게 자름 (최근 것부터 남김) */
export function trimHistory(history: ChatTurn[] = []): ChatTurn[] {
  const out: ChatTurn[] = [];
  let total = 0;
  for (const t of [...history].reverse()) {
    if (out.length >= CHAT_LIMITS.historyTurns) break;
    const text = t.text.trim().slice(0, CHAT_LIMITS.historyTurnChars);
    if (!text) continue;
    if (total + text.length > CHAT_LIMITS.historyTotalChars) break;
    total += text.length;
    out.unshift({ role: t.role, text });
  }
  return out;
}

/** 1단계: 질문 → 검색 조건 */
export async function planQuery(client: SupabaseClient, p: {
  clientRequestId: string; question: string; history?: ChatTurn[]; timezone?: string; today?: string;
}): Promise<QueryPlan> {
  const question = p.question.trim();
  if (!question) throw new AiError('INVALID_REQUEST', '질문을 입력해 주세요');
  if (question.length > CHAT_LIMITS.questionChars) throw new AiError('INPUT_TOO_LONG', `질문은 ${CHAT_LIMITS.questionChars}자까지 쓸 수 있어요`);
  const r = await invoke<QueryPlan>(client, 'query/plan', {
    client_request_id: p.clientRequestId, question, history: trimHistory(p.history),
    timezone: p.timezone ?? 'Asia/Seoul', today: p.today ?? null,
  });
  return r.draft;
}

// ---------------------------------------------------------------------
// 기기 검색 결과 고르기 (순수 함수)
// ---------------------------------------------------------------------
const norm = (s: string) => s.normalize('NFC').toLowerCase();
const nospace = (s: string) => s.replace(/\s+/g, '');

/** 낱말이 글에 있는지: 대소문자·띄어쓰기 차이 무시 ("중간 고사" = "중간고사") */
export function containsWord(text: string, word: string): boolean {
  const t = norm(text), w = norm(word.trim());
  if (!w) return false;
  return t.includes(w) || nospace(t).includes(nospace(w));
}

const dayOf = (d: string | null | undefined) => (d ? String(d).slice(0, 10) : null);

function countHits(text: string, word: string): number {
  const t = nospace(norm(text)), w = nospace(norm(word));
  if (!w) return 0;
  let n = 0;
  for (let i = t.indexOf(w); i >= 0 && n < 5; i = t.indexOf(w, i + w.length)) n++;
  return n;
}

/**
 * 검색 조건으로 기록을 고르고 순서를 정함
 *   - 종류·기간·상태는 거름 (기간 조건이 있으면 날짜 없는 기록은 뺌)
 *   - 키워드가 있으면 하나 이상 맞아야 함 (제목 3점, 본문 1점), 사람·프로젝트가 맞으면 2점 더
 *   - today: 'soonest'에서 지난 것보다 다가오는 것을 먼저
 */
export function rankRecords(records: ChatRecord[], plan: QueryPlan, opts: { today?: string; limit?: number } = {}): ChatRecord[] {
  const types = new Set(plan.types);
  const limit = Math.max(1, Math.min(CHAT_LIMITS.sources, opts.limit ?? plan.limit ?? 8));
  const scored: { r: ChatRecord; score: number; day: string | null }[] = [];
  for (const r of records) {
    if (types.size > 0 && !types.has(r.type)) continue;
    const day = dayOf(r.date);
    if (plan.date_from || plan.date_to) {
      if (!day) continue;
      if (plan.date_from && day < plan.date_from) continue;
      if (plan.date_to && day > plan.date_to) continue;
    }
    if (plan.status !== 'any' && (r.type === 'task' || r.type === 'event') && r.status && r.status !== plan.status) continue;
    let score = 0;
    let kwHit = false;
    for (const k of plan.keywords) {
      const t = countHits(r.title, k) * 3 + Math.min(countHits(r.text, k), 3)
        + ((r.project && containsWord(r.project, k)) || (r.people ?? []).some((p) => containsWord(p, k)) ? 1 : 0);
      if (t > 0) kwHit = true;
      score += t;
    }
    if (plan.keywords.length > 0 && !kwHit) continue;
    for (const name of plan.people) {
      if ((r.people ?? []).some((p) => containsWord(p, name)) || containsWord(r.text, name)) score += 2;
    }
    if (plan.project && r.project && containsWord(r.project, plan.project)) score += 2;
    scored.push({ r, score, day });
  }
  const byDay = (a: string | null, b: string | null, dir: 1 | -1) => (a === b ? 0 : !a ? 1 : !b ? -1 : a < b ? -dir : dir);
  const today = opts.today ?? null;
  scored.sort((a, b) => {
    switch (plan.sort) {
      case 'newest': return byDay(a.day, b.day, -1) || b.score - a.score;
      case 'oldest': return byDay(a.day, b.day, 1) || b.score - a.score;
      case 'soonest': {
        if (today) {
          const fa = a.day !== null && a.day >= today, fb = b.day !== null && b.day >= today;
          if (fa !== fb) return fa ? -1 : 1;
          if (!fa) return byDay(a.day, b.day, -1) || b.score - a.score;   // 지난 것끼리는 최근 것 먼저
        }
        return byDay(a.day, b.day, 1) || b.score - a.score;
      }
      default: return b.score - a.score || byDay(a.day, b.day, -1);
    }
  });
  return scored.slice(0, limit).map((x) => x.r);
}

/** 본문에서 키워드 주변만 잘라 서버에 보낼 발췌 (기본 1,500자) */
export function excerptFor(text: string, keywords: string[], maxChars = 1500): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const low = norm(t);
  let at = -1;
  for (const k of keywords) {
    const i = low.indexOf(norm(k.trim()));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const room = maxChars - 2;   // 앞뒤 '…' 자리
  if (at < 0) return t.slice(0, room + 1) + '…';
  const start = Math.max(0, Math.min(at - Math.floor(room / 3), t.length - room));
  const body = t.slice(start, start + room);
  return `${start > 0 ? '…' : ''}${body}${start + room < t.length ? '…' : ''}`;
}

/** timezone 기준 오늘 YYYY-MM-DD (Intl이 없으면 기기 날짜) */
export function todayIn(timezone = 'Asia/Seoul', now = new Date()): string {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
  }
}

/** rankRecords 결과 → 서버에 보낼 발췌 (글자 합계 한도 안으로) */
export function toSources(records: ChatRecord[], keywords: string[], perSource = 1500) {
  const out: { id: string; type: ChatRecordType; title: string; date: string | null; text: string; workspace_id: string | null }[] = [];
  let total = 0;
  for (const r of records.slice(0, CHAT_LIMITS.sources)) {
    const title = r.title.slice(0, 200);
    const left = CHAT_LIMITS.sourcesTotalChars - total - title.length;
    if (left < 100) break;
    const text = excerptFor(r.text ?? '', keywords, Math.min(perSource, left, CHAT_LIMITS.sourceChars));
    total += title.length + text.length;
    out.push({ id: r.id, type: r.type, title, date: dayOf(r.date), text, workspace_id: r.workspaceId ?? null });
  }
  return out;
}

/** 3단계: 질문 + 발췌 → 답변 */
export async function answerQuery(client: SupabaseClient, p: {
  clientRequestId: string; question: string; history?: ChatTurn[]; timezone?: string; today?: string;
  sources: ReturnType<typeof toSources>;
}): Promise<{ answer: ChatAnswer; remaining: number | null }> {
  const r = await invoke<ChatAnswer>(client, 'query/answer', {
    client_request_id: p.clientRequestId, question: p.question.trim(), history: trimHistory(p.history),
    timezone: p.timezone ?? 'Asia/Seoul', today: p.today ?? null, sources: p.sources,
  });
  return { answer: r.draft, remaining: typeof r.remaining === 'number' ? r.remaining : null };
}

export const NOT_FOUND_TEXT = '관련 기록을 찾지 못했어요. 다른 낱말로 묻거나 기간을 넓혀 보세요.';

/**
 * 질문 하나 처리 (화면에서 이것만 부르면 돼요)
 *   findRecords(plan): 기기 SQLite에서 후보 기록을 가져오는 함수 (조건으로 미리 걸러도 되고, 작은 앱이면 전부 줘도 됨)
 *   newId: 요청마다 새 UUID (ids.ts의 newId)
 *   예) const reply = await askAssistant(supabase, { question, history, newId, findRecords: (plan) => loadChatRecords(db, plan) })
 *       → setMessages(... { text: reply.text, sources: reply.sources })
 */
export async function askAssistant(client: SupabaseClient, p: {
  question: string;
  history?: ChatTurn[];
  newId: () => string;
  findRecords: (plan: QueryPlan) => Promise<ChatRecord[]> | ChatRecord[];
  timezone?: string;
  today?: string;
}): Promise<AssistantReply> {
  const plan = await planQuery(client, { clientRequestId: p.newId(), question: p.question, history: p.history, timezone: p.timezone, today: p.today });
  if (plan.intent !== 'search') {
    return { text: plan.reply ?? '', sources: [], kind: 'direct', insufficient: false, followUps: [], plan, remaining: null };
  }
  const today = p.today ?? todayIn(p.timezone);
  const ranked = rankRecords(await p.findRecords(plan), plan, { today });
  if (ranked.length === 0) {
    return { text: NOT_FOUND_TEXT, sources: [], kind: 'not_found', insufficient: true, followUps: [], plan, remaining: null };
  }
  const sources = toSources(ranked, plan.keywords);
  const { answer, remaining } = await answerQuery(client, {
    clientRequestId: p.newId(), question: p.question, history: p.history, timezone: p.timezone, today: p.today, sources,
  });
  const byId = new Map(ranked.map((r) => [r.id, r]));
  const quoteOf = (id: string) => answer.citations.find((c) => c.source_id === id)?.quote;
  return {
    text: answer.answer,
    sources: answer.used_source_ids.filter((id) => byId.has(id)).map((id) => ({ id, type: byId.get(id)!.type, title: byId.get(id)!.title || '(제목 없음)', quote: quoteOf(id) })),
    kind: 'answer',
    insufficient: answer.insufficient,
    followUps: answer.follow_ups,
    plan,
    remaining,
  };
}

export function chatErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  const map: Record<string, string> = {
    CONSENT_REQUIRED: 'AI 채팅을 쓰려면 외부 AI 사용에 동의해 주세요',
    QUOTA_EXCEEDED: '이번 달 AI 질문 횟수를 모두 썼어요',
    INPUT_TOO_LONG: '질문이나 대화가 너무 길어요. 줄여서 물어봐 주세요',
    FORBIDDEN: '더 이상 멤버가 아닌 공간의 기록이 섞여 있어요. 동기화한 뒤 다시 물어봐 주세요',
    NETWORK: '인터넷 연결을 확인해 주세요',
    PROVIDER_TIMEOUT: 'AI 응답이 늦어요. 잠시 후 다시 물어봐 주세요',
  };
  return map[code] ?? ((err as { message?: string })?.message || 'AI가 답하지 못했어요');
}
