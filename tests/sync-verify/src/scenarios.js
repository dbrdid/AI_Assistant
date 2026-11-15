// 두 기기 동기화 시나리오 (로컬·원격 공통)
//   env.users.A / env.users.B : { accountId, rpc, select, transport() }
//   env.forceSnapshotRequired(ws) : 있으면 서버에서 진짜로 커서를 무효화 (로컬), 없으면 응답 흉내 (원격)
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const S = require('../lib/local-sync.js');
const R = require('../lib/realtime.js');
const F = require('../lib/attachments.js');
const T = require('../lib/transcribe.js');
const Rec = require('../lib/recordings.js');
const Bill = require('../lib/billing.js');
const Team = require('../lib/project-team.js');
const Docs = require('../lib/documents.js');
const Chat = require('../lib/ai-chat.js');
const Agenda = require('../lib/agenda-judge.js');
const Fav = require('../lib/favorites.js');
const Bk = require('../lib/backup.js');
const Trash = require('../lib/trash.js');
const Push = require('../lib/push.js');
const Wd = require('../lib/withdraw.js');
const Mail = require('../lib/invite-mail.js');
const { newDevice, openDevice } = require('./device');
const { faulty } = require('./faults');

// pred가 참이 될 때까지 기다림 (async pred 가능). 시간 안에 안 되면 false
async function waitFor(pred, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}
// 시험용 녹음: 16kHz 모노 16비트 WAV, 440Hz 소리 (seconds초)
function toneWav(seconds) {
  const rate = 16000, n = Math.round(rate * seconds), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), 44 + i * 2);
  return new Uint8Array(buf);
}
// 시험용 글자 사진: "STELLA 2026"을 5×7 점 글꼴로 그린 흰 바탕 PNG (외부 라이브러리 없이)
function textPng(text = 'STELLA 2026', scale = 10) {
  const zlib = require('node:zlib');
  const F = {
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], 2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  };
  const cols = text.length * 6 + 3, rows = 11, w = cols * scale, h = rows * scale;
  const raw = Buffer.alloc((w + 1) * h, 255);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;   // 필터 없음
  [...text].forEach((ch, i) => (F[ch] ?? F[' ']).forEach((row, r) => [...row].forEach((bit, c) => {
    if (bit !== '1') return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const x = (2 + i * 6 + c) * scale + dx, y = (2 + r) * scale + dy;
      raw[y * (w + 1) + 1 + x] = 0;
    }
  })));
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;   // 8비트 흑백
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const statusText = (list) => list.map(([s, d]) => (d ? `${s}(${String(d).slice(0, 80)})` : s)).join(', ') || '응답 없음';

async function runScenarios(env, report) {
  const { A, B } = env.users;
  const { group, check } = report;
  const dir = env.dataDir;
  const id = () => randomUUID();
  const note = async (dev, ws, nid) => (await S.getLocal(dev.db, ws, 'notes', nid));
  const task = async (dev, ws, tid) => (await S.getLocal(dev.db, ws, 'tasks', tid));

  // -------------------------------------------------------------------
  group('1. 로그인 → 프로필·설정 조회');
  for (const [name, u] of [['A', A], ['B', B]]) {
    const p = await u.select('profiles', 'account_id', u.accountId);
    const s = await u.select('user_settings', 'account_id', u.accountId);
    check(`${name}: 내 프로필 조회`, p.length === 1, p[0] ? `이름=${p[0].display_name}` : '없음');
    check(`${name}: 내 설정 조회`, s.length === 1, s[0] ? `시간대=${s[0].timezone ?? '-'}` : '없음');
  }
  const leak = await A.select('user_settings', 'account_id', B.accountId);
  check('A는 B의 설정을 볼 수 없음 (RLS)', leak.length === 0);

  // -------------------------------------------------------------------
  group('2. 공간 생성 → B 초대·참여 → 두 기기 처음 받기');
  const ws = await A.rpc('create_workspace', { p_name: `동기화 검증 ${new Date().toISOString().slice(0, 16)}`, p_description: '두 기기 검증용 공간' });
  const inv = await A.rpc('create_invite', { p_workspace_id: ws, p_role: 'EDITOR', p_expires_in_hours: 1, p_max_uses: 1 });
  const acc = await B.rpc('accept_invite', { p_code: inv.code });
  check('A가 공간을 만들고 B가 초대 코드로 참여', acc.workspace_id === ws && acc.role === 'EDITOR', `role=${acc.role}`);

  let devA = newDevice(dir, 'deviceA');
  let devB = newDevice(dir, 'deviceB');
  const tA = faulty(A.transport());
  const tB = faulty(B.transport());
  const ctxA = { db: devA.db, transport: tA, workspaceId: ws, myAccountId: A.accountId, newId: id };
  const ctxB = { db: devB.db, transport: tB, workspaceId: ws, myAccountId: B.accountId, newId: id };
  await S.setupLocalSync(devA.db);
  await S.setupLocalSync(devB.db);
  const a0 = await S.pullWorkspace(ctxA);
  const b0 = await S.pullWorkspace(ctxB);
  check('처음 열면 전체 받기(스냅샷)로 시작', a0.status === 'RESYNCED' && b0.status === 'RESYNCED', `A=${a0.status} B=${b0.status}`);
  const membersB = await S.listLocal(devB.db, ws, 'workspace_members');
  check('B 기기에 멤버 2명 저장', membersB.length === 2, `${membersB.length}명`);
  env.cleanup.push(async () => { await A.rpc('delete_workspace', { p_workspace_id: ws }).catch(() => undefined); });

  // -------------------------------------------------------------------
  group('3. 기본 흐름: A 저장 → 보내기 → B 받기 → B SQLite에 데이터와 커서');
  const N1 = id(); const T1 = id();
  await S.saveLocal(ctxA, [
    { kind: 'create', entity: 'notes', id: N1, data: { title: '주간 회의록', body: '첫 메모' } },
    { kind: 'create', entity: 'tasks', id: T1, data: { title: '자료 조사', note_id: N1, priority: 2 } },
  ]);
  const n1a = await note(devA, ws, N1);
  check('A: 보내기 전에도 기기 화면에 바로 보임', n1a?.pending === true && n1a.data.title === '주간 회의록');
  const f1 = await S.flushOutbox(ctxA);
  check('A: 보내기 성공 (메모+할 일 한 묶음)', f1.status === 'DONE' && f1.sent === 1, JSON.stringify(f1));
  const p1 = await S.pullWorkspace(ctxB);
  const n1b = await note(devB, ws, N1);
  const t1b = await task(devB, ws, T1);
  check('B: 받기 후 메모·할 일이 같음', n1b?.data.body === '첫 메모' && t1b?.data.note_id === N1 && t1b?.data.priority === 2,
    `B 메모 revision=${n1b?.serverRevision}`);
  // 앱 재시작: DB 파일을 닫고 다시 열기
  devB.close(); devB = openDevice(devB.file); ctxB.db = devB.db;
  const stB = await S.getSyncStatus(devB.db, ws);
  check('B: 앱을 다시 켜도 커서와 데이터가 남아 있음', stB.lastSeq === p1.lastSeq && !!(await note(devB, ws, N1)),
    `커서=${stB.lastSeq}`);
  await S.pullWorkspace(ctxA);
  const n1aSrv = await note(devA, ws, N1);
  check('A: 자기 변경도 받기로 정식 행(revision 포함)이 됨', n1aSrv?.pending === false && n1aSrv.serverRevision === n1b?.serverRevision);

  const P1 = id();
  await S.saveLocal(ctxA, [
    { kind: 'create', entity: 'projects', id: P1, data: { name: '캡스톤 발표' } },
    { kind: 'link', entity: 'note_projects', data: { note_id: N1, project_id: P1 } },
  ]);
  await S.flushOutbox(ctxA);
  await S.pullWorkspace(ctxB);
  const linkB = await S.getLocal(devB.db, ws, 'note_projects', `${N1}:${P1}`);
  check('연결: A가 메모를 프로젝트에 연결 → B에도 연결', !!linkB && (await S.getLocal(devB.db, ws, 'projects', P1))?.data.name === '캡스톤 발표');
  await S.saveLocal(ctxA, [{ kind: 'unlink', entity: 'note_projects', data: { note_id: N1, project_id: P1 } }]);
  check('연결 해제: A 화면에서는 보내기 전에 바로 사라짐', !(await S.getLocal(devA.db, ws, 'note_projects', `${N1}:${P1}`)));
  await S.flushOutbox(ctxA);
  await S.pullWorkspace(ctxB);
  check('연결 해제: B에서도 사라짐', !(await S.getLocal(devB.db, ws, 'note_projects', `${N1}:${P1}`)));

  // -------------------------------------------------------------------
  group('4. 끊김 후 재연결');
  tA.mode = 'offline';
  const N2 = id();
  await S.saveLocal(ctxA, [{ kind: 'update', entity: 'notes', id: N1, data: { body: '오프라인에서 고침' } }]);
  await S.saveLocal(ctxA, [{ kind: 'create', entity: 'notes', id: N2, data: { title: '지하철에서 쓴 메모', body: '새로 씀' } }]);
  const f2 = await S.flushOutbox(ctxA);
  const st2 = await S.getSyncStatus(devA.db, ws);
  check('끊긴 동안: 보내기는 OFFLINE, 보낼 목록에 2건 보관', f2.status === 'OFFLINE' && st2.pending === 2, `${f2.status}, ${st2.pending}건`);
  check('끊긴 동안: A 화면에는 수정이 보임', (await note(devA, ws, N1))?.data.body === '오프라인에서 고침' && !!(await note(devA, ws, N2)));
  await S.pullWorkspace(ctxB);
  check('끊긴 동안: B에는 아직 안 보임', (await note(devB, ws, N1))?.data.body === '첫 메모' && !(await note(devB, ws, N2)));
  tA.mode = 'online';
  const f3 = await S.flushOutbox(ctxA);
  const pulledBefore = tB.pulled.length;
  const p3 = await S.pullWorkspace(ctxB, { limit: 1 });   // 한 번에 1건씩 → 여러 번 나눠 받기
  check('연결되면 순서대로 2건 보내기', f3.status === 'DONE' && f3.sent === 2, JSON.stringify(f3));
  check('B: 한 번에 1건씩 나눠 받아도 끝까지 받음', p3.status === 'OK' && p3.applied === 2 && tB.pulled.length - pulledBefore === 2,
    `${p3.applied}건`);
  check('B: 두 수정 모두 받음', (await note(devB, ws, N1))?.data.body === '오프라인에서 고침' && (await note(devB, ws, N2))?.data.title === '지하철에서 쓴 메모');

  // -------------------------------------------------------------------
  group('5. 같은 요청 재전송 (서버는 처리했는데 응답을 못 받음)');
  const N3 = id();
  await S.saveLocal(ctxA, [{ kind: 'create', entity: 'notes', id: N3, data: { title: '재전송 시험', body: '한 번만 저장돼야 함' } }]);
  const outBefore = (await S.listOutbox(devA.db, ws))[0];
  tA.mode = 'drop-response-once';
  const f4 = await S.flushOutbox(ctxA);
  const firstReceipt = tA.lastReceipt;
  const outAfter = (await S.listOutbox(devA.db, ws))[0];
  check('응답 유실: 기기는 실패로 보고 보낼 목록에 그대로 둠', f4.status === 'OFFLINE' && outAfter?.operationId === outBefore.operationId,
    `서버는 실제로 ${firstReceipt?.status}`);
  const f5 = await S.flushOutbox(ctxA);
  check('재전송: 같은 operation_id → 서버가 처음 결과를 그대로 돌려줌', f5.status === 'DONE' && tA.lastReceipt?.replayed === true,
    `replayed=${tA.lastReceipt?.replayed}`);
  const before = tB.pulled.length;
  await S.pullWorkspace(ctxB);
  const n3changes = tB.pulled.slice(before).filter((c) => c.entity === 'notes' && c.key === N3);
  check('B: 서버 변경 기록에 N3는 정확히 1번', n3changes.length === 1, `${n3changes.length}번`);
  const naive = await A.transport().push(ws, id(), [{ entity: 'notes', op: 'UPSERT', id: N3, data: { title: '재전송 시험', body: '한 번만 저장돼야 함' } }]);
  check('(대조) 새 operation_id로 다시 보내면 ALREADY_EXISTS 충돌 → operation_id를 유지해야 하는 이유',
    naive.status === 'CONFLICT' && naive.conflicts[0]?.reason === 'ALREADY_EXISTS', naive.conflicts?.[0]?.reason);

  // -------------------------------------------------------------------
  group('6. 두 기기에서 같은 기록 수정 (충돌)');
  await S.pullWorkspace(ctxA);
  await S.pullWorkspace(ctxB);
  await S.saveLocal(ctxA, [{ kind: 'update', entity: 'notes', id: N1, data: { body: 'A안: 금요일 마감' } }]);
  const f6 = await S.flushOutbox(ctxA);
  await S.saveLocal(ctxB, [{ kind: 'update', entity: 'notes', id: N1, data: { body: 'B안: 목요일 마감' } }]);
  const f7 = await S.flushOutbox(ctxB);
  check('A가 먼저 저장 → 성공', f6.status === 'DONE');
  check('B가 같은 기록을 저장 → CONFLICT (REVISION_MISMATCH)', f7.status === 'CONFLICT' && f7.conflicts[0]?.reason === 'REVISION_MISMATCH',
    f7.conflicts?.[0]?.reason);
  const n1Conf = await note(devB, ws, N1);
  check('B 화면: 내 수정은 그대로, 충돌 표시', n1Conf?.data.body === 'B안: 목요일 마감' && n1Conf.conflict === true);
  const f7b = await S.flushOutbox(ctxB);
  check('충돌이 풀리기 전에는 다시 보내지 않고 멈춤', f7b.status === 'CONFLICT' && tB.pushCalls === 1, `push 호출 ${tB.pushCalls}번`);
  await S.resolveConflict(ctxB, f7.outboxSeq, 'keep_mine');
  const f8 = await S.flushOutbox(ctxB);
  await S.pullWorkspace(ctxA);
  await S.pullWorkspace(ctxB);
  const fa = await note(devA, ws, N1); const fb = await note(devB, ws, N1);
  check('"내 것 유지" → 서버 최신 값 위에 다시 저장', f8.status === 'DONE' && fa?.data.body === 'B안: 목요일 마감');
  check('두 기기가 같은 값·같은 revision으로 맞춰짐', fa?.data.body === fb?.data.body && fa?.serverRevision === fb?.serverRevision,
    `revision A=${fa?.serverRevision} B=${fb?.serverRevision}`);
  // 서버 값 쓰기
  await S.saveLocal(ctxA, [{ kind: 'update', entity: 'tasks', id: T1, data: { title: '자료 조사 (A가 고침)' } }]);
  await S.flushOutbox(ctxA);
  await S.saveLocal(ctxB, [{ kind: 'update', entity: 'tasks', id: T1, data: { title: '자료 조사 (B가 고침)' } }]);
  const f9 = await S.flushOutbox(ctxB);
  await S.resolveConflict(ctxB, f9.outboxSeq, 'use_server');
  const t1after = await task(devB, ws, T1);
  const stB9 = await S.getSyncStatus(devB.db, ws);
  check('"서버 값 쓰기" → 내 수정 버리고 A의 값으로, 보낼 목록 비움',
    f9.status === 'CONFLICT' && t1after?.data.title === '자료 조사 (A가 고침)' && stB9.pending === 0 && !t1after.pending);

  // -------------------------------------------------------------------
  group('7. 전체 재동기화 때 안 보낸 수정 보존');
  await S.pullWorkspace(ctxB);
  tB.mode = 'offline';
  const N4 = id();
  await S.saveLocal(ctxB, [{ kind: 'update', entity: 'notes', id: N2, data: { body: 'B가 오프라인에서 고침' } }]);
  await S.saveLocal(ctxB, [{ kind: 'create', entity: 'notes', id: N4, data: { title: 'B의 새 메모', body: '아직 안 보냄' } }]);
  await S.saveLocal(ctxA, [{ kind: 'update', entity: 'notes', id: N3, data: { title: '재전송 시험 (A가 제목 수정)' } }]);
  await S.flushOutbox(ctxA);
  if (env.forceSnapshotRequired) await env.forceSnapshotRequired(ws);
  tB.mode = env.forceSnapshotRequired ? 'online' : 'snapshot-required-once';
  const p7 = await S.pullWorkspace(ctxB);      // 일부러 보내기 전에 받기 → 재동기화가 먼저 일어남
  const n2b = await note(devB, ws, N2); const n4b = await note(devB, ws, N4); const n3b = await note(devB, ws, N3);
  const st7 = await S.getSyncStatus(devB.db, ws);
  check(`서버가 "전체 다시 받기"를 요구 → 재동기화 (${env.forceSnapshotRequired ? '서버에서 커서 무효화' : '응답 흉내'})`, p7.status === 'RESYNCED', p7.status);
  check('재동기화 후에도 안 보낸 수정(N2 수정·N4 새 메모)이 그대로', n2b?.data.body === 'B가 오프라인에서 고침' && n2b.pending
    && n4b?.data.title === 'B의 새 메모' && n4b.pending && st7.pending === 2, `보낼 목록 ${st7.pending}건`);
  check('재동기화로 다른 사람 변경(A의 N3 제목)은 반영', n3b?.data.title === '재전송 시험 (A가 제목 수정)');
  const f10 = await S.flushOutbox(ctxB);
  await S.pullWorkspace(ctxA);
  check('그다음 보내기 → A까지 전달', f10.status === 'DONE' && (await note(devA, ws, N2))?.data.body === 'B가 오프라인에서 고침'
    && !!(await note(devA, ws, N4)), JSON.stringify(f10));

  // -------------------------------------------------------------------
  group('8. 삭제(휴지통)와 삭제된 기록 수정');
  await S.pullWorkspace(ctxB);
  await S.saveLocal(ctxA, [{ kind: 'delete', entity: 'tasks', id: T1 }]);
  await S.flushOutbox(ctxA);
  await S.saveLocal(ctxB, [{ kind: 'update', entity: 'tasks', id: T1, data: { status: 'DONE' } }]);
  const f11 = await S.flushOutbox(ctxB);
  check('A가 지운 할 일을 B가 고침 → 충돌', f11.status === 'CONFLICT', f11.conflicts?.[0]?.reason);
  let keepErr = null;
  try {
    await S.resolveConflict(ctxB, f11.outboxSeq, 'keep_mine');
    const again = await S.flushOutbox(ctxB);
    if (again.status === 'CONFLICT') await S.resolveConflict(ctxB, again.outboxSeq, 'keep_mine');
  } catch (e) { keepErr = e; }
  check('휴지통에 간 기록은 "내 것 유지" 불가 (CANNOT_KEEP)', keepErr?.code === 'CANNOT_KEEP', keepErr?.message);
  const pendingConf = (await S.listOutbox(devB.db, ws)).find((r) => r.status === 'CONFLICT');
  if (pendingConf) await S.resolveConflict(ctxB, pendingConf.seq, 'use_server');
  await S.pullWorkspace(ctxB);
  const visible = await S.listLocal(devB.db, ws, 'tasks');
  const trash = await S.listLocal(devB.db, ws, 'tasks', { includeDeleted: true });
  check('B: 목록에서는 빠지고 휴지통 보기에는 있음', !visible.some((t) => t.key === T1) && trash.some((t) => t.key === T1 && t.data.deleted_at));

  // -------------------------------------------------------------------
  group('8-1. 메모 복구 · 손글씨 · 화면 칸 (migration #22·#23)');
  const N5 = id(); const P5 = id(); const E5 = id();
  const ink = [{ id: 's1', c: '#1E88E5', w: 3, p: [[10, 10], [20.5, 18], [31, 25]] }];
  // 서버(jsonb)는 객체 키 순서를 바꿔서 돌려주므로 키를 정렬해서 비교
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  const sameInk = (v) => canon(v) === canon(ink);
  await S.pullWorkspace(ctxA);
  await S.saveLocal(ctxA, [
    { kind: 'create', entity: 'projects', id: P5, data: { name: '발표 준비', progress_status: 'IN_PROGRESS', due_date: '2026-11-30', priority: 3, assignee_name: '병욱', location: '공학관' } },
    { kind: 'create', entity: 'notes', id: N5, data: { title: '손글씨 메모', strokes: ink } },
    { kind: 'create', entity: 'events', id: E5, data: { title: '리허설', start_at: '2026-11-28T10:00:00+09:00', end_at: '2026-11-28T11:00:00+09:00', status: 'IN_PROGRESS', reminder_minutes: 30 } },
  ]);
  const f81 = await S.flushOutbox(ctxA);
  await S.pullWorkspace(ctxB);
  const p5b = await S.getLocal(devB.db, ws, 'projects', P5);
  const n5b = await note(devB, ws, N5);
  const e5b = await S.getLocal(devB.db, ws, 'events', E5);
  const snap81 = await B.rpc('sync_snapshot', { p_workspace_id: ws });
  check('A가 만든 화면 칸·손글씨가 B에 그대로 (프로젝트 진행·마감·중요도, 일정 상태·알림, 공간 설명)',
    f81.status === 'DONE' && p5b?.data.progress_status === 'IN_PROGRESS' && p5b.data.due_date === '2026-11-30' && p5b.data.priority === 3
    && p5b.data.status === 'ACTIVE' && sameInk(n5b?.data.strokes)
    && e5b?.data.status === 'IN_PROGRESS' && e5b.data.reminder_minutes === 30 && snap81.workspace?.description === '두 기기 검증용 공간',
    JSON.stringify(f81));

  await S.saveLocal(ctxA, [{ kind: 'delete', entity: 'notes', id: N5 }]);
  await S.flushOutbox(ctxA);
  await S.pullWorkspace(ctxB);
  const trashed = !!(await note(devB, ws, N5))?.data.deleted_at;
  await S.saveLocal(ctxB, [{ kind: 'restore', entity: 'notes', id: N5 }]);
  const n5r = await note(devB, ws, N5);
  check('B: 휴지통 메모 복구 → 보내기 전에도 화면에 바로 보임', trashed && n5r?.pending === true && !n5r.data.deleted_at,
    `휴지통=${trashed}`);
  const f82 = await S.flushOutbox(ctxB);
  await S.pullWorkspace(ctxA);
  const n5a = await note(devA, ws, N5);
  const listedA = (await S.listLocal(devA.db, ws, 'notes')).some((n) => n.key === N5);
  check('B의 복구가 A까지 전달 (목록에 다시 보이고 손글씨도 그대로)',
    f82.status === 'DONE' && listedA && !n5a?.data.deleted_at && sameInk(n5a?.data.strokes),
    JSON.stringify(f82));

  // 둘이 동시에 복구 → 늦은 쪽은 충돌, 이미 복구됐으니 "내 것 유지" 불가 → 서버 값
  await S.saveLocal(ctxA, [{ kind: 'delete', entity: 'notes', id: N5 }]);
  await S.flushOutbox(ctxA);
  await S.pullWorkspace(ctxB);
  await S.saveLocal(ctxA, [{ kind: 'restore', entity: 'notes', id: N5 }]);
  await S.saveLocal(ctxB, [{ kind: 'restore', entity: 'notes', id: N5 }]);
  const f83a = await S.flushOutbox(ctxA);
  const f83b = await S.flushOutbox(ctxB);
  let keepErr2 = null;
  if (f83b.status === 'CONFLICT') {
    try { await S.resolveConflict(ctxB, f83b.outboxSeq, 'keep_mine'); } catch (e) { keepErr2 = e; }
    if (keepErr2) await S.resolveConflict(ctxB, f83b.outboxSeq, 'use_server');
  }
  await S.pullWorkspace(ctxB);
  const n5c = await note(devB, ws, N5);
  check('두 기기가 같은 메모를 동시에 복구 → 늦은 쪽 충돌, "내 것 유지" 불가 → 서버 값 (복구된 상태)',
    f83a.status === 'DONE' && f83b.status === 'CONFLICT' && keepErr2?.code === 'CANNOT_KEEP' && !n5c?.data.deleted_at && !n5c.pending,
    `${f83b.conflicts?.[0]?.reason} / ${keepErr2?.message ?? '오류 없음'}`);

  // 잘못된 손글씨는 서버가 거절 → 그 묶음만 버림
  await S.saveLocal(ctxA, [{ kind: 'update', entity: 'notes', id: N5, data: { strokes: [{ id: 's1', c: '#000', w: 0, p: [[1, 2]] }] } }]);
  const f84 = await S.flushOutbox(ctxA);
  if (f84.status === 'BLOCKED') await S.discardOutbox(ctxA, f84.outboxSeq);
  const n5d = await note(devA, ws, N5);
  check('형식이 틀린 손글씨(굵기 0) → 서버 거절(CHECK_FAILED), 버리면 원래 손글씨로',
    f84.status === 'BLOCKED' && f84.code === 'CHECK_FAILED' && sameInk(n5d?.data.strokes) && !n5d.pending,
    `${f84.status} ${f84.code ?? ''}`);

  // -------------------------------------------------------------------
  group('9. 최종 일치 (두 기기 = 서버)');
  await S.pullWorkspace(ctxA);
  await S.pullWorkspace(ctxB);
  const snap = await A.rpc('sync_snapshot', { p_workspace_id: ws });
  const pick = (r) => JSON.stringify([r.title, r.body, r.revision, !!r.deleted_at]);
  const server = new Map(snap.notes.map((n) => [n.id, pick(n)]));
  const sameAs = async (dev) => {
    const local = await S.listLocal(dev.db, ws, 'notes', { includeDeleted: true });
    return local.length === server.size && local.every((n) => server.get(n.key) === pick(n.data));
  };
  check('A 기기 메모 = 서버', await sameAs(devA), `서버 메모 ${server.size}개`);
  check('B 기기 메모 = 서버', await sameAs(devB));
  const sA = await S.getSyncStatus(devA.db, ws); const sB = await S.getSyncStatus(devB.db, ws);
  check('두 기기 커서 = 서버 마지막 seq, 보낼 목록 0건', sA.lastSeq === snap.as_of_seq && sB.lastSeq === snap.as_of_seq && sA.pending + sB.pending === 0,
    `서버 ${snap.as_of_seq}, A ${sA.lastSeq}, B ${sB.lastSeq}`);

  // -------------------------------------------------------------------
  if (A.client && B.client) {
    group('10. 실시간 변경 신호 (Realtime, 원격만)');
    // B: 신호 구독
    const sigB = []; const stB = [];
    const unsubB = R.subscribeWorkspace(B.client, ws, { onSignal: (s) => sigB.push(s), onStatus: (s, d) => stB.push([s, d]) });
    check('B: 공간 신호 채널 구독됨', await waitFor(() => stB.some(([s]) => s === 'connected')), statusText(stB));

    // A 저장 → B 신호
    //   Realtime 서버가 한동안 쉬다가 이 연결로 막 켜졌으면, "연결됨" 뒤 1~2초 동안은 DB 신호를 아직 못 읽어서
    //   그 사이 신호는 빠져요(서버 로그: 연결 → 2초 뒤 replication 시작). 앱은 watchWorkspace의 연결 직후·5초 뒤 받기로 메워요.
    //   그래서 여기서는 신호가 안 오면 새로 저장해서 최대 3번 확인하고, 몇 번째에 왔는지 남겨요.
    let headR = -1; let fR = { status: 'NOT_RUN' }; let gotR = false; let tries = 0;
    while (!gotR && tries < 3) {
      tries++;
      await S.saveLocal(ctxA, [{ kind: 'create', entity: 'notes', id: id(), data: { title: `실시간 신호 확인 ${tries}`, body: '신호' } }]);
      fR = await S.flushOutbox(ctxA);
      const pR = await S.pullWorkspace(ctxA);
      headR = pR.status === 'OK' || pR.status === 'RESYNCED' ? pR.lastSeq : -1;
      gotR = await waitFor(() => sigB.some((s) => s.type === 'changed' && s.lastSeq >= headR), 8000);
    }
    check('A 저장 → B가 변경 신호를 받음 (공간 id·서버 순번)', fR.status === 'DONE' && gotR
      && sigB.every((s) => s.workspaceId === ws),
      `서버 순번 ${headR}, 받은 신호 ${sigB.filter((s) => s.type === 'changed').map((s) => s.lastSeq).join(',') || '없음'}`
      + (tries > 1 ? `, ${tries}번째 저장에서 받음 (앞 신호는 Realtime 서버가 켜지는 중이라 빠짐)` : ''));
    unsubB();

    // watchWorkspace: 신호 → 자동 받기 → B SQLite
    const pulls = []; const stW = [];
    const stopW = R.watchWorkspace(B.client, ctxB, { onPulled: (o) => pulls.push(o), onStatus: (s, d) => stW.push([s, d]), delayMs: 100 });
    await waitFor(() => pulls.length > 0);
    const NW = id();
    await S.saveLocal(ctxA, [{ kind: 'create', entity: 'notes', id: NW, data: { title: '자동으로 받기', body: 'watch' } }]);
    await S.flushOutbox(ctxA);
    const autoOk = await waitFor(async () => (await note(devB, ws, NW))?.data?.title === '자동으로 받기');
    check('B: 신호를 받으면 자동으로 받아 와서 SQLite에 반영 (watchWorkspace)', autoOk,
      `받기 ${pulls.length}번, 상태 ${statusText(stW)}`);
    stopW();

    // A만 있는 다른 공간: B는 구독 못 함, A는 삭제 신호를 받음
    const ws2 = await A.rpc('create_workspace', { p_name: '신호 권한 확인' });
    env.cleanup.push(async () => { await A.rpc('delete_workspace', { p_workspace_id: ws2 }).catch(() => undefined); });
    const stX = [];
    const unsubX = R.subscribeWorkspace(B.client, ws2, { onSignal: () => undefined, onStatus: (s, d) => stX.push([s, d]) });
    await waitFor(() => stX.length > 0);
    check('B는 멤버가 아닌 공간의 신호를 구독할 수 없음', stX.length > 0 && !stX.some(([s]) => s === 'connected')
      && stX.some(([s]) => s === 'denied' || s === 'error'), statusText(stX));
    unsubX();

    const sigA = []; const stA = [];
    const unsubA = R.subscribeWorkspace(A.client, ws2, { onSignal: (s) => sigA.push(s), onStatus: (s, d) => stA.push([s, d]) });
    await waitFor(() => stA.some(([s]) => s === 'connected'));
    await A.rpc('delete_workspace', { p_workspace_id: ws2 });
    check('공간을 삭제하면 멤버에게 closed 신호', await waitFor(() => sigA.some((s) => s.type === 'closed' && s.workspaceId === ws2)),
      `상태 ${statusText(stA)}, 신호 ${sigA.map((s) => s.type).join(',') || '없음'}`);
    unsubA();

    // 앱(멤버)이 직접 보낸 가짜 신호는 전달되지 않음
    const sigA2 = []; const stA2 = [];
    const unsubA2 = R.subscribeWorkspace(A.client, ws, { onSignal: (s) => sigA2.push(s), onStatus: (s, d) => stA2.push([s, d]) });
    await waitFor(() => stA2.some(([s]) => s === 'connected'));
    await B.client.removeAllChannels();   // 앞에서 쓴 B 채널 정리 (같은 주제로 새로 구독)
    const fake = B.client.channel(R.workspaceTopic(ws), { config: { private: true } });
    const joined = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 15000);
      fake.subscribe((st) => { if (st !== 'CLOSED') { clearTimeout(t); resolve(st); } });
    });
    const sent = joined === 'SUBSCRIBED'
      ? await fake.send({ type: 'broadcast', event: 'changed', payload: { workspace_id: ws, last_seq: 999999 } }).catch((e) => `error ${e.message}`)
      : 'not joined';
    await new Promise((r) => setTimeout(r, 3000));
    check('멤버도 가짜 신호를 보낼 수 없음 (서버 트리거만 보냄)', !sigA2.some((s) => s.type === 'changed' && s.lastSeq === 999999),
      `B 구독 ${joined}, 보내기 ${sent}`);
    await B.client.removeChannel(fake);
    unsubA2();
  } else {
    group('10. 실시간 변경 신호 — 원격에서만 확인 (로컬 DB는 supabase/tests/test_realtime.sql)');
  }

  // -------------------------------------------------------------------
  if (A.client && B.client) {
    group('11. 첨부 업로드·다운로드 (원격만)');
    const enc = new TextEncoder();
    const hex = async (b) => F.sha256Hex(b);
    const codeOf = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code ?? e.message; } };
    const fileBytes = enc.encode(`검증용 첨부 ${new Date().toISOString()}\n`.repeat(20));

    // 업로드
    const AID = id();
    const asset = await F.uploadAttachment(A.client, { workspaceId: ws, assetId: AID, bytes: fileBytes, mimeType: 'text/plain', name: '검증 메모.txt' });
    check('A: 올리기 → 서버가 크기·해시를 확인하고 AVAILABLE', asset.id === AID && asset.status === 'AVAILABLE'
      && Number(asset.actual_size_bytes) === fileBytes.byteLength && asset.declared_sha256 === await hex(fileBytes),
      `${asset.status}, ${asset.actual_size_bytes}B`);

    // 다른 기기
    await S.pullWorkspace(ctxB);
    const assetAtB = await S.getLocal(devB.db, ws, 'assets', AID);
    check('B: 받기 → 첨부 정보가 B SQLite에 저장', assetAtB?.data?.status === 'AVAILABLE' && assetAtB.data.object_path === `${ws}/${AID}`);
    const gotBytes = await F.downloadAttachment(B.client, assetAtB.data);
    check('B: 내려받은 내용 = A가 올린 내용 (SHA-256 같음)', await hex(gotBytes) === await hex(fileBytes), `${gotBytes.byteLength}B`);

    // 메모에 연결 → 다른 기기
    const NA = id();
    await S.saveLocal(ctxA, [
      { kind: 'create', entity: 'notes', id: NA, data: { title: '첨부 있는 메모', body: '사진 참고' } },
      { kind: 'link', entity: 'note_attachments', data: { note_id: NA, asset_id: AID, position: 0 } },
    ]);
    const fA = await S.flushOutbox(ctxA);
    await S.pullWorkspace(ctxB);
    const linksB = await S.listLocal(devB.db, ws, 'note_attachments');
    check('A: 메모에 첨부 연결 → B에도 연결이 옴', fA.status === 'DONE' && linksB.some((l) => l.data.note_id === NA && l.data.asset_id === AID),
      `보내기 ${fA.status}, B 연결 ${linksB.length}개`);

    // 같은 assetId로 다시
    const again = await F.uploadAttachment(A.client, { workspaceId: ws, assetId: AID, bytes: fileBytes, mimeType: 'text/plain' });
    check('같은 assetId로 다시 올리기 → 다시 안 올리고 같은 결과', again.id === AID && again.completed_at === asset.completed_at);

    // 내용이 다른 파일 (준비한 해시와 실제 업로드가 다름)
    const BAD = id();
    const prepBad = await A.client.functions.invoke('assets/prepare', { body: {
      asset_id: BAD, workspace_id: ws, mime_type: 'text/plain', size_bytes: fileBytes.byteLength, sha256: await hex(fileBytes) } });
    const other = new Uint8Array(fileBytes.byteLength).fill(65);
    await A.client.storage.from(prepBad.data.bucket).uploadToSignedUrl(prepBad.data.path, prepBad.data.token, other, { contentType: 'text/plain', upsert: true });
    const badRes = await A.client.functions.invoke('assets/complete', { body: { asset_id: BAD } });
    const badBody = badRes.error ? await badRes.error.context.json().catch(() => ({})) : badRes.data;
    const leftover = await A.client.storage.from('attachments').download(prepBad.data.path);
    check('준비한 내용과 다른 파일 → 거절(HASH_MISMATCH)하고 파일도 지움', badBody.code === 'HASH_MISMATCH' && !!leftover.error,
      `${badBody.code ?? badBody.status}`);

    // 올리지 않고 확인
    const NOUP = id();
    await A.client.functions.invoke('assets/prepare', { body: {
      asset_id: NOUP, workspace_id: ws, mime_type: 'image/png', size_bytes: 10, sha256: 'a'.repeat(64) } });
    const noUp = await A.client.functions.invoke('assets/complete', { body: { asset_id: NOUP } });
    const noUpBody = noUp.error ? await noUp.error.context.json().catch(() => ({})) : noUp.data;
    check('올리기 전에 확인 → NOT_UPLOADED (같은 id로 이어서 올리면 됨)', noUpBody.code === 'NOT_UPLOADED', noUpBody.code);

    // 권한·형식·크기
    const ws3 = await A.rpc('create_workspace', { p_name: '첨부 권한 확인' });
    env.cleanup.push(async () => { await A.rpc('delete_workspace', { p_workspace_id: ws3 }).catch(() => undefined); });
    const forb = await codeOf(F.uploadAttachment(B.client, { workspaceId: ws3, assetId: id(), bytes: fileBytes, mimeType: 'text/plain' }));
    check('멤버가 아닌 공간에는 못 올림 (FORBIDDEN)', forb === 'FORBIDDEN', forb);
    const exe = await codeOf(F.uploadAttachment(A.client, { workspaceId: ws, assetId: id(), bytes: fileBytes, mimeType: 'application/x-msdownload' }));
    const big = await A.client.functions.invoke('assets/prepare', { body: {
      asset_id: id(), workspace_id: ws, mime_type: 'audio/mp4', size_bytes: 52428801, sha256: 'a'.repeat(64) } });
    const bigBody = big.error ? await big.error.context.json().catch(() => ({})) : big.data;
    check('실행 파일 형식·50MB 초과는 서버가 거절', exe === 'UNSUPPORTED_TYPE' && bigBody.code === 'TOO_LARGE', `${exe}, ${bigBody.code}`);

    // 서명 URL 없이 직접 업로드
    const direct = await B.client.storage.from('attachments').upload(`${ws}/${id()}`, fileBytes, { contentType: 'text/plain' });
    check('앱이 Storage에 직접 올리는 것은 막힘 (서명 URL로만)', !!direct.error, direct.error?.message);

    // 삭제
    await F.deleteAttachment(A.client, AID);
    await S.pullWorkspace(ctxB);
    const afterDel = await S.getLocal(devB.db, ws, 'assets', AID);
    const urlErr = await codeOf(F.getAttachmentUrl(B.client, assetAtB.data));
    check('삭제 → B에 삭제 표시가 오고 주소도 못 받음', afterDel?.data?.status === 'DELETED' && !!afterDel.data.deleted_at && urlErr === 'NOT_FOUND',
      `${afterDel?.data?.status}, 주소 ${urlErr}`);
  } else {
    group('11. 첨부 업로드·다운로드 — 원격에서만 확인 (로컬 DB는 supabase/tests/test_assets.sql)');
  }

  // -------------------------------------------------------------------
  group('11-1. 프로젝트 팀원·초대 (프론트 화면 기준)');
  {
    const asClient = (U) => ({
      rpc: async (name, args) => {
        try { return { data: await U.rpc(name, args ?? {}), error: null }; }
        catch (e) { return { data: null, error: { message: `${e.code}: ${e.message}` } }; }
      },
    });
    await S.pullWorkspace(ctxA); await S.pullWorkspace(ctxB);
    const PA = id(), PB = id(), MA = id();
    await S.saveLocal(ctxA, [
      ...Team.newProjectChanges(PA, { name: '팀원 검증' }, { accountId: A.accountId, name: '검증A', memberId: MA }),
      { kind: 'create', entity: 'projects', id: PB, data: { name: '옮겨 갈 프로젝트' } },
    ]);
    const f1 = await S.flushOutbox(ctxA);
    await S.pullWorkspace(ctxB);
    const mB0 = Team.membersOf(await S.listLocal(devB.db, ws, 'project_members'), PA);
    check('프로젝트를 만든 사람이 팀장 → B 기기 팀원 목록에 그대로', f1.status === 'DONE' && mB0.length === 1
      && mB0[0].role === '팀장' && mB0[0].account_id === A.accountId, `${f1.status} · ${mB0.map((m) => `${m.name}(${m.role})`).join(', ')}`);

    let inv = null, invErr = null;
    try { inv = await Team.createProjectInvite(asClient(A), PA, { method: '링크' }); } catch (e) { invErr = e; }
    let memberB = null;
    if (inv) {
      const j = await B.rpc('join_with_invite', { p_code: inv.code });
      await S.pullWorkspace(ctxA); await S.pullWorkspace(ctxB);
      const mA = Team.membersOf(await S.listLocal(devA.db, ws, 'project_members'), PA);
      memberB = mA.find((m) => m.account_id === B.accountId) ?? null;
      const invA = (await S.listLocal(devA.db, ws, 'project_invites')).map((r) => r.data).find((i) => i.id === inv.project_invite_id);
      check('링크 초대 → B가 코드 입력 → 이미 공간 멤버라도 그 프로젝트 팀원으로, A 기기에 팀원·초대 수락 반영',
        j.already_member === true && j.projects.length === 1 && memberB?.role === '팀원' && invA?.status === 'ACCEPTED' && Team.pendingInvites(
          await S.listLocal(devA.db, ws, 'project_invites'), PA).length === 0, `${memberB?.name}(${memberB?.role}) · 초대 ${invA?.status}`);
    } else {
      // 원격 계정은 이번 달 초대 횟수(FREE 10회)를 다 쓸 수 있음 → 팀원은 직접 추가해서 다음 단계 계속
      const MB = id();
      await S.saveLocal(ctxA, Team.teamChanges.add(MB, PA, { name: '검증B', accountId: B.accountId }));
      await S.flushOutbox(ctxA); await S.pullWorkspace(ctxB);
      memberB = Team.membersOf(await S.listLocal(devB.db, ws, 'project_members'), PA).find((m) => m.id === MB) ?? null;
      check('초대 — 이번 달 초대 횟수를 다 써서 건너뜀 (팀원은 직접 추가, 다음 달에 다시 확인)', invErr?.code === 'INVITE_LIMIT' && !!memberB, invErr?.message);
    }

    // #30 팀장 권한: 팀원 B가 자기 역할을 바꾸면 충돌(NOT_PROJECT_LEADER) → 서버 값으로 되돌림. 팀장 A가 바꾸면 B 기기에 반영
    await S.pullWorkspace(ctxB);
    await S.saveLocal(ctxB, Team.teamChanges.edit(memberB.id, { name: '검증B', role: '디자이너' }));
    const f3 = await S.flushOutbox(ctxB);
    const leaderBlocked = f3.status === 'CONFLICT' && f3.conflicts.every((c) => Team.isLeaderConflict(c));
    if (f3.status === 'CONFLICT') await S.resolveConflict(ctxB, f3.outboxSeq, 'use_server');
    const bBack = await S.getLocal(devB.db, ws, 'project_members', memberB.id);
    await S.saveLocal(ctxA, Team.teamChanges.edit(memberB.id, { name: '검증B', role: '디자이너' }));
    const f3a = await S.flushOutbox(ctxA);
    await S.pullWorkspace(ctxB);
    const bOnB = Team.membersOf(await S.listLocal(devB.db, ws, 'project_members'), PA).find((m) => m.id === memberB.id);
    check('팀원 B가 자기 역할 수정 → 팀장 권한 충돌(NOT_PROJECT_LEADER) → 서버 값으로 되돌림, 팀장 A가 "디자이너"로 바꾸면 B 기기에 반영',
      leaderBlocked && bBack?.data.role === '팀원' && f3a.status === 'DONE' && bOnB?.role === '디자이너' && bOnB?.name === '검증B',
      `B 보냄 ${f3.status}(${f3.conflicts?.map((c) => c.reason).join(',') ?? ''}) → ${bBack?.data.role} / A 보냄 ${f3a.status} → ${bOnB?.name}(${bOnB?.role})`);

    // 팀장만 지우기는 막힘 (화면과 같은 규칙), B를 다른 프로젝트로 이동 → B 기기
    const membersA = Team.membersOf(await S.listLocal(devA.db, ws, 'project_members'), PA);
    let leaderErr = null;
    try { Team.teamChanges.remove(membersA, [MA]); } catch (e) { leaderErr = e; }
    await S.saveLocal(ctxA, Team.teamChanges.move([memberB.id], PB));
    const f4 = await S.flushOutbox(ctxA);
    await S.pullWorkspace(ctxB);
    const rowsB = await S.listLocal(devB.db, ws, 'project_members');
    check('팀장을 모두 지우기는 막힘(LAST_LEADER), B를 다른 프로젝트로 이동 → B 기기에서도 옮겨짐',
      leaderErr?.code === 'LAST_LEADER' && f4.status === 'DONE' && Team.membersOf(rowsB, PB).some((m) => m.id === memberB.id)
      && !Team.membersOf(rowsB, PA).some((m) => m.id === memberB.id), Team.teamErrorMessage(leaderErr));

    const q = await Team.getProjectInviteQuota(asClient(A));
    check('이번 달 초대 횟수 (화면: 남은 횟수 / 한도)', q.limit >= 10 && q.used >= (inv ? 1 : 0) && q.remaining === Math.max(q.limit - q.used, 0),
      `${q.plan} ${q.remaining} / ${q.limit}회`);
  }

  // -------------------------------------------------------------------
  group('11-2. 메모 즐겨찾기 · 팀장 권한 · 프로젝트 파일 직접 연결 (11/15)');
  {
    const asClient = (U) => ({
      rpc: async (name, args) => {
        try { return { data: await U.rpc(name, args ?? {}), error: null }; }
        catch (e) { return { data: null, error: { message: `${e.code}: ${e.message}` } }; }
      },
    });
    // 즐겨찾기: 사람마다 따로 (동기화 원장에 안 남음)
    const NF1 = id(), NF2 = id();
    await S.saveLocal(ctxA, [
      { kind: 'create', entity: 'notes', id: NF1, data: { title: '즐겨찾기 검증 1', body: '' } },
      { kind: 'create', entity: 'notes', id: NF2, data: { title: '즐겨찾기 검증 2', body: '' } }]);
    await S.flushOutbox(ctxA); await S.pullWorkspace(ctxB);
    const fa = await Fav.setNoteFavorites(asClient(A), ws, [NF1, NF2], true);
    const fb = await Fav.listNoteFavorites(asClient(B), ws);
    await Fav.setNoteFavorites(asClient(A), ws, [NF2], false);
    const faList = await Fav.listNoteFavorites(asClient(A), ws);
    check('메모 즐겨찾기: A가 별표 → A 목록(다른 기기도 같은 목록)에 보이고 B에게는 안 보임, 해제도 반영',
      fa.changed === 2 && !fb.has(NF1) && faList.has(NF1) && !faList.has(NF2), `A ${faList.size}개, B ${fb.size}개`);

    // 팀장 권한: A가 팀장인 프로젝트 PL(B는 팀원) + 팀장 없는 PN
    const PL = id(), PN = id();
    await S.saveLocal(ctxA, [
      ...Team.newProjectChanges(PL, { name: '팀장 권한 검증' }, { accountId: A.accountId, name: '검증A', memberId: id() }),
      ...Team.teamChanges.add(id(), PL, { name: '검증B', accountId: B.accountId }),
      { kind: 'create', entity: 'projects', id: PN, data: { name: '팀장 없는 프로젝트' } }]);
    const fl = await S.flushOutbox(ctxA);
    await S.pullWorkspace(ctxB);
    const roleB = (await S.getLocal(devB.db, ws, 'workspace_members', B.accountId))?.data.role;
    const devCalc = Team.canManageProject({ me: B.accountId, myRole: roleB, members: Team.membersOf(await S.listLocal(devB.db, ws, 'project_members'), PL) });
    const permB = await Team.getProjectPermissions(asClient(B), ws);
    await S.saveLocal(ctxB, [{ kind: 'update', entity: 'projects', id: PL, data: { name: 'B가 바꾼 이름' } }]);
    const fB = await S.flushOutbox(ctxB);
    if (fB.status === 'CONFLICT') await S.resolveConflict(ctxB, fB.outboxSeq, 'use_server');
    await S.saveLocal(ctxB, [{ kind: 'update', entity: 'projects', id: PN, data: { name: 'B도 바꿀 수 있는 프로젝트' } }]);
    const fB2 = await S.flushOutbox(ctxB);
    let invErr = null;
    try { await Team.createProjectInvite(asClient(B), PL, { method: '링크' }); } catch (e) { invErr = e; }
    check('팀장 권한: 팀원 B는 팀장 있는 프로젝트 수정(충돌 NOT_PROJECT_LEADER → 서버 값)·초대(FORBIDDEN) 불가, 팀장 없는 프로젝트는 수정 가능, 기기 계산 = 서버',
      fl.status === 'DONE' && permB[PL] === false && permB[PN] === true && devCalc === false
        && fB.status === 'CONFLICT' && fB.conflicts.every((c) => Team.isLeaderConflict(c)) && fB2.status === 'DONE' && invErr?.code === 'FORBIDDEN',
      `서버 ${permB[PL]}/${permB[PN]} · 기기 ${devCalc} · B 수정 ${fB.status}/${fB2.status} · 초대 ${invErr?.code ?? '됨(문제)'} ${Team.teamErrorMessage(invErr)}`);

    // 프로젝트에 파일 직접 연결 (업로드가 필요해서 원격만)
    if (A.client) {
      const asset = await F.uploadAttachment(A.client, { workspaceId: ws, assetId: id(), bytes: new TextEncoder().encode('프로젝트 자료'), mimeType: 'text/plain', name: '자료.txt' });
      await S.pullWorkspace(ctxB);
      await S.saveLocal(ctxB, Team.projectFileChanges.link(PL, asset.id));
      const fF = await S.flushOutbox(ctxB);
      await S.pullWorkspace(ctxA);
      const onA = Team.projectFilesOf(await S.listLocal(devA.db, ws, 'project_files'), PL);
      await S.saveLocal(ctxA, Team.projectFileChanges.move(asset.id, PL, PN));
      const fM = await S.flushOutbox(ctxA);
      await S.pullWorkspace(ctxB);
      const rowsF = await S.listLocal(devB.db, ws, 'project_files');
      check('프로젝트에 파일 직접 연결(메모 없이): 팀원 B가 연결 → A 기기에 보임, A가 다른 프로젝트로 옮김 → B 기기에서도 옮겨짐',
        fF.status === 'DONE' && onA.some((f) => f.asset_id === asset.id) && fM.status === 'DONE'
          && Team.projectOfFile(rowsF, asset.id) === PN && Team.projectFilesOf(rowsF, PL).length === 0,
        `연결 ${fF.status} → A ${onA.length}개 · 이동 ${fM.status} → B 기기 ${Team.projectOfFile(rowsF, asset.id) === PN ? '옮겨짐' : '그대로(문제)'}`);
      await F.deleteAttachment(A.client, asset.id).catch(() => {});
    }
  }

  // -------------------------------------------------------------------
  group('11-3. 공유 휴지통 (할 일·메모 복구·영구 삭제, 11/15)');
  {
    const TK = id(), NT = id();
    await S.saveLocal(ctxA, [
      { kind: 'create', entity: 'tasks', id: TK, data: { title: '휴지통 검증 할 일' } },
      { kind: 'create', entity: 'notes', id: NT, data: { title: '휴지통 검증 메모', body: '' } }]);
    await S.flushOutbox(ctxA);
    await S.saveLocal(ctxA, Trash.trashChanges.remove([{ entity: 'tasks', id: TK }, { entity: 'notes', id: NT }]));
    const f1 = await S.flushOutbox(ctxA);
    await S.pullWorkspace(ctxB);
    const roleB = (await S.getLocal(devB.db, ws, 'workspace_members', B.accountId))?.data.role;
    const items = Trash.trashItems({ tasks: await S.listLocal(devB.db, ws, 'tasks', { includeDeleted: true }), notes: await S.listLocal(devB.db, ws, 'notes', { includeDeleted: true }) })
      .filter((i) => i.id === TK || i.id === NT);
    check('휴지통: A가 할 일·메모를 휴지통으로 → B 기기 휴지통 목록에 둘 다 (30일 뒤 자동 삭제, B는 영구 삭제 버튼 없음)',
      f1.status === 'DONE' && items.length === 2 && items.every((i) => i.daysLeft === 30 && i.deletedBy === A.accountId)
        && !Trash.canPurge({ me: B.accountId, myRole: roleB, item: items[0] }) && Trash.canRestore(roleB),
      `${items.length}개 · ${items.map((i) => Trash.trashNoticeText(i)).join(' / ')}`);

    await S.saveLocal(ctxB, Trash.trashChanges.restore([{ entity: 'tasks', id: TK }]));
    const fR = await S.flushOutbox(ctxB);
    await S.pullWorkspace(ctxA);
    const tA = await S.getLocal(devA.db, ws, 'tasks', TK);
    check('복구: B가 A가 지운 할 일을 복구(메모만 되던 것 → 7가지 모두) → A 기기에서도 휴지통에서 빠짐',
      fR.status === 'DONE' && tA && !tA.data.deleted_at, `${fR.status}, A 기기 deleted_at=${tA?.data.deleted_at ?? null}`);

    await S.saveLocal(ctxB, Trash.trashChanges.purge([{ entity: 'notes', id: NT }]));
    const fP = await S.flushOutbox(ctxB);
    const why = fP.conflicts?.[0]?.reason;
    if (fP.status === 'CONFLICT') await S.resolveConflict(ctxB, fP.outboxSeq, 'use_server');
    await S.saveLocal(ctxA, Trash.trashChanges.purge([{ entity: 'notes', id: NT }]));
    const fA = await S.flushOutbox(ctxA);
    await S.pullWorkspace(ctxB);
    const nB = await S.getLocal(devB.db, ws, 'notes', NT);
    const nA = await S.getLocal(devA.db, ws, 'notes', NT);
    check('영구 삭제: 지운 사람이 아닌 B는 충돌(PURGE_NOT_ALLOWED) → 서버 값, 지운 A가 영구 삭제 → 두 기기에서 사라짐',
      fP.status === 'CONFLICT' && why === 'PURGE_NOT_ALLOWED' && fA.status === 'DONE' && !nB && !nA,
      `B ${fP.status}(${why}: ${Trash.trashConflictMessage(why)}) · A ${fA.status} · B 기기 ${nB ? '남음(문제)' : '없음'}`);
  }

  // -------------------------------------------------------------------
  group('12. 공간에서 빠지면 기기에서 닫힘');
  await A.rpc('remove_member', { p_workspace_id: ws, p_account_id: B.accountId });
  const p11 = await S.pullWorkspace(ctxB);
  const st11 = await S.getSyncStatus(devB.db, ws);
  check('B: 내보내진 뒤 받기 → CLOSED', p11.status === 'CLOSED' && st11.state === 'CLOSED', p11.status);
  await S.pullWorkspace(ctxA);
  const bAtA = await S.getLocal(devA.db, ws, 'workspace_members', B.accountId);
  check('A: 멤버 목록에 B가 REMOVED로 반영', bAtA?.data.status === 'REMOVED');

  // -------------------------------------------------------------------
  if (A.client && B.client) {
    group('13. 녹음 → 글자 (원격만: 올리기 → 변환 → 성공하면 삭제 / 실패하면 3일 보관)');
    const codeOf = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code ?? e.message; } };
    // 하루에 하나만 남도록 날짜로 정한 업로드 id (실패 시험용 녹음은 3일 보관되므로 실행할 때마다 쌓이지 않게)
    const dailyId = (tag) => {
      const h = require('node:crypto').createHash('sha256').update(`${A.accountId}:${tag}:${new Date().toISOString().slice(0, 10)}`).digest('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    };

    // 외부 AI 동의 (검증 계정 A만). 녹음을 올리기 전에 필요
    const { data: cons } = await A.client.from('consents').select('id').eq('consent_type', 'EXTERNAL_AI').is('revoked_at', null);
    if (!cons?.length) {
      await A.client.from('consents').insert({ account_id: A.accountId, consent_type: 'EXTERNAL_AI', policy_version: 'verify', scope: { features: ['stt'] } });
    }

    // 20MB 녹음: 올리기 → 서버가 꺼내서 OpenAI까지 보냄 (내용이 가짜라 OpenAI가 거절) → 녹음은 남아서 다시 요청 가능
    const bigUp = dailyId('big');
    const t0 = Date.now();
    const bigUpload = await codeOf(T.uploadRecording(A.client, { uploadId: bigUp, bytes: new Uint8Array(20 * 1024 * 1024).fill(1), mimeType: 'audio/mp4' }));
    const big1 = bigUpload === 'OK' ? await codeOf(T.transcribeUploaded(A.client, { uploadId: bigUp, clientRequestId: id(), durationSeconds: 60 })) : bigUpload;
    const keyMissing = big1 === 'NOT_CONFIGURED';
    check('20MB 녹음을 올리면 서버가 꺼내서 OpenAI까지 보냄 (가짜 내용이라 거절, 사용량 안 씀)', big1 === 'AUDIO_REJECTED',
      keyMissing ? '서버에 OPENAI_API_KEY가 없음 → Supabase 대시보드 Edge Functions > Secrets에 등록 필요'
        : `${big1} (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    const big2 = await codeOf(T.transcribeUploaded(A.client, { uploadId: bigUp, clientRequestId: id(), durationSeconds: 60 }));
    check('실패한 녹음은 서버에 남음 → 다시 올리지 않고 새 요청으로 다시 변환 가능', big2 === 'AUDIO_REJECTED', `${big2} (3일 뒤 자동 삭제)`);

    // 실제 변환: 2초짜리 시험음 (1분 차감)
    const wav = toneWav(2);
    const sttUp = id();
    const smallUp = await codeOf(T.uploadRecording(A.client, { uploadId: sttUp, bytes: wav, mimeType: 'audio/wav', fileName: 'tone.wav' }));
    const forb = await codeOf(T.transcribeUploaded(A.client, { uploadId: sttUp, clientRequestId: id(), durationSeconds: 2, workspaceId: id() }));
    const noConsent = await codeOf(T.uploadRecording(B.client, { uploadId: id(), bytes: wav, mimeType: 'audio/wav', fileName: 'tone.wav' }));
    check('거절: 동의 안 한 사람은 올리기부터, 멤버가 아닌 공간은 변환에서', smallUp === 'OK' && noConsent === 'CONSENT_REQUIRED' && forb === 'FORBIDDEN',
      `올리기 ${smallUp}, 동의 없음 ${noConsent}, 남의 공간 ${forb}`);

    const before = await T.getSttUsage(A.client);
    let stt = null; let sttErr = null;
    try {
      stt = await T.transcribeUploaded(A.client, { uploadId: sttUp, clientRequestId: id(), durationSeconds: 2, keywords: ['Stella'] });
    } catch (e) { sttErr = e; }
    check('A: 녹음 → 글자 초안 (OpenAI까지 왕복) → 서버가 녹음 바로 삭제', !!stt && typeof stt.text === 'string' && stt.chargedMinutes === 1 && stt.uploadDeleted === true,
      stt ? `글자 ${stt.text.length}자 "${stt.text.slice(0, 30)}", ${stt.chargedMinutes}분 차감, 남은 ${stt.remainingMinutes}분, 녹음 삭제 ${stt.uploadDeleted}`
        : `${sttErr?.code}: ${sttErr?.message}${sttErr?.code === 'NOT_CONFIGURED' ? ' → OPENAI_API_KEY 등록 필요' : ''}`);
    const after = await T.getSttUsage(A.client);
    check('사용량이 분 단위로 쌓임 (예약은 풀림)', !!stt && after.usedMinutes === before.usedMinutes + stt.chargedMinutes && after.reservedMinutes === 0,
      `전 ${before.usedMinutes}분 → 후 ${after.usedMinutes}분, 예약 ${after.reservedMinutes}분`);
    const gone = await codeOf(T.transcribeUploaded(A.client, { uploadId: sttUp, clientRequestId: id(), durationSeconds: 2 }));
    check('변환이 끝난 녹음은 서버에 없음 (UPLOAD_GONE)', gone === 'UPLOAD_GONE', gone);

    const png = await codeOf(T.uploadRecording(A.client, { uploadId: id(), bytes: wav, mimeType: 'image/png', fileName: 'a.png' }));
    const direct = await A.client.storage.from('stt-uploads').upload(`${A.accountId}/${id()}`, wav, { contentType: 'audio/wav' });
    check('사진 같은 다른 형식 거절, 앱이 보관함에 직접 올리는 것도 막힘 (서명 URL로만)', png === 'UNSUPPORTED_TYPE' && !!direct.error,
      `${png}, 직접 올리기: ${direct.error?.message ?? '됨(문제)'}`);
  } else {
    group('13. 녹음 → 글자 — 원격에서만 확인 (로컬은 supabase/tests/transcribe_function.test.ts)');
  }

  // -------------------------------------------------------------------
  if (A.client && B.client) {
    group('14. 긴 녹음 (원격만: 구간 업로드 → 서버가 구간별 전사 → 전사문 → 녹음 삭제)');
    const codeOf = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code ?? e.message; } };
    // 구간 2개 = 2초 시험음 2개 (실제 서비스는 약 2분 m4a 구간). 실행할 때마다 A의 변환 한도에서 2분 사용
    const seg = [toneWav(2), toneWav(2.5)];
    const recId = id();
    let created = null, createErr = null;
    try {
      created = await Rec.createRecording(A.client, {
        recordingId: recId, keywords: ['Stella'],
        segments: seg.map((b, i) => ({ seq: i, durationSeconds: i === 0 ? 2 : 2.5, sizeBytes: b.byteLength, mimeType: 'audio/wav' })),
      });
    } catch (e) { createErr = e; }
    const confirmed = [];
    let up = null, upErr = null;
    if (created) {
      try {
        up = await Rec.uploadRecordingSegments(A.client, { recordingId: recId, readSegment: async (n) => seg[n], onSegmentConfirmed: (n) => { confirmed.push(n); } });
      } catch (e) { upErr = e; }
    }
    check('녹음 등록 → 구간 2개 업로드 → 서버가 파일·크기·소유자 확인 후 전사 작업 등록', !!up?.allUploaded && confirmed.join() === '0,1',
      created ? (up ? `등록 ${created.total}구간, 확인 ${confirmed.join(',')}, 남은 변환 ${created.remainingMinutes}분` : `${upErr?.code}: ${upErr?.message}`)
        : `${createErr?.code}: ${createErr?.message}`);

    // 서버(stt-worker)가 앱 없이 처리 → 최대 90초 기다림
    let st = null;
    const t1 = Date.now();
    if (up) {
      await waitFor(async () => {
        st = await Rec.getRecordingStatus(A.client, recId).catch(() => st);
        return st && Rec.isRecordingSettled(st.state);
      }, 90000);
    }
    const keyMissing = !!st && st.state === 'PROCESSING' && st.counts.queued > 0;
    check('서버가 구간별로 전사 (앱은 진행률만 봄) → 성공한 구간 음성은 서버에서 바로 삭제', st?.state === 'DONE' && st.counts.done === 2,
      st ? `${Rec.recordingProgressText(st).lines.join(' / ')} (${((Date.now() - t1) / 1000).toFixed(0)}초, ${st.chargedMinutes}분 차감)`
         + (keyMissing ? ' → 서버에 OPENAI_API_KEY가 없어 대기 중 (Edge Functions > Secrets에 등록 필요)' : '') : '상태를 못 받음');

    let tr = null;
    if (st?.state === 'DONE') tr = await Rec.getRecordingTranscript(A.client, recId).catch(() => null);
    const cleared = tr ? await Rec.ackRecordingTranscript(A.client, recId).catch(() => -1) : -1;
    check('전사문 받기(구간 순서대로) → 기기에 저장했다고 알리면(ack) 서버 임시 전사문 삭제', !!tr && tr.complete && tr.segments.length === 2 && cleared === 2,
      tr ? `글 ${tr.text.length}자 "${tr.text.slice(0, 30)}", 지운 전사문 ${cleared}개` : '전사가 끝나지 않음');
    if (keyMissing) await Rec.cancelRecording(A.client, recId).catch(() => {});   // 키 없을 때는 대기 녹음이 쌓이지 않게 취소

    // 업로드 검증·정책·취소
    const rec2 = id();
    const c2 = await codeOf(Rec.createRecording(A.client, { recordingId: rec2, segments: [{ seq: 0, durationSeconds: 2, sizeBytes: 100, mimeType: 'audio/wav' }] }));
    const st2 = c2 === 'OK' ? await Rec.getRecordingStatus(A.client, rec2) : null;
    const pathA = st2?.segments[0]?.path;
    const byB = pathA ? await B.client.storage.from('stt-recordings').upload(pathA, seg[0], { contentType: 'audio/wav', upsert: true }) : { error: { message: 'no path' } };
    const stray = await A.client.storage.from('stt-recordings').upload(`${A.accountId}/${id()}/000.wav`, seg[0], { contentType: 'audio/wav' });
    const wrongSize = await codeOf(Rec.uploadRecordingSegments(A.client, { recordingId: rec2, readSegment: async () => seg[0] }));
    let sizeCode = null;
    if (pathA) {
      await A.client.storage.from('stt-recordings').upload(pathA, seg[0], { contentType: 'audio/wav', upsert: true });
      const { data } = await A.client.rpc('stt_segment_confirm', { p_recording_id: rec2, p_seq: 0 });
      sizeCode = data?.code ?? 'OK';
    }
    check('업로드 검증: 남의 녹음 경로·등록 안 된 경로에는 못 올리고, 크기가 다르면 등록 안 됨', !!byB.error && !!stray.error && wrongSize === 'SIZE_MISMATCH' && sizeCode === 'SIZE_MISMATCH',
      `B가 A 경로에: ${byB.error ? '거절' : '됨(문제)'}, 등록 안 된 경로: ${stray.error ? '거절' : '됨(문제)'}, 앱 확인 ${wrongSize}, 서버 확인 ${sizeCode}`);
    const cancel = await codeOf(Rec.cancelRecording(A.client, rec2));
    const st3 = await Rec.getRecordingStatus(A.client, rec2).catch(() => null);
    const after = pathA ? await A.client.storage.from('stt-recordings').upload(pathA, seg[0], { contentType: 'audio/wav', upsert: true }) : { error: {} };
    check('취소: 상태 CANCELED, 그 뒤로는 올릴 수 없음 (서버 파일은 정리 함수가 바로 삭제)', cancel === 'OK' && st3?.state === 'CANCELED' && !!after.error,
      `${cancel}, ${st3?.state}, 취소 후 업로드 ${after.error ? '거절' : '됨(문제)'}`);
  } else {
    group('14. 긴 녹음 — 원격에서만 확인 (로컬은 supabase/tests/test_stt_recordings.sql·stt_worker.test.ts·recordings_lib.test.ts)');
  }

  // -------------------------------------------------------------------
  if (A.client && B.client) {
    group('15. 사진 → 글자 (원격만: Terra가 사진을 직접 읽음, 사진은 저장 안 함)');
    const ocr = async (body) => {
      const { data, error } = await A.client.functions.invoke('ai-gateway/ocr', { body });
      if (!error) return { status: 200, body: data };
      const res = error.context; let payload = null;
      try { payload = await res.json(); } catch { /* 본문 없음 */ }
      return { status: res?.status ?? 0, body: payload ?? { code: error.message } };
    };
    const png = textPng('STELLA 2026');
    const t2 = Date.now();
    const r = await ocr({ client_request_id: id(), images: [{ base64: png.toString('base64') }], hint: '검증용 글자 사진' });
    const txt = String(r.body?.draft?.text ?? '');
    check('사진 속 글자 읽기 (OpenAI Terra까지 왕복): "STELLA 2026"', r.status === 200 && /STELLA/i.test(txt.replace(/\s/g, '')) && txt.includes('2026'),
      r.status === 200 ? `"${txt.slice(0, 40)}" (${r.body.draft.content_type}, ${((Date.now() - t2) / 1000).toFixed(1)}초, 남은 ${r.body.remaining}회)`
        : `${r.status} ${r.body?.code}: ${r.body?.message ?? ''}`);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    const bad = await ocr({ client_request_id: id(), images: [heic.toString('base64')] });
    const many = await ocr({ client_request_id: id(), images: new Array(6).fill(png.toString('base64')) });
    check('거절: HEIC 같은 읽을 수 없는 형식, 6장 이상 (OpenAI에 안 보내고 횟수도 안 씀)', bad.status === 415 && many.status === 413,
      `${bad.status} ${bad.body?.code}, ${many.status} ${many.body?.code}`);
  } else {
    group('15. 사진 → 글자 — 원격에서만 확인 (로컬은 supabase/tests/gateway_e2e.test.ts 8c)');
  }

  // -------------------------------------------------------------------
  if (A.client && B.client) {
    group('15-1. 문서 → 글자 (원격만: PDF·Word·PowerPoint, Edge Function doc-extract, 외부 AI로 안 보냄)');
    const fs = require('node:fs');
    const fx = (n) => new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'docs', n)));
    const codeOf = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code ?? e.message; } };
    const lecture = fx('lecture.pdf');
    const t3 = Date.now();
    let pdf = null, pdfErr = null;
    try { pdf = await Docs.extractDocumentText(A.client, { bytes: lecture, mimeType: 'application/pdf', fileName: '강의.pdf' }); } catch (e) { pdfErr = e; }
    check('기기 PDF → 쪽마다 글자 (빈 쪽 표시)', !!pdf && pdf.kind === 'PDF' && pdf.totalPages === 3 && pdf.emptyPages.join() === '2'
      && pdf.text.startsWith('--- 1쪽 ---\n1쪽 제목: 정규화와 트랜잭션') && pdf.text.includes('& <태그> 예시'),
      pdf ? `${pdf.totalPages}쪽, 빈 쪽 ${pdf.emptyPages.join(',')}, ${pdf.text.length}자 (${((Date.now() - t3) / 1000).toFixed(1)}초)` : `${pdfErr?.code}: ${pdfErr?.message}`);

    const docx = await Docs.extractDocumentText(A.client, { bytes: fx('meeting.docx'), fileName: '회의.docx' }).catch((e) => e);
    const pptx = await Docs.extractDocumentText(A.client, { bytes: fx('slides.pptx'), fileName: '발표.pptx' }).catch((e) => e);
    check('Word(표·쪽 나눔)·PowerPoint(슬라이드·발표자 메모)', docx?.kind === 'DOCX' && docx.pageBasis === 'DOCX_EXPLICIT' && docx.text.includes('담당 | 마감')
      && pptx?.kind === 'PPTX' && pptx.totalPages === 3 && pptx.text.includes('--- 슬라이드 2 ---') && pptx.text.includes('[발표자 메모] 발표자 메모: 동기화 설명'),
      `Word ${docx?.kind ?? docx?.code} ${docx?.totalPages ?? ''}쪽, PowerPoint ${pptx?.kind ?? pptx?.code} ${pptx?.totalPages ?? ''}장`);

    // 공유 첨부: 사용자 토큰으로 읽음 → 공간에서 빠진 B는 못 읽음 (12번에서 B를 내보냈음)
    const DOC = id();
    const docAsset = await F.uploadAttachment(A.client, { workspaceId: ws, assetId: DOC, bytes: lecture, mimeType: 'application/pdf', name: '강의.pdf' }).catch((e) => e);
    const viaAsset = docAsset?.id ? await Docs.extractDocumentText(A.client, { assetId: DOC }).catch((e) => e) : null;
    const byOutsider = docAsset?.id ? await codeOf(Docs.extractDocumentText(B.client, { assetId: DOC })) : 'SKIP';
    check('공유 첨부 PDF 읽기 (멤버만): A는 됨, 공간에서 빠진 B는 ASSET_NOT_FOUND', viaAsset?.text === pdf?.text && byOutsider === 'ASSET_NOT_FOUND',
      docAsset?.id ? `A ${viaAsset?.kind ?? viaAsset?.code}, B ${byOutsider}` : `첨부 올리기 실패 ${docAsset?.code}`);
    if (docAsset?.id) await F.deleteAttachment(A.client, DOC).catch(() => {});

    const scan = await Docs.extractDocumentText(A.client, { bytes: fx('scanned.pdf') }).catch((e) => e);
    const txt = await codeOf(Docs.extractDocumentText(A.client, { bytes: new TextEncoder().encode('그냥 글'), mimeType: 'text/plain' }));
    check('스캔본 → noText(사진 글자 인식 안내), 지원 안 하는 형식 → UNSUPPORTED_TYPE', scan?.noText === true && txt === 'UNSUPPORTED_TYPE',
      `스캔본 ${scan?.noText ?? scan?.code}, 글 파일 ${txt}`);
  } else {
    group('15-1. 문서 → 글자 — 원격에서만 확인 (로컬은 supabase/tests/doc_extract.test.ts·documents_lib.test.ts)');
  }

  // -------------------------------------------------------------------
  if (A.client && B.client) {
    group('15-2. AI 채팅·안건 판단 (원격만: Terra, 기록은 기기에서 찾아 발췌만 보냄)');
    const codeOf = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code ?? e.message; } };
    const today = Chat.todayIn('Asia/Seoul');
    // 기기 SQLite에 있다고 치는 기록 (서버에는 없음)
    const records = [
      { id: 'memo-1', type: 'memo', title: '중간 발표 준비', text: '중간 발표는 금요일 오후 3시. 준비물: 노트북, HDMI 젠더, 발표 자료 USB', date: today, workspaceId: ws },
      { id: 'task-1', type: 'task', title: '발표 자료 만들기', text: '민수가 슬라이드 10장 작성', date: today, status: 'open', people: ['민수'] },
      { id: 'memo-2', type: 'memo', title: '점심 메뉴', text: '김치찌개 맛집 목록', date: today },
    ];
    const t4 = Date.now();
    let chat = null, chatErr = null;
    try { chat = await Chat.askAssistant(A.client, { question: '중간 발표 준비물이 뭐였지?', newId: id, findRecords: () => records, today }); } catch (e) { chatErr = e; }
    check('질문 → 검색 조건(plan) → 기기 기록에서 발췌 → 답변 + 출처 (인용은 서버가 원문 확인)',
      !!chat && chat.kind === 'answer' && /노트북|HDMI/.test(chat.text) && chat.sources.some((x) => x.id === 'memo-1') && !chat.sources.some((x) => x.id === 'memo-2'),
      chat ? `"${chat.text.slice(0, 50)}" 출처 ${chat.sources.map((x) => x.id).join(',') || '없음'}, 키워드 ${chat.plan.keywords.join('·')} (${((Date.now() - t4) / 1000).toFixed(1)}초, 남은 질문 ${chat.remaining})`
        : `${chatErr?.code}: ${chatErr?.message}`);

    const hi = await Chat.askAssistant(A.client, { question: '고마워!', newId: id, findRecords: () => { throw new Error('기록을 찾으면 안 됨'); }, today }).catch((e) => e);
    check('인사는 1단계에서 바로 답 (기록 검색·답변 단계 없음, 질문 횟수 안 씀)', hi?.kind === 'direct' && hi.text.length > 0,
      hi?.kind ? `${hi.kind} "${String(hi.text).slice(0, 30)}"` : `${hi?.code}: ${hi?.message}`);

    const outsider = await codeOf(Chat.answerQuery(A.client, {
      clientRequestId: id(), question: '이 공간 기록 알려줘', today,
      sources: [{ id: 'x', type: 'memo', title: '남의 공간', date: null, text: '비밀', workspace_id: id() }],
    }));
    check('멤버가 아닌 공간의 기록이 섞이면 FORBIDDEN (OpenAI에 안 보내고 횟수도 안 씀)', outsider === 'FORBIDDEN', outsider);

    const changes = [
      { key: 'k-slide', kind: 'task', status: 'changed', titleBefore: '발표 자료 만들기', title: '발표 자료 만들기', bodyBefore: '슬라이드 8장', bodyAfter: '슬라이드 10장으로 늘림', workspaceId: ws },
      { key: 'k-dinner', kind: 'memo', status: 'added', title: '회식 장소 예약', bodyAfter: '강남역 근처 고깃집 6명', workspaceId: ws },
    ];
    const discussions = [{ id: 'note-1', kind: 'MEETING_NOTE', title: '정기 회의', workspaceId: ws,
      text: '민수: 발표 슬라이드를 8장에서 10장으로 늘리기로 했어요. 수요일까지 초안 공유할게요.\n지영: 리허설은 목요일 오후에 해요.' }];
    const cacheMap = new Map();
    const cache = { get: (k) => cacheMap.get(k) ?? null, set: (k, v) => { cacheMap.set(k, v); } };
    const t5 = Date.now();
    let ag = null, agErr = null;
    try { ag = await Agenda.judgeAgendaDiscussion(A.client, { changes, discussions, newId: id, projectTitle: '검증 프로젝트', date: today, cache }); } catch (e) { agErr = e; }
    const again = ag ? await Agenda.judgeAgendaDiscussion(A.client, { changes, discussions, newId: id, projectTitle: '검증 프로젝트', date: today, cache }).catch((e) => e) : null;
    check('안건 판단: 회의에서 말한 변경은 논의됨(근거 구절 원문 확인), 말 안 한 항목은 미논의 · 같은 입력은 캐시 (횟수 안 씀)',
      !!ag && ag.judged['k-slide'] === 'discussed' && ag.judged['k-dinner'] === 'open' && !!ag.details['k-slide'].evidence
        && discussions[0].text.replace(/\s+/g, ' ').includes(ag.details['k-slide'].evidence.replace(/\s+/g, ' ')) && again?.fromCache === true,
      ag ? `${Agenda.agendaJudgeSummary(ag)} · 근거 "${ag.details['k-slide']?.evidence ?? ''}" · 다시 열기 ${again?.fromCache ? '캐시' : '서버'} (${((Date.now() - t5) / 1000).toFixed(1)}초, 남은 ${ag.remaining}회)`
        : `${agErr?.code}: ${agErr?.message}`);
  } else {
    group('15-2. AI 채팅·안건 판단 — 원격에서만 확인 (로컬은 supabase/tests/gateway_e2e.test.ts 10~12·ai_assist_lib.test.ts)');
  }

  // -------------------------------------------------------------------
  group('16. 가짜 결제 (구독 관리, 계정 B)');
  {
    // billing.ts는 supabase-js처럼 { data, error }를 받음 → B.rpc를 감싸서 넘김
    const sb = {
      rpc: async (name, args) => {
        try { return { data: await B.rpc(name, args ?? {}), error: null }; }
        catch (e) { return { data: null, error: { message: `${e.code}: ${e.message}` } }; }
      },
    };
    const paid = async () => (await B.select('payments', 'account_id', B.accountId)).filter((p) => p.status === 'PAID').length;
    let s0 = await Bill.getSubscription(sb);
    check('내 구독 조회: 요금제·상태·다음 결제일·가격 4,900원',
      s0.price_krw.PRO === 4900 && ['FREE', 'ACTIVE', 'CANCELING'].includes(s0.state), `시작 상태 ${s0.state} · ${Bill.nextPaymentText(s0)}`);
    // 원격 계정은 실행마다 상태가 남음: ACTIVE면 먼저 해지 예약으로 맞춤 (FREE 또는 CANCELING에서 시작)
    // 전 실행이 TEAM에서 멈췄으면 PRO로 맞춤 (아래 흐름은 PRO 기준)
    if (s0.plan === 'TEAM') { await Bill.changePlan(sb, 'pro', { requestId: id() }); s0 = await Bill.getSubscription(sb); }
    if (s0.state === 'ACTIVE') s0 = await Bill.cancelSubscription(sb);

    if (s0.state === 'FREE') {
      const d = await Bill.changePlan(sb, 'pro', { requestId: id(), simulateDecline: true });
      const after = await Bill.getSubscription(sb);
      check('결제 실패 시연 → PAYMENT_DECLINED, 요금제 FREE 그대로 (결제 실패 화면)', d.ok === false && d.code === 'PAYMENT_DECLINED' && after.plan === 'FREE', d.code);
    } else {
      check('결제 실패 시연 — 이미 PRO(해지 예약)라 건너뜀 (기간이 끝나 FREE가 되면 다시 확인, 로컬은 매번 확인)', true, s0.current_period_end);
    }

    const before = await paid();
    const rid = id();
    const r1 = await Bill.changePlan(sb, 'pro', { requestId: rid });
    const r2 = await Bill.subscribePro(sb, { requestId: rid });
    const s1 = await Bill.getSubscription(sb);
    const expectPaid = s0.state === 'FREE' ? before + 1 : before;
    check(`PRO 선택 → ${s0.state === 'FREE' ? '가짜 결제 1번 (같은 요청 재시도는 처음 결과)' : '결제 없이 해지 취소(RESUMED)'} → PRO 이용 중`,
      r1.ok && r1.action === (s0.state === 'FREE' ? 'SUBSCRIBED' : 'RESUMED') && r2.ok && s1.state === 'ACTIVE' && (await paid()) === expectPaid,
      `${r1.action} / 다시 보냄 ${r2.replayed ? 'replayed' : r2.action} / ${Bill.nextPaymentText(s1)}`);

    // Team 요금제 (#28): PRO → TEAM 바로 변경 → 혜택 확인 → 다시 PRO (원격 계정 상태가 다음 실행에도 같은 흐름이 되게)
    const t1 = await Bill.changePlan(sb, 'team', { requestId: id() });
    const quota = await B.rpc('get_project_invite_quota', {});
    const sT = await Bill.getSubscription(sb);
    check('TEAM 선택 → 바로 변경(CHANGED) 9,900원 · 이번 달 초대 200회 · 다음 결제 9,900원',
      t1.ok && t1.action === 'CHANGED' && t1.payment?.amount_krw === 9900 && sT.plan === 'TEAM' && quota?.limit === 200
        && sT.next_payment_krw === 9900 && Bill.planOptionText(sT, 'team') === '월 9,900원 · 초대 월 200회 · 공간 첨부 10GB',
      `${t1.action} / ${Bill.nextPaymentText(sT)} / 초대 ${quota?.used}/${quota?.limit}회`);
    const p2 = await Bill.changePlan(sb, 'pro', { requestId: id() });
    const quota2 = await B.rpc('get_project_invite_quota', {});
    check('TEAM → PRO 다시 변경 (CHANGED 4,900원, 초대 50회)', p2.ok && p2.action === 'CHANGED' && p2.previous_plan === 'TEAM'
      && p2.payment?.amount_krw === 4900 && quota2?.limit === 50, `${p2.action} / 초대 ${quota2?.limit}회`);

    const subRow = (await B.select('subscriptions', 'account_id', B.accountId))[0];
    check('AI 한도가 읽는 구독 = PRO·ACTIVE (한도 함수는 그대로)', subRow?.plan === 'PRO' && subRow?.status === 'ACTIVE', subRow?.plan);

    const x = await Bill.changePlan(sb, 'free', { requestId: id() });
    const s2 = await Bill.getSubscription(sb);
    const others = await B.select('payments', 'account_id', A.accountId);
    check('무료 선택(구독 해지) → 다음 결제일까지 PRO, 다음 결제 없음 · 남의 결제 내역은 안 보임',
      x.ok && x.action === 'CANCEL_SCHEDULED' && s2.state === 'CANCELING' && s2.next_payment_at === null && others.length === 0,
      Bill.nextPaymentText(s2));
  }

  // -------------------------------------------------------------------
  if (A.client && B.client) {
    group('18. 백업·복원 (원격만: 개인 공간 기록 → 기기에서 암호화 → 클라우드, 11/15)');
    const nodeCrypto = require('node:crypto');
    const deps = { newId: id, randomBytes: (n) => new Uint8Array(nodeCrypto.randomBytes(n)), deviceName: '검증 기기 A', appVersion: 'verify' };
    const personal = { memos: [{ id: 'm1', title: '개인 메모', body: '비밀 내용 1234' }], tasks: [{ id: 't1', title: '개인 할 일' }], projects: [] };
    const before = await Bk.listBackups(A.client);
    const c1 = await Bk.createBackup(A.client, { data: personal, counts: { memos: 1, tasks: 1, projects: 0 }, keep: 50, deps });
    const raw = await F.downloadAttachment(A.client, c1.backup);
    const list = await Bk.listBackups(A.client);
    check('백업하기: 기기에서 암호화해서 올림(서버 파일에는 내용이 안 보임) → 목록 맨 위(기록 수·기기 이름)',
      !Buffer.from(raw).toString('utf8').includes('비밀 내용') && list[0]?.id === c1.backup.id && list[0].counts.memos === 1 && list[0].device_name === '검증 기기 A',
      `${list.length}개, ${raw.length}바이트`);
    const read = await Bk.readBackup(A.client, c1.backup, deps);
    let byB = 'OK';
    try { await Bk.readBackup(B.client, c1.backup, deps); } catch (e) { byB = e.code; }
    check('복원용으로 받기: 같은 계정은 키를 다시 받아 풀림(새 기기도 같음), 다른 계정(B)은 못 받음',
      JSON.stringify(read.data) === JSON.stringify(personal) && byB !== 'OK', `B: ${byB}`);
    let applied = null;
    const current = { memos: [{ id: 'm2', title: '복원 전 메모' }], tasks: [], projects: [] };
    const rs = await Bk.restoreBackup(A.client, { backup: c1.backup, currentData: current, currentCounts: { memos: 1 }, keep: 50, deps, apply: (d) => { applied = d; } });
    const list2 = await Bk.listBackups(A.client);
    check('복원하기: 고른 백업을 적용, 복원 전 상태는 "자동" 백업으로 남음',
      JSON.stringify(applied) === JSON.stringify(personal) && rs.safety?.auto === true && list2[0]?.id === rs.safety.id, `자동 백업 ${String(rs.safety?.id).slice(0, 8)}`);
    for (const b of [c1.backup, rs.safety]) if (b) await Bk.deleteBackup(A.client, b.id).catch(() => {});
    const list3 = await Bk.listBackups(A.client);
    check('백업 삭제 → 목록에서 빠짐 (이번에 만든 백업은 지워서 계정에 안 쌓임)', !list3.some((b) => b.id === c1.backup.id || b.id === rs.safety?.id),
      `${list3.length}개 남음 (시작 때 ${before.length}개)`);
  } else {
    group('18. 백업·복원 — 원격에서만 확인 (로컬은 supabase/tests/test_project_extras.sql 4절·project_extras_lib.test.ts)');
  }

  // -------------------------------------------------------------------
  group('19. 알림 설정 · 알림함 · 탈퇴 미리 보기 (11/15)');
  {
    const asClient = (U) => ({
      rpc: async (name, args) => {
        try { return { data: await U.rpc(name, args ?? {}), error: null }; }
        catch (e) { return { data: null, error: { message: `${e.code}: ${e.message}` } }; }
      },
    });
    const cA = A.client ?? asClient(A), cB = B.client ?? asClient(B);
    const before = await Push.getNotificationSettings(cB);
    const saved = await Push.setNotificationSettings(cB, Push.briefingFromAiSettings({
      daily: { on: true, time: '오전 7:30' }, weekly: { on: true, day: '금', time: '18:00' } }));
    const back = await Push.getNotificationSettings(cB);
    await Push.setNotificationSettings(cB, { briefing_daily: before.briefing_daily, briefing_weekly: before.briefing_weekly });
    check('알림 설정: 화면의 브리핑 값(오전 7:30·금 18:00) → 서버 07:30·5(금) 저장, 다른 기기에서도 같은 값 (검증 뒤 원래대로)',
      saved.briefing_daily.time === '07:30' && saved.briefing_daily.on === true && saved.briefing_weekly.day === 5
        && back.briefing_weekly.time === '18:00' && back.push === before.push,
      `일간 ${saved.briefing_daily.time} · 주간 ${saved.briefing_weekly.day}/${saved.briefing_weekly.time}`);
    let tokErr = null;
    try { await Push.registerPushToken(cB, id(), 'ExponentPushToken[verifyverifyverify00]'); } catch (e) { tokErr = e; }
    const listA = await Push.listNotifications(cA, { limit: 20 });
    const readN = await Push.markNotificationsRead(cA);
    check('알림 토큰: 등록 안 된 기기는 거절(NOT_FOUND) · 알림함 목록·읽음 표시',
      tokErr?.code === 'NOT_FOUND' && Array.isArray(listA) && readN >= 0, `토큰 ${tokErr?.code ?? '됨(문제)'} · 알림 ${listA.length}개, 읽음 ${readN}`);
    const pv = await Wd.getWithdrawPreview(cA);
    const mine = pv.find((x) => x.workspace_id === ws);
    check('탈퇴 미리 보기(실제 탈퇴는 안 함): B가 빠진 검증 공간은 A 혼자라 "삭제"로 안내',
      mine?.action === 'DELETE' && Wd.withdrawPreviewText(mine).includes('삭제'), mine ? Wd.withdrawPreviewText(mine) : '목록에 없음(문제)');
  }

  // -------------------------------------------------------------------
  if (A.client) {
    group('20. 초대 메일 (원격만: Gmail SMTP, SMTP_PASSWORD 등록 전이면 공유 문구로 안내)');
    const inv = await A.rpc('create_invite', { p_workspace_id: ws, p_role: 'EDITOR', p_expires_in_hours: 1, p_max_uses: 1 });
    let r = null, err = null;
    try { r = await Mail.sendInviteMail(A.client, { code: inv.code, email: A.email }); } catch (e) { err = e; }
    let again = null;
    if (r) { try { await Mail.sendInviteMail(A.client, { code: inv.code, email: A.email }); } catch (e) { again = e; } }
    await A.rpc('revoke_invite', { p_invite_id: inv.invite_id }).catch(() => {});
    check('초대 메일: 보냄(내 테스트 계정 주소로) + 10분 안 같은 주소는 MAIL_TOO_SOON, 또는 설정 전 MAIL_NOT_CONFIGURED → 공유 문구로',
      (r?.kind === 'WORKSPACE' && again?.code === 'MAIL_TOO_SOON') || (err?.code === 'MAIL_NOT_CONFIGURED' && Mail.shouldShareInstead(err)),
      r ? `보냄 → ${r.email}` : `${err?.code}: ${Mail.inviteMailErrorMessage(err)}`);
  } else {
    group('20. 초대 메일 — 원격에서만 확인 (로컬은 supabase/tests/test_invite_mail.sql·invite_mail.test.ts)');
  }

  devA.close(); devB.close();
  return { workspaceId: ws, files: [devA.file, devB.file].map((f) => path.basename(f)) };
}

module.exports = { runScenarios };
