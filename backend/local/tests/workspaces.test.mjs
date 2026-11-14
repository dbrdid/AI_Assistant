import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, rejects, rejectsUnchanged } from './helpers.mjs';

test('a new database starts with the personal workspace selected', () => {
  const t = setup();
  const state = t.store.getWorkspaceState();
  assert.deepEqual(state.list, [{ id: state.current.id, name: '개인 공간', desc: '', personal: true, createdAt: t.clock.t }]);
  assert.equal(state.current, state.list[0]);
  assert.equal(t.store.getWorkspaceState(), state, 'cached until a workspace changes');
});

test('workspaces keep memos, tasks and proposals apart', () => {
  const t = setup();
  const personal = t.store.getCurrentWorkspace().id;
  const memo = t.store.addMemo({ body: '개인 메모' });
  const task = t.store.addTask({ title: '개인 일정', date: '2026-11-16' });
  const [proposal] = t.store.addProposals([{ kind: 'task', title: '개인 제안', date: '2026-11-16', sourceType: 'memo', sourceId: memo.id }]);

  t.tick();
  const team = t.store.createWorkspace({ name: '팀 프로젝트', desc: '캡스톤' });
  assert.equal(t.store.getCurrentWorkspace().id, personal, 'creating does not switch');
  let calls = 0;
  t.store.subscribeMemos(() => { calls++; });
  assert.equal(t.store.switchWorkspace(team), team);
  assert.equal(calls, 1);
  assert.deepEqual([t.store.getMemos(), t.store.getTasks(), t.store.getProposals()], [[], [], []]);
  assert.equal(t.store.getMemo(memo.id), null);
  assert.equal(t.store.getTask(task.id), null);
  rejectsUnchanged(t, () => t.store.updateMemo(memo.id, { body: 'x' }), 'not_found');
  rejectsUnchanged(t, () => t.store.approveProposal(proposal.id, {}), 'not_found');
  rejectsUnchanged(t, () => t.store.addMemo({ body: '팀 메모', taskIds: [task.id] }), 'not_found', 'taskIds');
  const teamMemo = t.store.addMemo({ body: '팀 메모' });

  t.store.switchWorkspace(personal);
  assert.deepEqual(t.store.getMemos().map(m => m.id), [memo.id]);
  assert.equal(t.store.getMemo(teamMemo.id), null);
  assert.equal(calls, 3, 'switch, the team memo, switch back');
  assert.equal(t.store.switchWorkspace(personal), personal);
  assert.equal(calls, 3, 'switching to the current workspace changes nothing');
});

test('workspace names are required and unique; unknown ids are refused', () => {
  const t = setup();
  t.store.createWorkspace({ name: '팀' });
  rejectsUnchanged(t, () => t.store.createWorkspace({ name: ' 팀 ' }), 'name_taken');
  rejectsUnchanged(t, () => t.store.createWorkspace({ name: '개인 공간' }), 'name_taken');
  rejectsUnchanged(t, () => t.store.createWorkspace({ name: '  ' }), 'invalid_input', 'name');
  rejectsUnchanged(t, () => t.store.createWorkspace({ name: '팀2', members: 3 }), 'invalid_input', 'members');
  rejectsUnchanged(t, () => t.store.switchWorkspace('missing'), 'not_found');
  rejectsUnchanged(t, () => t.store.deleteWorkspace('missing'), 'not_found');
});

test('deleting a workspace deletes its data; the personal one stays; deleting the current one moves to personal', () => {
  const t = setup();
  const personal = t.store.getCurrentWorkspace().id;
  rejectsUnchanged(t, () => t.store.deleteWorkspace(personal), 'personal_workspace');
  const team = t.store.createWorkspace({ name: '팀' });
  t.store.switchWorkspace(team);
  const task = t.store.addTask({ title: '팀 일정', date: '2026-11-16' });
  const memo = t.store.addMemo({ body: '팀 메모', taskIds: [task.id] });
  t.store.addProposals([{ kind: 'task', title: '팀 제안', date: '2026-11-16', sourceType: 'memo', sourceId: memo.id }]);
  const seen = [];
  t.store.subscribe(areas => seen.push(areas.sort().join(',')));
  assert.equal(t.store.deleteWorkspace(team), true);
  assert.equal(t.store.getCurrentWorkspace().id, personal);
  assert.deepEqual(t.store.getWorkspaces().map(w => w.id), [personal]);
  assert.deepEqual(seen, ['memos,proposals,tasks,workspaces']);
  for (const table of ['memos', 'tasks', 'memo_tasks', 'proposals']) {
    assert.equal(t.db.getFirstSync(`select count(*) as n from ${table} where workspace_id=?`, [team]).n, 0, table);
  }
});

test('a failed workspace deletion keeps the current workspace, in memory and on disk', () => {
  let failOn = null;
  const t = setup({ onStatement: sql => { if (failOn && sql.startsWith(failOn)) throw new Error('disk full (simulated)'); } });
  const team = t.store.createWorkspace({ name: '팀' });
  t.store.switchWorkspace(team);
  const memo = t.store.addMemo({ body: '팀 메모' });
  const state = t.store.getWorkspaceState();
  failOn = 'delete from workspaces';
  assert.throws(() => t.store.deleteWorkspace(team), /disk full/);
  failOn = null;
  assert.equal(t.store.getWorkspaceState(), state);
  assert.equal(t.store.getCurrentWorkspace().id, team);
  assert.deepEqual(t.store.getMemos().map(m => m.id), [memo.id]);
  assert.equal(t.db.getFirstSync("select value from settings where key='current_workspace'").value, team);
});

test('the current workspace and all data survive closing and reopening the database file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-store-'));
  try {
    const path = join(dir, 'planner.db');
    const first = setup({ path });
    const team = first.store.createWorkspace({ name: '팀' });
    first.store.switchWorkspace(team);
    const memo = first.store.addMemo({ title: '남아 있어야 함', strokes: [{ p: [[0, 0]] }] });
    first.db.closeSync();

    const second = setup({ path });
    assert.equal(second.store.getCurrentWorkspace().id, team);
    assert.deepEqual(second.store.getMemo(memo.id), memo);
    assert.equal(second.store.getWorkspaces().length, 2);
    second.db.closeSync();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
