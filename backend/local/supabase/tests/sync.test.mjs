import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_ERRORS } from '../../contracts/errors.js';
import { database,uuid,cipher,asUser,withIdentity,inTransaction,rpc,rpcNamed,join,setAcl,deleteUserAsAuthAdmin } from './harness.mjs';
// Contract errors (shared/contracts/errors.js): SQLSTATE PT<status> with the bare reason as message. The RPCs raise a
// new error instead of passing a caught one on, so no detail or hint (constraint keys, input text) reaches callers.
const rejected=reason=>({code:SERVER_ERRORS[reason].sqlstate,message:reason,detail:undefined,hint:undefined});
const FORBIDDEN=rejected('forbidden'),UNAUTHENTICATED=rejected('unauthenticated');
// Raw constraint errors remain only for direct table writes by the test superuser, never for RPC callers.
const fkError=(table,constraint)=>({code:'23503',constraint,message:`insert or update on table "${table}" violates foreign key constraint "${constraint}"`});
const checkError=(table,constraint)=>({code:'23514',constraint,message:`new row for relation "${table}" violates check constraint "${constraint}"`});
const ROLLBACK=new Error('dry run rollback');
test('real SQL sync security and transaction invariants',async(t)=>{
 const db=await database(); t.after(()=>db.close());
 const owner=uuid(1),editor=uuid(2),viewer=uuid(3),outsider=uuid(4),unknown=uuid(5),w=uuid(10),other=uuid(11),f=uuid(20),nested=uuid(21),hidden=uuid(30),visible=uuid(31);
 // `unknown` is never inserted into auth.users.
 for(const id of [owner,editor,viewer,outsider]) await db.query('insert into auth.users values($1)',[id]);
 const call=(u,n,a)=>asUser(db,u,()=>rpc(db,n,a));
 // Positive control: the call succeeds as u, then rolls back so shared fixtures stay unchanged.
 const dryRun=async(u,n,a)=>{ let result; try { await asUser(db,u,async()=>{ result=await rpc(db,n,a); throw ROLLBACK; }); } catch(error) { if(error!==ROLLBACK) throw error; } return result; };
 const rankAs=(u,folder)=>withIdentity(db,u,async()=>(await db.query('select private.folder_rank($1,$2) r',[w,folder])).rows[0].r);
 const headOf=async()=>(await db.query('select head::text h from app.workspaces where id=$1',[w])).rows[0].h;
 // Everything an administration RPC can change in w.
 const adminState=async()=>({
  epoch:(await db.query('select access_epoch::text e from app.workspaces where id=$1',[w])).rows[0].e,
  members:(await db.query('select user_id,role from app.members where workspace_id=$1 order by user_id',[w])).rows,
  folders:(await db.query('select id,acl from app.folders where workspace_id=$1 order by id',[w])).rows,
  documents:(await db.query('select id,acl from app.documents where workspace_id=$1 order by id',[w])).rows,
  signals:(await db.query('select user_id,generation::text from app.user_signals where workspace_id=$1 order by user_id',[w])).rows,
  audit:(await db.query('select count(*)::int n from app.audit where workspace_id=$1',[w])).rows[0].n,
 });
 const nextEpoch=state=>({access_epoch:String(BigInt(state.epoch)+1n),changed:true});
 // set_folder_acl/set_document_acl answers also carry the ACL version.
 const nextAcl=(state,version)=>({...nextEpoch(state),acl_version:String(version)});
 const aclVersion=async(kind,id)=>(await db.query(`select acl_version::text v from app.${kind==='folder'?'folders':'documents'} where workspace_id=$1 and id=$2`,[w,id])).rows[0].v;
 // Signal generation per user, and the same after `times` signals to every listed user.
 const generations=state=>Object.fromEntries(state.signals.map(s=>[s.user_id,BigInt(s.generation)]));
 const signalled=(state,times=1n)=>Object.fromEntries(Object.entries(generations(state)).map(([user,g])=>[user,g+times]));
 await call(owner,'create_workspace',[w,'Test']); await call(owner,'create_workspace',[other,'Other']);
 // Members join by invitation (set_member only changes or removes them); epochs stay as before: each join bumps once.
 await join(db,owner,w,editor,'editor'); await join(db,owner,w,viewer,'viewer');
 await assert.rejects(call(editor,'create_folder',[w,f,null]),FORBIDDEN);
 // New folders inherit (F01), so these start restricted to the owner explicitly, as the old default made them.
 await call(owner,'create_folder',[w,f,null,{[owner]:'editor'}]); await call(owner,'create_folder',[w,nested,f,{[owner]:'editor'}]);
 await assert.rejects(call(editor,'create_document',[w,hidden,nested,'note',cipher(w,hidden)]),FORBIDDEN);
 await setAcl(db,owner,'folder',w,f,null); await setAcl(db,owner,'folder',w,nested,null);
 const c=cipher(w,hidden),cv=cipher(w,visible);
 await call(editor,'create_document',[w,hidden,nested,'note',c]); await call(editor,'create_document',[w,visible,null,'meeting',cv]);
 await t.test('documents inherit the folder chain and the workspace role, without an owner share (F01)',async()=>{
  // Was: creator-restricted until the owner shared. New documents have a NULL ACL, so readers see them at once.
  assert.deepEqual((await db.query('select id,acl from app.documents where workspace_id=$1 order by id',[w])).rows,[{id:hidden,acl:null},{id:visible,acl:null}]);
  for(const u of [owner,editor,viewer]) assert.equal((await call(u,'list_accessible_documents',[w])).documents.length,2);
  // The role still caps what inheritance gives: the viewer reads but cannot write.
  assert.equal(await withIdentity(db,viewer,async()=>(await db.query('select private.document_rank($1,$2) r',[w,hidden])).rows[0].r),1);
  assert.equal(await withIdentity(db,editor,async()=>(await db.query('select private.document_rank($1,$2) r',[w,hidden])).rows[0].r),2);
 });
 await t.test('create receipt is stable and hash bound',async()=>{
  // The receipt has the push shape; without p_op_id the document id is the op id.
  assert.deepEqual(await call(editor,'create_document',[w,hidden,nested,'note',c]),{op_id:hidden,document_id:hidden,status:'applied',revision:'1',head:'1'});
  await assert.rejects(call(editor,'create_document',[w,hidden,nested,'agenda',c]),rejected('op_id_reused'));
 });
 await t.test('create RPCs reject an existing id with id_conflict and no side effects',async()=>{
  const fresh=uuid(990),head=await headOf(),initial=await adminState();
  const otherHead=(await db.query('select head::text h from app.workspaces where id=$1',[other])).rows[0].h;
  const workspaces=async()=>(await db.query('select id,name,head::text,access_epoch::text from app.workspaces order by id')).rows;
  const visibleRow=async()=>(await db.query('select ciphertext,revision::text,acl from app.documents where workspace_id=$1 and id=$2',[w,visible])).rows;
  const before={workspaces:await workspaces(),visible:await visibleRow()};
  const created={workspace_id:fresh,head:'0',access_epoch:'1'};
  // [caller, rpc, rejected args, twin differing only in the id (or the workspace that scopes it), twin result]
  const cases=[
   [owner,'create_workspace',[w,'Test'],[fresh,'Test'],created], // the creator retrying
   [outsider,'create_workspace',[w,'Other'],[fresh,'Other'],created],
   [owner,'create_folder',[w,f,null],[w,fresh,null],{id:fresh,acl_version:'1'}],
   [owner,'create_folder',[w,f,null],[other,f,null],{id:f,acl_version:'1'}],
   // The editor created visible, so the owner holds no receipt for it and reaches the id check.
   [owner,'create_document',[w,visible,null,'note',cipher(w,visible)],[w,fresh,null,'note',cipher(w,fresh)],{op_id:fresh,document_id:fresh,status:'applied',revision:'1',head:String(BigInt(head)+1n)}],
   // The same document id in another workspace is free: the id check is scoped to the workspace.
   [owner,'create_document',[w,visible,null,'note',cipher(w,visible)],[other,visible,null,'note',cipher(other,visible)],{op_id:visible,document_id:visible,status:'applied',revision:'1',head:String(BigInt(otherHead)+1n)}],
  ];
  for(const [caller,name,invalid,valid,result] of cases){
   await assert.rejects(call(caller,name,invalid),rejected('id_conflict'));
   assert.deepEqual(await dryRun(caller,name,valid),result);
  }
  assert.deepEqual({workspaces:await workspaces(),visible:await visibleRow()},before);
  assert.deepEqual(await adminState(),initial); assert.equal(await headOf(),head);
  assert.equal((await db.query('select count(*)::int n from app.receipts where actor_id=$1 and op_id=$2',[owner,visible])).rows[0].n,0);
 });
 await t.test('create RPCs reject a null id or name and an unknown kind with invalid_request',async()=>{
  const fresh=uuid(991),head=await headOf(),initial=await adminState();
  const workspaceCount=async()=>(await db.query('select count(*)::int n from app.workspaces')).rows[0].n,count=await workspaceCount();
  // The ciphertext stays bound to the twin's id, so a null id is the only difference.
  const doc=[w,fresh,null,'note',cipher(w,fresh)],docResult={op_id:fresh,document_id:fresh,status:'applied',revision:'1',head:String(BigInt(head)+1n)};
  const created={workspace_id:fresh,head:'0',access_epoch:'1'};
  // [caller, rpc, rejected args, twin differing in that one field, twin result]
  const cases=[
   [outsider,'create_workspace',[null,'Name'],[fresh,'Name'],created],
   [outsider,'create_workspace',[fresh,null],[fresh,'Name'],created],
   // Names are shown to invitees, so they are 1 to 200 characters (C106).
   [outsider,'create_workspace',[fresh,''],[fresh,'N'],created],
   [outsider,'create_workspace',[fresh,'가'.repeat(201)],[fresh,'가'.repeat(200)],created],
   [owner,'create_folder',[w,null,null],[w,fresh,null],{id:fresh,acl_version:'1'}],
   [owner,'create_document',doc.with(1,null),doc,docResult],
   ...['memo','NOTE','',null].map(kind=>[owner,'create_document',doc.with(3,kind),doc,docResult]),
  ];
  for(const [caller,name,invalid,valid,result] of cases){
   await assert.rejects(call(caller,name,invalid),rejected('invalid_request'));
   assert.deepEqual(await dryRun(caller,name,valid),result);
  }
  assert.equal(await workspaceCount(),count); assert.deepEqual(await adminState(),initial); assert.equal(await headOf(),head);
  assert.equal((await db.query('select count(*)::int n from app.receipts where op_id=$1',[fresh])).rows[0].n,0);
 });
 await t.test('create_folder parent rank and create_document replay rank are forbidden without side effects',async()=>{
  const fresh=uuid(992),missingParent=uuid(993),initial=await adminState(),head=await headOf();
  const count=async table=>(await db.query(`select count(*)::int n from app.${table} where workspace_id=$1`,[w])).rows[0].n;
  const counts=async()=>({folders:await count('folders'),receipts:await count('receipts'),journal:await count('journal')});
  const before=await counts();
  // Only p_parent_id differs from the twin: the owner cannot rank a parent that does not exist.
  await assert.rejects(call(owner,'create_folder',[w,fresh,missingParent]),FORBIDDEN);
  assert.deepEqual(await dryRun(owner,'create_folder',[w,fresh,null]),{id:fresh,acl_version:'1'});
  assert.deepEqual(await counts(),before); assert.deepEqual(await adminState(),initial);
  // The editor's own create of visible: replaying it is refused while the editor has no access to visible
  // and returns the stored receipt once access is back, without a new receipt or journal row.
  await setAcl(db,owner,'document',w,visible,{});
  await assert.rejects(call(editor,'create_document',[w,visible,null,'meeting',cv]),FORBIDDEN);
  await setAcl(db,owner,'document',w,visible,null);
  assert.deepEqual(await call(editor,'create_document',[w,visible,null,'meeting',cv]),{op_id:visible,document_id:visible,status:'applied',revision:'1',head:'2'});
  assert.deepEqual(await counts(),before); assert.equal(await headOf(),head);
 });
 await t.test('RLS and grants deny direct content access, writes and private helpers',async()=>{
  const denied=[['select * from app.documents','permission denied for table documents'],['update app.workspaces set head=9','permission denied for table workspaces'],[`select private.role_rank('${w}')`,'permission denied for schema private']];
  // Infrastructure denials keep SQLSTATE 42501, which is never a contract code, so callers can tell them from 'forbidden'.
  for(const [statement,message] of denied) await assert.rejects(asUser(db,editor,()=>db.exec(statement)),{code:'42501',message});
  // Every app table, invitations and storage_deletions included.
  const r=await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app' and c.relkind='r'"); assert.equal(r.rows.length,12); assert.ok(r.rows.every(x=>x.relrowsecurity));
  // anon with the editor's subject (legacy GUC, as asUser sets it): only the role differs from the call below.
  const editorSubject=["select set_config('request.jwt.claim.sub',$1,true)",[editor]];
  await assert.rejects(inTransaction(db,['set local role anon',editorSubject],()=>rpc(db,'pull_changes',[w,'0'])),{code:'42501',message:'permission denied for function pull_changes'});
  assert.equal((await call(editor,'pull_changes',[w,'0'])).reset_required,true);
 });
 await t.test('workspace bound and nested ACL intersection',async()=>{
  await assert.rejects(call(editor,'create_document',[other,uuid(39),f,'note',cipher(other,uuid(39))]),FORBIDDEN);
  await assert.rejects(call(owner,'create_document',[other,uuid(39),f,'note',cipher(other,uuid(39))]),FORBIDDEN);
  await assert.rejects(call(editor,'set_folder_acl',[w,f,{},await aclVersion('folder',f)]),FORBIDDEN);
  await setAcl(db,owner,'folder',w,f,{[editor]:'viewer',[viewer]:'editor'});
  await setAcl(db,owner,'folder',w,nested,{[editor]:'editor',[viewer]:'editor'});
  await assert.rejects(call(editor,'push_document',[w,hidden,uuid(40),'1',c]),FORBIDDEN);
  await assert.rejects(call(viewer,'push_document',[w,hidden,uuid(41),'1',c]),FORBIDDEN);
  await setAcl(db,owner,'document',w,hidden,{});
  const m=await call(editor,'list_accessible_documents',[w]); assert.deepEqual(m.documents.map(x=>x.id),[visible]);
  const p=await call(editor,'pull_changes',[w,'0',1,m.access_epoch]); assert.equal(p.changes.length,0); assert.equal(p.scanned_through,'1');
  const p2=await call(editor,'pull_changes',[w,p.scanned_through,1,m.access_epoch]); assert.equal(p2.changes[0].id,visible); assert.equal(p2.scanned_through,'2');
  assert.equal((await call(editor,'pull_changes',[w,'0'])).reset_required,true);
 });
 await t.test('cipher validation and atomic rollback',async()=>{
  const before=(await db.query('select head from app.workspaces where id=$1',[w])).rows[0].head;
  for(const invalid of [{...cv,extra:'plaintext'},{...cv,aad:'wrong'},{...cv,nonce:'short'},{...cv,ciphertext:'AA=='},{...cv,algorithm:'plaintext'}]) await assert.rejects(call(editor,'push_document',[w,visible,uuid(45),'1',invalid]),rejected('invalid_ciphertext'));
  await assert.rejects(call(editor,'push_document',[w,visible,uuid(45),'1',cv,false,2]),rejected('invalid_key_epoch'));
  assert.equal((await db.query('select head from app.workspaces where id=$1',[w])).rows[0].head,before);
  assert.equal((await db.query('select count(*)::int n from app.receipts where op_id=$1',[uuid(45)])).rows[0].n,0);
 });
 await t.test('push receipts, stable conflict and no tombstone resurrection',async()=>{
  const op=uuid(50),c2=cipher(w,visible,1,'b'); const args=[w,visible,op,'1',c2];
  const a=await call(editor,'push_document',args); assert.equal(a.status,'applied'); assert.equal(a.revision,'2');
  assert.deepEqual(await call(editor,'push_document',args),a);
  await assert.rejects(call(editor,'push_document',[w,visible,op,'1',cv]),rejected('op_id_reused'));
  const conflictArgs=[w,visible,uuid(51),'1',cv]; const conflict=await call(editor,'push_document',conflictArgs); assert.equal(conflict.status,'conflict');
  const del=await call(editor,'push_document',[w,visible,uuid(52),'2',c2,true]); assert.equal(del.revision,'3');
  assert.deepEqual(await call(editor,'push_document',conflictArgs),conflict);
  // Even with the current revision as base, a push to a deleted document is answered 'deleted' (was 'conflict'),
  // stored like any receipt, and nothing is revived.
  const resurrect=[w,visible,uuid(53),'3',cv,false],deleted=await call(editor,'push_document',resurrect);
  assert.deepEqual(deleted,{op_id:uuid(53),document_id:visible,status:'deleted',revision:'3',head:del.head});
  assert.deepEqual(await call(editor,'push_document',resurrect),deleted);
  assert.equal((await call(editor,'list_accessible_documents',[w])).documents.length,0);
  const count=(await db.query('select count(*)::int n from app.journal where workspace_id=$1',[w])).rows[0].n; assert.equal(count,4); assert.equal((await db.query("select count(*)::int n from app.audit where workspace_id=$1 and action='document_revision'",[w])).rows[0].n,4);
  const manifest=await call(editor,'list_accessible_documents',[w]); const pull=await call(editor,'pull_changes',[w,'3',100,manifest.access_epoch]); assert.equal(pull.changes[0].deleted,true); assert.equal(pull.changes[0].ciphertext,null);
 });
 await t.test("a create reusing one of the caller's push op_ids is op_id_reused, not forbidden",async()=>{
  // uuid(50) is the editor's push op_id above, so the editor holds a receipt under it with another request hash.
  const reused=uuid(50),fresh=uuid(994),head=await headOf();
  await assert.rejects(call(editor,'create_document',[w,reused,null,'note',cipher(w,reused)]),rejected('op_id_reused'));
  assert.equal(await headOf(),head);
  assert.equal((await db.query('select count(*)::int n from app.documents where workspace_id=$1 and id=$2',[w,reused])).rows[0].n,0);
  // Twin: only the id differs, and a fresh id is created (rolled back).
  assert.deepEqual(await dryRun(editor,'create_document',[w,fresh,null,'note',cipher(w,fresh)]),{op_id:fresh,document_id:fresh,status:'applied',revision:'1',head:String(BigInt(head)+1n)});
 });
 await t.test('non-owner administration is rejected without side effects',async()=>{
  // Only the caller differs: the owner's dry run of each call succeeds. No case targets a caller, so the
  // self-change guard in set_member cannot reject it first.
  // ACL calls carry the stored version, so the owner's twin is a real change.
  const [vf,vh]=[await aclVersion('folder',f),await aclVersion('document',hidden)];
  const initial=await adminState();
  const cases=[['set_member',[w,viewer,'editor'],nextEpoch(initial)],
   ['set_folder_acl',[w,f,{[editor]:'editor',[viewer]:'editor'},vf],nextAcl(initial,BigInt(vf)+1n)],
   ['set_document_acl',[w,hidden,{[editor]:'editor'},vh],nextAcl(initial,BigInt(vh)+1n)]];
  // The editor rows test a non-owner MEMBER only while the editor is still a member (a later subtest removes it).
  assert.deepEqual(initial.members,[{user_id:owner,role:'owner'},{user_id:editor,role:'editor'},{user_id:viewer,role:'viewer'}]);
  for(const [name,args,result] of cases){
   for(const caller of [editor,outsider]) await assert.rejects(call(caller,name,args),FORBIDDEN);
   assert.deepEqual(await adminState(),initial);
   assert.deepEqual(await dryRun(owner,name,args),result);
  }
  assert.deepEqual(await adminState(),initial);
 });
 await t.test('invalid ACL payloads are rejected without side effects',async()=>{
  // Owner-only fixtures (the folder is restricted at creation, since new folders inherit) whose ACLs differ from every
  // valid twin, so no twin is a no-op.
  const folder=uuid(56),doc=uuid(57);
  await call(owner,'create_folder',[w,folder,null,{[owner]:'editor'}]); await call(owner,'create_document',[w,doc,folder,'note',cipher(w,doc)]);
  const invalidAcl=rejected('invalid_acl'),notMember=rejected('member_not_found');
  // [rejected ACL, valid twin differing in exactly one way, expected error]
  const cases=[
   [[],{},invalidAcl],
   [{[viewer]:'owner'},{[viewer]:'viewer'},invalidAcl],
   [{[viewer]:1},{[viewer]:'viewer'},invalidAcl],
   [{'not-a-uuid':'viewer'},{[viewer]:'viewer'},invalidAcl],
   // jsonb orders shorter keys first, so the invalid key follows a valid one: every key is checked.
   [{[viewer]:'viewer',['x'.repeat(40)]:'viewer'},{[viewer]:'viewer'},invalidAcl],
   // Two spellings of one uuid (F15): rejected rather than resolved by key order.
   [{[viewer]:'viewer',[`{${viewer}}`]:'editor'},{[viewer]:'viewer'},invalidAcl],
   // Keys must name current members (F12), for known and unknown accounts alike.
   [{[viewer]:'viewer',[outsider]:'viewer'},{[viewer]:'viewer'},notMember],
   [{[unknown]:'viewer'},{[viewer]:'viewer'},notMember],
  ];
  const initial=await adminState();
  for(const [name,target] of [['set_folder_acl',folder],['set_document_acl',doc]]) for(const [invalid,valid,error] of cases){
   await assert.rejects(call(owner,name,[w,target,invalid,'1']),error);
   assert.deepEqual(await adminState(),initial);
   assert.deepEqual(await dryRun(owner,name,[w,target,valid,'1']),nextAcl(initial,2));
  }
  assert.deepEqual(await adminState(),initial);
 });
 await t.test('ACL changes on a missing folder or document are not_found without side effects',async()=>{
  const initial=await adminState(),missing=uuid(58);
  // [rpc, kind, existing twin target, expected reason]; only the target id differs (same ACL and version).
  for(const [name,kind,target,reason] of [['set_folder_acl','folder',f,'folder_not_found'],['set_document_acl','document',hidden,'document_not_found']]){
   const version=await aclVersion(kind,target);
   await assert.rejects(call(owner,name,[w,missing,null,version]),rejected(reason));
   assert.deepEqual(await adminState(),initial);
   assert.deepEqual(await dryRun(owner,name,[w,target,null,version]),nextAcl(initial,BigInt(version)+1n));
  }
 });
 await t.test('owner transfer and self-change are rejected without side effects',async()=>{
  // [rejected set_member args, valid twin differing in exactly one way]
  const cases=[[[w,owner,'editor'],[w,viewer,'editor']],[[w,owner,null],[w,viewer,null]],[[w,viewer,'owner'],[w,viewer,'editor']]];
  const initial=await adminState();
  for(const [invalid,valid] of cases){
   await assert.rejects(call(owner,'set_member',invalid),rejected('owner_change_not_supported'));
   assert.deepEqual(await adminState(),initial);
   assert.deepEqual(await dryRun(owner,'set_member',valid),nextEpoch(initial));
  }
  assert.deepEqual(await adminState(),initial);
 });
 await t.test('set_member rejects non-members, unsupported roles and a null user without side effects',async()=>{
  // [rejected args, valid twin differing in exactly one way, expected error]
  // Members join only through invitations, so giving a role to a non-member is member_not_found (was: adding it, or
  // user_not_found for an id missing from auth.users). A known and an unknown account get the same answer. Removing a
  // non-member is a no-op (next subtest).
  const cases=[
   [[w,outsider,'editor'],[w,viewer,'editor'],rejected('member_not_found')],
   [[w,unknown,'editor'],[w,viewer,'editor'],rejected('member_not_found')],
   [[w,viewer,'admin'],[w,viewer,'editor'],rejected('invalid_role')],
   [[w,viewer,'Editor'],[w,viewer,'editor'],rejected('invalid_role')],
   [[w,viewer,''],[w,viewer,'editor'],rejected('invalid_role')],
   [[w,null,'editor'],[w,viewer,'editor'],rejected('invalid_request')],
   [[w,null,null],[w,viewer,null],rejected('invalid_request')],
  ];
  const initial=await adminState();
  for(const [invalid,valid,error] of cases){
   await assert.rejects(call(owner,'set_member',invalid),error);
   assert.deepEqual(await adminState(),initial);
   assert.deepEqual(await dryRun(owner,'set_member',valid),nextEpoch(initial));
  }
  assert.deepEqual(await adminState(),initial);
 });
 await t.test('permission calls that change nothing return changed:false and write nothing',async()=>{
  // Fixtures stay hidden from the editor (the folder ACLs leave it out; new folders inherit, so they are restricted at
  // creation), so the manifest subtest below stays exact.
  const folder=uuid(120),doc=uuid(121),empty=uuid(122),acl={[owner]:'editor',[viewer]:'viewer'};
  await call(owner,'create_folder',[w,folder,null,{[owner]:'editor'}]); await call(owner,'create_folder',[w,empty,null,{[owner]:'editor'}]);
  await call(owner,'create_document',[w,doc,folder,'note',cipher(w,doc)]);
  for(const [kind,id,value] of [['folder',folder,acl],['document',doc,acl],['folder',empty,null]]) assert.equal((await setAcl(db,owner,kind,w,id,value)).changed,true);
  // The same entries inserted in the other order: an equal jsonb value. The same keys in another uuid spelling: equal
  // once normalised (F15).
  const reordered={[viewer]:'viewer',[owner]:'editor'},respelled={[`{${owner}}`]:'editor',[viewer.replaceAll('-','')]:'viewer'};
  assert.notEqual(JSON.stringify(reordered),JSON.stringify(acl));
  const unchangedAcl={acl_version:'2'},changedAcl={acl_version:'3'};
  // [rpc, args that change nothing, twin differing in one way that changes something, extra answer fields of each]
  const cases=[
   ['set_member',[w,editor,'editor'],[w,editor,'viewer']],
   ['set_member',[w,viewer,'viewer'],[w,viewer,'editor']],
   // Removing a known non-member, and an id missing from auth.users (no account-existence probe).
   ['set_member',[w,outsider,null],[w,viewer,null]],
   ['set_member',[w,unknown,null],[w,viewer,null]],
   ['set_folder_acl',[w,folder,reordered,'2'],[w,folder,{[owner]:'editor'},'2'],unchangedAcl,changedAcl],
   ['set_document_acl',[w,doc,reordered,'2'],[w,doc,{[owner]:'editor'},'2'],unchangedAcl,changedAcl],
   ['set_document_acl',[w,doc,respelled,'2'],[w,doc,{[owner]:'editor'},'2'],unchangedAcl,changedAcl],
   // An equal ACL is a no-op even with a stale expected version, so a retry after a lost response is answered alike.
   ['set_folder_acl',[w,folder,acl,'1'],[w,folder,{[owner]:'editor'},'2'],unchangedAcl,changedAcl],
   ['set_folder_acl',[w,empty,null,'2'],[w,empty,{},'2'],unchangedAcl,changedAcl], // null (inherit) to null
  ];
  const initial=await adminState();
  for(const [name,unchanged,twin,unchangedExtra={},twinExtra={}] of cases){
   // Permission comes before the no-op decision: a non-owner member and a non-member get forbidden, never an
   // answer that would tell them a role, an ACL or the epoch.
   for(const caller of [editor,outsider]) await assert.rejects(call(caller,name,unchanged),FORBIDDEN);
   assert.deepEqual(await adminState(),initial);
   assert.deepEqual(await call(owner,name,unchanged),{access_epoch:initial.epoch,changed:false,...unchangedExtra});
   assert.deepEqual(await adminState(),initial);
   assert.deepEqual(await dryRun(owner,name,twin),{...nextEpoch(initial),...twinExtra});
  }
  // Validation comes before it too: the owner already holds the owner role, yet setting it again is rejected.
  await assert.rejects(call(owner,'set_member',[w,owner,'owner']),rejected('owner_change_not_supported'));
  assert.deepEqual(await adminState(),initial);
  // A real ACL change bumps the epoch and the ACL version once, adds one audit row and signals every member; the same
  // call again (its expected version now stale) is a no-op.
  const realChange=async(before,name,args,version)=>{
   assert.deepEqual(await call(owner,name,args),nextAcl(before,version));
   const after=await adminState();
   assert.deepEqual({audit:after.audit,signals:generations(after)},{audit:before.audit+1,signals:signalled(before)});
   assert.deepEqual(await call(owner,name,args),{access_epoch:after.epoch,changed:false,acl_version:String(version)});
   assert.deepEqual(await adminState(),after);
   return after;
  };
  const inherited=await realChange(initial,'set_document_acl',[w,doc,null,'2'],3);
  const restricted=await realChange(inherited,'set_folder_acl',[w,empty,{},'2'],3); // inherit (null) to an empty ACL
  // Giving a role to a non-member is member_not_found, for an unknown account too (was user_not_found when it added).
  await assert.rejects(call(owner,'set_member',[w,unknown,'viewer']),rejected('member_not_found'));
  assert.deepEqual(await adminState(),restricted);
  // Joining (invite, then accept; was one set_member) and removing a member are real changes; the invitee and the
  // removed user are signalled too. invite_member and respond_invitation each add an audit row and signal everyone.
  assert.deepEqual(await join(db,owner,w,outsider,'viewer'),{changed:true,role:'viewer',access_epoch:nextEpoch(restricted).access_epoch});
  const added=await adminState();
  assert.deepEqual({audit:added.audit,signals:generations(added)},{audit:restricted.audit+2,signals:{...signalled(restricted,2n),[outsider]:2n}});
  assert.deepEqual(await call(owner,'set_member',[w,outsider,null]),nextEpoch(added));
  const removed=await adminState();
  assert.deepEqual({audit:removed.audit,signals:generations(removed),members:removed.members},{audit:added.audit+1,signals:signalled(added),members:restricted.members});
 });
 await t.test('manifest lists id and revision of live documents, continues across head moves and restarts on access changes; removed member signaled',async()=>{
  // The nil uuid is a valid document id, so a listing cannot use it as a keyset sentinel.
  const nil='00000000-0000-0000-0000-000000000000',d1=uuid(60),d2=uuid(61);
  for(const d of [nil,d1,d2]) await call(editor,'create_document',[w,d,null,'agenda',cipher(w,d)]);
  // Exactly id and revision. visible is readable by the editor but deleted, so it is left out; the rest excludes the editor.
  const full=await call(editor,'list_accessible_documents',[w]);
  assert.deepEqual(full,{restart_required:false,documents:[nil,d1,d2].map(id=>({id,revision:'1'})),next_id:null,head:await headOf(),access_epoch:full.access_epoch});
  const tombstone=await call(editor,'get_documents',[w,[visible],full.access_epoch]);
  assert.deepEqual(tombstone.documents.map(({id,deleted,ciphertext,revision})=>({id,deleted,ciphertext,revision})),[{id:visible,deleted:true,ciphertext:null,revision:'3'}]);
  // Keyset pages of one entry.
  const page=await call(editor,'list_accessible_documents',[w,null,1]);
  assert.deepEqual(page,{...full,documents:[{id:nil,revision:'1'}],next_id:nil});
  assert.deepEqual(await call(editor,'list_accessible_documents',[w,nil,1,page.access_epoch]),{...full,documents:[{id:d1,revision:'1'}],next_id:d1});
  // A write between pages moves the head; the listing continues with current revisions and head.
  await call(editor,'push_document',[w,d2,uuid(62),'1',cipher(w,d2)]);
  const head=await headOf();
  assert.notEqual(head,page.head);
  assert.deepEqual(await call(editor,'list_accessible_documents',[w,d1,1,page.access_epoch]),{...full,documents:[{id:d2,revision:'2'}],next_id:null,head});
  // A continuation without the epoch restarts, and so does any listing after an access change.
  const restart=access_epoch=>({restart_required:true,documents:[],next_id:null,head,access_epoch});
  assert.deepEqual(await call(editor,'list_accessible_documents',[w,d1,1]),restart(page.access_epoch));
  await setAcl(db,owner,'document',w,d1,{});
  for(const args of [[w,d1,1,page.access_epoch],[w,null,1,page.access_epoch]]) assert.deepEqual(await call(editor,'list_accessible_documents',args),restart(String(BigInt(page.access_epoch)+1n)));
  assert.equal((await call(editor,'pull_changes',[w,head,100,page.access_epoch])).reset_required,true);
  const signals=await asUser(db,editor,()=>db.query('select * from app.user_signals')); assert.ok(signals.rows.every(x=>x.user_id===editor)); const before=signals.rows[0].generation;
  await call(owner,'set_member',[w,editor,null]); await assert.rejects(call(editor,'pull_changes',[w,'0']),FORBIDDEN);
  const after=await asUser(db,editor,()=>db.query('select * from app.user_signals')); assert.ok(BigInt(after.rows[0].generation)>BigInt(before));
  await assert.rejects(call(outsider,'list_accessible_documents',[w]),FORBIDDEN);
 });
 // Existing and missing workspaces get the same error: 'forbidden' for authenticated non-members, and
 // 'unauthenticated' without a subject (lock_workspace checks the subject before looking the workspace up).
 await t.test('non-members get forbidden and subject-less calls unauthenticated, for existing and missing workspaces',async()=>{
  for (const id of [w,uuid(999)]) {
   await assert.rejects(call(outsider,'pull_changes',[id,'0']),FORBIDDEN);
   await assert.rejects(call('','pull_changes',[id,'0']),UNAUTHENTICATED);
  }
  await assert.rejects(call('', 'create_workspace',[uuid(998),'Unauthorized']),UNAUTHENTICATED);
  // A subject without an auth.users row (for example a deleted account) cannot become an owner either.
  await assert.rejects(call(unknown,'create_workspace',[uuid(998),'Unauthorized']),UNAUTHENTICATED);
  assert.equal((await db.query('select count(*)::int n from app.workspaces where id=$1',[uuid(998)])).rows[0].n,0);
  // Only the subject is missing or unknown: the same request with a known one succeeds.
  assert.deepEqual(await dryRun(outsider,'create_workspace',[uuid(998),'Unauthorized']),{workspace_id:uuid(998),head:'0',access_epoch:'1'});
 });
 await t.test('definer role is narrow, ancestry fails closed, pulls never expose historical payloads',async()=>{
  const role=(await db.query("select rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname='sync_backend'")).rows[0];
  assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolbypassrls:false});
  assert.equal((await db.query("select pg_get_userbyid(relowner) owner from pg_class where oid='app.documents'::regclass")).rows[0].owner,'sync_backend');
  assert.equal((await db.query("select pg_has_role('authenticated','sync_backend','MEMBER') member")).rows[0].member,false);
  await assert.rejects(db.query('insert into app.folders values($1,$2,$3,null)',[other,uuid(70),f]),fkError('folders','folders_workspace_id_parent_id_fkey'));
  // The viewer (role cap 1, editor in both folder ACLs) is the identity with a positive rank here.
  for(const folder of [f,nested]) assert.equal(await rankAs(viewer,folder),1);
  await db.query('update app.folders set parent_id=$1 where workspace_id=$2 and id=$3',[nested,w,f]);
  try { for(const folder of [f,nested]) assert.equal(await rankAs(viewer,folder),0); }
  finally { await db.query('update app.folders set parent_id=null where workspace_id=$1 and id=$2',[w,f]); }
  for(const folder of [f,nested]) assert.equal(await rankAs(viewer,folder),1);
  const m=await call(owner,'list_accessible_documents',[w]);
  const p=await call(owner,'pull_changes',[w,'0',100,m.access_epoch]);
  // visible has three journal rows (create, edit, delete); the page carries one entry for it: the tombstone at its last row.
  assert.equal(p.scanned_through,p.head);
  const journal=(await db.query('select seq::text s from app.journal where workspace_id=$1 and document_id=$2 order by seq',[w,visible])).rows.map(r=>r.s);
  assert.equal(journal.length,3);
  assert.deepEqual(p.changes.filter(x=>x.id===visible).map(({deleted,ciphertext,revision,seq})=>({deleted,ciphertext,revision,seq})),[{deleted:true,ciphertext:null,revision:'3',seq:journal.at(-1)}]);
  // Admin-only fixture models a future per-document key rotation. No key API exists yet.
  await db.query('update app.documents set key_epoch=2 where workspace_id=$1 and id=$2',[w,hidden]);
  await setAcl(db,owner,'folder',w,f,{[owner]:'editor'});
  await setAcl(db,owner,'folder',w,nested,{[owner]:'editor'});
  await setAcl(db,owner,'document',w,hidden,{[owner]:'editor'});
  const pushed=await call(owner,'push_document',[w,hidden,uuid(71),'1',cipher(w,hidden,2),false,2]); assert.equal(pushed.status,'applied');
  const fresh=uuid(72); await call(owner,'create_document',[w,fresh,null,'note',cipher(w,fresh)]);
  assert.equal((await call(owner,'push_document',[w,fresh,uuid(73),'1',cipher(w,fresh)])).status,'applied');
 });

 await t.test('ciphertext maximum and canonical base64 match client boundaries',async()=>{
  const d=uuid(80), maximum={...cipher(w,d),ciphertext:Buffer.alloc(786432,0).toString('base64')};
  assert.equal(maximum.ciphertext.length,1048576);
  assert.equal((await call(owner,'create_document',[w,d,null,'note',maximum])).revision,'1');
  const invalidPayloads=[
   {...maximum,ciphertext:maximum.ciphertext+'AAAA'},
   {...maximum,ciphertext:'AAAAAAAAAAAAAAAAAAAAAB=='},
   {...maximum,ciphertext:'AAAAA'},
   {...maximum,ciphertext:'AAAAAAAAAAAAAAAAAAAAAA'},
   {...maximum,nonce:'AAAAAAAAAAAAAAAB=='},
   {...maximum,extra:'x'.repeat(2048)},
  ];
  for(const payload of invalidPayloads) await assert.rejects(call(owner,'push_document',[w,d,uuid(81),'1',payload]),rejected('invalid_ciphertext'));
  assert.equal((await db.query('select revision::text revision from app.documents where workspace_id=$1 and id=$2',[w,d])).rows[0].revision,'1');
  const minimum={...cipher(w,d),ciphertext:Buffer.alloc(16,0).toString('base64')};
  assert.equal((await call(owner,'push_document',[w,d,uuid(82),'1',minimum])).status,'applied');
 });

 await t.test('key envelopes are per-document and tenant constrained; numeric ledgers constrained',async()=>{
  for(const d of [hidden,visible]) await db.query('insert into app.key_envelopes(workspace_id,document_id,user_id,key_epoch,wrapped_key) values($1,$2,$3,1,$4)',[w,d,owner,'{}']);
  await assert.rejects(db.query('insert into app.key_envelopes(workspace_id,document_id,user_id,key_epoch,wrapped_key) values($1,$2,$3,1,$4)',[other,hidden,owner,'{}']),fkError('key_envelopes','key_envelopes_workspace_id_document_id_fkey'));
  await assert.rejects(db.query('update app.workspaces set head=-1 where id=$1',[w]),checkError('workspaces','workspaces_head_check'));
  await assert.rejects(db.query('update app.workspaces set access_epoch=0 where id=$1',[w]),checkError('workspaces','workspaces_access_epoch_check'));
  await assert.rejects(db.query('update app.documents set revision=0 where workspace_id=$1 and id=$2',[w,hidden]),checkError('documents','documents_revision_check'));
  await assert.rejects(db.query("update app.receipts set request_hash=decode('00','hex') where workspace_id=$1",[w]),checkError('receipts','receipts_request_hash_check'));
 });

 await t.test('owner administration does not bypass content ACLs',async()=>{
  const d=uuid(90),folder=uuid(91);
  await call(owner,'create_folder',[w,folder,null]);
  await call(owner,'create_document',[w,d,folder,'note',cipher(w,d)]);
  await setAcl(db,owner,'document',w,d,{[viewer]:'viewer'});
  assert.ok(!(await call(owner,'list_accessible_documents',[w])).documents.some(x=>x.id===d));
  await assert.rejects(call(owner,'push_document',[w,d,uuid(92),'1',cipher(w,d)]),FORBIDDEN);
  await setAcl(db,owner,'document',w,d,{[owner]:'editor'});
  assert.equal((await call(owner,'push_document',[w,d,uuid(92),'1',cipher(w,d)])).status,'applied');
  await setAcl(db,owner,'folder',w,folder,{});
  assert.ok(!(await call(owner,'list_accessible_documents',[w])).documents.some(x=>x.id===d));
  await assert.rejects(call(owner,'push_document',[w,d,uuid(93),'2',cipher(w,d)]),FORBIDDEN);
  await setAcl(db,owner,'folder',w,folder,{[owner]:'editor'});
  assert.equal((await call(owner,'push_document',[w,d,uuid(93),'2',cipher(w,d)])).status,'applied');
 });

 await t.test('folder ancestry deeper than 128 levels fails closed, including for the owner',async()=>{
  // Fixture: chains of inherited (null) ACLs inserted directly, so only depth can lower the rank.
  const chain=async(base,length)=>{
   const ids=Array.from({length},(_,i)=>uuid(base+i));
   for(const [i,id] of ids.entries()) await db.query('insert into app.folders(workspace_id,id,parent_id,acl) values($1,$2,$3,null)',[w,id,i?ids[i-1]:null]);
   return ids;
  };
  const chain128=await chain(10000,128),chain129=await chain(20000,129);
  assert.equal(await rankAs(owner,chain128.at(-1)),2); // owner role rank 3 is capped at 2
  assert.equal(await rankAs(owner,chain129.at(-2)),2); // depth 128 inside the longer chain
  assert.equal(await rankAs(owner,chain129.at(-1)),0);
  // Same document id and payload; only the target folder differs.
  const d=uuid(100),payload=cipher(w,d),head=await headOf();
  await assert.rejects(call(owner,'create_document',[w,d,chain129.at(-1),'note',payload]),FORBIDDEN);
  assert.equal(await headOf(),head);
  assert.equal((await db.query('select count(*)::int n from app.documents where workspace_id=$1 and id=$2',[w,d])).rows[0].n,0);
  assert.deepEqual(await call(owner,'create_document',[w,d,chain128.at(-1),'note',payload]),{op_id:d,document_id:d,status:'applied',revision:'1',head:String(BigInt(head)+1n)});
 });

 await t.test('pull separates invalid_cursor, invalid_limit and cursor_ahead; manifest limits',async()=>{
  const {access_epoch:epoch}=await call(owner,'list_accessible_documents',[w]);
  const head=await headOf(),max='9223372036854775807';
  const pull=(after,limit=100)=>call(owner,'pull_changes',[w,after,limit,epoch]);
  // Positive controls: oldest and newest cursor, smallest and largest limit.
  for(const [after,limit] of [['0',1],[head,500]]) assert.equal((await pull(after,limit)).reset_required,false);
  // 20 digits, 19 digits above the bigint maximum and more digits than numeric accepts are malformed cursors.
  for(const after of ['','-1','01','1.5',' 0','abc',null,'1'+'0'.repeat(19),String(BigInt(max)+1n),'1'.repeat(131073)]) await assert.rejects(pull(after),rejected('invalid_cursor'));
  for(const limit of [0,-1,501,null]) await assert.rejects(pull('0',limit),rejected('invalid_limit'));
  // Well formed but beyond the head (the bigint maximum included): a state conflict, not a malformed cursor.
  for(const after of [String(BigInt(head)+1n),max]) await assert.rejects(pull(after),rejected('cursor_ahead'));
  for(const limit of [0,501,null]) await assert.rejects(call(owner,'list_accessible_documents',[w,null,limit]),rejected('invalid_limit'));
  assert.equal((await call(owner,'list_accessible_documents',[w,null,500])).restart_required,false);
 });

 await t.test('push rejects malformed or out-of-range base revisions with invalid_push and no side effects',async()=>{
  const d=uuid(110),op=uuid(111),payload=cipher(w,d,1,'b'),max='9223372036854775807';
  await call(owner,'create_document',[w,d,null,'note',cipher(w,d)]);
  const head=await headOf(),receipts=async()=>(await db.query('select count(*)::int n from app.receipts where op_id=$1',[op])).rows[0].n;
  const args=[w,d,op,'1',payload];
  // Twins: the current revision applies; the bigint maximum is well formed and only conflicts.
  assert.equal((await dryRun(owner,'push_document',args)).status,'applied');
  assert.equal((await dryRun(owner,'push_document',args.with(3,max))).status,'conflict');
  // 20 digits, 19 digits above the bigint maximum, more digits than numeric accepts, other malformed text,
  // then a null op id and a null deleted flag.
  const invalid=[...['1'+'0'.repeat(19),String(BigInt(max)+1n),'1'.repeat(131073),'0','01','-1','1.0',' 1','',null].map(base=>args.with(3,base)),args.with(2,null),[...args,null]];
  for(const request of invalid) await assert.rejects(call(owner,'push_document',request),rejected('invalid_push'));
  assert.equal(await headOf(),head); assert.equal(await receipts(),0);
  assert.equal((await db.query('select revision::text r from app.documents where workspace_id=$1 and id=$2',[w,d])).rows[0].r,'1');
 });

});

// Byte budget of one read response (private.page_budget()) and the framing allowance of the P0-2 spec.
const BUDGET=4194304,FRAMING=128;
// The largest ciphertext the RPCs accept: 786432 bytes, 1,048,576 base64 characters.
const maximal=(w,d,fill)=>({...cipher(w,d),ciphertext:Buffer.alloc(786432,fill).toString('base64')});
// One RPC call as u with the text size of its result and of each element listed under key, measured in SQL.
const measure=(db,u,name,args,key)=>asUser(db,u,async()=>(await db.query(`with res as materialized (select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) r)
 select r,octet_length(r::text) bytes,array(select octet_length(e::text) from jsonb_array_elements(r->'${key}') with ordinality a(e,o) order by o) sizes from res`,args)).rows[0]);
test('byte-budgeted reads: pull_changes sends each document once per window, get_documents stops before the budget',async(t)=>{
 const db=await database(); t.after(()=>db.close());
 const owner=uuid(1),reader=uuid(2),outsider=uuid(3),w=uuid(10);
 for(const id of [owner,reader,outsider]) await db.query('insert into auth.users values($1)',[id]);
 const call=(u,n,a)=>asUser(db,u,()=>rpc(db,n,a));
 const headOf=async()=>(await db.query('select head::text h from app.workspaces where id=$1',[w])).rows[0].h;
 const epochOf=async()=>(await db.query('select access_epoch::text e from app.workspaces where id=$1',[w])).rows[0].e;
 const revisionOf=async d=>(await db.query('select revision::text r from app.documents where workspace_id=$1 and id=$2',[w,d])).rows[0].r;
 const lastSeq=async(d,after,through)=>(await db.query('select max(seq)::text s from app.journal where workspace_id=$1 and document_id=$2 and seq>$3 and seq<=$4',[w,d,after,through])).rows[0].s;
 const total=sizes=>sizes.reduce((sum,size)=>sum+size,0);
 const measured=(u,name,args,key)=>measure(db,u,name,args,key);
 // Listed elements stay within the budget unless one is listed alone; the response adds at most FRAMING bytes.
 const assertBounded=({bytes,sizes})=>{
  if(sizes.length>1) assert.ok(total(sizes)<=BUDGET,`elements of ${total(sizes)} bytes exceed the budget`);
  assert.ok(bytes<=Math.max(BUDGET,sizes[0]??0)+FRAMING,`response of ${bytes} bytes`);
 };
 // Pulls as the reader from `after` until scanned_through reaches the head, checking every page.
 const drain=async(after,limit)=>{
  const epoch=await epochOf(),pages=[];
  for(let cursor=after;;){
   const page=await measured(reader,'pull_changes',[w,cursor,limit,epoch],'changes'),{r}=page;
   assertBounded(page);
   assert.equal(r.reset_required,false);
   assert.ok(BigInt(r.scanned_through)>BigInt(cursor)||cursor===r.head,'every page advances');
   assert.equal(new Set(r.changes.map(c=>c.id)).size,r.changes.length,'one entry per document per response');
   // seq is the document's last journal row in the scanned range; the snapshot is its current revision.
   for(const c of r.changes) assert.deepEqual([c.seq,c.revision],[await lastSeq(c.id,cursor,r.scanned_through),await revisionOf(c.id)]);
   pages.push(page); cursor=r.scanned_through;
   if(cursor===r.head) return pages;
  }
 };
 await call(owner,'create_workspace',[w,'Budget']); await join(db,owner,w,reader,'viewer');
 // Ids sort A<B<C<D<H but are edited in the order C, A, H, D, B, so last-seq order differs from id order. H stays
 // owner-only (restricted right after creation); the others are shared by inheritance. Three maximal snapshots fit
 // the budget, four do not.
 const [A,B,C,D,H]=[201,202,203,204,205].map(uuid),order=[C,A,H,D,B];
 const [S,E,T]=[206,207,208].map(uuid),missing=uuid(299);
 let fill=0,op=3000;
 const edit=async(d,ciphertext,deleted=false)=>assert.equal((await call(owner,'push_document',[w,d,uuid(op++),await revisionOf(d),ciphertext,deleted])).status,'applied');
 for(const d of order){ await call(owner,'create_document',[w,d,null,'note',maximal(w,d,fill++)]); if(d===H) await setAcl(db,owner,'document',w,H,{[owner]:'editor'}); }
 for(let round=0;round<2;round++) for(const d of order) await edit(d,maximal(w,d,fill++));

 await t.test('round-robin edits: each document once per catch-up, the page cut just below the cut document',async()=>{
  const pages=await drain('0',100);
  // Last-seq order C, A, (H hidden), D, B: B does not fit beside three maximal snapshots.
  assert.deepEqual(pages.map(p=>p.r.changes.map(c=>c.id)),[[C,A,D],[B]]);
  assert.ok(total(pages[0].sizes)+pages[1].sizes[0]>BUDGET,'the cut was needed');
  // scanned_through stops just below B's last row, so no earlier row of B is skipped and nothing repeats.
  assert.equal(pages[0].r.scanned_through,String(BigInt(await lastSeq(B,'0',await headOf()))-1n));
 });

 await t.test('get_documents keeps the requested order, counts hidden and missing ids, and stops before the budget',async()=>{
  const epoch=await epochOf(),head=await headOf();
  const page=await measured(reader,'get_documents',[w,[H,C,missing,A,D,B],epoch],'documents');
  assertBounded(page);
  assert.deepEqual({restart_required:page.r.restart_required,ids:page.r.documents.map(d=>d.id),processed:page.r.processed,head:page.r.head},{restart_required:false,ids:[C,A,D],processed:5,head});
  // B was not processed; the next request starts with it.
  const rest=await measured(reader,'get_documents',[w,[B],epoch],'documents');
  assert.deepEqual({ids:rest.r.documents.map(d=>d.id),processed:rest.r.processed},{ids:[B],processed:1});
  assert.ok(total(page.sizes)+rest.sizes[0]>BUDGET,'the stop was needed');
  // The same snapshot pull_changes sends, without seq.
  const pulled=(await call(reader,'pull_changes',[w,'0',100,epoch])).changes.find(c=>c.id===C);
  const {seq,...snapshot}=pulled;
  assert.deepEqual(page.r.documents[0],snapshot);
 });

 await t.test('get_documents: tombstones, hidden ids, lower bounds, restarts and request validation',async()=>{
  for(const d of [S,E,T]) await call(owner,'create_document',[w,d,null,'note',cipher(w,d)]); // shared by inheritance
  await edit(T,cipher(w,T,1,'b'),true);
  const epoch=await epochOf(),head=await headOf();
  const request=(ids,u=reader,e=epoch)=>call(u,'get_documents',[w,ids,e]);
  const snapshot=async d=>(await db.query('select private.snapshot(x) s from app.documents x where workspace_id=$1 and id=$2',[w,d])).rows[0].s;
  const ok=(documents,processed)=>({restart_required:false,documents,processed,head,access_epoch:epoch});
  // Requested order kept; the tombstone is returned; hidden and missing ids are skipped but counted.
  assert.deepEqual(await request([E,H,T,missing,S]),ok([await snapshot(E),await snapshot(T),await snapshot(S)],5));
  assert.deepEqual((await request([T])).documents.map(({deleted,ciphertext,revision})=>({deleted,ciphertext,revision})),[{deleted:true,ciphertext:null,revision:'2'}]);
  // A hidden id and a missing id get the same answer.
  assert.deepEqual(await request([H]),ok([],1));
  assert.deepEqual(await request([missing]),ok([],1));
  // Array literals with other lower bounds are walked in storage order.
  assert.deepEqual(await request(`[0:1]={${E},${S}}`),ok([await snapshot(E),await snapshot(S)],2));
  assert.deepEqual(await request(`[5:6]={${S},${E}}`),ok([await snapshot(S),await snapshot(E)],2));
  // A missing, stale or non-canonical epoch restarts without reading.
  for(const stale of [null,'0',String(BigInt(epoch)+1n),`0${epoch}`]) assert.deepEqual(await request([S],reader,stale),{restart_required:true,documents:[],processed:0,head,access_epoch:epoch});
  // Subject, then membership (existing and missing workspaces alike).
  await assert.rejects(request([S],''),UNAUTHENTICATED);
  await assert.rejects(request([S],outsider),FORBIDDEN);
  await assert.rejects(call(reader,'get_documents',[uuid(999),[S],epoch]),FORBIDDEN);
  // [rejected p_ids, accepted twin]: 0 or 501 ids, a null element, a duplicate (also in another spelling) and a
  // nested JSON array, which arrives as a two-dimensional uuid[].
  const ids500=Array.from({length:500},(_,i)=>uuid(50000+i));
  const cases=[[null,[S]],['{}',[S]],[[],[S]],[[...ids500,S],ids500],[[S,null],[S]],[[S,S],[S]],[[S,S.toUpperCase()],[S]],[[[S],[E]],[S,E]]];
  for(const [invalid,twin] of cases){
   await assert.rejects(request(invalid),rejected('invalid_request'));
   const accepted=await request(twin);
   assert.deepEqual([accepted.restart_required,accepted.processed],[false,twin.length]);
  }
  // Membership is checked before p_ids, and p_ids before the epoch.
  await assert.rejects(request([S,S],outsider),FORBIDDEN);
  await assert.rejects(request([S,S],reader,'0'),rejected('invalid_request'));
 });

 await t.test('limit 500 over hundreds of maximal rows; hidden rows advance; an empty window keeps the cursor',async()=>{
  // 400 more rows inserted directly, cycling over the maximal documents: 320 visible maximal rows, more than the 256
  // that used to exceed the jsonb size limit (54000) when every row repeated its document's ciphertext.
  await db.query(`insert into app.journal(workspace_id,seq,document_id,snapshot,actor_id)
   select $1,x.head+g,($2::uuid[])[1+g%5],'{}',$3 from app.workspaces x,generate_series(1,400) g where x.id=$1`,[w,order,owner]);
  await db.query('update app.workspaces set head=head+400 where id=$1',[w]);
  assert.ok(Number(await headOf())<=500,'one window covers every row');
  const pages=await drain('0',500);
  const ids=pages.flatMap(p=>p.r.changes.map(c=>c.id));
  assert.deepEqual([...ids].sort(),[A,B,C,D,S,E,T].sort());
  assert.ok(pages.length>1,'the budget cut the window');
  // Two edits of the owner-only H: the reader gets no changes but the cursor moves over them.
  const before=await headOf();
  for(const value of ['c','d']) await edit(H,cipher(w,H,1,value));
  const epoch=await epochOf(),head=await headOf();
  const empty=scanned_through=>({reset_required:false,changes:[],scanned_through,head,access_epoch:epoch});
  assert.deepEqual(await call(reader,'pull_changes',[w,before,1,epoch]),empty(String(BigInt(before)+1n)));
  assert.deepEqual(await call(reader,'pull_changes',[w,before,500,epoch]),empty(head));
  assert.deepEqual(await call(reader,'pull_changes',[w,head,500,epoch]),empty(head));
 });

 await t.test('an element larger than the budget is returned alone and the cursor moves past it',async()=>{
  // cipher_ok caps RPC input near 1 MiB, so a snapshot above the budget exists only as a direct fixture: A gets a
  // 5 MiB ciphertext with the revision bump and journal row an RPC would write. The small S changes after it.
  const from=await headOf();
  await db.query(`update app.documents set ciphertext=jsonb_set(ciphertext,'{ciphertext}',to_jsonb(repeat('A',5242880))),revision=revision+1 where workspace_id=$1 and id=$2`,[w,A]);
  await db.query('update app.workspaces set head=head+1 where id=$1',[w]);
  await db.query(`insert into app.journal(workspace_id,seq,document_id,snapshot,actor_id) select $1,head,$2,'{}',$3 from app.workspaces where id=$1`,[w,A,owner]);
  await edit(S,cipher(w,S,1,'e'));
  const epoch=await epochOf();
  const first=await measured(reader,'pull_changes',[w,from,100,epoch],'changes');
  assertBounded(first);
  assert.ok(first.sizes[0]>BUDGET);
  assert.deepEqual({ids:first.r.changes.map(c=>c.id),scanned_through:first.r.scanned_through},{ids:[A],scanned_through:String(BigInt(from)+1n)});
  const second=await call(reader,'pull_changes',[w,first.r.scanned_through,100,epoch]);
  assert.deepEqual({ids:second.changes.map(c=>c.id),scanned_through:second.scanned_through},{ids:[S],scanned_through:second.head});
  // get_documents: alone when it comes first; not processed after another document.
  const alone=await measured(reader,'get_documents',[w,[A,S],epoch],'documents');
  assertBounded(alone);
  assert.deepEqual({ids:alone.r.documents.map(d=>d.id),processed:alone.r.processed},{ids:[A],processed:1});
  const after=await call(reader,'get_documents',[w,[S,A],epoch]);
  assert.deepEqual({ids:after.documents.map(d=>d.id),processed:after.processed},{ids:[S],processed:1});
 });

 await t.test('a maximal document edited 20 times: one delivery per catch-up, one per window when the limit splits the rows',async()=>{
  // Pages used to repeat the full ciphertext once per journal row: about 21 MB for these 20 rows.
  const M=uuid(209),edits=20,payloads=[];
  await call(owner,'create_document',[w,M,null,'note',maximal(w,M,fill++)]); // shared by inheritance
  const before=await headOf();
  for(let i=0;i<edits;i++){ payloads.push(maximal(w,M,fill++)); await edit(M,payloads.at(-1)); }
  const head=await headOf(),mid=String(BigInt(before)+10n);
  const current=(await db.query('select private.snapshot(x) s from app.documents x where workspace_id=$1 and id=$2',[w,M])).rows[0].s;
  assert.equal(BigInt(head)-BigInt(before),BigInt(edits));
  // The reader's catch-up from the cursor before the edits: one page with one element, the current snapshot at the last row.
  const pages=await drain(before,100);
  assert.deepEqual(pages.map(p=>({changes:p.r.changes,scanned_through:p.r.scanned_through})),[{changes:[{...current,seq:head}],scanned_through:head}]);
  assert.deepEqual(pages[0].r.changes[0].ciphertext,payloads.at(-1));
  // Limit 10 splits the rows into two windows: the current snapshot once per window, at the window's last row.
  const split=await drain(before,10);
  assert.deepEqual(split.map(p=>({changes:p.r.changes.map(c=>[c.id,c.seq,c.revision]),scanned_through:p.r.scanned_through})),
   [{changes:[[M,mid,current.revision]],scanned_through:mid},{changes:[[M,head,current.revision]],scanned_through:head}]);
  for(const p of [...pages,...split]) assert.ok(p.bytes<=BUDGET+160,`response of ${p.bytes} bytes`);
 });
});

// Boundaries need small budgets. This test's own database replaces private.page_budget() for one call at a time
// (CREATE OR REPLACE keeps its owner and grants) and restores the shipped definition in finally.
test('byte budget boundaries: the shipped 4 MiB, an exact fit, the first misfit ends the page, scanned_through below the cut',async(t)=>{
 const db=await database(); t.after(()=>db.close());
 const owner=uuid(1),reader=uuid(2);
 for(const id of [owner,reader]) await db.query('insert into auth.users values($1)',[id]);
 const call=(u,n,a)=>asUser(db,u,()=>rpc(db,n,a));
 const definition=async()=>(await db.query("select pg_get_functiondef('private.page_budget()'::regprocedure) d")).rows[0].d,shipped=await definition();
 const withBudget=async(budget,fn)=>{
  await db.exec(`create or replace function private.page_budget() returns integer language sql immutable set search_path=pg_catalog as $$ select ${budget} $$`);
  try { return await fn(); } finally { await db.exec(shipped); }
 };
 // Each subtest uses its own workspace, so its journal starts at seq 1; every document is shared with the reader.
 const workspace=async w=>{ await call(owner,'create_workspace',[w,'Boundary']); await join(db,owner,w,reader,'viewer'); };
 // Shared by inheritance (new documents have a NULL ACL).
 const shared=async(w,d,bytes=20)=>{ await call(owner,'create_document',[w,d,null,'note',{...cipher(w,d),ciphertext:Buffer.alloc(bytes,7).toString('base64')}]); };
 let op=4000;
 const edit=async(w,d)=>{ const {r}=(await db.query('select revision::text r from app.documents where workspace_id=$1 and id=$2',[w,d])).rows[0]; assert.equal((await call(owner,'push_document',[w,d,uuid(op++),r,cipher(w,d,1,'e')])).status,'applied'); };
 const epochOf=async w=>(await db.query('select access_epoch::text e from app.workspaces where id=$1',[w])).rows[0].e;
 // Element sizes under the shipped budget, exactly as each RPC returns the elements.
 const sizes=async(name,args,key)=>(await measure(db,reader,name,args,key)).sizes;

 await t.test('page_budget() is the specified 4 MiB',async()=>{
  assert.equal((await db.query('select private.page_budget() b')).rows[0].b,4194304);
 });

 await t.test('elements summing exactly to the budget fit and one byte less cuts, in pull_changes and get_documents',async()=>{
  const w=uuid(10),[A,B,C]=[201,202,203].map(uuid);
  await workspace(w); for(const d of [A,B,C]) await shared(w,d); // one journal row each: L(A)=1, L(B)=2, L(C)=3
  const epoch=await epochOf(w);
  // The budget counts each element as returned: a change with its seq key, a fetched snapshot without one.
  const pulled=await sizes('pull_changes',[w,'0',100,epoch],'changes'),fetched=await sizes('get_documents',[w,[A,B,C],epoch],'documents');
  const pull=async()=>{ const r=await call(reader,'pull_changes',[w,'0',100,epoch]); return [r.changes.map(c=>c.id),r.scanned_through]; };
  const get=async()=>{ const r=await call(reader,'get_documents',[w,[A,B,C],epoch]); return [r.documents.map(d=>d.id),r.processed]; };
  assert.deepEqual(await withBudget(pulled[0]+pulled[1],pull),[[A,B],'2']);
  assert.deepEqual(await withBudget(pulled[0]+pulled[1]-1,pull),[[A],'1']);
  assert.deepEqual(await withBudget(fetched[0]+fetched[1],get),[[A,B],2]);
  assert.deepEqual(await withBudget(fetched[0]+fetched[1]-1,get),[[A],1]);
 });

 await t.test('a document that does not fit ends the page even when a later, smaller one would fit',async()=>{
  const w=uuid(11),[big1,big2,small]=[211,212,213].map(uuid);
  await workspace(w); await shared(w,big1,3000); await shared(w,big2,3000); await shared(w,small); // L order big1, big2, small
  const epoch=await epochOf(w);
  const [p1,p2,p3]=await sizes('pull_changes',[w,'0',100,epoch],'changes'),[g1,g2,g3]=await sizes('get_documents',[w,[big1,big2,small],epoch],'documents');
  // big1 and big2 exceed the budget together; big1 and small fit, and so do big2 and small.
  const budget=p1+p3+16;
  assert.ok(p1+p2>budget&&p2+p3<=budget&&g1+g2>budget&&g1+g3<=budget,'fixture sizes');
  const first=await withBudget(budget,()=>call(reader,'pull_changes',[w,'0',100,epoch]));
  assert.deepEqual([first.changes.map(c=>c.id),first.scanned_through],[[big1],'1']);
  const second=await withBudget(budget,()=>call(reader,'pull_changes',[w,first.scanned_through,100,epoch]));
  assert.deepEqual([second.changes.map(c=>c.id),second.scanned_through],[[big2,small],second.head]);
  // get_documents stops at big2 too: small is not processed, so the caller asks for both again.
  const got=await withBudget(budget,()=>call(reader,'get_documents',[w,[big1,big2,small],epoch]));
  assert.deepEqual([got.documents.map(d=>d.id),got.processed],[[big1],1]);
 });

 await t.test("after a cut, scanned_through is the cut document's last seq minus one, not the last included seq",async()=>{
  const w=uuid(12),[x1,x2,x3]=[221,222,223].map(uuid);
  // Journal rows: x1 1, x3 2, x2 3, x3 4, so the visit order by last seq is x1 (1), x2 (3), x3 (4).
  await workspace(w); await shared(w,x1); await shared(w,x3); await shared(w,x2,3000); await edit(w,x3);
  const epoch=await epochOf(w),[s1]=await sizes('pull_changes',[w,'0',100,epoch],'changes');
  // x1 fits and x2 does not: scanned_through = L(x2)-1 = 2, above L(x1) = 1. Row 2 (x3) is passed over because x3
  // has a later row.
  const page=await withBudget(s1+100,()=>call(reader,'pull_changes',[w,'0',100,epoch]));
  assert.deepEqual([page.changes.map(c=>c.id),page.scanned_through],[[x1],'2']);
  // Under the shipped budget the next page delivers x2 and x3 (its current snapshot at row 4) and reaches the head.
  const rest=await call(reader,'pull_changes',[w,page.scanned_through,100,epoch]);
  assert.deepEqual([rest.changes.map(c=>[c.id,c.seq]),rest.scanned_through,rest.head],[[[x2,'3'],[x3,'4']],'4','4']);
 });
 assert.equal(await definition(),shipped);
});

// JSON timestamps: UTC with microseconds (private.utc_text).
const TIMESTAMP=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
// Everything a collaboration RPC can change in workspace w, plus signal generations per user.
const workspaceState=async(db,w)=>({
 epoch:(await db.query('select access_epoch::text e from app.workspaces where id=$1',[w])).rows[0].e,
 pending:(await db.query('select pending_owner_id p from app.workspaces where id=$1',[w])).rows[0].p,
 members:(await db.query('select user_id,role from app.members where workspace_id=$1 order by user_id',[w])).rows,
 invitations:(await db.query('select user_id,role from app.invitations where workspace_id=$1 order by user_id',[w])).rows,
 acls:(await db.query('select id,acl,acl_version::text v from app.folders where workspace_id=$1 union all select id,acl,acl_version::text from app.documents where workspace_id=$1 order by 1',[w])).rows,
 signals:Object.fromEntries((await db.query('select user_id,generation from app.user_signals where workspace_id=$1',[w])).rows.map(s=>[s.user_id,BigInt(s.generation)])),
 audit:(await db.query('select count(*)::int n from app.audit where workspace_id=$1',[w])).rows[0].n,
});
const bumped=(signals,users=Object.keys(signals))=>({...signals,...Object.fromEntries(users.map(u=>[u,(signals[u]??0n)+1n]))});

test('collaboration: inheritance, member-only ACL keys, compare-and-set, invitations, leaving and ownership',async(t)=>{
 const db=await database(); t.after(()=>db.close());
 // The viewer's id has hex letters, so ACL keys can differ from it in case.
 const owner=uuid(1),editor=uuid(2),viewer='abcdef00-0000-4000-8000-0000000000ab',stranger=uuid(4),unknown=uuid(5),w=uuid(10),missing=uuid(11);
 // `unknown` is never inserted into auth.users.
 for(const id of [owner,editor,viewer,stranger]) await db.query('insert into auth.users values($1)',[id]);
 const call=(u,n,a)=>asUser(db,u,()=>rpc(db,n,a));
 const state=()=>workspaceState(db,w);
 const lastAudit=async()=>(await db.query('select action,actor_id,target_id from app.audit where workspace_id=$1 order by id desc limit 1',[w])).rows[0];
 const rankOf=(u,kind,id)=>withIdentity(db,u,async()=>(await db.query(`select private.${kind}_rank($1,$2) r`,[w,id])).rows[0].r);
 const versionOf=async(kind,id)=>(await db.query(`select acl_version::text v from app.${kind==='folder'?'folders':'documents'} where workspace_id=$1 and id=$2`,[w,id])).rows[0].v;
 await call(owner,'create_workspace',[w,'Team']);
 await join(db,owner,w,editor,'editor'); await join(db,owner,w,viewer,'viewer');

 await t.test('folders and documents inherit; an ACL given to create_folder restricts at once; ACL keys are normalised members (F01, F15)',async()=>{
  const [F1,F2,F3,F4,d]=[20,21,22,23,30].map(uuid),before=await state();
  assert.deepEqual(await call(owner,'create_folder',[w,F1,null]),{id:F1,acl_version:'1'});
  assert.deepEqual(await call(owner,'create_folder',[w,F2,F1]),{id:F2,acl_version:'1'});
  // An empty new folder changes nobody's access: no epoch bump, one audit row each, and a signal so members refetch.
  const created=await state();
  assert.deepEqual({epoch:created.epoch,audit:created.audit,signals:created.signals},{epoch:before.epoch,audit:before.audit+2,signals:bumped(bumped(before.signals))});
  assert.deepEqual(created.acls,[{id:F1,acl:null,v:'1'},{id:F2,acl:null,v:'1'}]);
  await call(editor,'create_document',[w,d,F2,'note',cipher(w,d)]);
  // The workspace role caps the rank through the inherited chain.
  assert.deepEqual([await rankOf(viewer,'document',d),await rankOf(editor,'document',d),await rankOf(owner,'document',d)],[1,2,2]);
  assert.deepEqual(await call(viewer,'list_folders',[w]),{folders:[{id:F1,parent_id:null,can_edit:false},{id:F2,parent_id:F1,can_edit:false}],next_id:null});
  assert.deepEqual((await call(editor,'list_folders',[w])).folders.map(x=>x.can_edit),[true,true]);
  // An ACL in create_folder restricts the folder in the same call; keys are stored in the canonical spelling.
  assert.deepEqual(await call(owner,'create_folder',[w,F3,null,{[viewer.toUpperCase()]:'viewer',[`{${owner}}`]:'editor'}]),{id:F3,acl_version:'1'});
  assert.deepEqual((await db.query('select acl from app.folders where workspace_id=$1 and id=$2',[w,F3])).rows[0].acl,{[viewer]:'viewer',[owner]:'editor'});
  assert.equal((await state()).epoch,before.epoch);
  assert.deepEqual((await call(editor,'list_folders',[w])).folders.map(x=>x.id),[F1,F2]);
  assert.deepEqual((await call(viewer,'list_folders',[w])).folders.map(x=>[x.id,x.can_edit]),[[F1,false],[F2,false],[F3,false]]);
  // Malformed ACLs and keys that name no current member are refused before anything is written.
  const unchanged=await state();
  for(const [acl,reason] of [[{[stranger]:'viewer'},'member_not_found'],[{[unknown]:'viewer'},'member_not_found'],[{[owner]:'owner'},'invalid_acl'],
   [{[viewer]:'viewer',[viewer.toUpperCase()]:'editor'},'invalid_acl'],[[],'invalid_acl']]) await assert.rejects(call(owner,'create_folder',[w,F4,null,acl]),rejected(reason));
  assert.deepEqual(await state(),unchanged);
  // Restricting a parent hides its whole subtree, documents included; the editor's folder list becomes empty ([]).
  await setAcl(db,owner,'folder',w,F1,{[owner]:'editor'});
  assert.deepEqual((await call(viewer,'list_folders',[w])).folders.map(x=>x.id),[F3]);
  assert.deepEqual(await call(editor,'list_folders',[w]),{folders:[],next_id:null});
  assert.equal((await call(editor,'list_accessible_documents',[w])).documents.some(x=>x.id===d),false);
  assert.deepEqual([await rankOf(editor,'folder',F2),await rankOf(editor,'document',d)],[0,0]);
  await setAcl(db,owner,'folder',w,F1,null);
 });

 await t.test('ACL edits are compare-and-set: a stale version is refused, an equal ACL is a no-op at any version (F02)',async()=>{
  const d=uuid(31);
  await call(editor,'create_document',[w,d,null,'note',cipher(w,d)]);
  assert.deepEqual(await call(owner,'get_acl',[w,'document',d]),{id:d,acl:null,acl_version:'1'});
  // Two owner sessions edit from version 1: the first wins, the second is refused and writes nothing.
  const first=await call(owner,'set_document_acl',[w,d,{[editor]:'editor',[owner]:'editor'},'1']);
  assert.deepEqual([first.changed,first.acl_version],[true,'2']);
  const before=await state();
  await assert.rejects(call(owner,'set_document_acl',[w,d,{[viewer]:'viewer'},'1']),rejected('acl_version_mismatch'));
  // Well formed but above any stored version: a mismatch, not a format error. Malformed versions are invalid_request.
  await assert.rejects(call(owner,'set_document_acl',[w,d,{[viewer]:'viewer'},'9223372036854775807']),rejected('acl_version_mismatch'));
  for(const version of ['0','01','-1','1.0',' 1','',null,'9223372036854775808','1'.repeat(20)]) await assert.rejects(call(owner,'set_document_acl',[w,d,{[viewer]:'viewer'},version]),rejected('invalid_request'));
  await assert.rejects(call(owner,'set_folder_acl',[w,uuid(20),{[viewer]:'viewer'},'x']),rejected('invalid_request'));
  assert.deepEqual(await state(),before);
  // The winner's retry (same ACL, its now stale version) is answered unchanged.
  assert.deepEqual(await call(owner,'set_document_acl',[w,d,{[owner]:'editor',[editor]:'editor'},'1']),{access_epoch:before.epoch,changed:false,acl_version:'2'});
  assert.deepEqual(await state(),before);
  assert.deepEqual(await call(owner,'get_acl',[w,'document',d]),{id:d,acl:{[editor]:'editor',[owner]:'editor'},acl_version:'2'});
  // Folders follow the same rule (F1 of the first subtest is back to inherit at version 3).
  const F1=uuid(20);
  assert.deepEqual(await call(owner,'get_acl',[w,'folder',F1]),{id:F1,acl:null,acl_version:'3'});
  await assert.rejects(call(owner,'set_folder_acl',[w,F1,{[viewer]:'viewer'},'2']),rejected('acl_version_mismatch'));
  assert.deepEqual(await call(owner,'set_folder_acl',[w,F1,null,'2']),{access_epoch:before.epoch,changed:false,acl_version:'3'});
  assert.deepEqual(await state(),before);
  // get_acl: the kind is checked after the owner check, then the target.
  for(const kind of ['bad','Folder',null]) await assert.rejects(call(owner,'get_acl',[w,kind,d]),rejected('invalid_request'));
  await assert.rejects(call(owner,'get_acl',[w,'folder',d]),rejected('folder_not_found'));
  await assert.rejects(call(owner,'get_acl',[w,'document',uuid(39)]),rejected('document_not_found'));
  await assert.rejects(call(editor,'get_acl',[w,'document',d]),FORBIDDEN);
 });

 await t.test('invitations: invite, change, revoke, decline and accept; any uuid is accepted; only acceptance changes access (F13)',async()=>{
  const before=await state();
  assert.deepEqual(await call(owner,'invite_member',[w,stranger,'viewer']),{changed:true});
  let s=await state();
  // No epoch bump; one audit row; every member and the invitee are signalled.
  assert.deepEqual({epoch:s.epoch,invitations:s.invitations,audit:s.audit,signals:s.signals},
   {epoch:before.epoch,invitations:[{user_id:stranger,role:'viewer'}],audit:before.audit+1,signals:bumped(before.signals,[owner,editor,viewer,stranger])});
  assert.deepEqual(await lastAudit(),{action:'invite_member',actor_id:owner,target_id:stranger});
  // The same invitation again writes nothing; another role updates it.
  assert.deepEqual(await call(owner,'invite_member',[w,stranger,'viewer']),{changed:false});
  assert.deepEqual(await state(),s);
  assert.deepEqual(await call(owner,'invite_member',[w,stranger,'editor']),{changed:true});
  // An id without an account gets the same answers, so inviting reveals nothing about accounts (it gets no signal row).
  assert.deepEqual(await call(owner,'invite_member',[w,unknown,'viewer']),{changed:true});
  assert.deepEqual(await call(owner,'invite_member',[w,unknown,'viewer']),{changed:false});
  assert.deepEqual(await call(owner,'invite_member',[w,unknown,null]),{changed:true});
  assert.deepEqual(await call(owner,'invite_member',[w,unknown,null]),{changed:false});
  assert.equal((await state()).signals[unknown],undefined);
  // Refusals, each without side effects.
  s=await state();
  for(const [args,reason] of [[[w,editor,'viewer'],'already_member'],[[w,owner,'viewer'],'already_member'],[[w,stranger,'owner'],'invalid_role'],
   [[w,stranger,'Viewer'],'invalid_role'],[[w,null,'viewer'],'invalid_request']]) await assert.rejects(call(owner,'invite_member',args),rejected(reason));
  for(const caller of [editor,stranger]) await assert.rejects(call(caller,'invite_member',[w,stranger,'viewer']),FORBIDDEN);
  assert.deepEqual(await state(),s);
  // The owner's list of pending invitations and the invitee's own.
  const listed=await call(owner,'list_invitations',[w]);
  assert.deepEqual(listed.invitations.map(({user_id,role})=>({user_id,role})),[{user_id:stranger,role:'editor'}]);
  assert.match(listed.invitations[0].invited_at,TIMESTAMP);
  assert.deepEqual({next_id:listed.next_id,pending_owner_id:listed.pending_owner_id},{next_id:null,pending_owner_id:null});
  assert.deepEqual((await call(stranger,'list_my_invitations',[])).invitations.map(({workspace_id,name,role,invited_at})=>({workspace_id,name,role,invited_at})),
   [{workspace_id:w,name:'Team',role:'editor',invited_at:listed.invitations[0].invited_at}]);
  // Decline: the invitation goes and the invitee is signalled; a retry is forbidden (no invitation, no membership).
  assert.deepEqual(await call(stranger,'respond_invitation',[w,false]),{changed:true,role:null,access_epoch:s.epoch});
  assert.deepEqual(await lastAudit(),{action:'decline_invitation',actor_id:stranger,target_id:stranger});
  await assert.rejects(call(stranger,'respond_invitation',[w,false]),FORBIDDEN);
  assert.deepEqual(await call(stranger,'list_my_invitations',[]),{invitations:[],next_id:null});
  // Revoke: changed only while one is pending; a revoked invitee cannot answer.
  await call(owner,'invite_member',[w,stranger,'viewer']);
  assert.deepEqual(await call(owner,'invite_member',[w,stranger,null]),{changed:true});
  assert.deepEqual(await lastAudit(),{action:'revoke_invitation',actor_id:owner,target_id:stranger});
  assert.deepEqual(await call(owner,'invite_member',[w,stranger,null]),{changed:false});
  await assert.rejects(call(stranger,'respond_invitation',[w,true]),FORBIDDEN);
  // Accept: membership with the invited role and one epoch bump; retries are answered unchanged.
  await call(owner,'invite_member',[w,stranger,'viewer']);
  await assert.rejects(call(stranger,'respond_invitation',[w,null]),rejected('invalid_request'));
  const pre=await state();
  assert.deepEqual(await call(stranger,'respond_invitation',[w,true]),{changed:true,role:'viewer',access_epoch:String(BigInt(pre.epoch)+1n)});
  const post=await state();
  assert.deepEqual({invitations:post.invitations,members:post.members.filter(m=>m.user_id===stranger),audit:post.audit},{invitations:[],members:[{user_id:stranger,role:'viewer'}],audit:pre.audit+1});
  assert.deepEqual(await lastAudit(),{action:'accept_invitation',actor_id:stranger,target_id:stranger});
  for(const accept of [true,false]) assert.deepEqual(await call(stranger,'respond_invitation',[w,accept]),{changed:false,role:'viewer',access_epoch:post.epoch});
  await assert.rejects(call(stranger,'respond_invitation',[w,null]),rejected('invalid_request'));
  assert.deepEqual(await state(),post);
 });

 await t.test('leaving: once per membership, never by the owner; removal strips ACL keys and re-joining does not revive them (F12)',async()=>{
  const F=uuid(24),d=uuid(32),open=uuid(33);
  await call(owner,'create_folder',[w,F,null,{[stranger]:'viewer',[owner]:'editor'}]);
  await call(owner,'create_document',[w,d,F,'note',cipher(w,d)]); await call(owner,'create_document',[w,open,null,'note',cipher(w,open)]);
  await setAcl(db,owner,'document',w,d,{[stranger]:'viewer',[owner]:'editor'});
  assert.equal(await rankOf(stranger,'document',d),1);
  const [vf,vd]=[await versionOf('folder',F),await versionOf('document',d)];
  await assert.rejects(call(owner,'leave_workspace',[w]),rejected('owner_must_transfer'));
  const before=await state();
  assert.deepEqual(await call(stranger,'leave_workspace',[w]),{changed:true,access_epoch:String(BigInt(before.epoch)+1n)});
  const after=await state();
  // Keys naming the leaver are gone with a version bump, so a stale owner copy cannot put them back; NULL stays NULL.
  assert.deepEqual(after.acls.filter(a=>[F,d,open].includes(a.id)),[
   {id:F,acl:{[owner]:'editor'},v:String(BigInt(vf)+1n)},{id:d,acl:{[owner]:'editor'},v:String(BigInt(vd)+1n)},{id:open,acl:null,v:'1'}]);
  await assert.rejects(call(owner,'set_document_acl',[w,d,{[stranger]:'viewer',[owner]:'editor'},vd]),rejected('acl_version_mismatch'));
  await assert.rejects(call(owner,'set_folder_acl',[w,F,{[stranger]:'viewer',[owner]:'editor'},vf]),rejected('acl_version_mismatch'));
  assert.deepEqual(await state(),after);
  assert.deepEqual({audit:after.audit,signals:after.signals},{audit:before.audit+1,signals:bumped(before.signals)});
  assert.deepEqual(await lastAudit(),{action:'leave_workspace',actor_id:stranger,target_id:stranger});
  await assert.rejects(call(stranger,'leave_workspace',[w]),FORBIDDEN);
  await assert.rejects(call(stranger,'list_members',[w]),FORBIDDEN);
  // Re-joining starts from inherited access only: the earlier grants do not come back.
  await join(db,owner,w,stranger,'viewer');
  assert.deepEqual([await rankOf(stranger,'folder',F),await rankOf(stranger,'document',d),await rankOf(stranger,'document',open)],[0,0,1]);
  // Removal by the owner (set_member with a null role) strips keys the same way.
  await setAcl(db,owner,'document',w,open,{[stranger]:'editor',[owner]:'editor'});
  assert.equal((await call(owner,'set_member',[w,stranger,null])).changed,true);
  assert.deepEqual(await call(owner,'get_acl',[w,'document',open]),{id:open,acl:{[owner]:'editor'},acl_version:'3'});
 });

 await t.test('ownership: offer, cancel and accept; a role change withdraws the offer; access changes only on acceptance',async()=>{
  const before=await state();
  for(const [args,reason] of [[[w,owner],'owner_change_not_supported'],[[w,stranger],'member_not_found'],[[w,unknown],'member_not_found']]) await assert.rejects(call(owner,'offer_ownership',args),rejected(reason));
  await assert.rejects(call(editor,'offer_ownership',[w,editor]),FORBIDDEN);
  assert.deepEqual(await call(owner,'offer_ownership',[w,null]),{changed:false,pending_owner_id:null});
  assert.deepEqual(await state(),before);
  assert.deepEqual(await call(owner,'offer_ownership',[w,editor]),{changed:true,pending_owner_id:editor});
  const offered=await state();
  assert.deepEqual({epoch:offered.epoch,pending:offered.pending,audit:offered.audit},{epoch:before.epoch,pending:editor,audit:before.audit+1});
  assert.deepEqual(await lastAudit(),{action:'offer_ownership',actor_id:owner,target_id:editor});
  assert.deepEqual(await call(owner,'offer_ownership',[w,editor]),{changed:false,pending_owner_id:editor});
  assert.deepEqual(await state(),offered);
  assert.equal((await call(owner,'list_invitations',[w])).pending_owner_id,editor);
  assert.deepEqual((await call(editor,'list_my_workspaces',[])).workspaces.map(x=>x.ownership_offered),[true]);
  assert.deepEqual((await call(viewer,'list_my_workspaces',[])).workspaces.map(x=>x.ownership_offered),[false]);
  for(const caller of [viewer,stranger]) await assert.rejects(call(caller,'accept_ownership',[w]),FORBIDDEN);
  // Cancelling withdraws it.
  assert.deepEqual(await call(owner,'offer_ownership',[w,null]),{changed:true,pending_owner_id:null});
  assert.deepEqual(await lastAudit(),{action:'offer_ownership',actor_id:owner,target_id:null});
  await assert.rejects(call(editor,'accept_ownership',[w]),FORBIDDEN);
  // A later role change of the offeree withdraws the offer too: the owner's latest decision wins.
  await call(owner,'offer_ownership',[w,viewer]);
  await call(owner,'set_member',[w,viewer,'editor']);
  assert.equal((await state()).pending,null);
  assert.deepEqual((await db.query('select action,target_id from app.audit where workspace_id=$1 order by id desc limit 2',[w])).rows,[{action:'set_member',target_id:viewer},{action:'offer_ownership',target_id:null}]);
  await assert.rejects(call(viewer,'accept_ownership',[w]),FORBIDDEN);
  await call(owner,'set_member',[w,viewer,'viewer']);
  // Accepting swaps the roles with one epoch bump; the old owner stays as an editor; a retry changes nothing.
  await call(owner,'offer_ownership',[w,editor]);
  const pre=await state();
  assert.deepEqual(await call(editor,'accept_ownership',[w]),{changed:true,access_epoch:String(BigInt(pre.epoch)+1n)});
  const post=await state();
  assert.deepEqual({members:post.members,pending:post.pending},{members:[{user_id:owner,role:'editor'},{user_id:editor,role:'owner'},{user_id:viewer,role:'viewer'}],pending:null});
  assert.deepEqual(await lastAudit(),{action:'transfer_ownership',actor_id:editor,target_id:editor});
  assert.deepEqual(await call(editor,'accept_ownership',[w]),{changed:false,access_epoch:post.epoch});
  assert.deepEqual(await state(),post);
  // The old owner lost the owner RPCs; the new owner hands the workspace back.
  await assert.rejects(call(owner,'invite_member',[w,stranger,'viewer']),FORBIDDEN);
  await call(editor,'offer_ownership',[w,owner]); await call(owner,'accept_ownership',[w]);
  assert.deepEqual((await state()).members,[{user_id:owner,role:'owner'},{user_id:editor,role:'editor'},{user_id:viewer,role:'viewer'}]);
 });

 await t.test('list RPCs: shapes, keyset pages by id, [] for empty lists, and limits',async()=>{
  const w2=uuid(12),excluded=uuid(34);
  await call(viewer,'create_workspace',[w2,'Second']);
  const mine=await call(viewer,'list_my_workspaces',[]);
  assert.deepEqual(mine,{workspaces:[{id:w,name:'Team',role:'viewer',member_count:3,ai_enabled:false,ownership_offered:false},
   {id:w2,name:'Second',role:'owner',member_count:1,ai_enabled:false,ownership_offered:false}],next_id:null});
  assert.deepEqual(await call(viewer,'list_my_workspaces',[null,1]),{workspaces:[mine.workspaces[0]],next_id:w});
  assert.deepEqual(await call(viewer,'list_my_workspaces',[w,1]),{workspaces:[mine.workspaces[1]],next_id:null});
  assert.deepEqual(await call(stranger,'list_my_workspaces',[]),{workspaces:[],next_id:null});
  // Members by user id, with the epoch they are valid for.
  const members=await call(viewer,'list_members',[w]);
  assert.deepEqual(members,{members:[{user_id:owner,role:'owner'},{user_id:editor,role:'editor'},{user_id:viewer,role:'viewer'}],next_id:null,access_epoch:(await state()).epoch});
  assert.deepEqual(await call(viewer,'list_members',[w,null,2]),{...members,members:members.members.slice(0,2),next_id:editor});
  assert.deepEqual(await call(viewer,'list_members',[w,editor,2]),{...members,members:members.members.slice(2)});
  assert.deepEqual(await call(viewer,'list_members',[w,viewer]),{...members,members:[]});
  // Empty lists are [] (never null).
  assert.deepEqual(await call(viewer,'list_invitations',[w2]),{invitations:[],next_id:null,pending_owner_id:null});
  assert.deepEqual(await call(viewer,'list_folders',[w2]),{folders:[],next_id:null});
  for(const kind of ['folder','document']) assert.deepEqual(await call(viewer,'list_acls',[w2,kind]),{entries:[],next_id:null});
  assert.deepEqual(await call(viewer,'list_trash',[w2]),{documents:[],next_id:null,head:'0',access_epoch:'1'});
  assert.deepEqual(await call(viewer,'list_my_invitations',[]),{invitations:[],next_id:null});
  // list_acls: every row with its ACL and version, including a document whose ACL leaves the owner out; no content.
  await call(editor,'create_document',[w,excluded,null,'note',cipher(w,excluded)]); await setAcl(db,owner,'document',w,excluded,{[editor]:'editor'});
  assert.equal((await call(owner,'list_accessible_documents',[w])).documents.some(x=>x.id===excluded),false);
  const folders=(await db.query('select id,parent_id,acl,acl_version::text acl_version from app.folders where workspace_id=$1 order by id',[w])).rows;
  const documents=(await db.query(`select id,folder_id,deleted,private.utc_text(deleted_at) deleted_at,deleted and ciphertext is null purged,acl,acl_version::text acl_version
   from app.documents where workspace_id=$1 order by id`,[w])).rows;
  assert.ok(documents.some(x=>x.id===excluded));
  assert.deepEqual(await call(owner,'list_acls',[w,'folder']),{entries:folders,next_id:null});
  assert.deepEqual(await call(owner,'list_acls',[w,'document']),{entries:documents,next_id:null});
  for(const [kind,rows] of [['folder',folders],['document',documents]]){
   const page=await call(owner,'list_acls',[w,kind,null,2]);
   assert.deepEqual(page,{entries:rows.slice(0,2),next_id:rows[1].id});
   assert.deepEqual(await call(owner,'list_acls',[w,kind,page.next_id,500]),{entries:rows.slice(2),next_id:null});
  }
  // Folder pages: only folders the caller can see (F3 is the viewer's; F leaves it out since it left).
  const visibleFolders=(await call(viewer,'list_folders',[w])).folders;
  assert.deepEqual(visibleFolders.map(x=>x.id),[uuid(20),uuid(21),uuid(22)]);
  assert.deepEqual(await call(viewer,'list_folders',[w,null,2]),{folders:visibleFolders.slice(0,2),next_id:uuid(21)});
  assert.deepEqual(await call(viewer,'list_folders',[w,uuid(21),2]),{folders:visibleFolders.slice(2),next_id:null});
  // Invitation pages by user id (an invitee without an account is listed like any other).
  for(const invitee of [stranger,unknown]) await call(viewer,'invite_member',[w2,invitee,'viewer']);
  const invited=await call(viewer,'list_invitations',[w2,null,1]);
  assert.deepEqual([invited.invitations.map(x=>x.user_id),invited.next_id],[[stranger],stranger]);
  assert.deepEqual((({invitations,next_id})=>[invitations.map(x=>[x.user_id,x.role]),next_id])(await call(viewer,'list_invitations',[w2,stranger,1])),[[[unknown,'viewer']],null]);
  for(const invitee of [stranger,unknown]) await call(viewer,'invite_member',[w2,invitee,null]);
  await assert.rejects(call(owner,'list_acls',[w,'bad']),rejected('invalid_request'));
  await assert.rejects(call(editor,'list_acls',[w,'folder']),FORBIDDEN);
  // Limits 1..500 (checked after access); the caller's own lists need a subject.
  for(const [u,name,args] of [[viewer,'list_my_workspaces',[]],[viewer,'list_my_invitations',[]],[viewer,'list_members',[w]],[owner,'list_invitations',[w]],
   [viewer,'list_folders',[w]],[owner,'list_acls',[w,'folder']],[viewer,'list_trash',[w]]]){
   for(const limit of [0,-1,501,null]) await assert.rejects(call(u,name,[...args,null,limit]),rejected('invalid_limit'),name);
   for(const limit of [1,500]) assert.equal(typeof await call(u,name,[...args,null,limit]),'object');
  }
  for(const name of ['list_my_workspaces','list_my_invitations']) await assert.rejects(call('',name,[]),UNAUTHENTICATED);
 });

 await t.test('every new workspace RPC answers a non-member forbidden, for existing and missing workspaces alike',async()=>{
  // Arguments that would fail validation (null answers, bad kinds, malformed ACLs and versions) must not reveal the workspace.
  const x=uuid(40);
  const cases=id=>[['invite_member',[id,editor,'viewer']],['invite_member',[id,null,'bad']],['respond_invitation',[id,true]],['respond_invitation',[id,null]],
   ['leave_workspace',[id]],['offer_ownership',[id,null]],['offer_ownership',[id,stranger]],['accept_ownership',[id]],['set_member',[id,stranger,'viewer']],
   ['list_members',[id,null,0]],['list_invitations',[id,null,0]],['create_folder',[id,x,null,[]]],['list_folders',[id,null,0]],
   ['set_folder_acl',[id,x,[],'x']],['set_document_acl',[id,x,[],'x']],['get_acl',[id,'bad',x]],['list_acls',[id,'bad']],
   ['restore_document',[id,x,null,'x']],['list_trash',[id,null,0]],['set_ai_enabled',[id,null]]];
  assert.deepEqual((await state()).members.some(m=>m.user_id===stranger),false);
  for(const id of [w,missing]) for(const [name,args] of cases(id)){
   await assert.rejects(call(stranger,name,args),FORBIDDEN,`${name} ${id}`);
   await assert.rejects(call('',name,args),UNAUTHENTICATED,`${name} ${id}`);
  }
 });

 await t.test('the AI switch is off by default and only the owner flips it, without an epoch bump (F29 minimum)',async()=>{
  assert.equal((await db.query('select ai_enabled from app.workspaces where id=$1',[w])).rows[0].ai_enabled,false);
  const before=await state();
  await assert.rejects(call(editor,'set_ai_enabled',[w,true]),FORBIDDEN);
  await assert.rejects(call(owner,'set_ai_enabled',[w,null]),rejected('invalid_request'));
  assert.deepEqual(await call(owner,'set_ai_enabled',[w,false]),{ai_enabled:false,changed:false});
  assert.deepEqual(await state(),before);
  assert.deepEqual(await call(owner,'set_ai_enabled',[w,true]),{ai_enabled:true,changed:true});
  const after=await state();
  assert.deepEqual({epoch:after.epoch,audit:after.audit,signals:after.signals},{epoch:before.epoch,audit:before.audit+1,signals:bumped(before.signals,[owner,editor,viewer])});
  assert.deepEqual(await lastAudit(),{action:'set_ai_enabled',actor_id:owner,target_id:null});
  assert.equal((await call(viewer,'list_my_workspaces',[])).workspaces.find(x=>x.id===w).ai_enabled,true);
  assert.deepEqual(await call(owner,'set_ai_enabled',[w,true]),{ai_enabled:true,changed:false});
  assert.deepEqual(await state(),after);
 });

 await t.test('create_document with its own op id: the receipt is keyed by it, and calls resolve by parameter name (F20)',async()=>{
  const d=uuid(35),op=uuid(36);
  const args={p_workspace_id:w,p_document_id:d,p_folder_id:null,p_kind:'agenda',p_ciphertext:cipher(w,d),p_key_epoch:1,p_op_id:op};
  const receipt=await asUser(db,editor,()=>rpcNamed(db,'create_document',args));
  assert.deepEqual(receipt,{op_id:op,document_id:d,status:'applied',revision:'1',head:receipt.head});
  assert.deepEqual(await asUser(db,editor,()=>rpcNamed(db,'create_document',args)),receipt);
  assert.deepEqual((await db.query('select op_id from app.receipts where workspace_id=$1 and actor_id=$2 and op_id in ($3,$4)',[w,editor,op,d])).rows,[{op_id:op}]);
  // The op id namespace is shared with push: another request under it is op_id_reused.
  await assert.rejects(call(editor,'push_document',[w,d,op,'1',cipher(w,d)]),rejected('op_id_reused'));
  // A parameter name the function does not have is not matched by position, as with PostgREST.
  await assert.rejects(asUser(db,editor,()=>rpcNamed(db,'create_document',{...args,p_doc_id:d})),{code:'42883'});
 });
});

test('trash: a delete keeps the content for editors, restore within 720 hours, purge as sync_maintainer (F27, C101)',async(t)=>{
 const db=await database(); t.after(()=>db.close());
 const owner=uuid(1),editor=uuid(2),viewer=uuid(3),w=uuid(10),w2=uuid(11);
 for(const id of [owner,editor,viewer]) await db.query('insert into auth.users values($1)',[id]);
 const call=(u,n,a)=>asUser(db,u,()=>rpc(db,n,a));
 const asMaintainer=fn=>inTransaction(db,['set local role sync_maintainer'],fn);
 const row=async(id,ws=w)=>(await db.query('select ciphertext,deleted,deleted_at,revision::text revision from app.documents where workspace_id=$1 and id=$2',[ws,id])).rows[0];
 const headOf=async(ws=w)=>(await db.query('select head::text h from app.workspaces where id=$1',[ws])).rows[0].h;
 const count=async(sql,params)=>(await db.query(`select count(*)::int n from ${sql}`,params)).rows[0].n;
 // Fixture: moves a deletion time back directly (SQL has no clock control).
 const deletedAgo=(id,hours,ws=w)=>db.query("update app.documents set deleted_at=clock_timestamp()-make_interval(hours=>$3) where workspace_id=$1 and id=$2",[ws,id,hours]);
 let opCounter=100; const nextOp=()=>uuid(opCounter++);
 await call(owner,'create_workspace',[w,'Trash']); await join(db,owner,w,editor,'editor'); await join(db,owner,w,viewer,'viewer');
 const [d,e,f]=[20,21,22].map(uuid),content=cipher(w,d,1,'c');
 await call(editor,'create_document',[w,d,null,'note',cipher(w,d)]);
 await call(editor,'push_document',[w,d,nextOp(),'1',content]); // revision 2

 await t.test('a delete moves the document to the trash and keeps its stored content; clients still read a tombstone',async()=>{
  const opDel=nextOp(),request=cipher(w,d,1,'z');
  const receipt=await call(editor,'push_document',[w,d,opDel,'2',request,true]);
  assert.deepEqual([receipt.status,receipt.revision],['applied','3']);
  const stored=await row(d);
  // The delete request's ciphertext is validated and hashed, never stored: a deleter cannot plant trash content.
  assert.deepEqual({ciphertext:stored.ciphertext,deleted:stored.deleted,revision:stored.revision},{ciphertext:content,deleted:true,revision:'3'});
  assert.ok(stored.deleted_at instanceof Date);
  const epoch=(await call(viewer,'list_accessible_documents',[w])).access_epoch;
  assert.deepEqual((await call(viewer,'get_documents',[w,[d],epoch])).documents.map(x=>[x.deleted,x.ciphertext,x.revision]),[[true,null,'3']]);
  assert.deepEqual((await call(viewer,'pull_changes',[w,'0',100,epoch])).changes.map(x=>[x.id,x.deleted,x.ciphertext]),[[d,true,null]]);
  // The delete's replay gets its receipt; any other push gets 'deleted' at the current revision, even a stale one.
  assert.deepEqual(await call(editor,'push_document',[w,d,opDel,'2',request,true]),receipt);
  for(const [base,deleted] of [['3',false],['3',true],['2',false]]) assert.deepEqual((({status,revision})=>[status,revision])(await call(editor,'push_document',[w,d,nextOp(),base,content,deleted])),['deleted','3']);
  assert.deepEqual(await row(d),stored);
 });

 await t.test('list_trash shows restorable entries with their content to editors only, by id, within the byte budget',async()=>{
  const times=(await db.query("select private.utc_text(deleted_at) a,private.utc_text(deleted_at+interval '720 hours') p from app.documents where workspace_id=$1 and id=$2",[w,d])).rows[0];
  const listed=await call(editor,'list_trash',[w]);
  assert.deepEqual(listed,{documents:[{id:d,folder_id:null,kind:'note',key_epoch:1,revision:'3',deleted_at:times.a,purge_after:times.p,ciphertext:content}],
   next_id:null,head:await headOf(),access_epoch:(await db.query('select access_epoch::text e from app.workspaces where id=$1',[w])).rows[0].e});
  assert.match(times.a,TIMESTAMP);
  // Readers (rank 1) never see deleted content, and neither does an owner the document's ACL leaves out.
  assert.deepEqual((await call(viewer,'list_trash',[w])).documents,[]);
  await setAcl(db,owner,'document',w,d,{[editor]:'editor'});
  assert.deepEqual((await call(owner,'list_trash',[w])).documents,[]);
  assert.deepEqual((await call(editor,'list_trash',[w])).documents.map(x=>x.id),[d]);
  await setAcl(db,owner,'document',w,d,null);
  // Pages by id; next_id is the last included id while more entries follow.
  for(const id of [e,f]){ await call(editor,'create_document',[w,id,null,'agenda',cipher(w,id)]); await call(editor,'push_document',[w,id,nextOp(),'1',cipher(w,id),true]); }
  const first=await call(editor,'list_trash',[w,null,2]);
  assert.deepEqual([first.documents.map(x=>x.id),first.next_id],[[d,e],e]);
  const second=await call(editor,'list_trash',[w,e,2]);
  assert.deepEqual([second.documents.map(x=>x.id),second.next_id],[[f],null]);
  // A budget below one entry still returns the first one, then stops: next_id is the last included id.
  const shipped=(await db.query("select pg_get_functiondef('private.page_budget()'::regprocedure) d")).rows[0].d;
  await db.exec('create or replace function private.page_budget() returns integer language sql immutable set search_path=pg_catalog as $$ select 1 $$');
  try {
   const cut=await call(editor,'list_trash',[w]);
   assert.deepEqual([cut.documents.map(x=>x.id),cut.next_id],[[d],d]);
  } finally { await db.exec(shipped); }
  assert.equal((await db.query('select private.page_budget() b')).rows[0].b,4194304);
 });

 await t.test('restore: applied once with a new revision, conflict when live, deleted with the current revision for a stale base',async()=>{
  await assert.rejects(call(viewer,'restore_document',[w,d,nextOp(),'3']),FORBIDDEN);
  await assert.rejects(call(owner,'restore_document',[uuid(99),d,nextOp(),'3']),FORBIDDEN);
  for(const [opId,base] of [[null,'3'],[nextOp(),null],[nextOp(),'0'],[nextOp(),'03'],[nextOp(),'1.0'],[nextOp(),'9223372036854775808']]) await assert.rejects(call(editor,'restore_document',[w,d,opId,base]),rejected('invalid_request'));
  const head=await headOf(),receipts=await count('app.receipts where workspace_id=$1',[w]);
  // A stale base: 'deleted' with the current revision, stored like any receipt, and nothing else changes.
  const staleOp=nextOp(),stale=await call(editor,'restore_document',[w,d,staleOp,'2']);
  assert.deepEqual(stale,{op_id:staleOp,document_id:d,status:'deleted',revision:'3',head});
  assert.deepEqual(await call(editor,'restore_document',[w,d,staleOp,'2']),stale);
  assert.deepEqual([await headOf(),await count('app.receipts where workspace_id=$1',[w])],[head,receipts+1]);
  // The op id namespace is shared with push and create: another request under it is op_id_reused.
  await assert.rejects(call(editor,'restore_document',[w,d,staleOp,'3']),rejected('op_id_reused'));
  // The current revision restores: revision+1, one journal row and audit rows, the kept content back.
  const journal=await count('app.journal where workspace_id=$1',[w]);
  const restoreOp=nextOp(),restored=await call(editor,'restore_document',[w,d,restoreOp,'3']);
  assert.deepEqual(restored,{op_id:restoreOp,document_id:d,status:'applied',revision:'4',head:String(BigInt(head)+1n)});
  assert.deepEqual(await row(d),{ciphertext:content,deleted:false,deleted_at:null,revision:'4'});
  assert.equal(await count('app.journal where workspace_id=$1',[w]),journal+1);
  assert.deepEqual((await db.query("select action,actor_id from app.audit where workspace_id=$1 and target_id=$2 order by id desc limit 2",[w,d])).rows,
   [{action:'restore_document',actor_id:editor},{action:'document_revision',actor_id:editor}]);
  const epoch=(await call(viewer,'list_accessible_documents',[w])).access_epoch;
  assert.deepEqual((await call(viewer,'get_documents',[w,[d],epoch])).documents.map(x=>[x.deleted,x.ciphertext,x.revision]),[[false,content,'4']]);
  assert.deepEqual(await call(editor,'restore_document',[w,d,restoreOp,'3']),restored);
  // A live document: 'conflict' at its revision. It left the trash.
  const liveOp=nextOp();
  assert.deepEqual(await call(editor,'restore_document',[w,d,liveOp,'4']),{op_id:liveOp,document_id:d,status:'conflict',revision:'4',head:restored.head});
  assert.equal((await call(editor,'list_trash',[w])).documents.some(x=>x.id===d),false);
 });

 await t.test('720 hours after the delete a restore is restore_expired even without a purge, and nothing is stored',async()=>{
  assert.equal((await call(editor,'push_document',[w,d,nextOp(),'4',content,true])).status,'applied'); // revision 5
  // One hour inside the window it is listed and restorable (checked in a transaction that is rolled back).
  await deletedAgo(d,719);
  assert.ok((await call(editor,'list_trash',[w])).documents.some(x=>x.id===d));
  await assert.rejects(asUser(db,editor,async()=>{ assert.equal((await rpc(db,'restore_document',[w,d,nextOp(),'5'])).status,'applied'); throw ROLLBACK; }),error=>error===ROLLBACK);
  // At the boundary it is expired: off the list, no receipt, content still stored (no purge has run).
  await deletedAgo(d,720);
  const receipts=await count('app.receipts where workspace_id=$1',[w]),stored=await row(d),expiredOp=nextOp();
  await assert.rejects(call(editor,'restore_document',[w,d,expiredOp,'5']),rejected('restore_expired'));
  await assert.rejects(call(editor,'restore_document',[w,d,expiredOp,'5']),rejected('restore_expired'));
  assert.deepEqual([await count('app.receipts where workspace_id=$1',[w]),await row(d)],[receipts,stored]);
  assert.deepEqual(stored.ciphertext,content);
  assert.equal((await call(editor,'list_trash',[w])).documents.some(x=>x.id===d),false);
  // A stale base still gets 'deleted' first, so the client learns the revision before learning it is too late.
  assert.equal((await call(editor,'restore_document',[w,d,nextOp(),'4'])).status,'deleted');
 });

 await t.test('purge_expired_trash runs only as sync_maintainer and clears content per (workspace, document) without a client-visible change',async()=>{
  // The same document id in a second workspace, deleted but inside the window: purging w must not touch it.
  await call(owner,'create_workspace',[w2,'Other']);
  await call(owner,'create_document',[w2,d,null,'note',cipher(w2,d)]); await call(owner,'push_document',[w2,d,nextOp(),'1',cipher(w2,d),true]);
  for(const [ws,n] of [[w,1],[w2,2]]){
   await db.query("insert into app.key_envelopes values($1,$2,$3,1,'{}')",[ws,d,owner]);
   await db.query("insert into app.attachments values($1,$2,$3,$4,'digest',1)",[ws,d,uuid(900+n),`synthetic/${n}/attachment`]);
  }
  const scope=ws=>({
   journal:count("app.journal where workspace_id=$1 and document_id=$2 and snapshot->'ciphertext'<>'null'::jsonb",[ws,d]),
   rows:count('app.journal where workspace_id=$1',[ws]),
   envelopes:count('app.key_envelopes where workspace_id=$1 and document_id=$2',[ws,d]),
   attachments:count('app.attachments where workspace_id=$1 and document_id=$2',[ws,d]),
   document:row(d,ws),
   workspace:db.query('select head::text,access_epoch::text from app.workspaces where id=$1',[ws]).then(r=>r.rows[0]),
   signals:db.query('select user_id,generation::text from app.user_signals where workspace_id=$1 order by user_id',[ws]).then(r=>r.rows),
  });
  const resolved=async ws=>Object.fromEntries(await Promise.all(Object.entries(scope(ws)).map(async([k,v])=>[k,await v])));
  const [before,other]=[await resolved(w),await resolved(w2)];
  assert.ok(before.journal>0&&before.envelopes===1&&before.attachments===1);
  // Clients cannot run it; the limit is 1..500.
  await assert.rejects(call(owner,'purge_expired_trash',[100]),{code:'42501',message:'permission denied for function purge_expired_trash'});
  for(const limit of [0,501,null]) await assert.rejects(asMaintainer(()=>rpc(db,'purge_expired_trash',[limit])),rejected('invalid_limit'));
  assert.deepEqual(await asMaintainer(()=>rpc(db,'purge_expired_trash',[100])),{purged:1,more:false});
  const after=await resolved(w);
  // Content is gone from the document, the journal snapshots, the key envelopes and the attachment rows; the
  // attachment path is queued for Storage. Revision, journal length, head, epoch and signals stay.
  assert.deepEqual(after,{...before,journal:0,envelopes:0,attachments:0,document:{...before.document,ciphertext:null}});
  assert.deepEqual((await db.query('select path,workspace_id from app.storage_deletions')).rows,[{path:'synthetic/1/attachment',workspace_id:w}]);
  assert.deepEqual((await db.query("select actor_id,target_id from app.audit where workspace_id=$1 and action='purge_document'",[w])).rows,[{actor_id:null,target_id:d}]);
  assert.deepEqual(await resolved(w2),other);
  // Nothing is left to purge; a restore stays restore_expired; the owner's ACL list shows it purged.
  assert.deepEqual(await asMaintainer(()=>rpc(db,'purge_expired_trash',[])),{purged:0,more:false});
  await assert.rejects(call(editor,'restore_document',[w,d,nextOp(),'5']),rejected('restore_expired'));
  assert.deepEqual((await call(owner,'list_acls',[w,'document'])).entries.filter(x=>x.id===d).map(x=>[x.deleted,x.purged]),[[true,true]]);
  // Pages: with limit 1, more reports candidates left anywhere.
  for(const id of [e,f]) await deletedAgo(id,721);
  assert.deepEqual(await asMaintainer(()=>rpc(db,'purge_expired_trash',[1])),{purged:1,more:true});
  assert.deepEqual(await asMaintainer(()=>rpc(db,'purge_expired_trash',[1])),{purged:1,more:false});
  assert.deepEqual((await db.query('select id from app.documents where ciphertext is null order by id')).rows.map(r=>r.id),[d,e,f]);
 });
});

test('account deletion: the auth.users trigger cleans up for a non-superuser deleter without a JWT subject (F24)',async(t)=>{
 const db=await database(); t.after(()=>db.close());
 const owner=uuid(1),member=uuid(2),other=uuid(3),solo=uuid(4),w=uuid(10),ws=uuid(11),w3=uuid(12);
 for(const id of [owner,member,other,solo]) await db.query('insert into auth.users values($1)',[id]);
 const call=(u,n,a)=>asUser(db,u,()=>rpc(db,n,a));
 const count=async(sql,params)=>(await db.query(`select count(*)::int n from ${sql}`,params)).rows[0].n;
 const exists=async u=>(await count('auth.users where id=$1',[u]))===1;
 // Rows that name u anywhere in the sync schema.
 const references=async u=>({
  members:await count('app.members where user_id=$1',[u]),invitations:await count('app.invitations where user_id=$1',[u]),
  receipts:await count('app.receipts where actor_id=$1',[u]),signals:await count('app.user_signals where user_id=$1',[u]),
  journal:await count('app.journal where actor_id=$1',[u]),audit:await count('app.audit where actor_id=$1 or target_id=$1',[u]),
  offers:await count('app.workspaces where pending_owner_id=$1',[u]),
  acl_keys:await count('(select acl from app.folders union all select acl from app.documents) a where acl ? $1::text',[u]),
 });
 const none={members:0,invitations:0,receipts:0,signals:0,journal:0,audit:0,offers:0,acl_keys:0};
 await call(owner,'create_workspace',[w,'Shared']); await join(db,owner,w,member,'editor'); await join(db,owner,w,other,'viewer');
 // member's history in w: a document and an edit (journal, audit, receipts), a folder ACL key and a pending offer.
 const d=uuid(20),F=uuid(21);
 await call(member,'create_document',[w,d,null,'note',cipher(w,d)]); await call(member,'push_document',[w,d,uuid(30),'1',cipher(w,d,1,'b')]);
 await call(owner,'create_folder',[w,F,null,{[member]:'editor',[owner]:'editor'}]);
 await call(owner,'offer_ownership',[w,member]);
 // An invitation into another workspace that member never answered.
 await call(other,'create_workspace',[w3,'Third']); await call(other,'invite_member',[w3,member,'viewer']);

 await t.test('an owner whose workspace has other members is refused with owner_must_transfer, and nothing changes',async()=>{
  const before=await references(owner);
  await assert.rejects(deleteUserAsAuthAdmin(db,owner),rejected('owner_must_transfer'));
  assert.equal(await exists(owner),true);
  assert.deepEqual(await references(owner),before);
 });

 await t.test('a member is removed and unlinked everywhere; documents written into shared workspaces stay',async()=>{
  const before=await workspaceState(db,w),journal=await count('app.journal where workspace_id=$1',[w]);
  const document=async()=>(await db.query('select ciphertext,revision::text revision from app.documents where workspace_id=$1 and id=$2',[w,d])).rows[0],doc=await document();
  assert.notDeepEqual(await references(member),none);
  assert.equal(await deleteUserAsAuthAdmin(db,member),1);
  assert.equal(await exists(member),false);
  assert.deepEqual(await references(member),none);
  // One removal: one epoch bump, the ACL key stripped with a version bump, the offer withdrawn, one audit row without
  // actor or target, and a signal to the remaining members only (none for the deleted user).
  const after=await workspaceState(db,w),remaining=Object.fromEntries(Object.entries(before.signals).filter(([u])=>u!==member));
  assert.deepEqual({epoch:after.epoch,pending:after.pending,members:after.members,audit:after.audit,signals:after.signals},
   {epoch:String(BigInt(before.epoch)+1n),pending:null,members:before.members.filter(m=>m.user_id!==member),audit:before.audit+1,signals:bumped(remaining)});
  assert.deepEqual(after.acls.find(a=>a.id===F),{id:F,acl:{[owner]:'editor'},v:'2'});
  assert.deepEqual((await db.query('select action,actor_id,target_id from app.audit where workspace_id=$1 order by id desc limit 1',[w])).rows,[{action:'account_deleted',actor_id:null,target_id:null}]);
  // Shared history stays with the actor unlinked; the document and its content stay; the unanswered invitation went.
  assert.equal(await count('app.journal where workspace_id=$1',[w]),journal);
  assert.equal(await count('app.journal where workspace_id=$1 and document_id=$2 and actor_id is null',[w,d]),2);
  assert.deepEqual(await document(),doc);
  assert.deepEqual((await workspaceState(db,w3)).invitations,[]);
  // A token issued before the deletion cannot come back in: a new invitation to the old id is answered unauthenticated.
  await call(owner,'invite_member',[w,member,'viewer']);
  for(const accept of [true,false]) await assert.rejects(call(member,'respond_invitation',[w,accept]),UNAUTHENTICATED);
  await call(owner,'invite_member',[w,member,null]);
  await assert.rejects(call(member,'list_members',[w]),FORBIDDEN);
 });

 await t.test("a sole member's workspace is deleted with the account, its attachment paths queued for Storage",async()=>{
  const [P,C,x,y]=[40,41,42,43].map(uuid);
  await call(solo,'create_workspace',[ws,'Solo']);
  await call(solo,'create_folder',[ws,P,null]); await call(solo,'create_folder',[ws,C,P,{[solo]:'editor'}]);
  await call(solo,'create_document',[ws,x,C,'note',cipher(ws,x)]); await call(solo,'create_document',[ws,y,null,'note',cipher(ws,y)]);
  await call(solo,'push_document',[ws,y,uuid(44),'1',cipher(ws,y),true]);
  await db.query("insert into app.attachments values($1,$2,$3,'synthetic/solo/a','digest',1)",[ws,x,uuid(45)]);
  await db.query("insert into app.key_envelopes values($1,$2,$3,1,'{}')",[ws,x,solo]);
  // Pending invitations from solo to someone else, and from the owner of w to solo.
  await call(solo,'invite_member',[ws,other,'editor']); await call(owner,'invite_member',[w,solo,'viewer']);
  const tables=['members','folders','documents','journal','audit','receipts','invitations','key_envelopes','attachments','user_signals'];
  for(const table of tables) assert.ok(await count(`app.${table} where workspace_id=$1`,[ws])>0,table);
  assert.equal(await deleteUserAsAuthAdmin(db,solo),1);
  assert.equal(await count('app.workspaces where id=$1',[ws]),0);
  for(const table of tables) assert.equal(await count(`app.${table} where workspace_id=$1`,[ws]),0,table);
  assert.deepEqual(await references(solo),none);
  assert.deepEqual((await db.query('select path from app.storage_deletions where workspace_id=$1',[ws])).rows,[{path:'synthetic/solo/a'}]);
  assert.deepEqual((await workspaceState(db,w)).invitations,[]);
 });

 await t.test('the deleter needs no rights on app or private; a reference the cleanup does not know fails the whole delete',async()=>{
  // The cleanup above ran on the trigger's definer rights: the deleting role cannot even use the schemas.
  for(const statement of ['select 1 from app.members','select private.trash_retention()']) await assert.rejects(inTransaction(db,['set local role auth_admin_test'],()=>db.query(statement)),{code:'42501'});
  // Fail-safe: foreign keys stay NO ACTION, so a row that still references the user fails the delete as a whole.
  await db.exec('create table public.unlisted_reference(user_id uuid references auth.users(id))');
  try {
   await db.query('insert into public.unlisted_reference values($1)',[other]);
   const state=async()=>({exists:await exists(other),memberships:await count('app.members where user_id=$1',[other]),w3:await count('app.workspaces where id=$1',[w3])});
   const before=await state();
   await assert.rejects(deleteUserAsAuthAdmin(db,other),{code:'23503'});
   assert.deepEqual(await state(),before);
  } finally { await db.exec('drop table public.unlisted_reference'); }
  // Without it the delete goes through: other was a viewer of w and the sole member of w3.
  assert.equal(await deleteUserAsAuthAdmin(db,other),1);
  assert.deepEqual(await references(other),none);
  assert.equal(await count('app.workspaces where id=$1',[w3]),0);
 });
});
