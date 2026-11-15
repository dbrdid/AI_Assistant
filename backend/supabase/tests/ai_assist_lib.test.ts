// 앱 모듈 ai-chat.ts · agenda-judge.ts ↔ ai-gateway assist.ts
//   가짜 client가 앱이 보낸 본문을 서버와 같은 parse 함수로 검사하고, 정해 둔 모델 출력을 서버와 같은 validate 함수로 거름
//   → 앱·서버 사이 칸 이름이 어긋나면 여기서 실패
//   실행: deno test -A --no-check --config deno.test.json ai_assist_lib.test.ts
//   앱 모듈 경로(아래 import)는 저장소에 둔 위치에 맞게 고치세요 (지금: ../../../frontend/Frontend_UI/src/lib/stella)
import nodeAssert from "node:assert/strict";
import { FunctionsFetchError, FunctionsHttpError } from "npm:@supabase/supabase-js@2";
import * as S from "../functions/ai-gateway/assist.ts";
import * as C from "../../../frontend/Frontend_UI/src/lib/stella/ai-chat.ts";
import * as G from "../../../frontend/Frontend_UI/src/lib/stella/agenda-judge.ts";

const eq = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepEqual(a, b, msg);
const NOW = new Date("2026-11-15T03:00:00Z");   // 서울 12시
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

type Script = (body: Record<string, unknown>) => unknown;
function fakeClient(scripts: Record<string, Script[]>, log: { path: string; body: Record<string, unknown> }[] = []) {
  let offline = false;
  const client = {
    setOffline(v: boolean) { offline = v; },
    functions: {
      async invoke(name: string, { body }: { body: Record<string, unknown> }) {
        if (offline) return { data: null, error: new FunctionsFetchError(new Error("offline")) };
        const path = name.replace("ai-gateway/", "");
        log.push({ path, body });
        const fail = (status: number, code: string, message = code, extra: Record<string, unknown> = {}) =>
          ({ data: null, error: new FunctionsHttpError(new Response(JSON.stringify({ ok: false, code, message, ...extra }), { status })) });
        try {
          const raw = scripts[path]?.shift()?.(body);
          if (raw instanceof Response) return { data: null, error: new FunctionsHttpError(raw) };
          if (path === "query/plan") {
            S.parsePlanInput(body, NOW);
            const d = S.validatePlan(raw);
            return d ? { data: { ok: true, request_id: "r", draft: d, remaining: 140, today: "2026-11-15" }, error: null } : fail(502, "OUTPUT_SCHEMA_INVALID");
          }
          if (path === "query/answer") {
            const a = S.parseAnswerInput(body, NOW);
            const d = S.validateAnswer(raw, a.sources);
            return d ? { data: { ok: true, request_id: "r", draft: d, remaining: 41 }, error: null } : fail(502, "OUTPUT_SCHEMA_INVALID");
          }
          if (path === "agenda/judge") {
            const g = S.parseAgendaInput(body, NOW);
            const d = S.validateAgenda(raw, g.items, g.discussions);
            return d ? { data: { ok: true, request_id: "r", draft: d, remaining: 49 }, error: null } : fail(502, "OUTPUT_SCHEMA_INVALID");
          }
          return fail(404, "NOT_FOUND");
        } catch (e) {
          if (e instanceof S.InputError) return fail(e.status, e.code, e.message, e.extra);
          throw e;
        }
      },
    },
  };
  return client as typeof client & never;
}

const plan = (o: Partial<C.QueryPlan> = {}): C.QueryPlan => ({
  intent: "search", reply: null, keywords: [], types: [], date_from: null, date_to: null, status: "any",
  people: [], project: null, sort: "relevance", limit: 8, ...o,
});

const RECORDS: C.ChatRecord[] = [
  { id: "m1", type: "memo", title: "중간고사 안내", text: "중간고사는 11월 25일 10시 공학관 301", date: "2026-11-10T09:00:00+09:00", project: "데이터베이스" },
  { id: "e1", type: "event", title: "중간 고사", text: "DB 과목 시험", date: "2026-11-25", status: "open" },
  { id: "e2", type: "event", title: "기말고사", text: "12월 시험", date: "2026-12-16", status: "open" },
  { id: "t1", type: "task", title: "시험 공부", text: "중간고사 3장까지 복습", date: "2026-11-24", status: "done", people: ["병욱"] },
  { id: "t2", type: "task", title: "ERD 제출", text: "지은이 담당", date: "2026-11-20", status: "open", people: ["지은"], workspaceId: "11111111-1111-4111-8111-111111111111" },
  { id: "f1", type: "file", title: "발표 자료.pdf", text: "", date: "2026-11-12" },
];

Deno.test("ai-chat.ts: 기기 기록 고르기·발췌", async (t) => {
  await t.step("키워드 (띄어쓰기 무시, 제목 가중치)", () => {
    const r = C.rankRecords(RECORDS, plan({ keywords: ["중간고사"] }));
    eq(r.map((x) => x.id), ["m1", "e1", "t1"], "제목에 있는 것 먼저, '중간 고사'도 맞음");
  });
  await t.step("종류·기간·상태 거르기", () => {
    eq(C.rankRecords(RECORDS, plan({ types: ["event", "task"], date_from: "2026-11-16", date_to: "2026-11-30", sort: "soonest" }), { today: "2026-11-15" }).map((x) => x.id),
       ["t2", "t1", "e1"], "기간 안, 다가오는 순");
    eq(C.rankRecords(RECORDS, plan({ types: ["event", "task"], status: "open", sort: "soonest" }), { today: "2026-11-15" }).map((x) => x.id),
       ["t2", "e1", "e2"], "끝난 할 일은 뺌");
    eq(C.rankRecords(RECORDS, plan({ date_from: "2026-11-11" })).some((x) => x.id === "m1"), false, "기간 밖 (시각은 날짜만 봄)");
    const undated = [...RECORDS, { id: "n1", type: "memo" as const, title: "날짜 없는 메모", text: "중간고사" }];
    eq(C.rankRecords(undated, plan({ keywords: ["중간고사"], date_to: "2026-12-31" })).some((x) => x.id === "n1"), false, "기간 조건이 있으면 날짜 없는 기록은 뺌");
    eq(C.rankRecords(undated, plan({ keywords: ["중간고사"] })).some((x) => x.id === "n1"), true, "기간 조건이 없으면 포함");
  });
  await t.step("사람·프로젝트 가산, 정렬", () => {
    eq(C.rankRecords(RECORDS, plan({ keywords: ["시험"], people: ["병욱"] })).map((x) => x.id)[0], "t1", "사람이 맞으면 앞으로");
    eq(C.rankRecords(RECORDS, plan({ keywords: ["301"], project: "데이터베이스" })).map((x) => x.id), ["m1"]);
    eq([C.containsWord("중간 고사 안내", "중간고사"), C.containsWord("ERD", "erd"), C.containsWord("abc", " ")], [true, true, false]);
    eq(C.rankRecords([{ ...RECORDS[3], people: ["유 병욱"] }, { ...RECORDS[0], text: "시험" }], plan({ keywords: ["시험"], people: ["유병욱"] })).map((x) => x.id)[0], "t1",
       "이름 띄어쓰기가 달라도 맞음");
    eq(C.rankRecords(RECORDS, plan({ types: ["event"], sort: "newest" })).map((x) => x.id), ["e2", "e1"]);
    eq(C.rankRecords(RECORDS, plan({ types: ["event"], sort: "oldest" })).map((x) => x.id), ["e1", "e2"]);
    eq(C.rankRecords(RECORDS, plan({ sort: "soonest" }), { today: "2026-11-21" }).map((x) => x.id), ["t1", "e1", "e2", "t2", "f1", "m1"],
       "다가오는 것 먼저(가까운 순), 지난 것은 최근 순");
    eq(C.rankRecords(RECORDS, plan({ limit: 99 })).length, 6);
    eq(C.rankRecords(RECORDS, plan({ keywords: ["없는말"] })), []);
  });
  await t.step("발췌·글자 한도", () => {
    const long = "가".repeat(3000) + "핵심 낱말" + "나".repeat(3000);
    const ex = C.excerptFor(long, ["핵심"], 1000);
    nodeAssert.ok(ex.length <= 1000 && ex.includes("핵심 낱말") && ex.startsWith("…") && ex.endsWith("…"), `${ex.length}`);
    eq(C.excerptFor("짧은 글", ["x"]), "짧은 글");
    const noHit = C.excerptFor("가".repeat(2000), ["x"], 100);
    eq([noHit.length <= 100, noHit.endsWith("…")], [true, true]);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, type: "memo" as const, title: "t", text: "가".repeat(5000) }));
    const src = C.toSources(many, []);
    const total = src.reduce((a, s) => a + s.title.length + s.text.length, 0);
    nodeAssert.ok(src.length <= 12 && total <= C.CHAT_LIMITS.sourcesTotalChars, `${src.length}개 ${total}자`);
    const big = C.toSources(many, [], 2500);
    const bigTotal = big.reduce((a, s) => a + s.title.length + s.text.length, 0);
    nodeAssert.ok(big.length < 12 && bigTotal <= C.CHAT_LIMITS.sourcesTotalChars && big.every((s) => s.text.length >= 100), `합계 한도에서 멈춤: ${big.length}개 ${bigTotal}자`);
    S.parseAnswerInput({ client_request_id: newId(), question: "q", sources: big }, NOW);   // 서버 검사 통과
    eq(C.toSources([RECORDS[4]], [])[0], { id: "t2", type: "task", title: "ERD 제출", date: "2026-11-20", text: "지은이 담당", workspace_id: "11111111-1111-4111-8111-111111111111" });
  });
  await t.step("앞 대화 자르기 (최근 것부터)", () => {
    const h = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `${i}`.repeat(900) }));
    const cut = C.trimHistory(h);
    eq([cut.length, cut.at(-1)!.text[0]], [4, "9"], "합계 4,000자 안에서 최근 4개");
    eq(C.trimHistory([{ role: "user", text: "  " }, { role: "user", text: "a" }]), [{ role: "user", text: "a" }]);
  });
  await t.step("오늘 날짜는 사용자 시간대 기준", () => {
    eq([C.todayIn("Asia/Seoul", new Date("2026-11-14T16:30:00Z")), C.todayIn("America/New_York", new Date("2026-11-14T16:30:00Z"))], ["2026-11-15", "2026-11-14"]);
  });
});

Deno.test("ai-chat.ts: askAssistant (2단계 흐름)", async (t) => {
  await t.step("검색 → 답변 → 화면 모양 { text, sources }", async () => {
    const log: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeClient({
      "query/plan": [() => ({ intent: "search", reply: null, keywords: ["중간고사"], types: [], date_from: null, date_to: null,
        status: "any", people: [], project: null, sort: "relevance", limit: 8 })],
      "query/answer": [(b) => {
        const srcs = b.sources as { id: string; text: string }[];
        eq(srcs.map((s) => s.id), ["m1", "e1", "t1"], "고른 기록이 순서대로 감");
        return { answer: "11월 25일 10시예요.", insufficient: false,
          citations: [{ source_id: "S2", quote: "DB 과목 시험" }, { source_id: "S1", quote: "11월 25일 10시" }, { source_id: "S3", quote: "만든 말" }],
          follow_ups: ["시험 범위는?"] };
      }],
    }, log);
    let asked: C.QueryPlan | null = null;
    const r = await C.askAssistant(client, { question: " 중간고사 언제야? ", newId, today: "2026-11-15",
      history: [{ role: "user", text: "안녕" }], findRecords: (p) => { asked = p; return RECORDS; } });
    eq([r.kind, r.text, r.insufficient, r.followUps, r.remaining], ["answer", "11월 25일 10시예요.", false, ["시험 범위는?"], 41]);
    eq(r.sources, [{ id: "e1", type: "event", title: "중간 고사", quote: "DB 과목 시험" }, { id: "m1", type: "memo", title: "중간고사 안내", quote: "11월 25일 10시" }],
       "인용된 순서대로, 원문에 없는 인용(t1)은 출처에서 빠짐");
    eq(asked!.keywords, ["중간고사"]);
    eq(log.map((l) => l.path), ["query/plan", "query/answer"]);
    eq([log[0].body.question, log[0].body.history, log[0].body.timezone], ["중간고사 언제야?", [{ role: "user", text: "안녕" }], "Asia/Seoul"]);
    nodeAssert.notEqual(log[0].body.client_request_id, log[1].body.client_request_id, "단계마다 새 요청 id");
  });

  await t.step("인사는 1단계 답으로 끝 (질문 횟수 안 씀)", async () => {
    const log: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeClient({ "query/plan": [() => ({ intent: "chitchat", reply: "안녕하세요!", keywords: [], types: [], date_from: null, date_to: null,
      status: "any", people: [], project: null, sort: "relevance", limit: 8 })] }, log);
    let searched = false;
    const r = await C.askAssistant(client, { question: "안녕", newId, findRecords: () => { searched = true; return []; } });
    eq([r.kind, r.text, r.sources, searched, log.length], ["direct", "안녕하세요!", [], false, 1]);
  });

  await t.step("찾은 기록이 없으면 답변 단계를 안 부름", async () => {
    const log: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeClient({ "query/plan": [() => ({ intent: "search", reply: null, keywords: ["장보기"], types: [], date_from: null, date_to: null,
      status: "any", people: [], project: null, sort: "relevance", limit: 8 })] }, log);
    const r = await C.askAssistant(client, { question: "장보기 목록", newId, findRecords: async () => RECORDS });
    eq([r.kind, r.text, r.insufficient, log.length], ["not_found", C.NOT_FOUND_TEXT, true, 1]);
  });

  await t.step("공유 공간 기록은 공간 id와 함께 감 (서버가 멤버 확인)", async () => {
    const log: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeClient({
      "query/plan": [() => ({ intent: "search", reply: null, keywords: ["ERD"], types: [], date_from: null, date_to: null, status: "any", people: [], project: null, sort: "relevance", limit: 8 })],
      "query/answer": [() => new Response(JSON.stringify({ ok: false, code: "FORBIDDEN", message: "x", workspace_ids: ["11111111-1111-4111-8111-111111111111"] }), { status: 403 })],
    }, log);
    const e = await C.askAssistant(client, { question: "ERD 언제까지?", newId, findRecords: () => RECORDS }).then(() => null, (x) => x);
    eq([e?.code, e?.status, C.chatErrorMessage(e)], ["FORBIDDEN", 403, "더 이상 멤버가 아닌 공간의 기록이 섞여 있어요. 동기화한 뒤 다시 물어봐 주세요"]);
    eq((log[1].body.sources as { workspace_id: string }[])[0].workspace_id, "11111111-1111-4111-8111-111111111111");
  });

  await t.step("오류: 빈 질문·긴 질문은 보내기 전에, 서버 오류·연결 오류는 문구로", async () => {
    const log: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeClient({ "query/plan": [() => new Response(JSON.stringify({ ok: false, code: "QUOTA_EXCEEDED", message: "x" }), { status: 429 })] }, log);
    const err = (p: Promise<unknown>) => p.then(() => null, (e) => e);
    eq((await err(C.askAssistant(client, { question: "  ", newId, findRecords: () => [] })))?.code, "INVALID_REQUEST");
    eq((await err(C.askAssistant(client, { question: "가".repeat(2001), newId, findRecords: () => [] })))?.code, "INPUT_TOO_LONG");
    eq(log.length, 0);
    // 화면 입력 한도(2000자)까지는 앱도 서버도 받음 (11/15 프론트 기준으로 1000 → 2000)
    eq([C.CHAT_LIMITS.questionChars, S.QUERY_LIMITS.questionChars, S.parsePlanInput({ client_request_id: crypto.randomUUID(), question: "가".repeat(2000) }).question.length], [2000, 2000, 2000]);
    const q = await err(C.askAssistant(client, { question: "q", newId, findRecords: () => [] }));
    eq([q?.code, C.chatErrorMessage(q)], ["QUOTA_EXCEEDED", "이번 달 AI 질문 횟수를 모두 썼어요"]);
    client.setOffline(true);
    eq(C.chatErrorMessage(await err(C.askAssistant(client, { question: "q", newId, findRecords: () => [] }))), "인터넷 연결을 확인해 주세요");
  });

  await t.step("서버 한도와 같은 값 (앱이 잘라 보내는 기준)", () => {
    eq([C.CHAT_LIMITS.sources, C.CHAT_LIMITS.sourceChars, C.CHAT_LIMITS.sourcesTotalChars, C.CHAT_LIMITS.historyTurns, C.CHAT_LIMITS.historyTotalChars, C.CHAT_LIMITS.questionChars],
       [S.QUERY_LIMITS.sources, S.QUERY_LIMITS.sourceChars, S.QUERY_LIMITS.sourcesTotalChars, S.QUERY_LIMITS.historyTurns, S.QUERY_LIMITS.historyTotalChars, S.QUERY_LIMITS.questionChars]);
    eq([G.AGENDA_JUDGE_LIMITS.items, G.AGENDA_JUDGE_LIMITS.itemTextChars, G.AGENDA_JUDGE_LIMITS.discussions, G.AGENDA_JUDGE_LIMITS.discussionTotalChars],
       [S.AGENDA_LIMITS.items, S.AGENDA_LIMITS.itemTextChars, S.AGENDA_LIMITS.discussions, S.AGENDA_LIMITS.discussionTotalChars]);
  });
});

// 안건 비교 화면 computeChanges가 만드는 모양
const CHANGES: G.AgendaChange[] = [
  { key: "memo:a", kind: "memo", status: "changed", title: "발표 담당", titleBefore: "발표 담당", bodyBefore: "발표는 내가", bodyAfter: "발표는 지은이" },
  { key: "task:b", kind: "task", status: "added", title: "ERD 수정", bodyAfter: "11/20까지" },
  { key: "file:c", kind: "file", status: "removed", title: "옛 기획서", titleBefore: "옛 기획서", bodyBefore: "v1" },
];
const TALK: G.AgendaDiscussion[] = [{ id: "rec-1", kind: "TRANSCRIPT", title: "회의 녹음", text: "[00:00] 발표는 지은이가 맡기로 했어요. ERD는 다음에." }];

Deno.test("agenda-judge.ts: 안건 비교 화면 연결", async (t) => {
  await t.step("화면 change → 서버 항목 (이전/이후 묶기)", () => {
    eq(G.toAgendaItems(CHANGES), [
      { key: "memo:a", kind: "memo", status: "changed", title: "발표 담당", before: "발표 담당\n발표는 내가", after: "발표 담당\n발표는 지은이", workspace_id: null },
      { key: "task:b", kind: "task", status: "added", title: "ERD 수정", before: null, after: "ERD 수정\n11/20까지", workspace_id: null },
      { key: "file:c", kind: "file", status: "removed", title: "옛 기획서", before: "옛 기획서\nv1", after: null, workspace_id: null },
    ]);
  });

  await t.step("판단 → { key: 'discussed' | 'open' }, 같은 입력은 캐시", async () => {
    const log: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeClient({ "agenda/judge": [() => ({ judgments: [
      { item_id: "I1", status: "discussed", reason: "담당 변경을 이야기함", evidence: "발표는 지은이가 맡기로", discussion_id: "D1" },
      { item_id: "I2", status: "discussed", reason: "ERD", evidence: "ERD는 20일까지", discussion_id: "D1" },
      { item_id: "I3", status: "open", reason: "언급 없음", evidence: "", discussion_id: null },
    ] })] }, log);
    const cache = new Map<string, G.AgendaJudgeResult>();
    const store: G.AgendaJudgeCache = { get: (k) => cache.get(k), set: (k, v) => { cache.set(k, v); } };
    const r = await G.judgeAgendaDiscussion(client, { changes: CHANGES, discussions: TALK, newId, projectTitle: "캡스톤", date: "2026-11-15", cache: store });
    eq(r.judged, { "memo:a": "discussed", "task:b": "open", "file:c": "open" }, "근거가 원문에 없으면 미논의");
    eq([r.details["memo:a"].discussion_id, r.details["task:b"].downgraded, r.fromCache, r.remaining], ["rec-1", true, false, 49]);
    eq(G.agendaJudgeSummary(r), "논의됨 1 · 미논의 2");
    eq([log[0].body.project_title, log[0].body.date, (log[0].body.items as unknown[]).length], ["캡스톤", "2026-11-15", 3]);
    const again = await G.judgeAgendaDiscussion(client, { changes: CHANGES, discussions: TALK, newId, projectTitle: "캡스톤", date: "2026-11-15", cache: store });
    eq([again.fromCache, again.judged, log.length], [true, r.judged, 1], "다시 열어도 서버 안 부름");
    const changed = await G.judgeAgendaDiscussion(client, { changes: CHANGES.slice(0, 1), discussions: TALK, newId, cache: store }).then(() => "called", (e) => e.code);
    eq([changed, log.length], ["OUTPUT_SCHEMA_INVALID", 2], "입력이 바뀌면 다시 부름 (여기선 준비한 답이 없어 형식 오류)");
  });

  await t.step("회의 자료가 없으면 부르지 않고 빈 결과 (화면에 표시 없음)", async () => {
    const log: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeClient({}, log);
    const r = await G.judgeAgendaDiscussion(client, { changes: CHANGES, discussions: [{ id: "x", text: "   " }], newId, cache: null });
    eq([r.judged, log.length], [{}, 0]);
    eq((await G.judgeAgendaDiscussion(client, { changes: [], discussions: TALK, newId, cache: null })).judged, {});
  });

  await t.step("한도 맞추기: 항목 50개, 회의 자료 합계 60,000자", async () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ key: `k${i}`, kind: "memo", status: "added" as const, title: `t${i}`, bodyAfter: "가".repeat(2000) }));
    const items = G.toAgendaItems(many);
    eq([items.length, items[0].after!.length], [50, 1500]);
    const { discussions, droppedChars } = G.toDiscussions([{ id: "a", text: "가".repeat(50000) }, { id: "b", text: "나".repeat(20000) }, { id: "c", text: "다" }]);
    eq([discussions.map((d) => d.text.length), droppedChars], [[50000, 10000], 10001]);
    const log: { path: string; body: Record<string, unknown> }[] = [];
    const client = fakeClient({ "agenda/judge": [() => ({ judgments: items.map((it, i) => ({ item_id: `I${i + 1}`, status: "open", reason: "", evidence: "", discussion_id: null })) })] }, log);
    const r = await G.judgeAgendaDiscussion(client, { changes: many, discussions: [{ id: "a", text: "가".repeat(70000) }], newId, cache: null });
    eq([Object.keys(r.judged).length, r.truncated], [50, { items: 5, discussionChars: 10000 }], "서버 검사를 통과하는 크기로 잘라 보냄");
  });

  await t.step("오류 문구", async () => {
    const client = fakeClient({ "agenda/judge": [() => new Response(JSON.stringify({ ok: false, code: "CONSENT_REQUIRED", message: "x" }), { status: 403 })] });
    const e = await G.judgeAgendaDiscussion(client, { changes: CHANGES, discussions: TALK, newId, cache: null }).then(() => null, (x) => x);
    eq(G.agendaJudgeErrorMessage(e), "안건 자동 판단을 쓰려면 외부 AI 사용에 동의해 주세요");
    eq(G.agendaInputKey({ a: 1 }) === G.agendaInputKey({ a: 1 }) && G.agendaInputKey({ a: 1 }) !== G.agendaInputKey({ a: 2 }), true);
  });
});
