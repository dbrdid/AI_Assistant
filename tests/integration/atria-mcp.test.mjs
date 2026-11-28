import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalStore } from '../../backend/local/src/index.js';
import { createStellaDocumentStore } from '../../backend/local/src/stella-documents.js';
import { openDatabaseSync } from '../../backend/local/tests/expo-sqlite-node.mjs';

const server = fileURLToPath(new URL('../../tools/atria-mcp.mjs', import.meta.url));
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });

function runSession(args, messages) {
  const input = messages.map(message => JSON.stringify(message)).join('\n') + '\n';
  const child = spawnSync(process.execPath, [server, ...args], { input, encoding: 'utf8', timeout: 8000 });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim().split('\n').map(line => JSON.parse(line));
}

const handshake = [
  request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration', version: '1' } }),
  request(undefined, 'notifications/initialized'),
];

test('MCP client can discover tools and read only the selected Markdown exports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atria-mcp-'));
  try {
    const file = join(directory, '회의록.md');
    writeFileSync(file, '# 회의록\n행사 준비 자료');
    writeFileSync(join(directory, '미선택.md'), '숨겨진 준비 자료');
    const responses = runSession([file], [
      request(0, 'tools/list'),
      ...handshake,
      request(2, 'tools/list'),
      call(3, 'search_documents', { query: '준비' }),
      call(4, 'get_document', { id: '1' }),
      call(5, 'get_document', { id: '2' }),
      call(6, 'get_document', { id: '1', path: '../미선택.md' }),
      call(7, 'delete_document', { id: '1' }),
    ]);
    assert.deepEqual(responses.map(message => message.id), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(responses[0].error.code, -32000);
    assert.equal(responses[1].result.protocolVersion, '2025-11-25');
    assert.deepEqual(responses[2].result.tools.map(tool => tool.name), ['search_documents', 'get_document']);
    const payload = index => JSON.parse(responses[index].result.content[0].text);
    assert.deepEqual(payload(3), [{ id: '1', title: '회의록' }]);
    assert.match(payload(4).text, /행사 준비 자료/u);
    for (const index of [5, 6, 7]) assert.equal(responses[index].result.isError, true);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('MCP live DB mode reads workspace-scoped documents, blocks, tasks, and enforces AI exclusions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atria-mcp-live-'));
  const dbPath = join(directory, 'planner.db');
  let openDb = null;
  try {
    const db = openDb = openDatabaseSync(dbPath);
    db.execSync('create table if not exists integration_preferences(key text primary key, value text not null)');
    const store = createLocalStore({ db });
    const docs = createStellaDocumentStore({ db, store });
    const personal = store.getCurrentWorkspace();
    const visibleDoc = store.addMemo({ title: '발표 준비', body: '발표 개요' });
    docs.saveContent(visibleDoc.id, {
      title: '발표 준비',
      body: '발표 개요\n\n[ ] 슬라이드 점검',
      blocks: [
        { id: 'b1', type: 'heading', text: '발표 개요', checked: false },
        { id: 'b2', type: 'task', text: '슬라이드 점검', checked: false },
      ],
    }, visibleDoc.revision);
    const hiddenDoc = store.addMemo({ title: '비밀 발표 준비', body: '외부 AI 제외' });
    db.runSync('insert into integration_preferences(key,value) values(?,?)', [`ai-excluded:${hiddenDoc.id}`, 'true']);
    const openTask = store.addTask({ kind: 'task', title: '데모 리허설', date: '2026-12-01' });
    const hiddenTask = store.addTask({ kind: 'task', title: '비공개 할 일', date: '2026-12-01' });
    db.runSync('insert into integration_preferences(key,value) values(?,?)', [`ai-excluded:${hiddenTask.id}`, 'true']);

    const otherId = store.createWorkspace({ name: '다른 팀 공간' });
    store.switchWorkspace(otherId);
    store.addMemo({ title: '다른 공간 발표 준비', body: '격리 문서' });
    store.switchWorkspace(personal.id);
    db.closeSync(); openDb = null;

    const responses = runSession(['--db', dbPath], [
      ...handshake,
      request(2, 'tools/list'),
      call(3, 'list_workspaces'),
      call(4, 'search_documents', { query: '발표 준비' }),
      call(5, 'get_document', { id: visibleDoc.id }),
      call(6, 'get_document', { id: hiddenDoc.id }),
      call(7, 'list_tasks', { kind: 'task', status: 'open', from: '2026-12-01', before: '2026-12-02' }),
      call(8, 'propose_item', { kind: 'task', title: '차단되어야 함' }),
    ]);
    const payload = id => JSON.parse(responses.find(r => r.id === id).result.content[0].text);
    assert.deepEqual(responses.find(r => r.id === 2).result.tools.map(t => t.name), [
      'list_workspaces', 'search_documents', 'get_document', 'list_tasks', 'list_proposals',
    ]);
    assert.equal(payload(3).find(w => w.current).id, personal.id);
    assert.deepEqual(payload(4).map(d => d.id), [visibleDoc.id]);
    assert.equal(payload(5).blocks.length, 2);
    assert.equal(payload(5).blocks[1].type, 'task');
    assert.equal(responses.find(r => r.id === 6).result.isError, true);
    assert.deepEqual(payload(7).map(t => t.id), [openTask.id]);
    assert.equal(responses.find(r => r.id === 8).result.isError, true);

    // Turning off AI access in settings blocks document/task reads.
    const db2 = openDb = openDatabaseSync(dbPath);
    db2.runSync('insert into integration_preferences(key,value) values(?,?)', ['settings', JSON.stringify({ ai: { transmissionDisabled: true } })]);
    db2.closeSync(); openDb = null;
    const blocked = runSession(['--db', dbPath], [...handshake, call(9, 'search_documents', { query: '발표' })]);
    assert.equal(blocked.find(r => r.id === 9).result.isError, true);
  } finally {
    try { openDb?.closeSync(); } catch {}
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('MCP --allow-proposals queues reviewable proposals without direct writes and blocks viewer spaces', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atria-mcp-propose-'));
  const dbPath = join(directory, 'planner.db');
  let openDb = null;
  try {
    const db = openDb = openDatabaseSync(dbPath);
    db.execSync('create table if not exists integration_preferences(key text primary key, value text not null)');
    const store = createLocalStore({ db });
    const sourceDoc = store.addMemo({ title: '회의록', body: '12월 2일 최종 점검' });
    const excludedDoc = store.addMemo({ title: '비공개', body: '제외됨' });
    db.runSync('insert into integration_preferences(key,value) values(?,?)', [`ai-excluded:${excludedDoc.id}`, 'true']);
    const viewerId = store.upsertServerWorkspace({
      id: '00000000-0000-4000-8000-000000000099',
      name: '읽기 전용 공간',
      role: 'VIEWER',
    });
    db.closeSync(); openDb = null;

    const responses = runSession(['--db', dbPath, '--allow-proposals'], [
      ...handshake,
      call(2, 'propose_item', {
        kind: 'task', title: '최종 점검', date: '2026-12-02', evidence: '12월 2일 최종 점검', sourceId: sourceDoc.id,
      }),
      call(3, 'list_proposals'),
      call(4, 'propose_item', { kind: 'task', title: '제외 출처', sourceId: excludedDoc.id }),
    ]);
    const created = JSON.parse(responses.find(r => r.id === 2).result.content[0].text);
    assert.equal(created.status, 'pending');
    assert.equal(created.requiresUserApproval, true);
    const listed = JSON.parse(responses.find(r => r.id === 3).result.content[0].text);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(responses.find(r => r.id === 4).result.isError, true);

    // Saved tasks remain untouched until the user approves the proposal in Atria.
    const verifyDb = openDb = openDatabaseSync(dbPath);
    const verifyStore = createLocalStore({ db: verifyDb });
    assert.equal(verifyStore.getTasks().length, 0);
    const approved = verifyStore.approveProposal(created.id);
    assert.equal(approved.kind, 'task');
    assert.equal(verifyStore.getTasks().length, 1);
    verifyDb.closeSync(); openDb = null;

    // Viewer shared workspace cannot queue proposals.
    const viewerResp = runSession(['--db', dbPath, '--workspace', viewerId, '--allow-proposals'], [
      ...handshake,
      call(5, 'propose_item', { kind: 'task', title: '보기 전용 제안' }),
    ]);
    assert.equal(viewerResp.find(r => r.id === 5).result.isError, true);
  } finally {
    try { openDb?.closeSync(); } catch {}
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
