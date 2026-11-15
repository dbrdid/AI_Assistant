// 앱 모듈 project-team.ts ↔ 화면 규칙 · 프로젝트 초대 RPC (로컬 DB, RLS 그대로) 테스트 (Deno)
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check --config deno.test.json project_team_lib.test.ts
import nodeAssert from "node:assert/strict";
import pg from "npm:pg@8";
import * as P from "../../../frontend/Frontend_UI/src/lib/stella/project-team.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const throwsCode = (fn: () => unknown, code: string) =>
  nodeAssert.throws(fn, (e: Error & { code?: string }) => { eq(e.code, code); return true; });

// 프론트 TeamScreen.wouldRemoveAllLeaders 그대로 (비교 기준)
function frontWouldRemoveAllLeaders(members: { id: string; role: string }[], picked: string[]) {
  const leaders = members.filter((m) => m.role === "팀장");
  return leaders.length > 0 && leaders.every((m) => picked.includes(m.id));
}

Deno.test("팀장 삭제 규칙 = 프론트 TeamScreen", () => {
  const ms = [{ id: "a", role: "팀장" }, { id: "b", role: "팀원" }, { id: "c", role: "팀장" }, { id: "d", role: "디자이너" }];
  const picks = [[], ["a"], ["a", "c"], ["b", "d"], ["a", "b", "c", "d"], ["c"], ["x"]];
  for (const p of picks) eq(P.wouldRemoveAllLeaders(ms, p), frontWouldRemoveAllLeaders(ms, p), JSON.stringify(p));
  eq(P.wouldRemoveAllLeaders([{ id: "b", role: "팀원" }], ["b"]), false, "팀장이 없으면 막지 않음 (화면과 같음)");
  throwsCode(() => P.teamChanges.remove(ms, ["a", "c"]), "LAST_LEADER");
  eq(P.teamChanges.remove(ms, ["a", "b"]).map((c) => c.kind), ["delete", "delete"]);
});

Deno.test("teamChanges: 이름 20자·역할 12자, 앞뒤 공백 정리, 이동", () => {
  const add = P.teamChanges.add("m1", "p1", { name: "  김디자  ", role: " 디자이너 " });
  eq(add, [{ kind: "create", entity: "project_members", id: "m1", data: { project_id: "p1", name: "김디자", role: "디자이너", account_id: null, position: 0 } }]);
  eq((P.teamChanges.add("m2", "p1", { name: "이름" })[0] as { data: { role: string } }).data.role, "팀원", "역할 기본 팀원");
  throwsCode(() => P.teamChanges.add("m", "p", { name: "가".repeat(21) }), "INVALID_NAME");
  throwsCode(() => P.teamChanges.edit("m", { name: "   " }), "INVALID_NAME");
  throwsCode(() => P.teamChanges.edit("m", { role: "가".repeat(13) }), "INVALID_ROLE");
  eq(P.teamChanges.edit("m", { role: "팀장" }), [{ kind: "update", entity: "project_members", id: "m", data: { role: "팀장" } }], "보낸 칸만");
  eq(P.teamChanges.move(["a", "b"], "p2").map((c) => (c as { data: unknown }).data), [{ project_id: "p2" }, { project_id: "p2" }]);
  const np = P.newProjectChanges("p9", { name: "발표 준비" }, { accountId: "u1", name: "병욱", memberId: "m9" });
  eq(np.map((c) => [c.kind, c.entity]), [["create", "projects"], ["create", "project_members"]]);
  eq((np[1] as { data: Record<string, unknown> }).data, { project_id: "p9", name: "병욱", role: "팀장", account_id: "u1", position: 0 }, "만든 사람 = 팀장");
});

Deno.test("membersOf · pendingInvites · 공유 문구", () => {
  const rows = [
    { data: { id: "1", project_id: "p", name: "나", role: "팀원", position: 2, deleted_at: null } },
    { data: { id: "2", project_id: "p", name: "가", role: "팀장", position: 0, deleted_at: null } },
    { data: { id: "3", project_id: "p", name: "삭제됨", role: "팀원", position: 1, deleted_at: "2026-11-15T00:00:00Z" } },
    { data: { id: "4", project_id: "q", name: "다른 프로젝트", role: "팀원", position: 0, deleted_at: null } },
  ];
  eq(P.membersOf(rows, "p").map((m) => m.id), ["2", "1"]);
  const now = new Date("2026-11-15T00:00:00Z");
  const inv = [
    { data: { id: "a", project_id: "p", status: "PENDING", expires_at: "2026-11-20T00:00:00Z", created_at: "2026-11-14T00:00:00Z" } },
    { data: { id: "b", project_id: "p", status: "PENDING", expires_at: "2026-11-14T00:00:00Z", created_at: "2026-11-13T00:00:00Z" } },
    { data: { id: "c", project_id: "p", status: "ACCEPTED", expires_at: "2026-11-20T00:00:00Z", created_at: "2026-11-14T00:00:00Z" } },
    { data: { id: "d", project_id: "p", status: "PENDING", expires_at: "2026-11-21T00:00:00Z", created_at: "2026-11-14T05:00:00Z" } },
  ];
  eq(P.pendingInvites(inv, "p", now).map((i) => i.id), ["d", "a"], "기간 지난 것·수락된 것 빼고 최근 순");
  eq(P.projectInviteShareText({ projectName: "발표 준비", code: "ABCDE-FGHJK", expiresAt: "2026-11-21T16:00:00Z" }),
    "[Stella] '발표 준비' 프로젝트에 초대합니다\n앱에서 [공간 참여]를 누르고 코드를 입력하세요: ABCDE-FGHJK\n11월 22일까지 · 1명");
});

async function asUser(uid: string) {
  const c = new pg.Client(PG);
  await c.connect();
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
  await c.query("set role authenticated");
  return c;
}
function fakeClient(c: pg.Client) {
  return {
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args);
      try {
        const r = await c.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
  };
}

Deno.test("project-team.ts ↔ 초대 RPC: 메일·링크 초대, 한도, 취소, 오류 문구", async () => {
  const admin = new pg.Client(PG); await admin.connect();
  const own = crypto.randomUUID(), vw = crypto.randomUUID();
  for (const id of [own, vw]) await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@t.dev`]);
  const co = await asUser(own);
  const ws = (await co.query(`select public.create_workspace('팀') as w`)).rows[0].w;
  const code = (await co.query(`select public.create_invite($1, 'VIEWER', 24, 1) ->> 'code' as c`, [ws])).rows[0].c;
  const cv = await asUser(vw); await cv.query(`select public.accept_invite($1)`, [code]);
  const pid = crypto.randomUUID();
  await co.query(`select public.sync_push($1, gen_random_uuid(), $2::jsonb)`, [ws, JSON.stringify([{ entity: "projects", op: "UPSERT", id: pid, data: { name: "발표" } }])]);
  const sb = fakeClient(co) as never;

  const q0 = await P.getProjectInviteQuota(sb);
  eq([q0.plan, q0.limit, q0.used, q0.remaining], ["FREE", 10, 0, 10]);
  const link = await P.createProjectInvite(sb, pid, { method: "링크" });
  ok(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(link.code) && link.method === "LINK" && link.email === null && link.quota.remaining === 9, JSON.stringify(link));
  const mail = await P.createProjectInvite(sb, pid, { method: "메일", email: "Friend@Example.com" });
  eq([mail.method, mail.email], ["EMAIL", "friend@example.com"]);
  await nodeAssert.rejects(() => P.createProjectInvite(sb, pid, { method: "메일", email: "friend@example.com" }), (e: Error & { code?: string }) => {
    eq(e.code, "ALREADY_INVITED"); eq(P.teamErrorMessage(e), "이미 초대한 이메일이에요"); return true;
  });
  await nodeAssert.rejects(() => P.createProjectInvite(sb, pid, { method: "메일", email: "nope" }), (e: Error & { code?: string }) => {
    eq(P.teamErrorMessage(e), "이메일 형식이 올바르지 않아요. 예) name@example.com"); return true;
  });
  await nodeAssert.rejects(() => P.createProjectInvite(fakeClient(cv) as never, pid, { method: "링크" }), (e: Error & { code?: string }) => {
    eq(e.code, "FORBIDDEN"); eq(P.teamErrorMessage(e), "보기 전용 멤버는 할 수 없어요"); return true;
  });
  eq((await P.revokeProjectInvite(sb, mail.project_invite_id)).status, "REVOKED");
  // 한도: 10회
  for (let i = 0; i < 8; i++) await P.createProjectInvite(sb, pid, { method: "링크" });
  await nodeAssert.rejects(() => P.createProjectInvite(sb, pid, { method: "링크" }), (e: Error & { code?: string }) => {
    eq(e.code, "INVITE_LIMIT"); eq(P.teamErrorMessage(e), "이번 달 초대 횟수를 모두 사용했어요."); return true;
  });
  eq((await P.getProjectInviteQuota(sb)).remaining, 0);
  await co.end(); await cv.end(); await admin.end();
});
