import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { migrate, openDatabase } from '../db/database.js';
import { performanceFixture } from './performance-fixture.mjs';
import { setup, uuid, cipher, appState } from './harness.mjs';

const indexes = db => db.prepare("select name from sqlite_schema where type='index' order by name").all().map(x=>x.name);
test('v1 to v2 index migration preserves every application row, queue order and rowid; rerun is idempotent', () => {
  const db=performanceFixture(64);
  try {
    const before=appState(db);
    const rowids=db.prepare('select id,rowid from ai_jobs order by rowid').all();
    migrate(db);
    assert.equal(db.prepare('pragma user_version').get().user_version,2);
    assert.deepEqual(appState(db),before);
    assert.deepEqual(db.prepare('select id,rowid from ai_jobs order by rowid').all(),rowids);
    const afterIndexes=indexes(db);migrate(db);assert.deepEqual(indexes(db),afterIndexes);
    assert.deepEqual(db.prepare('pragma foreign_key_check').all(),[]);
    assert.equal(db.prepare('pragma integrity_check').get().integrity_check,'ok');
  } finally {db.close();}
});
test('a failed index migration rolls back dropped indexes and version without modifying data', () => {
  const db=performanceFixture(16);
  try {
    db.exec('create index ai_queue_workspace on ai_jobs(id)');
    const before=appState(db), beforeIndexes=indexes(db);
    assert.throws(()=>migrate(db));
    assert.equal(db.prepare('pragma user_version').get().user_version,1);
    assert.deepEqual(indexes(db),beforeIndexes);assert.deepEqual(appState(db),before);
  }finally{db.close();}
});
test('new file databases create v2, reopen safely, and reject unsupported future versions', () => {
  const directory=mkdtempSync(joinPath(tmpdir(),'sqlite-v2-'));
  let db;
  try {
    const file=joinPath(directory,'test.sqlite');db=openDatabase(file);
    assert.equal(db.prepare('pragma user_version').get().user_version,2);
    db.prepare('insert into users(id) values(?)').run(uuid(1));db.close();db=openDatabase(file);
    assert.equal(db.prepare('select count(*) n from users').get().n,1);
    db.exec('pragma user_version=99');db.close();db=undefined;
    assert.throws(()=>openDatabase(file),/Unknown schema version 99/);
  }finally{if(db?.isOpen)db.close();rmSync(directory,{recursive:true,force:true});}
});
test('queue and recent-request plans use matching indexes without an extra queue sort', () => {
  const db=performanceFixture(2000);
  try {
    migrate(db);db.exec('analyze');
    const queue=db.prepare("explain query plan select id from ai_jobs where workspace_id=? and state='queued' order by created_at,rowid limit 1").all(uuid(100)).map(x=>x.detail).join('\n');
    assert.match(queue,/ai_queue_workspace/);assert.doesNotMatch(queue,/TEMP B-TREE/);
    const recent=db.prepare('explain query plan select count(*) n from ai_jobs where workspace_id=? and actor_id=? and created_at>?').all(uuid(100),uuid(1),1500).map(x=>x.detail).join('\n');
    assert.match(recent,/COVERING INDEX ai_jobs_actor_recent/);
    assert.match(recent,/created_at>/);
  }finally{db.close();}
});
test('paginated folders and documents preserve ACL filtering, cursors and early iterator closure', () => {
  const t=setup({users:[1]});const actor=uuid(1),w=uuid(100);
  try {
    t.as(actor,'create_workspace',[w,'Paging']);
    for(let i=0;i<36;i++){
      const f=uuid(1000+i),d=uuid(2000+i);
      t.as(actor,'create_folder',[w,f,null]);
      t.as(actor,'create_document',[w,d,f,'note',cipher(w,d)]);
      if(i%3===0)t.as(actor,'set_folder_acl',[w,f,{},'1']);
    }
    const counts={all:0,rows:0};
    const prepare=t.db.prepare.bind(t.db);
    t.db.prepare=sql=>{
      const stmt=prepare(sql);
      if(sql.startsWith('select id,parent_id from folders where')||sql.startsWith('select id,revision from documents where')){
        const all=stmt.all.bind(stmt),iterate=stmt.iterate.bind(stmt);
        stmt.all=(...args)=>{counts.all++;return all(...args);};
        stmt.iterate=function*(...args){for(const row of iterate(...args)){counts.rows++;yield row;}};
      }
      return stmt;
    };
    t.as(actor,'list_folders',[w,null,5]);
    assert.ok(counts.rows < 36, 'first page must stop stepping before loading the remaining rows');
    for(const name of ['list_folders','list_accessible_documents']){
      let after=null,epoch=null;const found=[];
      do{
        const args={p_workspace_id:w,p_after_id:after,p_limit:5};
        if(name==='list_accessible_documents')args.p_expected_epoch=epoch;
        const result=t.as(actor,name,args);
        epoch=result.access_epoch??epoch;
        found.push(...(result.folders??result.documents).map(x=>x.id));after=result.next_id;
      }while(after);
      assert.equal(found.length,24);assert.equal(new Set(found).size,24);
      const base=name==='list_folders'?1000:2000;
      assert.deepEqual(found,Array.from({length:36},(_,i)=>i).filter(i=>i%3!==0).map(i=>uuid(base+i)));
    }
    assert.equal(counts.all,0);
    // An early break must not leave a busy statement preventing subsequent writes/commit.
    t.as(actor,'create_folder',[w,uuid(9000),null]);
    assert.equal(t.db.isTransaction,false);
  }finally{t.close();}
});

test('trash streaming keeps pagination, hidden-document filtering and retention semantics', () => {
  const t=setup({users:[1]});const a=uuid(1),w=uuid(100);
  try {
    t.as(a,'create_workspace',[w,'Trash']);
    for(let i=0;i<18;i++){
      const d=uuid(3000+i);
      t.as(a,'create_document',[w,d,null,'note',cipher(w,d)]);
      t.as(a,'push_document',[w,d,uuid(4000+i),'1',cipher(w,d),true,1]);
      if(i%3===0)t.as(a,'set_document_acl',[w,d,{},'1']);
    }
    const found=[];let after=null;
    do{
      const page=t.as(a,'list_trash',[w,after,4]);
      found.push(...page.documents.map(d=>d.id));after=page.next_id;
    }while(after);
    assert.deepEqual(found,Array.from({length:18},(_,i)=>i).filter(i=>i%3!==0).map(i=>uuid(3000+i)));
    t.advance(721);
    assert.deepEqual(t.as(a,'list_trash',[w,null,4]).documents,[]);
    assert.equal(t.db.isTransaction,false);
  }finally{t.close();}
});
