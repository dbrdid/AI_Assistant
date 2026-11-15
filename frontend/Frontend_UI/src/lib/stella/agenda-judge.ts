// 안건 논의 판단 (클라우드 AI) — 안건 비교 화면(AgendaCompareScreen)의 '논의됨 / 미논의' 표시
//
//   화면이 계산한 "달라진 항목"(computeChanges의 changes) + 그날 회의 자료(회의 메모·녹음 전사문)를 보내면
//   항목마다 discussed(논의됨) / open(미논의)과 이유·근거 구절을 돌려줘요     ai-gateway/agenda/judge (월 FREE 50 / PRO 500회)
//     - 화면이 쓰는 모양 그대로: judged = { [change.key]: 'discussed' | 'open' }
//     - 근거 구절은 서버가 회의 자료 원문에 실제로 있는지 확인해요. 없으면 미논의로 낮춰요 (확신 없으면 미논의 → 사용자가 확인)
//     - 회의 자료가 없으면 서버를 부르지 않고 빈 결과 (화면에 표시 없음)
//     - 같은 입력은 캐시에서 돌려줘요 (화면을 다시 열 때마다 횟수를 쓰지 않게). 기기에 오래 두려면 cache에 SQLite 저장소를 넘기세요
//
//   외부 AI 동의가 있어야 해요. 회의 내용은 서버에 저장되지 않아요
//   이 파일은 react-native를 쓰지 않아요
import type { SupabaseClient } from '@supabase/supabase-js';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { AiError } from './errors';

export const AGENDA_JUDGE_LIMITS = {
  items: 50,
  itemTextChars: 1500,
  titleChars: 200,
  discussions: 10,
  discussionTotalChars: 60000,
} as const;

/** AgendaCompareScreen의 computeChanges가 만드는 항목 (필요한 칸만) */
export interface AgendaChange {
  key: string;
  kind: string;                         // 'memo' | 'task' | 'file' …
  status: 'added' | 'changed' | 'removed';
  title?: string | null;
  titleBefore?: string | null;
  bodyBefore?: string | null;
  bodyAfter?: string | null;
  workspaceId?: string | null;
}

/** 그날 회의 자료 */
export interface AgendaDiscussion {
  id: string;
  /** 'MEETING_NOTE' | 'TRANSCRIPT' | 'MEMO' 등 */
  kind?: string;
  title?: string;
  /** 회의 메모 본문 또는 녹음 전사문 (recordings.ts의 tr.text 그대로 — 빠진 구간 표시 포함) */
  text: string;
  workspaceId?: string | null;
}

export interface AgendaJudgment {
  key: string;
  status: 'discussed' | 'open';
  reason: string;
  evidence: string | null;
  discussion_id: string | null;
  downgraded: boolean;
}

export interface AgendaJudgeResult {
  /** 화면용: { [key]: 'discussed' | 'open' } */
  judged: Record<string, 'discussed' | 'open'>;
  details: Record<string, AgendaJudgment>;
  fromCache: boolean;
  /** 이번 달 남은 판단 횟수 (서버를 불렀을 때만) */
  remaining: number | null;
  /** 한도 때문에 잘라서 보낸 것: 항목 수·회의 자료 글자 */
  truncated: { items: number; discussionChars: number };
}

export interface AgendaJudgeCache {
  get(key: string): Promise<AgendaJudgeResult | null | undefined> | AgendaJudgeResult | null | undefined;
  set(key: string, value: AgendaJudgeResult): Promise<void> | void;
}

const memory = new Map<string, AgendaJudgeResult>();
/** 기본 캐시: 앱이 켜져 있는 동안만 (최근 100개) */
export const memoryAgendaCache: AgendaJudgeCache = {
  get: (k) => memory.get(k) ?? null,
  set: (k, v) => {
    memory.set(k, v);
    if (memory.size > 100) memory.delete(memory.keys().next().value as string);
  },
};

/** 입력 지문 (FNV-1a 두 개 → 16자리, crypto 없이) */
export function agendaInputKey(payload: unknown): string {
  const s = JSON.stringify(payload);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

const cut = (s: string | null | undefined, n: number) => (s ? String(s).slice(0, n) : null);
const join = (a?: string | null, b?: string | null) => [a?.trim(), b?.trim()].filter(Boolean).join('\n') || null;

/** 화면의 change → 서버 항목 (제목·본문을 이전/이후로 묶음) */
export function toAgendaItems(changes: AgendaChange[]) {
  return changes.slice(0, AGENDA_JUDGE_LIMITS.items).map((c) => ({
    key: c.key,
    kind: c.kind,
    status: c.status,
    title: cut(c.title ?? c.titleBefore ?? '', AGENDA_JUDGE_LIMITS.titleChars) ?? '',
    before: c.status === 'added' ? null : cut(join(c.titleBefore, c.bodyBefore), AGENDA_JUDGE_LIMITS.itemTextChars),
    after: c.status === 'removed' ? null : cut(join(c.title, c.bodyAfter), AGENDA_JUDGE_LIMITS.itemTextChars),
    workspace_id: c.workspaceId ?? null,
  }));
}

/** 회의 자료를 합계 한도 안으로 (앞 자료부터 채우고 넘치는 자료는 자름) */
export function toDiscussions(ds: AgendaDiscussion[]) {
  const out: { id: string; kind: string; title: string; text: string; workspace_id: string | null }[] = [];
  let left = AGENDA_JUDGE_LIMITS.discussionTotalChars;
  let dropped = 0;
  for (const d of ds) {
    const text = (d.text ?? '').trim();
    if (!text) continue;
    if (out.length >= AGENDA_JUDGE_LIMITS.discussions || left <= 0) { dropped += text.length; continue; }
    const kept = text.slice(0, left);
    dropped += text.length - kept.length;
    left -= kept.length;
    out.push({ id: d.id, kind: d.kind ?? 'MEMO', title: (d.title ?? '').slice(0, AGENDA_JUDGE_LIMITS.titleChars), text: kept, workspace_id: d.workspaceId ?? null });
  }
  return { discussions: out, droppedChars: dropped };
}

const EMPTY = (truncated = { items: 0, discussionChars: 0 }): AgendaJudgeResult => ({ judged: {}, details: {}, fromCache: false, remaining: null, truncated });

/**
 * 판단하기
 *   const r = await judgeAgendaDiscussion(supabase, { changes, discussions, projectTitle: project.title, date: day, newId })
 *   setJudged(r.judged)
 *   (AgendaJudge.js의 judgeDiscussion 자리: 그날 프로젝트에 연결된 회의 메모·녹음 전사문을 discussions로 모아서 넘기면 돼요)
 */
export async function judgeAgendaDiscussion(client: SupabaseClient, p: {
  changes: AgendaChange[];
  discussions: AgendaDiscussion[];
  newId: () => string;
  projectTitle?: string | null;
  date?: string | null;
  timezone?: string;
  cache?: AgendaJudgeCache | null;
}): Promise<AgendaJudgeResult> {
  const items = toAgendaItems(p.changes);
  const { discussions, droppedChars } = toDiscussions(p.discussions);
  const truncated = { items: Math.max(0, p.changes.length - items.length), discussionChars: droppedChars };
  if (items.length === 0 || discussions.length === 0) return EMPTY(truncated);

  const body = {
    project_title: p.projectTitle ?? null, date: p.date ?? null, timezone: p.timezone ?? 'Asia/Seoul', items, discussions,
  };
  const cache = p.cache === undefined ? memoryAgendaCache : p.cache;
  const key = agendaInputKey(body);
  const hit = cache ? await cache.get(key) : null;
  if (hit) return { ...hit, fromCache: true };

  const { data, error } = await client.functions.invoke<{ ok: true; draft: AgendaJudgment[]; remaining?: number }>('ai-gateway/agenda/judge', {
    body: { client_request_id: p.newId(), ...body },
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      let payload: { code?: string; message?: string } | null = null;
      try { payload = await res.json(); } catch { /* 본문 없음 */ }
      throw new AiError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? '안건을 판단하지 못했습니다', res.status, payload);
    }
    if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
      throw new AiError('NETWORK', '서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요', undefined, error);
    }
    throw new AiError('UNKNOWN', String((error as Error)?.message ?? error), undefined, error);
  }
  const list = data!.draft;
  const result: AgendaJudgeResult = {
    judged: Object.fromEntries(list.map((j) => [j.key, j.status])),
    details: Object.fromEntries(list.map((j) => [j.key, j])),
    fromCache: false,
    remaining: typeof data!.remaining === 'number' ? data!.remaining : null,
    truncated,
  };
  if (cache) await cache.set(key, result);
  return result;
}

/** 요약 문구: "논의됨 3 · 미논의 2" */
export function agendaJudgeSummary(r: Pick<AgendaJudgeResult, 'judged'>): string {
  const v = Object.values(r.judged);
  return `논의됨 ${v.filter((x) => x === 'discussed').length} · 미논의 ${v.filter((x) => x === 'open').length}`;
}

export function agendaJudgeErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  const map: Record<string, string> = {
    CONSENT_REQUIRED: '안건 자동 판단을 쓰려면 외부 AI 사용에 동의해 주세요',
    QUOTA_EXCEEDED: '이번 달 안건 판단 횟수를 모두 썼어요',
    INPUT_TOO_LONG: '회의 내용이 너무 길어요',
    FORBIDDEN: '더 이상 멤버가 아닌 공간의 기록이 섞여 있어요',
    NETWORK: '인터넷 연결을 확인해 주세요',
  };
  return map[code] ?? ((err as { message?: string })?.message || '안건을 판단하지 못했어요');
}
