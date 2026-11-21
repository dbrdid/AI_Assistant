import { tableRows } from './document-blocks.mjs';
const BLOCK_TYPES = new Set(['paragraph', 'heading', 'bullet', 'task', 'table']);
export function normalizeLinkAnchors(anchors) {
  if (anchors == null) return null;
  const result = {};
  for (const key of ['source','target']) {
    const point = anchors[key];
    if (!point || !['left','right','top','bottom'].includes(point.side) || !Number.isFinite(point.offset) || point.offset < 0 || point.offset > 1) throw new Error('올바르지 않은 연결 위치입니다');
    result[key] = {side:point.side,offset:point.offset};
  }
  if (anchors.via != null) {
    if (!Array.isArray(anchors.via) || anchors.via.length>32 || anchors.via.some(p=>!p || ![p.x,p.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=100000))) throw new Error('올바르지 않은 연결선 경로입니다');
    result.via=anchors.via.map(p=>({x:p.x,y:p.y}));
  }
  return result;
}
export function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length > 1000) throw new Error('블록은 1,000개 이하로 구성해 주세요');
  const ids = new Set();
  return blocks.map((block, index) => {
    if (!block || !BLOCK_TYPES.has(block.type) || (block.type !== 'table' && (typeof block.text !== 'string' || block.text.length > 100000))) throw new Error('올바르지 않은 문서 블록입니다');
    const id = typeof block.id === 'string' && block.id.length < 100 ? block.id : `block-${index}`;
    if (ids.has(id)) throw new Error('블록 ID가 중복되었습니다');
    ids.add(id);
    if (block.type === "table") return { id, type: "table", text: "", checked: false, rows: tableRows(block.rows) };
    return {
      id,
      type: block.type,
      text: block.text,
      checked: block.type === 'task' && block.checked === true
    };
  });
}
export const blocksText = blocks => blocks.map(block => block.type === "table" ? tableRows(block.rows).map(row => row.join("\t")).join("\n") : block.type === 'bullet' ? `• ${block.text}` : block.type === 'task' ? `${block.checked ? '[x]' : '[ ]'} ${block.text}` : block.text).join('\n\n');
export function documentTree(documents) {
  const ids = new Set(documents.map(document => document.id));
  const byParent = new Map();
  for (const document of documents) {
    const parent = ids.has(document.parentId) && document.parentId !== document.id ? document.parentId : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(document);
  }
  const output = [],
    visited = new Set();
  function visit(document, depth) {
    if (visited.has(document.id)) return;
    visited.add(document.id);
    output.push({
      ...document,
      depth
    });
    for (const child of (byParent.get(document.id) ?? []).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)) visit(child, depth + 1);
  }
  for (const document of (byParent.get(null) ?? []).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)) visit(document, 0);
  for (const document of documents) visit(document, 0);
  return output;
}

/** Device-only desktop document features. Existing note bodies and sync DTOs remain the shared contract. */
export function createStellaDocumentStore({
  db,
  store,
  notify = () => {},
  now = Date.now,
  tablesReady = false
}) {
  if (!tablesReady) ensureDocumentTables(db);
  let cache = null;
  const invalidate = () => {
    cache = null;
  };
  const unsubscribe = store.subscribe(invalidate);
  const workspace = () => store.getCurrentWorkspace();
  const scope = () => workspace().id;
  const changed = () => {
    invalidate();
    notify();
  };
  function requireMemo(id, edit = false) {
    const memo = store.getMemo(id);
    if (!memo || memo.deletedAt !== null) throw new Error('현재 공간에서 문서를 찾을 수 없습니다');
    if (edit && workspace().roleCode === 'VIEWER' && !workspace().personal) throw new Error('보기 전용 공간입니다');
    return memo;
  }
  function meta(id) {
    return db.getFirstSync('select * from stella_document_meta where workspace_id=? and memo_id=?', [scope(), id]);
  }
  function ensureMeta(id) {
    requireMemo(id, true);
    db.runSync('insert or ignore into stella_document_meta(workspace_id,memo_id,sort_order) values(?,?,?)', [scope(), id, now()]);
  }
  function blocksFor(memo) {
    const row = meta(memo.id);
    if (row?.blocks_json && row.blocks_revision === memo.revision) {
      const blocks = normalizeBlocks(JSON.parse(row.blocks_json));
      if (blocksText(blocks) === memo.body) return blocks;
    }
    return [{
      id: 'body',
      type: 'paragraph',
      text: memo.body,
      checked: false
    }];
  }
  function snapshot(memo) {
    return {
      title: memo.title,
      body: memo.body,
      blocks: blocksFor(memo),
      revision: memo.revision
    };
  }
  function listDocuments() {
    const memos = store.getMemos(),
      ws = scope();
    if (cache?.memos === memos && cache.workspace === ws) return cache.documents;
    const metadata = new Map(db.getAllSync('select * from stella_document_meta where workspace_id=?', [ws]).map(row => [row.memo_id, row]));
    const ids = new Set(memos.map(memo => memo.id));
    const documents = memos.map(memo => {
      const row = metadata.get(memo.id);
      return {
        ...memo,
        parentId: ids.has(row?.parent_id) ? row.parent_id : null,
        order: row?.sort_order ?? memo.createdAt,
        x: row?.graph_x ?? null,
        y: row?.graph_y ?? null
      };
    });
    cache = {
      memos,
      workspace: ws,
      documents: Object.freeze(documentTree(documents))
    };
    return cache.documents;
  }
  function rememberOriginal(memo) {
    db.runSync('insert or ignore into stella_document_originals(workspace_id,memo_id,payload,created_at) values(?,?,?,?)', [scope(), memo.id, JSON.stringify(snapshot(memo)), now()]);
  }
  function saveContent(id, fields, expectedRevision) {
    const memo = requireMemo(id, true);
    if (memo.revision !== expectedRevision) throw Object.assign(new Error('다른 곳에서 수정된 문서입니다. 저장본과 비교해 주세요.'), {
      code: 'revision_conflict'
    });
    const blocks = normalizeBlocks(fields.blocks);
    if (blocksText(blocks) !== fields.body) throw new Error('블록 내용과 본문이 일치하지 않습니다');
    rememberOriginal(memo);
    store.updateMemo(id, {
      title: fields.title,
      body: fields.body
    }, {
      expectedRevision
    });
    const saved = requireMemo(id);
    ensureMeta(id);
    db.runSync('update stella_document_meta set blocks_json=?,blocks_revision=? where workspace_id=? and memo_id=?', [JSON.stringify(blocks), saved.revision, scope(), id]);
    changed();
    return saved;
  }
  function createVersion(id, expectedRevision) {
    const memo = requireMemo(id, true);
    if (memo.revision !== expectedRevision) throw Object.assign(new Error('문서가 변경되었습니다'), {
      code: 'revision_conflict'
    });
    const payload = JSON.stringify(snapshot(memo));
    const last = db.getFirstSync('select * from stella_document_versions where workspace_id=? and memo_id=? order by version desc limit 1', [scope(), id]);
    if (last) {
      const previous = JSON.parse(last.payload),
        current = JSON.parse(payload);
      if (previous.title === current.title && previous.body === current.body && JSON.stringify(previous.blocks) === JSON.stringify(current.blocks)) return last.version;
    }
    const number = (last?.version ?? 0) + 1;
    db.runSync('insert into stella_document_versions values(?,?,?,?,?)', [scope(), id, number, payload, now()]);
    changed();
    return number;
  }
  function listVersions(id) {
    requireMemo(id);
    return db.getAllSync('select version,payload,created_at from stella_document_versions where workspace_id=? and memo_id=? order by version desc', [scope(), id]).map(row => ({
      number: row.version,
      createdAt: row.created_at,
      ...JSON.parse(row.payload)
    }));
  }
  function moveDocument(id, parentId = null, beforeId = null) {
    requireMemo(id, true);
    if (parentId) requireMemo(parentId);
    if (id === parentId) throw new Error('자기 자신 아래로 이동할 수 없습니다');
    const rows = listDocuments(),
      map = new Map(rows.map(document => [document.id, document]));
    let cursor = parentId;
    const seen = new Set();
    while (cursor) {
      if (cursor === id || seen.has(cursor)) throw new Error('하위 문서 아래로 이동할 수 없습니다');
      seen.add(cursor);
      cursor = map.get(cursor)?.parentId;
    }
    const siblings = rows.filter(document => document.parentId === parentId && document.id !== id);
    const position = beforeId ? siblings.findIndex(document => document.id === beforeId) : siblings.length;
    if (position < 0) throw new Error('이동할 위치가 현재 문서 목록에 없습니다');
    siblings.splice(position, 0, map.get(id));
    db.withTransactionSync(() => {
      ensureMeta(id);
      db.runSync('update stella_document_meta set parent_id=? where workspace_id=? and memo_id=?', [parentId, scope(), id]);
      siblings.forEach((document, index) => {
        ensureMeta(document.id);
        db.runSync('update stella_document_meta set sort_order=? where workspace_id=? and memo_id=?', [index, scope(), document.id]);
      });
    });
    changed();
  }
  return {
    listDocuments,
    blocksFor,
    saveContent,
    createVersion,
    listVersions,
    moveDocument,
    original(id) {
      const memo = requireMemo(id);
      const row = db.getFirstSync('select payload,created_at from stella_document_originals where workspace_id=? and memo_id=?', [scope(), id]);
      return row ? {
        ...JSON.parse(row.payload),
        capturedAt: row.created_at
      } : {
        ...snapshot(memo),
        capturedAt: null
      };
    },
    restoreVersion(id, number, expectedRevision) {
      const memo = requireMemo(id, true);
      if (memo.revision !== expectedRevision) throw Object.assign(new Error('문서가 변경되었습니다'), {
        code: 'revision_conflict'
      });
      const version = listVersions(id).find(item => item.number === number);
      if (!version) throw new Error('버전을 찾을 수 없습니다');
      createVersion(id, memo.revision);
      return saveContent(id, version, memo.revision);
    },
    setLink(source, target, linked, anchors = null) {
      requireMemo(source, true);
      requireMemo(target);
      if (source === target) throw new Error('같은 문서를 연결할 수 없습니다');
      const [a, b] = [source, target].sort();
      const normalized = normalizeLinkAnchors(anchors);
      const canonical = normalized && (source === a ? normalized : {source:normalized.target,target:normalized.source,...(normalized.via ? {via:[...normalized.via].reverse()} : {})});
      if (linked) db.runSync('insert into stella_document_links(workspace_id,source_id,target_id,anchors_json) values(?,?,?,?) on conflict(workspace_id,source_id,target_id) do update set anchors_json=coalesce(excluded.anchors_json,anchors_json)',[scope(),a,b,canonical ? JSON.stringify(canonical) : null]);
      else db.runSync('delete from stella_document_links where workspace_id=? and source_id=? and target_id=?',[scope(),a,b]);
      changed();
    },
    links() {
      const ids = new Set(store.getMemos().map(memo => memo.id));
      const explicit = db.getAllSync('select source_id,target_id,anchors_json from stella_document_links where workspace_id=?', [scope()]);
      const derived = db.getAllSync("select source_id,result_id as target_id from proposals where workspace_id=? and source_type='memo' and result_kind='memo' and status='approved'", [scope()]);
      return [...explicit.map(row => ({...row, kind: 'manual'})), ...derived.map(row => ({...row, kind: 'source'}))].filter(row => ids.has(row.source_id) && ids.has(row.target_id)).map(row => ({
        source: row.source_id,
        target: row.target_id,
        kind: row.kind,
        anchors: row.anchors_json ? normalizeLinkAnchors(JSON.parse(row.anchors_json)) : null
      }));
    },
    savePosition(id, x, y) {
      if (![x, y].every(value => Number.isFinite(value) && Math.abs(value) <= 100000)) throw new Error('올바르지 않은 위치입니다');
      ensureMeta(id);
      db.runSync('update stella_document_meta set graph_x=?,graph_y=? where workspace_id=? and memo_id=?', [x, y, scope(), id]);
      changed();
    },
    trash(id) {
      const memo = requireMemo(id, true);
      const parent = meta(memo.id)?.parent_id ?? null;
      store.trashDocument(id);
      db.runSync('update stella_document_meta set parent_id=? where workspace_id=? and parent_id=?', [parent, scope(), id]);
      changed();
    },
    dispose: unsubscribe
  };
}


export function ensureDocumentTables(db) {
  db.execSync(DOCUMENT_TABLE_SQL);
  if (!db.getAllSync('pragma table_info(stella_document_links)').some(column => column.name === 'anchors_json')) {
    db.execSync('alter table stella_document_links add column anchors_json text');
  }
}

const DOCUMENT_TABLE_SQL = `
    create table if not exists stella_document_meta(
      workspace_id text not null, memo_id text not null references memos(id) on delete cascade,
      parent_id text, sort_order integer not null default 0, blocks_json text, blocks_revision integer,
      graph_x real, graph_y real, primary key(workspace_id,memo_id));
    create index if not exists stella_document_parent on stella_document_meta(workspace_id,parent_id,sort_order);
    create table if not exists stella_document_links(
      workspace_id text not null, source_id text not null references memos(id) on delete cascade,
      target_id text not null references memos(id) on delete cascade, primary key(workspace_id,source_id,target_id));
    create table if not exists stella_document_versions(
      workspace_id text not null, memo_id text not null references memos(id) on delete cascade,
      version integer not null, payload text not null, created_at integer not null,
      primary key(workspace_id,memo_id,version));
    create table if not exists stella_document_originals(
      workspace_id text not null, memo_id text not null references memos(id) on delete cascade,
      payload text not null, created_at integer not null, primary key(workspace_id,memo_id));
  `;

export async function prepareDocumentTables(db) {
  await db.execAsync(DOCUMENT_TABLE_SQL);
  const columns = await db.getAllAsync("pragma table_info(stella_document_links)");
  if (!columns.some(column => column.name === "anchors_json")) {
    await db.execAsync("alter table stella_document_links add column anchors_json text");
  }
}
