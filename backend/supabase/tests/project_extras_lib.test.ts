// 앱 모듈 favorites.ts · project-team.ts(팀장 권한·프로젝트 파일) · backup.ts ↔ 로컬 DB + 진짜 assets handler (Deno)
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check --config deno.test.json project_extras_lib.test.ts
//   가짜 Supabase 클라이언트: rpc → 로그인 사용자 권한으로 로컬 DB, functions.invoke → assets handler.ts, storage → 메모리(읽기는 DB 정책 함수)
//   앱 모듈 경로(아래 import)는 저장소에 둔 위치에 맞게 고치세요 (지금: ../../../frontend/Frontend_UI/src/lib/stella)
import nodeAssert from "node:assert/strict";
import pg from "npm:pg@8";
import { FunctionsHttpError } from "npm:@supabase/supabase-js@2";
import { createHandler, type Deps } from "../functions/assets/handler.ts";
import * as Fav from "../../../frontend/Frontend_UI/src/lib/stella/favorites.ts";
import * as P from "../../../frontend/Frontend_UI/src/lib/stella/project-team.ts";
import * as BK from "../../../frontend/Frontend_UI/src/lib/stella/backup.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const codeOf = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

async function pgc() { const c = new pg.Client(PG); await c.connect(); return c; }
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function world() {
  const admin = await pgc();
  const svc = await pgc(); await svc.query("set role service_role");
  const users: pg.Client[] = [];
  const asUser = async (uid: string) => {
    const c = await pgc();
    await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set role authenticated");
    users.push(c);
    return c;
  };
  const objects = new Map<string, Uint8Array>();
  const tokens = new Map<string, string>();
  const deps: Deps = {
    getUserId: async (t) => t.replace(/^user:/, "") || null,
    rpc: async (name, args) => {
      const keys = Object.keys(args);
      try {
        const r = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
        return { data: r.rows[0].r, error: null };
      } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    },
    storage: {
      async createSignedUploadUrl(b, p) { const token = crypto.randomUUID(); tokens.set(token, `${b}/${p}`); return { signedUrl: `x?token=${token}`, token, path: p }; },
      async download(b, p) { const o = objects.get(`${b}/${p}`); return o ? { bytes: o, mime: null } as never : null; },
      async remove(b, p) { objects.delete(`${b}/${p}`); },
    },
  };
  const handle = createHandler(deps);
  const client = async (uid: string) => {
    const c = await asUser(uid);
    const canRead = async (bucket: string, path: string) =>
      (await c.query("select private.can_read_asset_object($1, $2) as r", [bucket, path])).rows[0].r;
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
      functions: {
        async invoke(path: string, { body }: { body: unknown }) {
          const res = await handle(new Request(`https://x/functions/v1/${path}`, {
            method: "POST", headers: { Authorization: `Bearer user:${uid}` }, body: JSON.stringify(body) }));
          return res.ok ? { data: await res.json(), error: null } : { data: null, error: new FunctionsHttpError(res) };
        },
      },
      storage: {
        from(bucket: string) {
          return {
            async uploadToSignedUrl(path: string, token: string, bytes: Uint8Array) {
              if (tokens.get(token) !== `${bucket}/${path}`) return { data: null, error: { message: "bad token" } };
              objects.set(`${bucket}/${path}`, new Uint8Array(bytes)); return { data: { path }, error: null };
            },
            async download(path: string) {
              const o = objects.get(`${bucket}/${path}`);
              return (await canRead(bucket, path)) && o ? { data: new Blob([o]), error: null } : { data: null, error: { message: "Object not found" } };
            },
          };
        },
      },
      sql: c,
    } as any;
  };
  const newUser = async (name: string) => {
    const id = crypto.randomUUID();
    await admin.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, `${id}@t.dev`, JSON.stringify({ name })]);
    return id;
  };
  const close = async () => { for (const c of users) await c.end(); await svc.end(); await admin.end(); };
  return { admin, client, newUser, objects, close };
}

// ---------------------------------------------------------------------
Deno.test("favorites.ts: 화면 규칙 · 켜기/끄기 · 사람마다 따로 · 오류 문구", async () => {
  eq(Fav.favoriteAction([{ favorite: true }, { favorite: true }]), "remove", "전부 별표 → 해제");
  eq(Fav.favoriteAction([{ favorite: true }, { favorite: false }]), "add", "하나라도 아니면 → 즐겨찾기");
  eq(Fav.favoriteAction([]), "add");

  const w = await world();
  try {
    const me = await w.newUser("나"), mate = await w.newUser("팀원");
    const A = await w.client(me), B = await w.client(mate);
    const ws = (await A.rpc("create_workspace", { p_name: "즐겨찾기" })).data as string;
    const code = ((await A.rpc("create_invite", { p_workspace_id: ws, p_role: "EDITOR", p_expires_in_hours: 24, p_max_uses: 1 })).data as { code: string }).code;
    await B.rpc("accept_invite", { p_code: code });
    const n1 = crypto.randomUUID(), n2 = crypto.randomUUID();
    const push = await A.rpc("sync_push", { p_workspace_id: ws, p_operation_id: crypto.randomUUID(), p_ops: JSON.stringify([
      { entity: "notes", op: "UPSERT", id: n1, data: { title: "a" } }, { entity: "notes", op: "UPSERT", id: n2, data: { title: "b" } }]) });
    eq(push.data.status, "ACCEPTED");

    const r = await Fav.setNoteFavorites(A, ws, [n1, n2, n1], true);
    eq([r.changed, r.noteIds.length], [2, 2]);
    eq([...(await Fav.listNoteFavorites(A, ws))].sort(), [n1, n2].sort());
    eq((await Fav.listNoteFavorites(B, ws)).size, 0, "팀원에게는 안 보임");
    const off = await Fav.setNoteFavorites(A, ws, [n2], false);
    eq(off.noteIds, [n1]);
    const byWs = await Fav.listNoteFavoritesByWorkspace(A);
    eq([...(byWs.get(ws) ?? [])], [n1]);

    // 같은 id는 한 번만: 501번 넣어도 한 번 호출
    let calls = 0;
    const spy = { rpc: (n: string, a: Record<string, unknown>) => { calls++; return A.rpc(n, a); } } as never;
    await Fav.setNoteFavorites(spy, ws, Array(501).fill(n1), true);
    eq(calls, 1, "중복을 빼고 보냄");
    calls = 0;
    await Fav.setNoteFavorites(spy, ws, [...Array.from({ length: 500 }, () => n1), n2], false);
    eq(calls, 1);
    // 500개 넘으면 나눠 보냄 (없는 메모라 NOT_FOUND가 나야 정상: 첫 묶음에서)
    const many = Array.from({ length: 501 }, () => crypto.randomUUID());
    const e1 = await codeOf(Fav.setNoteFavorites(A, ws, many, true));
    eq(e1, "NOT_FOUND");
    eq(Fav.favoriteErrorMessage({ code: "NOT_FOUND" }).includes("동기화"), true);
    eq(await codeOf(Fav.setNoteFavorites(A, "", [n1], true)), "INVALID_REQUEST", "개인 공간(공간 id 없음)은 서버로 안 보냄");
    eq(await codeOf(Fav.setNoteFavorites(A, ws, [], true)), "INVALID_REQUEST");
  } finally { await w.close(); }
});

// ---------------------------------------------------------------------
Deno.test("project-team.ts: 팀장 권한(기기 계산 = 서버) · 파일 연결 변경 · 문구", async () => {
  // 기기에서 계산하는 규칙
  const L = (account_id: string | null, role = "팀장", deleted_at: string | null = null) => ({ account_id, role, deleted_at });
  eq(P.canManageProject({ me: "a", myRole: "OWNER", members: [L("b")] }), true, "공간 관리자");
  eq(P.canManageProject({ me: "a", myRole: "EDITOR", members: [L("a")] }), true, "팀장");
  eq(P.canManageProject({ me: "a", myRole: "EDITOR", members: [L("b"), L("a", "팀원")] }), false, "팀원");
  eq(P.canManageProject({ me: "a", myRole: "VIEWER", members: [] }), false, "보기 전용");
  eq(P.canManageProject({ me: "a", myRole: "EDITOR", members: [L(null), L("a", "팀원")] }), true, "이름만 팀장 → 팀장 없음");
  eq(P.canManageProject({ me: "a", myRole: "EDITOR", members: [L("b", "팀장", "2026-11-15")] }), true, "휴지통 팀장 → 팀장 없음");
  eq(P.canManageProject({ me: "a", myRole: "EDITOR", members: [L("a", "팀장", "2026-11-15"), L("b")] }), false, "내 팀장 행이 휴지통이고 다른 팀장이 있으면 불가");
  eq(P.isProjectLeader([L("a", "팀장", "2026-11-15")], "a"), false);
  eq(P.canManageProject({ me: "a", myRole: "EDITOR", members: [L("b")], activeAccountIds: ["a"] }), true, "떠난 팀장 → 팀장 없음");
  eq(P.canManageProject({ me: "a", myRole: "EDITOR", members: [L("b")], activeAccountIds: ["a", "b"] }), false);
  eq(P.canManageProject({ me: "a", myRole: "EDITOR", members: [L("a", " 팀장 ")] }), true, "역할 앞뒤 공백");
  eq(P.isLeaderConflict({ reason: "NOT_PROJECT_LEADER" }), true);
  eq(P.isLeaderConflict({ reason: "REVISION_MISMATCH" }), false);
  eq(P.teamErrorMessage({ code: "FORBIDDEN", message: "프로젝트 팀장만 초대할 수 있습니다" }), "프로젝트 팀장만 할 수 있어요");
  eq(P.teamErrorMessage({ code: "FORBIDDEN", message: "보기 전용 멤버는 초대할 수 없습니다" }), "보기 전용 멤버는 할 수 없어요");
  eq(P.teamErrorMessage({ code: "NOT_PROJECT_LEADER" }).startsWith("프로젝트 팀장만"), true);

  // 파일 연결 변경
  eq(P.projectFileChanges.link("p1", "f1"), [{ kind: "link", entity: "project_files", data: { project_id: "p1", asset_id: "f1", position: 0 } }]);
  eq(P.projectFileChanges.move("f1", "p1", "p2").map((c) => [c.kind, (c as { data: { project_id: string } }).data.project_id]), [["unlink", "p1"], ["link", "p2"]]);
  eq(P.projectFileChanges.move("f1", null, "p2").length, 1);
  eq(P.projectFileChanges.move("f1", "p2", "p2").length, 0, "같은 프로젝트면 변경 없음");
  const rows = [
    { data: { project_id: "p1", asset_id: "f2", position: 1, added_at: "2026-11-15T01:00:00Z" } },
    { data: { project_id: "p1", asset_id: "f1", position: 0, added_at: "2026-11-15T02:00:00Z" } },
    { data: { project_id: "p2", asset_id: "f3", position: 0, added_at: "2026-11-15T00:00:00Z" } },
  ];
  eq(P.projectFilesOf(rows, "p1").map((f) => f.asset_id), ["f1", "f2"]);
  eq([P.projectOfFile(rows, "f3"), P.projectOfFile(rows, "fx")], ["p2", null]);

  // 서버와 같은 결과인지 (같은 상황을 서버에 만들고 get_project_permissions와 비교)
  const w = await world();
  try {
    const own = await w.newUser("관리자"), ld = await w.newUser("팀장"), ed = await w.newUser("팀원"), vw = await w.newUser("보기");
    const O = await w.client(own), LD = await w.client(ld), ED = await w.client(ed), VW = await w.client(vw);
    const ws = (await O.rpc("create_workspace", { p_name: "권한" })).data as string;
    const ce = ((await O.rpc("create_invite", { p_workspace_id: ws, p_role: "EDITOR", p_expires_in_hours: 24, p_max_uses: 2 })).data as { code: string }).code;
    const cv = ((await O.rpc("create_invite", { p_workspace_id: ws, p_role: "VIEWER", p_expires_in_hours: 24, p_max_uses: 1 })).data as { code: string }).code;
    await LD.rpc("accept_invite", { p_code: ce }); await ED.rpc("accept_invite", { p_code: ce }); await VW.rpc("accept_invite", { p_code: cv });
    const pLead = crypto.randomUUID(), pFree = crypto.randomUUID();
    const ops = [
      ...P.newProjectChanges(pLead, { name: "팀장 있음" }, { accountId: ld, name: "팀장", memberId: crypto.randomUUID() }),
      ...P.teamChanges.add(crypto.randomUUID(), pLead, { name: "팀원", accountId: ed }),
      { kind: "create", entity: "projects", id: pFree, data: { name: "팀장 없음" } },
    ].map((c) => ({ entity: c.entity, op: "UPSERT", id: (c as { id: string }).id, data: (c as { data: unknown }).data }));
    eq((await LD.rpc("sync_push", { p_workspace_id: ws, p_operation_id: crypto.randomUUID(), p_ops: JSON.stringify(ops) })).data.status, "ACCEPTED");
    const members = (await O.sql.query("select account_id, role, deleted_at from public.project_members where project_id = $1", [pLead])).rows;
    for (const [who, uid, role] of [[O, own, "OWNER"], [LD, ld, "EDITOR"], [ED, ed, "EDITOR"], [VW, vw, "VIEWER"]] as const) {
      const server = await P.getProjectPermissions(who, ws);
      eq(server[pLead], P.canManageProject({ me: uid, myRole: role, members }), `팀장 있는 프로젝트: ${role} ${uid === ld ? "(팀장)" : ""}`);
      eq(server[pFree], P.canManageProject({ me: uid, myRole: role, members: [] }), `팀장 없는 프로젝트: ${role}`);
    }
    eq(await codeOf(P.createProjectInvite(ED, pLead, { method: "링크" })), "FORBIDDEN");
    ok((await P.createProjectInvite(LD, pLead, { method: "링크" })).code);

    // 파일 업로드 → 프로젝트에 연결 → 다른 기기는 snapshot에서 받음
    const F = await import("../../../frontend/Frontend_UI/src/lib/stella/attachments.ts");
    const asset = await F.uploadAttachment(ED, { workspaceId: ws, assetId: crypto.randomUUID(), bytes: new TextEncoder().encode("자료"), mimeType: "text/plain", name: "자료.txt" });
    const link = P.projectFileChanges.link(pLead, asset.id).map((c) => ({ entity: c.entity, op: "UPSERT", data: (c as { data: unknown }).data }));
    eq((await ED.rpc("sync_push", { p_workspace_id: ws, p_operation_id: crypto.randomUUID(), p_ops: JSON.stringify(link) })).data.status, "ACCEPTED",
      "팀원도 파일 연결은 가능 (공간 권한)");
    const snap = (await VW.rpc("sync_snapshot", { p_workspace_id: ws })).data;
    eq(P.projectFilesOf(snap.project_files.map((d: unknown) => ({ data: d })), pLead).map((f) => f.asset_id), [asset.id]);
  } finally { await w.close(); }
});

// ---------------------------------------------------------------------
Deno.test("backup.ts: base64 · 암호화(바꿔치기·손상 감지) · 백업 → 목록 → 복원(자동 백업) · 보관 개수 · 새 기기 · 남의 백업", async () => {
  // base64는 btoa와 같아야
  for (const n of [0, 1, 2, 3, 31, 32, 33, 100]) {
    const b = rnd(n);
    eq(BK.bytesToBase64(b), btoa(String.fromCharCode(...b)), `base64 ${n}바이트`);
    eq(BK.base64ToBytes(BK.bytesToBase64(b)), b);
  }
  const key = rnd(32), plain = new TextEncoder().encode('{"memos":[1,2,3]}');
  const file = BK.encryptBackup(key, plain, "asset-1", rnd);
  eq(new TextDecoder().decode(file.subarray(0, 4)), "STB1");
  eq(BK.decryptBackup(key, file, "asset-1"), plain);
  const flipped = new Uint8Array(file); flipped[20] ^= 1;
  eq(await codeOf(Promise.resolve().then(() => BK.decryptBackup(key, flipped, "asset-1"))), "BACKUP_CORRUPT", "한 비트만 바뀌어도 감지");
  eq(await codeOf(Promise.resolve().then(() => BK.decryptBackup(key, file, "asset-2"))), "BACKUP_CORRUPT", "다른 백업 id로는 안 풀림 (바꿔치기 방지)");
  eq(await codeOf(Promise.resolve().then(() => BK.decryptBackup(rnd(32), file, "asset-1"))), "BACKUP_CORRUPT", "다른 키");
  eq(await codeOf(Promise.resolve().then(() => BK.decryptBackup(key, new Uint8Array(10), "asset-1"))), "BACKUP_CORRUPT", "형식 아님");
  ok(BK.encryptBackup(key, plain, "asset-1", rnd).some((b, i) => b !== file[i]), "같은 내용도 매번 다른 암호문 (nonce)");

  const w = await world();
  try {
    const me = await w.newUser("나"), other = await w.newUser("남");
    const A = await w.client(me), A2 = await w.client(me), X = await w.client(other);
    let t = Date.parse("2026-11-15T03:00:00Z");
    const deps: BK.BackupDeps = { newId: () => crypto.randomUUID(), randomBytes: rnd, deviceName: "Galaxy", appVersion: "1.0.0", now: () => new Date(t += 60_000) };
    const data1 = { memos: [{ id: "m1", title: "개인 메모" }], tasks: [], projects: [] };

    const c1 = await BK.createBackup(A, { data: data1, counts: { memos: 1, tasks: 0, projects: 0, junk: NaN as unknown as number }, keep: 2, deps });
    eq([c1.backup.kind, c1.backup.auto, c1.backup.counts, c1.removed], ["MANUAL", false, { memos: 1, tasks: 0, projects: 0 }, 0]);
    const stored = w.objects.get(`backups/${c1.backup.object_path}`)!;
    ok(stored && !new TextDecoder().decode(stored).includes("개인 메모"), "서버에 올라간 파일은 암호화돼 있음");

    // 새 기기(같은 계정): 로그인만 하면 풀림
    const list = await BK.listBackups(A2);
    eq(list.map((b) => b.id), [c1.backup.id]);
    const read = await BK.readBackup<typeof data1>(A2, list[0], deps);
    eq([read.format, read.data, read.counts.memos], [1, data1, 1]);
    // 남의 계정: 목록에 없고, 경로를 알아도 못 받음
    eq((await BK.listBackups(X)).length, 0);
    eq(await codeOf(BK.readBackup(X, list[0], deps)), "NOT_FOUND");

    // 복원: 지금 상태를 자동 백업으로 남긴 뒤 적용 (보관 2개가 꽉 찬 상태에서도 고른 백업은 안 지움)
    const c2 = await BK.createBackup(A, { data: { memos: [] }, counts: { memos: 0 }, keep: 2, deps });
    eq(c2.removed, 0);
    const current = { memos: [{ id: "m9", title: "지금 메모" }], tasks: [], projects: [] };
    let applied: unknown = null;
    const rs = await BK.restoreBackup<typeof data1>(A, { backup: list[0], currentData: current, currentCounts: { memos: 1 }, keep: 2, deps,
      apply: (d) => { applied = d; } });
    eq(applied, data1);
    eq([rs.safety?.kind, rs.safety?.auto], ["AUTO", true]);
    eq((await BK.listBackups(A)).length, 3, "자동 백업은 보관 개수 +1로 계산 (복원한 백업이 남음)");
    eq((await BK.readBackup(A, rs.safety!, deps)).data, current, "자동 백업에는 복원 전 상태");

    // 보관 개수 2: 다음 백업을 만들면 오래된 것부터 지움
    const c3 = await BK.createBackup(A, { data: { memos: [] }, counts: { memos: 0 }, keep: 2, deps });
    eq([c3.removed, c3.removeFailed], [2, []]);
    const after = await BK.listBackups(A);
    eq(after.map((b) => b.id), [c3.backup.id, rs.safety!.id], "최신순, 오래된 수동 백업 2개가 지워짐");
    eq(w.objects.has(`backups/${c2.backup.object_path}`), false);
    eq(w.objects.has(`backups/${c1.backup.object_path}`), false, "지운 백업 파일은 저장소에서도 지움");
    eq((await BK.listBackups(A, "old"))[0].id, rs.safety!.id);

    // 손상된 백업: 자동 백업도 안 만들고 적용도 안 함
    const bad = after[0];
    const obj = w.objects.get(`backups/${bad.object_path}`)!; obj[obj.length - 1] ^= 1;
    let applied2 = false;
    eq(await codeOf(BK.restoreBackup(A, { backup: bad, currentData: current, apply: () => { applied2 = true; }, deps })), "BACKUP_CORRUPT");
    eq([applied2, (await BK.listBackups(A)).length], [false, 2], "손상 → 아무것도 안 바뀜");

    // 자동 백업이 실패하면 적용하지 않음
    const good = after[1];
    let applied3 = false;
    const failing = { ...deps, newId: () => "not-a-uuid" };
    eq(await codeOf(BK.restoreBackup(A, { backup: good, currentData: current, apply: () => { applied3 = true; }, deps: failing })), "SAFETY_BACKUP_FAILED");
    eq(applied3, false);
    let applied4 = false;
    await BK.restoreBackup(A, { backup: good, currentData: current, apply: () => { applied4 = true; }, deps: failing, skipSafety: true });
    eq(applied4, true, "skipSafety면 자동 백업 없이");

    // 더 새 형식
    const newer = BK.encryptBackup(await BK.getBackupKey(A, rnd), new TextEncoder().encode('{"format":99,"data":{}}'), good.id, rnd);
    w.objects.set(`backups/${good.object_path}`, newer);
    eq(await codeOf(BK.readBackup(A, good, deps)), "BACKUP_TOO_NEW");

    await BK.deleteBackup(A, good.id);
    eq((await BK.listBackups(A)).map((b) => b.id), [bad.id]);
    eq(await codeOf(BK.createBackup(A, { data: "x".repeat(51 * 1024 * 1024), deps })), "TOO_LARGE");
    eq(BK.backupErrorMessage({ code: "BACKUP_CORRUPT" }).includes("풀 수 없어요"), true);
    eq(BK.backupErrorMessage({ code: "QUOTA_EXCEEDED" }).includes("백업 용량"), true);
  } finally { await w.close(); }
});
