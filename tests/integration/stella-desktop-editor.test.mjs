import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { createStellaDocumentStore, normalizeBlocks, blocksText, prepareDocumentTables } from '../../backend/local/src/stella-documents.js';
import { insertBlock, splitBlock, moveBlock, tableRows } from '../../backend/local/src/document-blocks.mjs';
import { createDocumentWorkspace } from '../../frontend/Frontend_UI/src/integration/documentWorkspace.mjs';
function fixture(){const t=setup(),prefs=new Map();const content=createStellaDocumentStore({db:t.db,store:t.store});const documents=createDocumentWorkspace({content,store:t.store,read:(key,value)=>prefs.get(key)??value,write:(key,value)=>prefs.set(key,value)});return {...t,documents};}
const paragraph=(id,text)=>({id,type:'paragraph',text,checked:false});
test('between-block insertion, splitting and movement preserve block data',()=>{const initial=[paragraph('a','첫 문단'),paragraph('b','마지막')];const added=insertBlock(initial,'a',paragraph('c','중간'));assert.deepEqual(added.map(b=>b.id),['a','c','b']);const split=splitBlock(added,'c','중간\n다음',()=> 'd');assert.deepEqual(split.map(b=>b.text),['첫 문단','중간','다음','마지막']);assert.deepEqual(moveBlock(split,'d','a').map(b=>b.id),['d','a','c','b']);assert.equal(initial.length,2);});
test('table blocks retain all cells through save, version restore and backup',()=>{const t=fixture();const memo=t.store.addMemo({title:'표 문서',body:'원문'});const blocks=normalizeBlocks([{id:'grid',type:'table',rows:[['이름','상태'],['회의','준비']]}]);const saved=t.documents.saveContent(memo.id,{title:memo.title,body:blocksText(blocks),blocks},memo.revision);assert.deepEqual(t.documents.blocksFor(saved)[0].rows,[['이름','상태'],['회의','준비']]);const version=t.documents.createVersion(saved.id,saved.revision);const changed=t.documents.saveContent(saved.id,{title:'변경',body:'다른 내용',blocks:[paragraph('x','다른 내용')]},saved.revision);const restored=t.documents.restoreVersion(saved.id,version,changed.revision);assert.deepEqual(t.documents.blocksFor(restored),blocks);const backup=t.store.exportAll();assert.ok(backup.documents);t.store.importAll(backup);assert.deepEqual(t.documents.blocksFor(t.store.getMemo(saved.id)),blocks);});
test('existing hierarchy is the only parent authority used by the forced UI',()=>{const t=fixture(),a=t.store.addMemo({title:'상위'}),b=t.store.addMemo({title:'하위'});t.documents.moveDocument(b.id,a.id);assert.equal(t.store.getMemo(b.id).parentMemoId,a.id);assert.equal(t.documents.listDocuments().find(d=>d.id===b.id).parentId,a.id);assert.throws(()=>t.documents.moveDocument(a.id,b.id));});
test('invalid table edits and malformed backups do not overwrite saved content',()=>{const t=fixture(),memo=t.store.addMemo({title:'기존',body:'보존'});assert.throws(()=>tableRows([['a'],['b','c']]));const backup=t.store.exportAll();backup.documents.tables.stella_document_meta.push({memo_id:memo.id,parent_id:null,sort_order:0,blocks_json:'not-json',blocks_revision:1,graph_x:null,graph_y:null});assert.throws(()=>t.store.importAll(backup));assert.equal(t.store.getMemo(memo.id).body,'보존');});

test("async document initialization prepares all tables before sync editing",async()=>{const t=setup();await prepareDocumentTables({execAsync:async sql=>t.db.execSync(sql),getAllAsync:async sql=>t.db.getAllSync(sql)});const content=createStellaDocumentStore({db:t.db,store:t.store,tablesReady:true});const memo=t.store.addMemo({title:"async initialization"});assert.ok(content.blocksFor(memo));assert.ok(t.db.getAllSync("pragma table_info(stella_document_links)").some(c=>c.name==="anchors_json"));});

test('deleting a child promotes its children and preserves blocks and restore',()=>{
  const t=fixture();
  const parent=t.store.addMemo({title:'parent'});
  const child=t.store.addMemo({title:'child',body:'preserved'});
  const grandchild=t.store.addMemo({title:'grandchild'});
  t.documents.moveDocument(child.id,parent.id);
  t.documents.moveDocument(grandchild.id,child.id);
  const before=t.store.getMemo(child.id);
  const blocks=[paragraph('child-block','preserved')];
  const saved=t.documents.saveContent(child.id,{title:child.title,body:'preserved',blocks},before.revision);
  t.documents.createVersion(saved.id,saved.revision);
  t.documents.trash(child.id);
  assert.ok(t.store.getMemo(child.id).deletedAt!==null);
  assert.equal(t.store.getMemo(grandchild.id).parentMemoId,parent.id);
  assert.ok(!t.documents.listDocuments().some(d=>d.id===child.id));
  t.store.restoreMemos([child.id]);
  assert.equal(t.store.getMemo(child.id).parentMemoId,parent.id);
  assert.deepEqual(t.documents.blocksFor(t.store.getMemo(child.id)),blocks);
  assert.equal(t.documents.listVersions(child.id).length,1);
});
test('failed child promotion rolls back deletion and all parent changes',()=>{
  const t=fixture(),parent=t.store.addMemo({title:'parent'}),child=t.store.addMemo({title:'child'});
  t.documents.moveDocument(child.id,parent.id);
  t.db.execSync("create trigger reject_parent_change before update of parent_memo_id on memos begin select raise(abort, 'test promotion failure'); end;");
  assert.throws(()=>t.documents.trash(parent.id));
  assert.equal(t.store.getMemo(parent.id).deletedAt,null);
  assert.equal(t.store.getMemo(child.id).parentMemoId,parent.id);
});
