import { lstat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createLocalStore } from '../backend/local/src/index.js';
import { createStellaDocumentStore } from '../backend/local/src/stella-documents.js';
import { memoTitle, rankSearchRows, searchTerms } from '../frontend/Frontend_UI/src/data/memos/memoSearch.mjs';
import { filterTasks } from '../frontend/Frontend_UI/src/data/tasks/taskOperations.mjs';

const MAX_FILES = 40;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_LIST_ITEMS = 30;
const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const schema = (key, limit) => ({
  type: 'object', properties: { [key]: { type: 'string', minLength: 1, maxLength: limit } },
  required: [key], additionalProperties: false,
});
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const readOnly = { readOnlyHint: true, openWorldHint: false };

const markdownDefinitions = [
  { name: 'search_documents', description: 'Search the titles and text of the selected Markdown exports.', inputSchema: schema('query', 200) },
  { name: 'get_document', description: 'Read up to 8,000 characters of a selected export by its result ID.', inputSchema: schema('id', 32) },
].map(tool => ({ ...tool, annotations: readOnly }));

const liveReadDefinitions = [
  { name: 'list_workspaces', description: 'List workspaces in the connected Atria database and show which workspace is active.', inputSchema: emptySchema },
  { name: 'search_documents', description: 'Search live documents in the active Atria workspace (excluding AI-excluded and trashed items).', inputSchema: schema('query', 200) },
  { name: 'get_document', description: 'Read a live document and its blocks from the active Atria workspace by ID (up to 8,000 chars).', inputSchema: schema('id', 64) },
  {
    name: 'list_tasks',
    description: 'List live tasks or events in the active Atria workspace (excluding AI-excluded and trashed items).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['task', 'event'] },
        status: { type: 'string', enum: ['open', '완료', '진행 전', '진행 중'] },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        before: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
  },
  { name: 'list_proposals', description: 'List open AI proposals waiting for user review in the active Atria workspace.', inputSchema: emptySchema },
].map(tool => ({ ...tool, annotations: readOnly }));

const proposeDefinition = {
  name: 'propose_item',
  description: 'Queue a reviewable proposal (task, event, or memo) in Atria without directly modifying saved data.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['event', 'task', 'memo'] },
      title: { type: 'string', minLength: 1, maxLength: 100 },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      start: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
      end: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
      place: { type: 'string', maxLength: 120 },
      body: { type: 'string', maxLength: 4000 },
      evidence: { type: 'string', maxLength: 500 },
      sourceId: { type: 'string', minLength: 1, maxLength: 64 },
    },
    required: ['kind', 'title'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

function openSqliteAdapter(path) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  let inTransaction = false;
  const bind = params => (params === undefined ? [] : params);
  return {
    execSync(source) { db.exec(source); },
    runSync(source, params) {
      const r = db.prepare(source).run(...bind(params));
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    getFirstSync(source, params) {
      const row = db.prepare(source).get(...bind(params));
      return row === undefined ? null : { ...row };
    },
    getAllSync(source, params) {
      return db.prepare(source).all(...bind(params)).map(row => ({ ...row }));
    },
    withTransactionSync(task) {
      if (inTransaction) throw new Error('Nested transaction is not supported');
      db.exec('begin');
      inTransaction = true;
      try { task(); db.exec('commit'); }
      catch (error) { db.exec('rollback'); throw error; }
      finally { inTransaction = false; }
    },
    closeSync() { db.close(); },
  };
}

function parseCli(argv) {
  let dbPath = null;
  let workspace = null;
  let allowProposals = false;
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      dbPath = argv[++i];
      if (!dbPath) throw new Error('--db requires a SQLite database file path.');
    } else if (arg === '--workspace') {
      workspace = argv[++i];
      if (!workspace) throw new Error('--workspace requires a workspace ID or name.');
    } else if (arg === '--allow-proposals') {
      allowProposals = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (dbPath && files.length) throw new Error('Choose either --db <path> or Markdown export files, not both.');
  if (!dbPath && (workspace || allowProposals)) throw new Error('--workspace and --allow-proposals require --db <path>.');
  return { dbPath, workspace, allowProposals, files };
}

async function selectedDocuments(paths) {
  if (!paths.length || paths.length > MAX_FILES) throw new Error('Select 1 to 40 Atria Markdown export files, or pass --db <sqlite-path>.');
  const documents = [];
  for (const [index, path] of [...new Set(paths)].entries()) {
    const info = await lstat(path, { bigint: true });
    if (extname(path).toLowerCase() !== '.md' || !info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new Error('Only regular .md files up to 128 KiB can be selected.');
    }
    const file = await open(path, 'r');
    try {
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || info.ino !== opened.ino || info.dev !== opened.dev) throw new Error('A selected file changed.');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new Error('A selected file exceeds 128 KiB.');
      documents.push({
        id: String(index + 1),
        title: basename(path, '.md'),
        text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      });
    } finally { await file.close(); }
  }
  return documents;
}

async function openLiveBackend({ dbPath, workspace, allowProposals }) {
  const info = await lstat(dbPath, { bigint: true });
  if (!info.isFile()) throw new Error('The --db path must point to an existing Atria SQLite file.');
  const db = openSqliteAdapter(dbPath);
  const store = createLocalStore({ db });
  const documents = createStellaDocumentStore({ db, store });
  if (workspace) {
    const list = store.getWorkspaces();
    const byId = list.find(item => item.id === workspace);
    const byName = list.filter(item => item.name === workspace);
    if (!byId && byName.length !== 1) {
      db.closeSync();
      throw new Error(byName.length > 1 ? `Multiple workspaces share the name "${workspace}". Pass its workspace ID.` : `Workspace not found: ${workspace}`);
    }
    store.switchWorkspace((byId ?? byName[0]).id);
  }
  const hasPrefs = () => !!db.getFirstSync("select 1 as ok from sqlite_master where type='table' and name='integration_preferences'");
  const readPref = (key, fallback) => {
    if (!hasPrefs()) return fallback;
    const row = db.getFirstSync('select value from integration_preferences where key=?', [key]);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  };
  const isAiDisabled = () => readPref('settings', {})?.ai?.transmissionDisabled === true;
  const isExcluded = id => readPref(`ai-excluded:${id}`, false) === true;
  const tools = allowProposals ? [...liveReadDefinitions, proposeDefinition] : liveReadDefinitions;
  return {
    serverInfo: { name: 'atria-live', version: '1.0.0' },
    tools,
    close: () => db.closeSync(),
    runTool(params) {
      const tool = tools.find(entry => entry.name === params?.name);
      if (!tool) return content({ error: 'Unknown tool' }, true);
      const args = params.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) return content({ error: 'Invalid arguments' }, true);
      const allowedKeys = new Set(Object.keys(tool.inputSchema.properties ?? {}));
      if (Object.keys(args).some(key => !allowedKeys.has(key))) return content({ error: 'Unexpected argument' }, true);
      if (tool.name !== 'list_workspaces' && isAiDisabled()) {
        return content({ error: 'AI data access is disabled in Atria settings.' }, true);
      }
      if (tool.name === 'list_workspaces') {
        const active = store.getCurrentWorkspace();
        return content(store.getWorkspaces().map(ws => ({
          id: ws.id, name: ws.name, personal: ws.personal, roleCode: ws.roleCode, current: ws.id === active.id,
        })));
      }
      if (tool.name === 'search_documents') {
        const query = args.query;
        if (typeof query !== 'string' || !query.trim() || query.length > 200) return content({ error: 'Invalid query' }, true);
        const rows = store.getMemos()
          .filter(memo => !memo.deletedAt && !isExcluded(memo.id))
          .map(memo => ({ id: memo.id, title: memoTitle(memo), text: memo.body ?? '', revision: memo.revision, updatedAt: memo.updatedAt }));
        const matches = rankSearchRows(rows, searchTerms(query));
        const byId = new Map(rows.map(row => [row.id, row]));
        return content(matches.slice(0, 12).map(({ id, title }) => {
          const item = byId.get(id);
          return { id, title, revision: item.revision, updatedAt: item.updatedAt };
        }));
      }
      if (tool.name === 'get_document') {
        const id = args.id;
        if (typeof id !== 'string' || !id.trim() || id.length > 64) return content({ error: 'Invalid document ID' }, true);
        const memo = store.getMemo(id);
        if (!memo || memo.deletedAt !== null || isExcluded(memo.id)) return content({ error: 'Document not found in active workspace' }, true);
        const text = memo.body ?? '';
        const blocks = documents.blocksFor(memo).slice(0, 100);
        return content({
          id: memo.id,
          title: memoTitle(memo),
          revision: memo.revision,
          updatedAt: memo.updatedAt,
          text: text.slice(0, MAX_OUTPUT_CHARS),
          truncated: text.length > MAX_OUTPUT_CHARS,
          blocks,
        });
      }
      if (tool.name === 'list_tasks') {
        const { kind, status, from, before } = args;
        if (kind !== undefined && !['task', 'event'].includes(kind)) return content({ error: 'Invalid kind' }, true);
        if (status !== undefined && !['open', '완료', '진행 전', '진행 중'].includes(status)) return content({ error: 'Invalid status' }, true);
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if ((from !== undefined && !dateRe.test(from)) || (before !== undefined && !dateRe.test(before))) {
          return content({ error: 'Invalid date filter' }, true);
        }
        const items = filterTasks(store.getTasks().filter(task => !isExcluded(task.id)), { kind, status, from, before });
        return content(items.slice(0, MAX_LIST_ITEMS).map(item => ({
          id: item.id, kind: item.kind, title: item.title, date: item.date, endDate: item.endDate,
          start: item.start, end: item.end, place: item.place, status: item.status, revision: item.revision,
        })));
      }
      if (tool.name === 'list_proposals') {
        return content(store.getProposals().slice(0, MAX_LIST_ITEMS).map(item => ({
          id: item.id, kind: item.kind, title: item.title, date: item.date, start: item.start,
          status: item.status, sourceType: item.sourceType, sourceId: item.sourceId,
        })));
      }
      if (tool.name === 'propose_item') {
        const ws = store.getCurrentWorkspace();
        if (!ws.personal && ws.roleCode === 'VIEWER') {
          return content({ error: 'Cannot propose changes in a read-only workspace.' }, true);
        }
        const { kind, title, date, endDate, start, end, place, body, evidence, sourceId } = args;
        if (!['event', 'task', 'memo'].includes(kind) || typeof title !== 'string' || !title.trim() || title.length > 100) {
          return content({ error: 'Invalid proposal kind or title' }, true);
        }
        let source = { sourceType: 'mcp', sourceId: null, sourceTitle: 'External MCP', sourceRevision: null };
        if (sourceId !== undefined) {
          if (typeof sourceId !== 'string' || !sourceId.trim()) return content({ error: 'Invalid sourceId' }, true);
          const memo = store.getMemo(sourceId);
          if (!memo || memo.deletedAt !== null || isExcluded(memo.id)) {
            return content({ error: 'Source document is unavailable in active workspace.' }, true);
          }
          source = { sourceType: 'memo', sourceId: memo.id, sourceTitle: memoTitle(memo), sourceRevision: memo.revision };
        }
        try {
          const added = store.addProposals([{
            kind,
            title: title.trim(),
            ...(date && { date }),
            ...(endDate && { endDate }),
            ...(start && { start }),
            ...(end && { end }),
            ...(place && { place }),
            ...(body && { body }),
            ...(evidence && { evidence }),
            ...source,
          }]);
          if (!added.length) return content({ status: 'duplicate_skipped', requiresUserApproval: true });
          const created = added[0];
          return content({
            id: created.id, kind: created.kind, title: created.title, status: created.status,
            requiresUserApproval: true,
          });
        } catch (error) {
          return content({ error: error?.message ?? 'Failed to add proposal' }, true);
        }
      }
      return content({ error: 'Unknown tool' }, true);
    },
  };
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const content = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError });

function createMarkdownBackend(documents) {
  return {
    serverInfo: { name: 'atria-markdown', version: '1.0.0' },
    tools: markdownDefinitions,
    close: () => {},
    runTool(params) {
      const tool = markdownDefinitions.find(entry => entry.name === params?.name);
      if (!tool) return content({ error: 'Unknown tool' }, true);
      const args = params.arguments;
      const [key] = tool.inputSchema.required;
      const value = args?.[key];
      if (!args || Object.keys(args).length !== 1 || typeof value !== 'string' || !value.trim()
          || value.length > tool.inputSchema.properties[key].maxLength) return content({ error: 'Invalid arguments' }, true);
      if (key === 'query') {
        const matches = rankSearchRows(documents, searchTerms(value));
        return content(matches.slice(0, 12).map(({ id, title }) => ({ id, title })));
      }
      const document = documents.find(entry => entry.id === value);
      if (!document) return content({ error: 'Document not found among selected exports' }, true);
      return content({ ...document, text: document.text.slice(0, MAX_OUTPUT_CHARS), truncated: document.text.length > MAX_OUTPUT_CHARS });
    },
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const backend = cli.dbPath ? await openLiveBackend(cli) : createMarkdownBackend(await selectedDocuments(cli.files));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let initialized = false;
  let negotiated = false;
  function respond(message) {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return failure(null, -32600, 'Invalid request');
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/initialized' && negotiated) initialized = true;
      return null;
    }
    if (!['string', 'number'].includes(typeof id)) return failure(null, -32600, 'Invalid request ID');
    if (method === 'ping') return reply(id, {});
    if (method === 'initialize' && !negotiated) {
      if (typeof params?.protocolVersion !== 'string') return failure(id, -32602, 'Missing protocol version');
      negotiated = true;
      return reply(id, {
        protocolVersion: versions.has(params.protocolVersion) ? params.protocolVersion : '2025-11-25',
        serverInfo: backend.serverInfo,
        capabilities: { tools: { listChanged: false } },
      });
    }
    if (!initialized) return failure(id, -32000, 'Initialize the session first');
    if (method === 'tools/list') return reply(id, { tools: backend.tools });
    if (method === 'tools/call') return reply(id, backend.runTool(params));
    return failure(id, -32601, 'Method not found');
  }
  try {
    for await (const line of input) {
      let message;
      try { message = JSON.parse(line); }
      catch { process.stdout.write(JSON.stringify(failure(null, -32700, 'Invalid JSON')) + '\n'); continue; }
      const result = respond(message);
      if (result) process.stdout.write(JSON.stringify(result) + '\n');
    }
  } finally {
    backend.close();
  }
}

main().catch(error => {
  process.stderr.write(`Atria MCP: ${error.code ? 'Unable to open a selected source' : error.message}\n`);
  process.exitCode = 1;
});
