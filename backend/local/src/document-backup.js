import { ensureDocumentTables, normalizeBlocks, normalizeLinkAnchors, blocksText } from './stella-documents.js';
const TABLES = {
  stella_document_meta: ['memo_id','parent_id','sort_order','blocks_json','blocks_revision','graph_x','graph_y'],
  stella_document_links: ['source_id','target_id','anchors_json'],
  stella_document_versions: ['memo_id','version','payload','created_at'],
  stella_document_originals: ['memo_id','payload','created_at'],
};
const invalid = () => { throw new Error('문서 블록 백업이 손상되었습니다.'); };
export function exportDocumentData(db, workspaceId) {
  if (!db.getFirstSync("select name from sqlite_master where type='table' and name='stella_document_meta'")) return undefined;
  return { format: 1, tables: Object.fromEntries(Object.entries(TABLES).map(([name, columns]) => [name, db.getAllSync(`select ${columns.join(',')} from ${name} where workspace_id=?`, [workspaceId])])) };
}
export function validateDocumentData(data, memos) {
  if (data === undefined) return;
  if (!data || data.format !== 1 || !data.tables || typeof data.tables !== 'object') invalid();
  const ids=new Set(memos.map(memo=>memo.id));
  for (const [name, columns] of Object.entries(TABLES)) {
    const rows=data.tables[name];
    if (!Array.isArray(rows) || rows.length>100000) invalid();
    const keys=new Set();
    for (const row of rows) {
      if (!row || typeof row!=='object' || columns.some(column=>row[column]!==null && typeof row[column]!=='string' && typeof row[column]!=='number')) invalid();
      if (name==='stella_document_links') {
        if (!ids.has(row.source_id)||!ids.has(row.target_id)||row.source_id===row.target_id) invalid();
        if (row.anchors_json) normalizeLinkAnchors(JSON.parse(row.anchors_json));
      } else {
        if (!ids.has(row.memo_id)) invalid();
        if (name==='stella_document_meta') {
          if (row.parent_id!==null && !ids.has(row.parent_id)) invalid();
          if (!Number.isFinite(row.sort_order)||[row.graph_x,row.graph_y].some(value=>value!==null&&(!Number.isFinite(value)||Math.abs(value)>100000))) invalid();
          if (row.blocks_revision!==null&&(!Number.isInteger(row.blocks_revision)||row.blocks_revision<1)) invalid();
          if (row.blocks_json) normalizeBlocks(JSON.parse(row.blocks_json));
        } else {
          if (!Number.isFinite(row.created_at)||typeof row.payload!=='string') invalid();
          const payload=JSON.parse(row.payload);
          if (!payload||typeof payload.title!=='string'||typeof payload.body!=='string'||!Number.isInteger(payload.revision)||payload.revision<1) invalid();
          const blocks=normalizeBlocks(payload.blocks);
          if (blocksText(blocks)!==payload.body) invalid();
          if (name==='stella_document_versions'&&(!Number.isInteger(row.version)||row.version<1)) invalid();
        }
      }
      const key=name==='stella_document_links'?JSON.stringify([row.source_id,row.target_id]):JSON.stringify([row.memo_id,row.version??null]);
      if(keys.has(key))invalid();keys.add(key);
    }
  }
}
export function restoreDocumentData(db, workspaceId, data) {
  if(data===undefined)return;
  ensureDocumentTables(db);
  for(const [name,columns] of Object.entries(TABLES)) {
    db.runSync(`delete from ${name} where workspace_id=?`,[workspaceId]);
    for(const row of data.tables[name])db.runSync(`insert into ${name}(workspace_id,${columns.join(',')}) values(?,${columns.map(()=>'?').join(',')})`,[workspaceId,...columns.map(column=>row[column])]);
  }
}
