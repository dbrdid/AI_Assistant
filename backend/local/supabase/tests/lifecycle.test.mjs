import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_ERRORS } from '../../contracts/errors.js';
import { database,uuid,cipher,asUser,withIdentity,inTransaction,rpc,join,setAcl,deleteUserAsAuthAdmin,dryRunDeletion,tableReads,asMaintainer,appState } from './harness.mjs';

/*
 * P0-3 collaboration and account lifecycle on the sync migration alone. "Writes nothing" and "changes exactly these
 * tables" compare appState() snapshots: every row of every app table plus the auth.users ids, not a chosen subset. Time
 * moves only through direct deleted_at fixtures (SQL has no clock control). Single-session PGlite: lock waits, SKIP
 * LOCKED and lock_timeout are not exercised here. Which rows a call locks is seen from inside its own transaction
 * (xmax), and what a call reads from the cumulative statistics.
 */
const rejected=reason=>({code:SERVER_ERRORS[reason].sqlstate,message:reason,detail:undefined,hint:undefined});
const FORBIDDEN=rejected('forbidden'),UNAUTHENTICATED=rejected('unauthenticated');
const ROLLBACK=new Error('dry run rollback');
const TIMESTAMP=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const NIL='00000000-0000-0000-0000-000000000000';
const byText=(a,b)=>(a<b?-1:a>b?1:0);
// Rows come back in a fixed order, so a table changed exactly when its JSON text did.
const changedTables=(before,after)=>Object.keys(after).filter(k=>JSON.stringify(after[k])!==JSON.stringify(before[k])).sort();
// Rows of a table that the earlier snapshot lacks, matched by primary key (a journal seq is unique per workspace only).
const KEYS={journal:r=>`${r.workspace_id}/${r.seq}`,storage_deletions:r=>r.path};
const newRows=(before,after,table)=>{ const key=KEYS[table]??(r=>r.id),old=new Set(before[table].map(key)); return after[table].filter(r=>!old.has(key(r))); };
const newAudit=(before,after)=>newRows(before,after,'audit').sort((a,b)=>a.id-b.id).map(r=>[r.action,r.actor_id,r.target_id]);
// Signal generation increments in w by user (a new row counts from 0).
const signalDelta=(before,after,w)=>{
 const generations=state=>Object.fromEntries(state.user_signals.filter(r=>r.workspace_id===w).map(r=>[r.user_id,r.generation]));
 const [b,a]=[generations(before),generations(after)];
 return Object.fromEntries(Object.keys(a).filter(u=>a[u]!==(b[u]??0)).map(u=>[u,a[u]-(b[u]??0)]));
};
const rows=(state,table,match)=>state[table].filter(r=>Object.entries(match).every(([k,v])=>r[k]===v));
const workspaceRow=(state,w)=>state.workspaces.find(r=>r.id===w);
// Tables compared as sets of rows, for expectations computed from an earlier snapshot (row order then differs).
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>byText(a,b))):v);
const asSets=state=>Object.fromEntries(Object.entries(state).map(([table,list])=>[table,list.map(canonical).sort(byText)]));
// Tables with a row that names u anywhere (a column, an ACL key, a snapshot).
const traces=(state,u)=>Object.keys(state).filter(table=>state[table].some(r=>canonical(r).includes(`"${u}"`)));

/** One database per top-level test with auth.users rows for `accounts`; every helper compares whole snapshots. */
async function open(t,accounts){
 const db=await database(); t.after(()=>db.close());
 for(const id of accounts) await db.query('insert into auth.users values($1)',[id]);
 const call=(u,n,a)=>asUser(db,u,()=>rpc(db,n,a));
 // Positive control: the call succeeds as u, then rolls back.
 const dryRun=async(u,n,a)=>{ let result; try { await asUser(db,u,async()=>{ result=await rpc(db,n,a); throw ROLLBACK; }); } catch(error) { if(error!==ROLLBACK) throw error; } return result; };
 const step=async(u,n,a)=>{ const before=await appState(db),result=await call(u,n,a); return {result,before,after:await appState(db)}; };
 // A refusal: the contract error, and not one row written anywhere.
 const refuses=async(u,n,a,reason)=>{
  const before=await appState(db),label=`${n}(${JSON.stringify(a)}) as ${u||'no subject'}`;
  await assert.rejects(call(u,n,a),rejected(reason),label);
  assert.deepEqual(await appState(db),before,`${label} wrote while refusing`);
 };
 // A call that changes nothing writes nothing (R3).
 const unchanged=async(u,n,a)=>{ const before=await appState(db),result=await call(u,n,a); assert.deepEqual(await appState(db),before,`${n}(${JSON.stringify(a)}) wrote on a no-op`); return result; };
 return {db,call,dryRun,step,refuses,unchanged};
}
const deletedAgo=(db,w,id,hours)=>db.query('update app.documents set deleted_at=clock_timestamp()-make_interval(hours=>$3) where workspace_id=$1 and id=$2',[w,id,hours]);

test('R1: every workspace RPC refuses outsiders alike for an existing and a missing workspace, before any argument check, and writes nothing',async(t)=>{
 // ghost: a still-valid token whose account is gone (no auth.users row).
 const [owner,editor,viewer,invitee,former,stranger,ghost]=[1,2,3,4,5,6,7].map(uuid),everyone=[owner,editor,viewer,invitee,former,stranger,ghost];
 const {db,call,dryRun}=await open(t,everyone.filter(u=>u!==ghost));
 const w=uuid(10),missing=uuid(11),[F,D,T,x]=[20,30,31,40].map(uuid);
 await call(owner,'create_workspace',[w,'Leak']);
 for(const [u,role] of [[editor,'editor'],[viewer,'viewer'],[former,'viewer']]) await join(db,owner,w,u,role);
 await call(former,'leave_workspace',[w]); await call(owner,'invite_member',[w,invitee,'editor']);
 await call(owner,'create_folder',[w,F,null]);
 for(const d of [D,T]) await call(editor,'create_document',[w,d,F,'note',cipher(w,d)]);
 await call(editor,'push_document',[w,T,uuid(50),'1',cipher(w,T),true]); // T: in the trash at revision 2
 const epoch=String(workspaceRow(await appState(db),w).access_epoch),OK='answered';
 const owners=[owner],members=[owner,editor,viewer],editors=[owner,editor],answering=[...members,invitee];
 // [rpc, arguments for a workspace id, callers that pass the access check on w, one of them, its answer on w]. Most
 // arguments fail validation, so an answer given before the access decision would tell outsiders that w exists.
 const cases=[
  ['set_member',id=>[id,viewer,'editor'],owners,owner,OK],
  ['set_member',id=>[id,null,'bad'],owners,owner,'invalid_request'],
  ['set_member',id=>[id,stranger,'viewer'],owners,owner,'member_not_found'],
  ['set_member',id=>[id,viewer,'admin'],owners,owner,'invalid_role'],
  ['set_member',id=>[id,owner,'editor'],owners,owner,'owner_change_not_supported'],
  ['invite_member',id=>[id,stranger,'viewer'],owners,owner,OK],
  ['invite_member',id=>[id,null,'bad'],owners,owner,'invalid_request'],
  ['invite_member',id=>[id,viewer,'viewer'],owners,owner,'already_member'],
  ['invite_member',id=>[id,stranger,'owner'],owners,owner,'invalid_role'],
  ['offer_ownership',id=>[id,editor],owners,owner,OK],
  ['offer_ownership',id=>[id,null],owners,owner,OK],
  ['offer_ownership',id=>[id,invitee],owners,owner,'member_not_found'],
  ['offer_ownership',id=>[id,owner],owners,owner,'owner_change_not_supported'],
  // Nobody holds an offer, so only the owner gets past the check (answered unchanged).
  ['accept_ownership',id=>[id],owners,owner,OK],
  ['list_invitations',id=>[id],owners,owner,OK],
  ['list_invitations',id=>[id,null,0],owners,owner,'invalid_limit'],
  ['create_folder',id=>[id,x,null],owners,owner,OK],
  ['create_folder',id=>[id,null,null,[]],owners,owner,'invalid_request'],
  ['create_folder',id=>[id,x,null,[]],owners,owner,'invalid_acl'],
  ['create_folder',id=>[id,x,null,{[invitee]:'viewer'}],owners,owner,'member_not_found'],
  ['create_folder',id=>[id,F,null],owners,owner,'id_conflict'],
  ['set_folder_acl',id=>[id,F,{},'1'],owners,owner,OK],
  ['set_folder_acl',id=>[id,F,[],'x'],owners,owner,'invalid_request'],
  ['set_folder_acl',id=>[id,F,[],'1'],owners,owner,'invalid_acl'],
  ['set_folder_acl',id=>[id,x,{},'1'],owners,owner,'folder_not_found'],
  ['set_folder_acl',id=>[id,F,{},'2'],owners,owner,'acl_version_mismatch'],
  ['set_folder_acl',id=>[id,F,{[invitee]:'viewer'},'1'],owners,owner,'member_not_found'],
  ['set_document_acl',id=>[id,D,{},'1'],owners,owner,OK],
  ['set_document_acl',id=>[id,D,[],'x'],owners,owner,'invalid_request'],
  ['set_document_acl',id=>[id,D,[],'1'],owners,owner,'invalid_acl'],
  ['set_document_acl',id=>[id,x,{},'1'],owners,owner,'document_not_found'],
  ['set_document_acl',id=>[id,D,{},'2'],owners,owner,'acl_version_mismatch'],
  ['set_document_acl',id=>[id,D,{[former]:'viewer'},'1'],owners,owner,'member_not_found'],
  ['get_acl',id=>[id,'folder',F],owners,owner,OK],
  ['get_acl',id=>[id,'bad',x],owners,owner,'invalid_request'],
  ['get_acl',id=>[id,'document',x],owners,owner,'document_not_found'],
  ['list_acls',id=>[id,'document'],owners,owner,OK],
  ['list_acls',id=>[id,'bad'],owners,owner,'invalid_request'],
  ['list_acls',id=>[id,'folder',null,0],owners,owner,'invalid_limit'],
  ['set_ai_enabled',id=>[id,true],owners,owner,OK],
  ['set_ai_enabled',id=>[id,null],owners,owner,'invalid_request'],
  ['list_members',id=>[id],members,viewer,OK],
  ['list_members',id=>[id,null,0],members,viewer,'invalid_limit'],
  ['list_folders',id=>[id],members,viewer,OK],
  ['list_folders',id=>[id,null,501],members,viewer,'invalid_limit'],
  ['list_trash',id=>[id],members,viewer,OK],
  ['list_trash',id=>[id,null,0],members,viewer,'invalid_limit'],
  ['leave_workspace',id=>[id],members,viewer,OK],
  // Members answer from their membership, so they pass too; the invitee answers its invitation.
  ['respond_invitation',id=>[id,true],answering,invitee,OK],
  ['respond_invitation',id=>[id,null],answering,invitee,'invalid_request'],
  ['create_document',id=>[id,x,null,'note',cipher(id,x)],editors,editor,OK],
  ['create_document',id=>[id,null,null,'memo',{}],editors,editor,'invalid_request'],
  ['push_document',id=>[id,D,uuid(51),'1',cipher(id,D)],editors,editor,OK],
  ['push_document',id=>[id,D,null,'x',{}],editors,editor,'invalid_push'],
  ['restore_document',id=>[id,T,uuid(52),'2'],editors,editor,OK],
  ['restore_document',id=>[id,T,null,'x'],editors,editor,'invalid_request'],
  ['pull_changes',id=>[id,'0'],members,viewer,OK],
  ['pull_changes',id=>[id,'x'],members,viewer,'invalid_cursor'],
  ['list_accessible_documents',id=>[id,null,0],members,viewer,'invalid_limit'],
  ['get_documents',id=>[id,[],epoch],members,viewer,'invalid_request'],
 ];
 for(const [name,args,insiders,caller,expected] of cases){
  const before=await appState(db),label=`${name}(${JSON.stringify(args('w'))})`;
  for(const [id,where] of [[w,'w'],[missing,'missing']]){
   for(const u of everyone) if(id===missing||!insiders.includes(u)) await assert.rejects(call(u,name,args(id)),FORBIDDEN,`${label} as ${u} on ${where}`);
   await assert.rejects(call('',name,args(id)),UNAUTHENTICATED,`${label} without a subject on ${where}`);
  }
  // Positive control: past the access check the same arguments get their own answer, so each outsider's forbidden came
  // from the access decision alone.
  if(expected===OK) assert.equal(typeof await dryRun(caller,name,args(w)),'object',label);
  else await assert.rejects(call(caller,name,args(w)),rejected(expected),label);
  assert.deepEqual(await appState(db),before,label);
 }
 // The caller-wide lists have no workspace to hide; they need a subject.
 for(const name of ['list_my_workspaces','list_my_invitations']) await assert.rejects(call('',name,[]),UNAUTHENTICATED);
});

test('membership (F13): invitations are the only way in, and every answer writes exactly what the spec lists (R3, R4, R8)',async(t)=>{
 const [owner,editor,alice,bob,nobody]=[1,2,3,4,5].map(uuid); // nobody: an id without an account
 const {db,call,step,refuses,unchanged}=await open(t,[owner,editor,alice,bob]);
 const w=uuid(10),epochOf=state=>workspaceRow(state,w).access_epoch;
 await call(owner,'create_workspace',[w,'Team']); await join(db,owner,w,editor,'editor');

 await t.test('invite, re-invite, change and revoke: an audit row and a signal to the members and the invitee, never an epoch bump',async()=>{
  let s=await step(owner,'invite_member',[w,alice,'viewer']);
  assert.deepEqual([s.result,changedTables(s.before,s.after),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{changed:true},['audit','invitations','user_signals'],[['invite_member',owner,alice]],{[owner]:1,[editor]:1,[alice]:1}]);
  assert.deepEqual(rows(s.after,'invitations',{workspace_id:w}).map(r=>[r.user_id,r.role]),[[alice,'viewer']]);
  // An invitation grants nothing yet.
  for(const [name,args] of [['list_members',[w]],['list_accessible_documents',[w]],['list_folders',[w]],['leave_workspace',[w]]]) await refuses(alice,name,args,'forbidden');
  assert.deepEqual(await unchanged(owner,'invite_member',[w,alice,'viewer']),{changed:false});
  s=await step(owner,'invite_member',[w,alice,'editor']);
  assert.deepEqual([s.result,changedTables(s.before,s.after),newAudit(s.before,s.after)],[{changed:true},['audit','invitations','user_signals'],[['invite_member',owner,alice]]]);
  assert.deepEqual(rows(s.after,'invitations',{workspace_id:w}).map(r=>[r.user_id,r.role]),[[alice,'editor']]);
  // After the owner check: a null user, then membership (whatever the role, even null), then the role.
  for(const [args,reason] of [[[w,null,'owner'],'invalid_request'],[[w,editor,'owner'],'already_member'],[[w,editor,null],'already_member'],[[w,owner,'viewer'],'already_member'],
   ...['owner','admin','Viewer',''].map(role=>[[w,bob,role],'invalid_role'])]) await refuses(owner,'invite_member',args,reason);
  await refuses(editor,'invite_member',[w,bob,'viewer'],'forbidden');
  // Revoking: changed only while one is pending; the revoked invitee is signalled and can no longer answer.
  s=await step(owner,'invite_member',[w,alice,null]);
  assert.deepEqual([s.result,changedTables(s.before,s.after),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{changed:true},['audit','invitations','user_signals'],[['revoke_invitation',owner,alice]],{[owner]:1,[editor]:1,[alice]:1}]);
  assert.deepEqual(await unchanged(owner,'invite_member',[w,alice,null]),{changed:false});
  await refuses(alice,'respond_invitation',[w,true],'forbidden');
  // An id without an account gets the same answers (no account-existence oracle); only the members are signalled.
  s=await step(owner,'invite_member',[w,nobody,'viewer']);
  assert.deepEqual([s.result,changedTables(s.before,s.after),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{changed:true},['audit','invitations','user_signals'],[['invite_member',owner,nobody]],{[owner]:1,[editor]:1}]);
  assert.deepEqual(await unchanged(owner,'invite_member',[w,nobody,'viewer']),{changed:false});
  s=await step(owner,'invite_member',[w,nobody,null]);
  assert.deepEqual([s.result,newAudit(s.before,s.after),rows(s.after,'invitations',{workspace_id:w})],[{changed:true},[['revoke_invitation',owner,nobody]],[]]);
 });

 await t.test('accepting joins with the invited role and one epoch bump; declining changes no access; retries',async()=>{
  await call(owner,'invite_member',[w,alice,'viewer']); await call(owner,'invite_member',[w,bob,'editor']);
  await refuses(alice,'respond_invitation',[w,null],'invalid_request');
  let s=await step(alice,'respond_invitation',[w,true]);
  const epoch=epochOf(s.before)+1;
  assert.deepEqual(s.result,{changed:true,role:'viewer',access_epoch:String(epoch)});
  assert.deepEqual(changedTables(s.before,s.after),['audit','invitations','members','user_signals','workspaces']);
  assert.deepEqual(workspaceRow(s.after,w),{...workspaceRow(s.before,w),access_epoch:epoch});
  assert.deepEqual([rows(s.after,'members',{workspace_id:w,user_id:alice}).map(r=>r.role),rows(s.after,'invitations',{workspace_id:w}).map(r=>r.user_id)],[['viewer'],[bob]]);
  assert.deepEqual([newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],[[['accept_invitation',alice,alice]],{[owner]:1,[editor]:1,[alice]:1}]);
  // A lost response: answering again, either way, is answered from the membership; so is any member.
  for(const accept of [true,false]) assert.deepEqual(await unchanged(alice,'respond_invitation',[w,accept]),{changed:false,role:'viewer',access_epoch:String(epoch)});
  assert.deepEqual(await unchanged(owner,'respond_invitation',[w,false]),{changed:false,role:'owner',access_epoch:String(epoch)});
  await refuses(alice,'respond_invitation',[w,null],'invalid_request');
  // Declining removes the invitation only and signals the decliner; a retried answer is forbidden.
  s=await step(bob,'respond_invitation',[w,false]);
  assert.deepEqual([s.result,changedTables(s.before,s.after),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{changed:true,role:null,access_epoch:String(epoch)},['audit','invitations','user_signals'],[['decline_invitation',bob,bob]],{[owner]:1,[editor]:1,[alice]:1,[bob]:1}]);
  for(const accept of [false,true]) await refuses(bob,'respond_invitation',[w,accept],'forbidden');
  await refuses(bob,'list_members',[w],'forbidden');
 });

 await t.test('set_member changes roles and removes members but never adds; one epoch bump per change',async()=>{
  let s=await step(owner,'set_member',[w,alice,'editor']);
  const epoch=epochOf(s.before)+1;
  assert.deepEqual([s.result,changedTables(s.before,s.after),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{access_epoch:String(epoch),changed:true},['audit','members','user_signals','workspaces'],[['set_member',owner,alice]],{[owner]:1,[editor]:1,[alice]:1}]);
  assert.deepEqual(rows(s.after,'members',{workspace_id:w,user_id:alice}).map(r=>r.role),['editor']);
  assert.deepEqual(await unchanged(owner,'set_member',[w,alice,'editor']),{access_epoch:String(epoch),changed:false});
  // Non-members never join through set_member, accounts or not; removing one is a no-op.
  for(const u of [bob,nobody]){
   await refuses(owner,'set_member',[w,u,'viewer'],'member_not_found');
   assert.deepEqual(await unchanged(owner,'set_member',[w,u,null]),{access_epoch:String(epoch),changed:false});
  }
  // The user, the owner role and the role name are checked before membership.
  for(const [args,reason] of [[[w,null,'viewer'],'invalid_request'],[[w,owner,'viewer'],'owner_change_not_supported'],[[w,owner,null],'owner_change_not_supported'],
   [[w,bob,'owner'],'owner_change_not_supported'],[[w,alice,'owner'],'owner_change_not_supported'],[[w,bob,'admin'],'invalid_role'],[[w,alice,'Editor'],'invalid_role']]) await refuses(owner,'set_member',args,reason);
  await refuses(editor,'set_member',[w,alice,'viewer'],'forbidden');
  // Removal signals the removed member too, which loses access at once.
  s=await step(owner,'set_member',[w,alice,null]);
  assert.deepEqual([s.result,changedTables(s.before,s.after),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{access_epoch:String(epoch+1),changed:true},['audit','members','user_signals','workspaces'],[['set_member',owner,alice]],{[owner]:1,[editor]:1,[alice]:1}]);
  await refuses(alice,'list_members',[w],'forbidden');
 });

 await t.test('leave_workspace: once per membership; the owner must hand the workspace over first',async()=>{
  await join(db,owner,w,alice,'viewer');
  await refuses(owner,'leave_workspace',[w],'owner_must_transfer');
  const s=await step(alice,'leave_workspace',[w]);
  assert.deepEqual([s.result,changedTables(s.before,s.after),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{changed:true,access_epoch:String(epochOf(s.before)+1)},['audit','members','user_signals','workspaces'],[['leave_workspace',alice,alice]],{[owner]:1,[editor]:1,[alice]:1}]);
  for(const name of ['leave_workspace','list_members']) await refuses(alice,name,[w],'forbidden');
 });
});

test('ownership: an offer changes no access, only the offeree accepts, and a later role change or removal of the offeree withdraws it',async(t)=>{
 const [owner,ann,ben,cat,stranger,nobody]=[1,2,3,4,5,6].map(uuid);
 const {db,call,step,refuses,unchanged}=await open(t,[owner,ann,ben,cat,stranger]);
 const w=uuid(10),pendingOf=state=>workspaceRow(state,w).pending_owner_id,epochOf=state=>workspaceRow(state,w).access_epoch;
 await call(owner,'create_workspace',[w,'Hand-over']); await join(db,owner,w,ann,'editor'); await join(db,owner,w,ben,'viewer');
 await call(owner,'invite_member',[w,cat,'viewer']); // invited, not a member

 await t.test('offer, repeat, retarget and cancel; refusals in the specified order',async()=>{
  for(const [u,reason] of [[owner,'owner_change_not_supported'],[stranger,'member_not_found'],[nobody,'member_not_found'],[cat,'member_not_found']]) await refuses(owner,'offer_ownership',[w,u],reason);
  for(const u of [ann,ben,cat]) await refuses(u,'offer_ownership',[w,ann],'forbidden');
  assert.deepEqual(await unchanged(owner,'offer_ownership',[w,null]),{changed:false,pending_owner_id:null});
  let s=await step(owner,'offer_ownership',[w,ann]);
  // Only the offer is stored: same epoch, same members.
  assert.deepEqual([s.result,changedTables(s.before,s.after),workspaceRow(s.after,w)],[{changed:true,pending_owner_id:ann},['audit','user_signals','workspaces'],{...workspaceRow(s.before,w),pending_owner_id:ann}]);
  assert.deepEqual([newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],[[['offer_ownership',owner,ann]],{[owner]:1,[ann]:1,[ben]:1}]);
  assert.deepEqual(await unchanged(owner,'offer_ownership',[w,ann]),{changed:false,pending_owner_id:ann});
  s=await step(owner,'offer_ownership',[w,ben]);
  assert.deepEqual([s.result,pendingOf(s.after),newAudit(s.before,s.after)],[{changed:true,pending_owner_id:ben},ben,[['offer_ownership',owner,ben]]]);
  await refuses(ann,'accept_ownership',[w],'forbidden');
  s=await step(owner,'offer_ownership',[w,null]);
  assert.deepEqual([s.result,changedTables(s.before,s.after),workspaceRow(s.after,w),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{changed:true,pending_owner_id:null},['audit','user_signals','workspaces'],{...workspaceRow(s.before,w),pending_owner_id:null},[['offer_ownership',owner,null]],{[owner]:1,[ann]:1,[ben]:1}]);
  await refuses(ben,'accept_ownership',[w],'forbidden');
 });

 await t.test('acceptance: the offeree becomes owner and the old owner an editor with one epoch bump; a retry is unchanged',async()=>{
  await call(owner,'offer_ownership',[w,ann]);
  for(const u of [ben,cat,stranger,nobody]) await refuses(u,'accept_ownership',[w],'forbidden');
  assert.deepEqual(await unchanged(owner,'accept_ownership',[w]),{changed:false,access_epoch:String(epochOf(await appState(db)))});
  const s=await step(ann,'accept_ownership',[w]),epoch=epochOf(s.before)+1;
  assert.deepEqual([s.result,changedTables(s.before,s.after),workspaceRow(s.after,w)],
   [{changed:true,access_epoch:String(epoch)},['audit','members','user_signals','workspaces'],{...workspaceRow(s.before,w),access_epoch:epoch,pending_owner_id:null}]);
  assert.deepEqual(rows(s.after,'members',{workspace_id:w}).map(m=>[m.user_id,m.role]).sort(),[[owner,'editor'],[ann,'owner'],[ben,'viewer']].sort());
  assert.deepEqual([newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],[[['transfer_ownership',ann,ann]],{[owner]:1,[ann]:1,[ben]:1}]);
  assert.deepEqual(await unchanged(ann,'accept_ownership',[w]),{changed:false,access_epoch:String(epoch)});
  // The old owner lost the owner RPCs; the new owner may not leave.
  await refuses(owner,'invite_member',[w,stranger,'viewer'],'forbidden');
  await refuses(ann,'leave_workspace',[w],'owner_must_transfer');
  await call(ann,'offer_ownership',[w,owner]); await call(owner,'accept_ownership',[w]);
  assert.deepEqual(rows(await appState(db),'members',{workspace_id:w}).map(m=>[m.user_id,m.role]).sort(),[[owner,'owner'],[ann,'editor'],[ben,'viewer']].sort());
 });

 await t.test("a role change of the offeree withdraws the offer (recorded like a cancel); another member's change keeps it",async()=>{
  await call(owner,'offer_ownership',[w,ann]);
  let s=await step(owner,'set_member',[w,ben,'editor']);
  assert.deepEqual([pendingOf(s.after),newAudit(s.before,s.after)],[ann,[['set_member',owner,ben]]]);
  // A no-op role call keeps it too.
  assert.equal((await unchanged(owner,'set_member',[w,ann,'editor'])).changed,false);
  for(const role of ['viewer','editor']){
   s=await step(owner,'set_member',[w,ann,role]);
   assert.deepEqual([pendingOf(s.after),epochOf(s.after)-epochOf(s.before),newAudit(s.before,s.after)],[null,1,[['offer_ownership',owner,null],['set_member',owner,ann]]]);
   await refuses(ann,'accept_ownership',[w],'forbidden');
   if(role==='viewer') await call(owner,'offer_ownership',[w,ann]); // offered again before the promotion
  }
  await call(owner,'set_member',[w,ben,'viewer']);
 });

 await t.test('removing or losing the offeree withdraws the offer; removing someone else keeps it; re-joining does not restore it',async()=>{
  await call(owner,'offer_ownership',[w,ann]);
  let s=await step(owner,'set_member',[w,ben,null]);
  assert.equal(pendingOf(s.after),ann);
  await join(db,owner,w,ben,'viewer');
  for(const [remove,expected] of [[()=>step(owner,'set_member',[w,ben,null]),['set_member',owner,ben]],[()=>step(ben,'leave_workspace',[w]),['leave_workspace',ben,ben]]]){
   await call(owner,'offer_ownership',[w,ben]);
   s=await remove();
   assert.deepEqual([pendingOf(s.after),newAudit(s.before,s.after)],[null,[expected]]);
   await join(db,owner,w,ben,'viewer');
   await refuses(ben,'accept_ownership',[w],'forbidden');
   assert.equal(pendingOf(await appState(db)),null);
  }
 });

 await t.test('the offer shows as ownership_offered (a boolean) to the offeree only, and as pending_owner_id to the owner',async()=>{
  await call(owner,'offer_ownership',[w,ben]);
  const offered=async u=>(await call(u,'list_my_workspaces',[])).workspaces.find(x=>x.id===w).ownership_offered;
  assert.deepEqual([await offered(owner),await offered(ann),await offered(ben)],[false,false,true]);
  assert.equal((await call(owner,'list_invitations',[w])).pending_owner_id,ben);
  await call(owner,'offer_ownership',[w,null]);
  assert.deepEqual([await offered(ben),(await call(owner,'list_invitations',[w])).pending_owner_id],[false,null]);
 });
});

test('ACLs (F02, F12, F15): syntax-normalised keys, member-only keys, compare-and-set, and the specified order of checks',async(t)=>{
 // The editor's id has hex letters, so spellings can differ in case.
 const owner=uuid(1),editor='abcdef00-0000-4000-8000-0000000000ab',[viewer,invitee,former,stranger,nobody]=[3,4,5,6,7].map(uuid);
 const {db,call,dryRun,step,refuses,unchanged}=await open(t,[owner,editor,viewer,invitee,former,stranger]);
 const w=uuid(10),[F,G,H,D,E,x]=[20,21,22,30,31,40].map(uuid);
 await call(owner,'create_workspace',[w,'ACL']);
 for(const [u,role] of [[editor,'editor'],[viewer,'viewer'],[former,'viewer']]) await join(db,owner,w,u,role);
 await call(former,'leave_workspace',[w]); await call(owner,'invite_member',[w,invitee,'viewer']);
 await call(stranger,'create_workspace',[uuid(11),'Elsewhere']); // a member of another workspace is no member of w
 await call(owner,'create_folder',[w,F,null]); await call(owner,'create_document',[w,D,F,'note',cipher(w,D)]);
 const stored=async(kind,id)=>{ const r=rows(await appState(db),kind==='folder'?'folders':'documents',{workspace_id:w,id})[0]; return {acl:r.acl,version:r.acl_version}; };
 const rank=(u,kind,id)=>withIdentity(db,u,async()=>(await db.query(`select private.${kind}_rank($1,$2) r`,[w,id])).rows[0].r);
 const targets=[['set_folder_acl','folder',F,'folder_not_found'],['set_document_acl','document',D,'document_not_found']];

 await t.test('keys are stored in the canonical uuid spelling, so another spelling of an ACL is the same ACL',async()=>{
  const spelled={[editor.toUpperCase()]:'editor',[`{${viewer}}`]:'viewer',[owner.replaceAll('-','')]:'editor'},respelled={[`{${editor.toUpperCase()}}`]:'editor',[viewer]:'viewer',[owner]:'editor'};
  for(const [name,kind,id] of targets){
   const s=await step(owner,name,[w,id,spelled,'1']);
   assert.deepEqual(s.result,{access_epoch:String(workspaceRow(s.before,w).access_epoch+1),changed:true,acl_version:'2'});
   assert.deepEqual(await stored(kind,id),{acl:{[editor]:'editor',[viewer]:'viewer',[owner]:'editor'},version:2});
   assert.deepEqual(await unchanged(owner,name,[w,id,respelled,'1']),{access_epoch:String(workspaceRow(s.after,w).access_epoch),changed:false,acl_version:'2'});
  }
  // A new folder holds nothing, so no epoch bump; members are signalled to refetch their folder lists.
  const s=await step(owner,'create_folder',[w,G,null,spelled]);
  assert.deepEqual([s.result,changedTables(s.before,s.after),workspaceRow(s.after,w),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{id:G,acl_version:'1'},['audit','folders','user_signals'],workspaceRow(s.before,w),[['create_folder',owner,G]],{[owner]:1,[editor]:1,[viewer]:1}]);
  assert.deepEqual(await stored('folder',G),{acl:{[editor]:'editor',[viewer]:'viewer',[owner]:'editor'},version:1});
 });

 await t.test('{} is stored as {} and denies everyone, the owner included; null inherits',async()=>{
  assert.deepEqual(await call(owner,'create_folder',[w,H,null,{}]),{id:H,acl_version:'1'});
  await call(owner,'create_document',[w,E,null,'note',cipher(w,E)]); await setAcl(db,owner,'document',w,E,{});
  assert.deepEqual([await stored('folder',H),await stored('document',E)],[{acl:{},version:1},{acl:{},version:2}]);
  for(const u of [owner,editor,viewer]) assert.deepEqual([await rank(u,'folder',H),await rank(u,'document',E)],[0,0]);
  // The owner still manages what it cannot read, but creates nothing inside it.
  assert.deepEqual(await call(owner,'get_acl',[w,'folder',H]),{id:H,acl:{},acl_version:'1'});
  await refuses(owner,'create_folder',[w,x,H],'forbidden');
  await refuses(owner,'create_document',[w,x,H,'note',cipher(w,x)],'forbidden');
  await setAcl(db,owner,'document',w,E,null);
  assert.deepEqual([await stored('document',E),await rank(viewer,'document',E)],[{acl:null,version:3},1]);
 });

 await t.test('anything but an object of uuid keys with "viewer" or "editor" values is invalid_acl in every RPC that takes an ACL',async()=>{
  const invalid=[[],'null','"editor"','1','true',[{[viewer]:'viewer'}],{[viewer]:'owner'},{[viewer]:'Editor'},{[viewer]:null},{[viewer]:1},{[viewer]:['viewer']},
   {[viewer]:{role:'viewer'}},{x:'viewer'},{'':'viewer'},{[` ${viewer}`]:'viewer'},{[`${viewer} `]:'viewer'},{[viewer.slice(0,-1)]:'viewer'},
   // Two spellings of one uuid are rejected rather than resolved by key order, whatever their values (F15).
   {[editor]:'editor',[editor.toUpperCase()]:'viewer'},{[viewer]:'viewer',[`{${viewer}}`]:'viewer'},{[editor]:'editor',[editor.toUpperCase()]:'editor',[editor.replaceAll('-','')]:'editor'}];
  const versions=Object.fromEntries(await Promise.all(targets.map(async([name,kind,id])=>[name,String((await stored(kind,id)).version)])));
  for(const acl of invalid){
   for(const [name,,id] of targets) await refuses(owner,name,[w,id,acl,versions[name]],'invalid_acl');
   await refuses(owner,'create_folder',[w,x,null,acl],'invalid_acl');
  }
  // Positive twins: a valid ACL in the same calls applies.
  for(const [name,,id] of targets) assert.equal((await dryRun(owner,name,[w,id,{[viewer]:'viewer'},versions[name]])).changed,true);
  assert.deepEqual(await dryRun(owner,'create_folder',[w,x,null,{[viewer]:'viewer'}]),{id:x,acl_version:'1'});
 });

 await t.test('every key must name a current member: invitees, former members, strangers and unknown ids are member_not_found',async()=>{
  for(const [name,kind,id] of targets){
   const version=String((await stored(kind,id)).version);
   for(const u of [invitee,former,stranger,nobody]) await refuses(owner,name,[w,id,{[owner]:'editor',[u]:'viewer'},version],'member_not_found');
   assert.equal((await dryRun(owner,name,[w,id,{[owner]:'editor',[viewer]:'viewer'},version])).changed,true);
  }
  for(const u of [invitee,former,stranger,nobody]) await refuses(owner,'create_folder',[w,x,null,{[u]:'viewer'}],'member_not_found');
  // After the ACL checks comes the id: an existing id with a bad ACL reports the ACL.
  await refuses(owner,'create_folder',[w,F,null,[]],'invalid_acl');
  await refuses(owner,'create_folder',[w,F,null,{[stranger]:'viewer'}],'member_not_found');
  await refuses(owner,'create_folder',[w,F,null,{[viewer]:'viewer'}],'id_conflict');
  await refuses(owner,'create_folder',[w,null,null,[]],'invalid_request');
 });

 await t.test('compare-and-set checks owner, version syntax, ACL syntax, target, equality, version, then membership',async()=>{
  for(const [name,kind,id,missingReason] of targets){
   const {acl,version:v}=await stored(kind,id),current=String(v),stale=String(v-1),other={[owner]:'editor',[editor]:'viewer'};
   assert.ok(v>=2&&canonical(acl)!==canonical(other),'fixture: a stale version exists and the new ACL differs');
   const epoch=String(workspaceRow(await appState(db),w).access_epoch);
   for(const u of [editor,viewer,invitee]) await refuses(u,name,[w,id,[],'x'],'forbidden');
   for(const bad of ['0','01','-1','1.0',' 1','','x',null,'9223372036854775808','1'.repeat(20)]) await refuses(owner,name,[w,id,[],bad],'invalid_request');
   await refuses(owner,name,[w,x,[],current],'invalid_acl');
   // A missing target is not a null ACL, and it is reported before membership.
   for(const value of [null,{},{[stranger]:'viewer'}]) await refuses(owner,name,[w,x,value,current],missingReason);
   // The stored ACL again is a no-op at any well-formed version, so a retry after a lost response is answered alike.
   for(const at of [stale,current,'9223372036854775807']) assert.deepEqual(await unchanged(owner,name,[w,id,acl,at]),{access_epoch:epoch,changed:false,acl_version:current});
   // A stale copy is a mismatch even when it names a non-member: the version comes before membership.
   await refuses(owner,name,[w,id,{[stranger]:'viewer'},stale],'acl_version_mismatch');
   await refuses(owner,name,[w,id,other,'9223372036854775807'],'acl_version_mismatch');
   await refuses(owner,name,[w,id,{[stranger]:'viewer'},current],'member_not_found');
   // The write: the version and the epoch move once, one audit row, every member signalled.
   const s=await step(owner,name,[w,id,other,current]);
   assert.deepEqual([s.result,changedTables(s.before,s.after),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
    [{access_epoch:String(Number(epoch)+1),changed:true,acl_version:String(v+1)},['audit',kind==='folder'?'folders':'documents','user_signals','workspaces'],[[name,owner,id]],{[owner]:1,[editor]:1,[viewer]:1}]);
   assert.deepEqual(await stored(kind,id),{acl:other,version:v+1});
   // The other session that read the same version loses; the winner's retry is a no-op.
   await refuses(owner,name,[w,id,{[viewer]:'viewer'},current],'acl_version_mismatch');
   assert.equal((await unchanged(owner,name,[w,id,other,current])).changed,false);
  }
 });

 await t.test('get_acl: the owner reads any ACL with its version; the kind is checked before the target',async()=>{
  assert.deepEqual(await unchanged(owner,'get_acl',[w,'document',D]),{id:D,acl:(await stored('document',D)).acl,acl_version:String((await stored('document',D)).version)});
  assert.deepEqual(await call(owner,'get_acl',[w,'folder',G]),{id:G,acl:{[editor]:'editor',[viewer]:'viewer',[owner]:'editor'},acl_version:'1'});
  for(const kind of ['bad','Folder','documents','',null]) await refuses(owner,'get_acl',[w,kind,x],'invalid_request');
  await refuses(owner,'get_acl',[w,'folder',D],'folder_not_found');
  await refuses(owner,'get_acl',[w,'document',F],'document_not_found');
  for(const u of [editor,viewer]) await refuses(u,'get_acl',[w,'bad',x],'forbidden');
 });
});

test('inheritance (F01): new folders and documents follow the folder chain capped by the workspace role; a restricted ancestor hides its subtree',async(t)=>{
 const [owner,editor,viewer,late]=[1,2,3,4].map(uuid);
 const {db,call,refuses}=await open(t,[owner,editor,viewer,late]);
 const w=uuid(10),[A,B,C,R,S]=[20,21,22,23,24].map(uuid),[dA,dC,dS,dRoot,x]=[30,31,32,33,40].map(uuid);
 await call(owner,'create_workspace',[w,'Tree']); await join(db,owner,w,editor,'editor'); await join(db,owner,w,viewer,'viewer');
 const rank=(u,kind,id)=>withIdentity(db,u,async()=>(await db.query(`select private.${kind}_rank($1,$2) r`,[w,id])).rows[0].r);
 const ranks=async(kind,id)=>[await rank(owner,kind,id),await rank(editor,kind,id),await rank(viewer,kind,id)];
 // A > B > C inherit; R is restricted at creation (the editor only reads in it, the viewer is left out); S inherits in R.
 await call(owner,'create_folder',[w,A,null]); await call(owner,'create_folder',[w,B,A]); await call(owner,'create_folder',[w,C,B]);
 await call(owner,'create_folder',[w,R,null,{[owner]:'editor',[editor]:'viewer'}]); await call(owner,'create_folder',[w,S,R]);
 for(const [d,folder] of [[dA,A],[dC,C],[dS,S],[dRoot,null]]) await call(owner,'create_document',[w,d,folder,'note',cipher(w,d)]);

 await t.test('ACLs stay NULL unless given; a rank is the role (capped at 2) lowered by the most restrictive ancestor',async()=>{
  const state=await appState(db),byId=(a,b)=>byText(a.id,b.id);
  assert.deepEqual([...state.folders].sort(byId).map(f=>[f.id,f.acl,f.acl_version]),[[A,null,1],[B,null,1],[C,null,1],[R,{[owner]:'editor',[editor]:'viewer'},1],[S,null,1]]);
  assert.deepEqual(state.documents.map(d=>d.acl),[null,null,null,null]);
  for(const id of [A,B,C]) assert.deepEqual(await ranks('folder',id),[2,2,1]);
  for(const id of [R,S]) assert.deepEqual(await ranks('folder',id),[2,1,0]);
  for(const d of [dA,dC,dRoot]) assert.deepEqual(await ranks('document',d),[2,2,1]);
  assert.deepEqual(await ranks('document',dS),[2,1,0]);
 });

 await t.test('listings follow the ranks: folders whose whole chain is visible (can_edit at rank 2), documents with rank > 0',async()=>{
  const listed=async u=>({folders:(await call(u,'list_folders',[w])).folders.map(f=>[f.id,f.parent_id,f.can_edit]),documents:(await call(u,'list_accessible_documents',[w])).documents.map(d=>d.id)});
  assert.deepEqual(await listed(owner),{folders:[[A,null,true],[B,A,true],[C,B,true],[R,null,true],[S,R,true]],documents:[dA,dC,dS,dRoot]});
  assert.deepEqual(await listed(editor),{folders:[[A,null,true],[B,A,true],[C,B,true],[R,null,false],[S,R,false]],documents:[dA,dC,dS,dRoot]});
  assert.deepEqual(await listed(viewer),{folders:[[A,null,false],[B,A,false],[C,B,false]],documents:[dA,dC,dRoot]});
  // A member who joins later reads the inherited documents at once; nobody has to share them.
  await join(db,owner,w,late,'viewer');
  assert.deepEqual(await listed(late),await listed(viewer));
 });

 await t.test('writes follow the ranks: documents only where the caller can edit, folders only under a parent the owner can edit',async()=>{
  for(const [u,name,args] of [[editor,'create_document',[w,x,S,'note',cipher(w,x)]],[editor,'push_document',[w,dS,uuid(60),'1',cipher(w,dS)]],
   [viewer,'create_document',[w,x,C,'note',cipher(w,x)]],[viewer,'push_document',[w,dC,uuid(61),'1',cipher(w,dC)]]]) await refuses(u,name,args,'forbidden');
  assert.equal((await call(editor,'push_document',[w,dC,uuid(62),'1',cipher(w,dC,1,'b')])).status,'applied');
  assert.equal((await call(owner,'push_document',[w,dS,uuid(63),'1',cipher(w,dS,1,'b')])).status,'applied');
  await refuses(owner,'create_folder',[w,x,uuid(41)],'forbidden'); // a missing parent
  await setAcl(db,owner,'folder',w,R,{[editor]:'editor'});
  await refuses(owner,'create_folder',[w,x,S],'forbidden');
  await setAcl(db,owner,'folder',w,R,{[owner]:'editor',[editor]:'viewer'});
  assert.deepEqual(await call(owner,'create_folder',[w,x,S]),{id:x,acl_version:'1'});
 });

 await t.test('restricting an ancestor hides the whole subtree, the owner included, until lifted; ACLs narrow within the role, never widen',async()=>{
  await setAcl(db,owner,'folder',w,B,{});
  for(const [kind,id] of [['folder',B],['folder',C],['document',dC]]) assert.deepEqual(await ranks(kind,id),[0,0,0]);
  assert.deepEqual([await ranks('folder',A),await ranks('document',dA)],[[2,2,1],[2,2,1]]);
  assert.deepEqual([(await call(viewer,'list_folders',[w])).folders.map(f=>f.id),(await call(viewer,'list_accessible_documents',[w])).documents.map(d=>d.id)],[[A],[dA,dRoot]]);
  await setAcl(db,owner,'folder',w,B,null);
  assert.deepEqual(await ranks('document',dC),[2,2,1]);
  await setAcl(db,owner,'folder',w,A,{[owner]:'editor',[editor]:'editor',[viewer]:'editor'});
  assert.deepEqual(await ranks('document',dA),[2,2,1]);
  await setAcl(db,owner,'document',w,dA,{[viewer]:'editor',[editor]:'viewer'});
  assert.deepEqual(await ranks('document',dA),[0,1,1]);
  await setAcl(db,owner,'folder',w,A,{[owner]:'editor',[editor]:'editor'});
  assert.deepEqual(await ranks('document',dA),[0,1,0]);
 });
});

test('removal (F12): every ACL key naming the removed member goes with a version bump, and re-joining starts from inheritance only',async(t)=>{
 const [owner,m,other]=[1,2,3].map(uuid);
 const {db,call,step,refuses}=await open(t,[owner,m,other]);
 const w=uuid(10),w2=uuid(11),[Fm,Fo,Fn]=[20,21,22].map(uuid),[Dm,Dn,Do,Dsolo]=[30,31,32,33].map(uuid);
 await call(owner,'create_workspace',[w,'Strip']); await join(db,owner,w,m,'editor'); await join(db,owner,w,other,'viewer');
 for(const f of [Fm,Fo,Fn]) await call(owner,'create_folder',[w,f,null]);
 for(const d of [Dm,Dn,Do,Dsolo]) await call(owner,'create_document',[w,d,Fn,'note',cipher(w,d)]);
 // m is a member of w2 too, with keys on rows that even share ids with w's: a removal from w must leave them alone.
 await call(owner,'create_workspace',[w2,'Elsewhere']); await join(db,owner,w2,m,'editor');
 await call(owner,'create_folder',[w2,Fm,null,{[m]:'editor',[owner]:'editor'}]); await call(owner,'create_document',[w2,Dm,Fm,'note',cipher(w2,Dm)]);
 await setAcl(db,owner,'document',w2,Dm,{[m]:'viewer',[owner]:'editor'});
 const acls=state=>Object.fromEntries([...state.folders,...state.documents].filter(r=>r.workspace_id===w).map(r=>[r.id,{acl:r.acl,version:r.acl_version}]));
 const elsewhere=state=>[...state.folders,...state.documents].filter(r=>r.workspace_id===w2);
 const rank=(u,kind,id)=>withIdentity(db,u,async()=>(await db.query(`select private.${kind}_rank($1,$2) r`,[w,id])).rows[0].r);
 // Grants naming m, decided anew each round (the owner can name m only while it is a member).
 const grant=async()=>{
  for(const [kind,id,acl] of [['folder',Fm,{[m]:'editor',[owner]:'editor'}],['folder',Fo,{[other]:'viewer',[owner]:'editor'}],
   ['document',Dm,{[m]:'viewer',[owner]:'editor',[other]:'viewer'}],['document',Do,{[owner]:'editor'}],['document',Dsolo,{[m]:'editor'}]]) await setAcl(db,owner,kind,w,id,acl);
 };
 for(const [path,remove,audit] of [['set_member',()=>step(owner,'set_member',[w,m,null]),['set_member',owner,m]],['leave_workspace',()=>step(m,'leave_workspace',[w]),['leave_workspace',m,m]]]){
  await t.test(`${path}: only ACLs naming the member change; a stale owner copy cannot put the key back; re-joining revives nothing`,async()=>{
   await grant();
   const s=await remove(),[before,after]=[acls(s.before),acls(s.after)];
   assert.deepEqual(after,Object.fromEntries(Object.entries(before).map(([id,{acl,version}])=>[id,acl&&Object.hasOwn(acl,m)?{acl:Object.fromEntries(Object.entries(acl).filter(([k])=>k!==m)),version:version+1}:{acl,version}])));
   // A grant to m alone becomes {} (nobody), not NULL (everybody); NULL ACLs keep their version; w2 is untouched.
   assert.deepEqual([after[Dsolo].acl,after[Dn],after[Fn]],[{},before[Dn],before[Fn]]);
   assert.deepEqual(elsewhere(s.after),elsewhere(s.before));
   assert.equal(elsewhere(s.after).length,2);
   assert.deepEqual([changedTables(s.before,s.after),workspaceRow(s.after,w).access_epoch-workspaceRow(s.before,w).access_epoch,newAudit(s.before,s.after)],
    [['audit','documents','folders','members','user_signals','workspaces'],1,[audit]]);
   await refuses(owner,'set_folder_acl',[w,Fm,before[Fm].acl,String(before[Fm].version)],'acl_version_mismatch');
   await refuses(owner,'set_document_acl',[w,Dm,before[Dm].acl,String(before[Dm].version)],'acl_version_mismatch');
   await refuses(owner,'set_document_acl',[w,Dm,before[Dm].acl,String(after[Dm].version)],'member_not_found');
   await join(db,owner,w,m,'editor');
   assert.deepEqual([await rank(m,'folder',Fm),await rank(m,'document',Dm),await rank(m,'document',Dsolo),await rank(m,'document',Do),await rank(m,'document',Dn)],[0,0,0,0,2]);
  });
 }
});

test('list RPCs (R5, R6): exact shapes, keyset pages by id with next_id only while more rows exist, [] when empty, only what the caller may see',async(t)=>{
 const [owner,m1,m2,outsider]=[1,2,3,4].map(uuid);
 const {db,call,unchanged,refuses}=await open(t,[owner,m1,m2,outsider]);
 const [w1,w2,w3,w4]=[10,11,12,13].map(uuid),[f1,f2,f3]=[20,21,22].map(uuid),[d1,d2,d3]=[30,31,32].map(uuid);
 for(const [w,name] of [[w1,'One'],[w2,'Two'],[w3,'Three'],[w4,'Four']]) await call(owner,'create_workspace',[w,name]);
 await join(db,owner,w1,m1,'editor'); await join(db,owner,w1,m2,'viewer'); await join(db,owner,w3,m1,'viewer');
 for(const [w,u,role] of [[w2,m1,'editor'],[w4,m1,'viewer'],[w4,m2,'editor'],[w4,outsider,'viewer']]) await call(owner,'invite_member',[w,u,role]);
 await call(owner,'offer_ownership',[w3,m1]); await call(owner,'set_ai_enabled',[w3,true]);
 const invitedAt=async(w,u)=>(await db.query('select private.utc_text(invited_at) t from app.invitations where workspace_id=$1 and user_id=$2',[w,u])).rows[0].t;

 await t.test('list_my_workspaces: memberships only, by id, with role, member_count, ai_enabled and ownership_offered',async()=>{
  const all=[{id:w1,name:'One',role:'editor',member_count:3,ai_enabled:false,ownership_offered:false},{id:w3,name:'Three',role:'viewer',member_count:2,ai_enabled:true,ownership_offered:true}];
  assert.deepEqual(await unchanged(m1,'list_my_workspaces',[]),{workspaces:all,next_id:null});
  assert.deepEqual(await call(m1,'list_my_workspaces',[null,1]),{workspaces:[all[0]],next_id:w1});
  // Exactly the remaining count is no next page; the cursor need not be one of the caller's workspaces.
  assert.deepEqual(await call(m1,'list_my_workspaces',[w1,1]),{workspaces:[all[1]],next_id:null});
  assert.deepEqual(await call(m1,'list_my_workspaces',[w2,500]),{workspaces:[all[1]],next_id:null});
  assert.deepEqual(await call(m1,'list_my_workspaces',[w3]),{workspaces:[],next_id:null});
  const owned=(await call(owner,'list_my_workspaces',[NIL,3])).workspaces.map(x=>[x.id,x.role,x.member_count,x.ownership_offered]);
  assert.deepEqual(owned,[[w1,'owner',3,false],[w2,'owner',1,false],[w3,'owner',2,false]]);
  assert.deepEqual(await call(outsider,'list_my_workspaces',[]),{workspaces:[],next_id:null});
 });

 await t.test("list_my_invitations: the caller's pending invitations by workspace id, with the name; gone once answered",async()=>{
  const all=[{workspace_id:w2,name:'Two',role:'editor',invited_at:await invitedAt(w2,m1)},{workspace_id:w4,name:'Four',role:'viewer',invited_at:await invitedAt(w4,m1)}];
  for(const i of all) assert.match(i.invited_at,TIMESTAMP);
  assert.deepEqual(await unchanged(m1,'list_my_invitations',[]),{invitations:all,next_id:null});
  assert.deepEqual(await call(m1,'list_my_invitations',[null,1]),{invitations:[all[0]],next_id:w2});
  assert.deepEqual(await call(m1,'list_my_invitations',[w2,1]),{invitations:[all[1]],next_id:null});
  assert.deepEqual((await call(m2,'list_my_invitations',[])).invitations.map(i=>[i.workspace_id,i.role]),[[w4,'editor']]);
  await call(m1,'respond_invitation',[w4,false]);
  assert.deepEqual(await call(m1,'list_my_invitations',[]),{invitations:[all[0]],next_id:null});
  assert.deepEqual(await call(owner,'list_my_invitations',[]),{invitations:[],next_id:null});
 });

 await t.test('list_members: members of that workspace by user id, never invitees, with the access_epoch the list is valid for',async()=>{
  const access_epoch=String(workspaceRow(await appState(db),w1).access_epoch);
  const all=[{user_id:owner,role:'owner'},{user_id:m1,role:'editor'},{user_id:m2,role:'viewer'}];
  assert.deepEqual(await unchanged(m2,'list_members',[w1]),{members:all,next_id:null,access_epoch});
  assert.deepEqual(await call(m2,'list_members',[w1,null,2]),{members:all.slice(0,2),next_id:m1,access_epoch});
  assert.deepEqual(await call(m2,'list_members',[w1,m1,1]),{members:all.slice(2),next_id:null,access_epoch});
  assert.deepEqual(await call(m2,'list_members',[w1,m2]),{members:[],next_id:null,access_epoch});
  assert.deepEqual((await call(owner,'list_members',[w4])).members,[{user_id:owner,role:'owner'}]);
 });

 await t.test("list_invitations: the owner's view by user id, with invited_at and the pending ownership offer",async()=>{
  const all=[{user_id:m2,role:'editor',invited_at:await invitedAt(w4,m2)},{user_id:outsider,role:'viewer',invited_at:await invitedAt(w4,outsider)}];
  assert.deepEqual(await unchanged(owner,'list_invitations',[w4]),{invitations:all,next_id:null,pending_owner_id:null});
  assert.deepEqual(await call(owner,'list_invitations',[w4,null,1]),{invitations:[all[0]],next_id:m2,pending_owner_id:null});
  assert.deepEqual(await call(owner,'list_invitations',[w4,m2,1]),{invitations:[all[1]],next_id:null,pending_owner_id:null});
  assert.deepEqual(await call(owner,'list_invitations',[w3]),{invitations:[],next_id:null,pending_owner_id:m1});
  await refuses(m1,'list_invitations',[w3],'forbidden');
 });

 await t.test('list_folders: visible folders by id; a hidden folder is neither listed nor counted in a page',async()=>{
  await call(owner,'create_folder',[w1,f1,null]); await call(owner,'create_folder',[w1,f2,null,{[owner]:'editor',[m1]:'viewer'}]); await call(owner,'create_folder',[w1,f3,f1]);
  const [one,three]=[{id:f1,parent_id:null,can_edit:false},{id:f3,parent_id:f1,can_edit:false}];
  assert.deepEqual(await unchanged(m2,'list_folders',[w1]),{folders:[one,three],next_id:null});
  assert.deepEqual(await call(m2,'list_folders',[w1,null,1]),{folders:[one],next_id:f1});
  assert.deepEqual(await call(m2,'list_folders',[w1,f1,1]),{folders:[three],next_id:null});
  assert.deepEqual((await call(m1,'list_folders',[w1])).folders.map(f=>[f.id,f.can_edit]),[[f1,true],[f2,false],[f3,true]]);
  assert.deepEqual(await call(m1,'list_folders',[w3]),{folders:[],next_id:null});
 });

 await t.test('list_acls: every folder or document with its ACL and version, rows that hide from the owner included; never content',async()=>{
  await call(m1,'create_document',[w1,d1,f1,'note',cipher(w1,d1)]);
  await call(m1,'create_document',[w1,d2,null,'agenda',cipher(w1,d2)]); await setAcl(db,owner,'document',w1,d2,{[m1]:'editor'});
  await call(m1,'create_document',[w1,d3,null,'meeting',cipher(w1,d3)]); await call(m1,'push_document',[w1,d3,uuid(50),'1',cipher(w1,d3),true]);
  const deletedAt=(await db.query('select private.utc_text(deleted_at) t from app.documents where workspace_id=$1 and id=$2',[w1,d3])).rows[0].t;
  assert.match(deletedAt,TIMESTAMP);
  assert.equal((await call(owner,'list_accessible_documents',[w1])).documents.some(d=>d.id===d2),false);
  const folders=[{id:f1,parent_id:null,acl:null,acl_version:'1'},{id:f2,parent_id:null,acl:{[owner]:'editor',[m1]:'viewer'},acl_version:'1'},{id:f3,parent_id:f1,acl:null,acl_version:'1'}];
  const documents=[{id:d1,folder_id:f1,deleted:false,deleted_at:null,purged:false,acl:null,acl_version:'1'},{id:d2,folder_id:null,deleted:false,deleted_at:null,purged:false,acl:{[m1]:'editor'},acl_version:'2'},
   {id:d3,folder_id:null,deleted:true,deleted_at:deletedAt,purged:false,acl:null,acl_version:'1'}];
  for(const [kind,list] of [['folder',folders],['document',documents]]){
   assert.deepEqual(await unchanged(owner,'list_acls',[w1,kind]),{entries:list,next_id:null});
   assert.deepEqual(await call(owner,'list_acls',[w1,kind,null,2]),{entries:list.slice(0,2),next_id:list[1].id});
   assert.deepEqual(await call(owner,'list_acls',[w1,kind,list[1].id,1]),{entries:list.slice(2),next_id:null});
   assert.deepEqual(await call(owner,'list_acls',[w2,kind]),{entries:[],next_id:null});
  }
  // The kind is checked before the limit.
  await refuses(owner,'list_acls',[w1,'bad',null,0],'invalid_request');
  await refuses(owner,'list_acls',[w1,null],'invalid_request');
 });
});

test('I1/I2: access_epoch moves exactly once per access change and never otherwise; head, revision and journal move only with content',async(t)=>{
 const [owner,ed,vi,inv]=[1,2,3,4].map(uuid);
 const {db,call}=await open(t,[owner,ed,vi,inv]);
 const w=uuid(10),[F,G]=[20,21].map(uuid),d=uuid(30);
 await call(owner,'create_workspace',[w,'Ledger']);
 let op=100; const nextOp=()=>uuid(op++);
 const as=(u,n,a)=>()=>call(u,n,a);
 // [what, the writer (for journal rows), action, epoch steps, content writes: each is one head step, one journal row and
 // one revision of d]
 const ledger=[
  ['invite',null,as(owner,'invite_member',[w,ed,'editor']),0,0],
  ['accept',null,as(ed,'respond_invitation',[w,true]),1,0],
  ['invite',null,as(owner,'invite_member',[w,vi,'viewer']),0,0],
  ['accept',null,as(vi,'respond_invitation',[w,true]),1,0],
  ['invite',null,as(owner,'invite_member',[w,inv,'viewer']),0,0],
  ['decline',null,as(inv,'respond_invitation',[w,false]),0,0],
  ['invite',null,as(owner,'invite_member',[w,inv,'editor']),0,0],
  ['revoke',null,as(owner,'invite_member',[w,inv,null]),0,0],
  ['role change',null,as(owner,'set_member',[w,vi,'editor']),1,0],
  ['role change back',null,as(owner,'set_member',[w,vi,'viewer']),1,0],
  ['the same role',null,as(owner,'set_member',[w,vi,'viewer']),0,0],
  ['offer',null,as(owner,'offer_ownership',[w,ed]),0,0],
  ['cancel',null,as(owner,'offer_ownership',[w,null]),0,0],
  ['create a folder',null,as(owner,'create_folder',[w,F,null]),0,0],
  ['create a restricted folder',null,as(owner,'create_folder',[w,G,null,{[owner]:'editor'}]),0,0],
  ['folder ACL',null,()=>setAcl(db,owner,'folder',w,F,{[owner]:'editor',[ed]:'editor',[vi]:'viewer'}),1,0],
  ['the same folder ACL',null,()=>setAcl(db,owner,'folder',w,F,{[vi]:'viewer',[ed]:'editor',[owner]:'editor'}),0,0],
  ['AI on',null,as(owner,'set_ai_enabled',[w,true]),0,0],
  ['AI off',null,as(owner,'set_ai_enabled',[w,false]),0,0],
  ['create',ed,as(ed,'create_document',[w,d,F,'note',cipher(w,d)]),0,1],
  ['document ACL',null,()=>setAcl(db,owner,'document',w,d,{[ed]:'editor',[vi]:'viewer'}),1,0],
  ['edit',ed,as(ed,'push_document',[w,d,nextOp(),'1',cipher(w,d,1,'b')]),0,1],
  ['stale edit (conflict)',null,as(ed,'push_document',[w,d,nextOp(),'1',cipher(w,d,1,'c')]),0,0],
  ['delete',ed,as(ed,'push_document',[w,d,nextOp(),'2',cipher(w,d,1,'b'),true]),0,1],
  ['push to the deleted document',null,as(ed,'push_document',[w,d,nextOp(),'3',cipher(w,d,1,'b')]),0,0],
  ['restore',ed,as(ed,'restore_document',[w,d,nextOp(),'3']),0,1],
  ['restore a live document (conflict)',null,as(ed,'restore_document',[w,d,nextOp(),'4']),0,0],
  ['delete again',ed,as(ed,'push_document',[w,d,nextOp(),'4',cipher(w,d,1,'b'),true]),0,1],
  ['purge after 720 hours',null,async()=>{ await deletedAgo(db,w,d,720); assert.deepEqual(await asMaintainer(db,()=>rpc(db,'purge_expired_trash',[])),{purged:1,more:false}); },0,0],
  ['restore after the window',null,()=>assert.rejects(call(ed,'restore_document',[w,d,nextOp(),'5']),rejected('restore_expired')),0,0],
  ['offer',null,as(owner,'offer_ownership',[w,ed]),0,0],
  ['transfer',null,as(ed,'accept_ownership',[w]),1,0],
  ['the old owner leaves',null,as(owner,'leave_workspace',[w]),1,0],
  ['removal',null,as(ed,'set_member',[w,vi,null]),1,0],
  ['removing a non-member',null,as(ed,'set_member',[w,vi,null]),0,0],
  ['invite the removed member',null,as(ed,'invite_member',[w,vi,'viewer']),0,0],
  ['account deletion of an invitee',null,()=>deleteUserAsAuthAdmin(db,vi),0,0],
  ['invite',null,as(ed,'invite_member',[w,inv,'viewer']),0,0],
  ['accept',null,as(inv,'respond_invitation',[w,true]),1,0],
  ['account deletion of a member',null,()=>deleteUserAsAuthAdmin(db,inv),1,0],
 ];
 const revisionOf=state=>rows(state,'documents',{workspace_id:w,id:d})[0]?.revision??0;
 for(const [what,writer,action,epoch,writes] of ledger){
  const before=await appState(db); await action(); const after=await appState(db);
  const [b,a]=[workspaceRow(before,w),workspaceRow(after,w)];
  assert.deepEqual({epoch:a.access_epoch-b.access_epoch,head:a.head-b.head,journal:after.journal.length-before.journal.length,revision:revisionOf(after)-revisionOf(before)},
   {epoch,head:writes,journal:writes,revision:writes},what);
  // A content write appends the document's snapshot at its new revision, by the writer, at the new head.
  if(writes) assert.deepEqual(newRows(before,after,'journal').map(r=>[r.seq,r.document_id,r.actor_id,r.snapshot.revision]),[[a.head,d,writer,String(revisionOf(after))]],what);
 }
});

test('trash and restore (F27, C101): a delete keeps the content for editors; restore answers applied, conflict, deleted or restore_expired',async(t)=>{
 const [owner,ed1,ed2,vi,reader]=[1,2,3,4,5].map(uuid); // reader: an editor whose entry in folder R is 'viewer'
 const {db,call,dryRun,step,refuses,unchanged}=await open(t,[owner,ed1,ed2,vi,reader]);
 const w=uuid(10),R=uuid(20),[d,e,f,g]=[30,31,32,33].map(uuid),content=cipher(w,d,1,'c'),editOp=uuid(99);
 let op=100; const nextOp=()=>uuid(op++);
 const everyone={[owner]:1,[ed1]:1,[ed2]:1,[vi]:1,[reader]:1};
 const docRow=(state,id)=>rows(state,'documents',{workspace_id:w,id})[0];
 const snapshot=(id,ciphertext,revision,deleted)=>({id,workspace_id:w,folder_id:null,kind:'note',ciphertext,key_epoch:1,revision,deleted});
 await call(owner,'create_workspace',[w,'Trash']);
 for(const [u,role] of [[ed1,'editor'],[ed2,'editor'],[vi,'viewer'],[reader,'editor']]) await join(db,owner,w,u,role);
 await call(owner,'create_folder',[w,R,null,{[owner]:'editor',[ed1]:'editor',[ed2]:'editor',[vi]:'viewer',[reader]:'viewer'}]);
 await call(ed1,'create_document',[w,d,null,'note',cipher(w,d)]); await call(ed1,'push_document',[w,d,editOp,'1',content]); // d: revision 2
 // w2 holds a deleted document with d's id (ids are unique per workspace only): nothing done in w may touch it.
 const w2=uuid(11),inW2=state=>Object.fromEntries(Object.entries(state).map(([table,list])=>[table,list.filter(r=>r.workspace_id===w2||(table==='workspaces'&&r.id===w2))]));
 await call(owner,'create_workspace',[w2,'Other trash']); for(const u of [ed1,ed2]) await join(db,owner,w2,u,'editor');
 await call(ed2,'create_document',[w2,d,null,'note',cipher(w2,d)]); await call(ed2,'push_document',[w2,d,nextOp(),'1',cipher(w2,d),true]);
 const w2Before=inW2(await appState(db));

 await t.test('a delete is a write like any other (revision, journal, receipt, signals), and the stored content stays for a restore',async()=>{
  const delOp=nextOp(),args=[w,d,delOp,'2',cipher(w,d,1,'z'),true],s=await step(ed1,'push_document',args),head=workspaceRow(s.before,w).head+1;
  assert.deepEqual([s.result,changedTables(s.before,s.after)],[{op_id:delOp,document_id:d,status:'applied',revision:'3',head:String(head)},['audit','documents','journal','receipts','user_signals','workspaces']]);
  assert.deepEqual(workspaceRow(s.after,w),{...workspaceRow(s.before,w),head});
  // The request's ciphertext is validated and hashed but not stored: a deleter cannot plant trash content.
  const now=docRow(s.after,d);
  assert.match(now.deleted_at,/^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(now,{...docRow(s.before,d),deleted:true,deleted_at:now.deleted_at,revision:3});
  assert.deepEqual(now.ciphertext,content);
  // Clients read a tombstone: the journal snapshot carries no content.
  assert.deepEqual(newRows(s.before,s.after,'journal').map(r=>[r.seq,r.document_id,r.actor_id,r.snapshot]),[[head,d,ed1,snapshot(d,null,'3',true)]]);
  assert.deepEqual([newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],[[['document_revision',ed1,d]],everyone]);
  assert.deepEqual(await unchanged(ed1,'push_document',args),s.result);
 });

 await t.test("then every other push is answered 'deleted' at the current revision, before any revision comparison, and stored",async()=>{
  for(const [base,deleted] of [['3',false],['3',true],['2',false],['1',true],['9',false]]){
   const pushOp=nextOp(),args=[w,d,pushOp,base,cipher(w,d,1,'y'),deleted],s=await step(ed2,'push_document',args);
   assert.deepEqual([s.result,changedTables(s.before,s.after)],[{op_id:pushOp,document_id:d,status:'deleted',revision:'3',head:String(workspaceRow(s.before,w).head)},['receipts']]);
   assert.deepEqual(await unchanged(ed2,'push_document',args),s.result);
  }
 });

 await t.test('list_trash: what the caller may restore (document_rank >= 2) with its content, by id, under the byte budget; never for readers',async()=>{
  for(const [id,folder] of [[e,R],[f,null]]){ await call(ed1,'create_document',[w,id,folder,'agenda',cipher(w,id)]); await call(ed1,'push_document',[w,id,nextOp(),'1',cipher(w,id),true]); }
  const entry=async(id,folder,kind,ciphertext,revision)=>{
   const {a,p}=(await db.query("select private.utc_text(deleted_at) a,private.utc_text(deleted_at+interval '720 hours') p from app.documents where workspace_id=$1 and id=$2",[w,id])).rows[0];
   return {id,folder_id:folder,kind,key_epoch:1,revision,deleted_at:a,purge_after:p,ciphertext};
  };
  const all=[await entry(d,null,'note',content,'3'),await entry(e,R,'agenda',cipher(w,e),'2'),await entry(f,null,'agenda',cipher(w,f),'2')];
  for(const x of all){ assert.match(x.deleted_at,TIMESTAMP); assert.match(x.purge_after,TIMESTAMP); }
  const state=workspaceRow(await appState(db),w);
  const page=(documents,next_id)=>({documents,next_id,head:String(state.head),access_epoch:String(state.access_epoch)});
  assert.deepEqual(await unchanged(ed2,'list_trash',[w]),page(all,null));
  // The reader may only read in R, so e is not its to restore; readers get nothing, in either keyset branch.
  assert.deepEqual(await call(reader,'list_trash',[w]),page([all[0],all[2]],null));
  for(const args of [[w],[w,null,1],[w,NIL],[w,d,500]]) assert.deepEqual(await call(vi,'list_trash',args),page([],null));
  // Pages by id: next_id while more follow, null on an exact fit.
  assert.deepEqual(await call(ed2,'list_trash',[w,null,1]),page([all[0]],d));
  assert.deepEqual(await call(ed2,'list_trash',[w,d,1]),page([all[1]],e));
  assert.deepEqual(await call(ed2,'list_trash',[w,d,2]),page(all.slice(1),null));
  assert.deepEqual(await call(ed2,'list_trash',[w,f]),page([],null));
  // The byte budget: entries while they fit, the first one always; next_id is then the last included id.
  const sizes=await Promise.all(all.map(async x=>(await db.query('select octet_length($1::jsonb::text) n',[x])).rows[0].n));
  const shipped=(await db.query("select pg_get_functiondef('private.page_budget()'::regprocedure) d")).rows[0].d;
  const withBudget=async(budget,fn)=>{ await db.exec(`create or replace function private.page_budget() returns integer language sql immutable set search_path=pg_catalog as $$ select ${budget} $$`); try { return await fn(); } finally { await db.exec(shipped); } };
  assert.deepEqual(await withBudget(sizes[0]+sizes[1],()=>call(ed2,'list_trash',[w])),page(all.slice(0,2),e));
  assert.deepEqual(await withBudget(sizes[0]+sizes[1]-1,()=>call(ed2,'list_trash',[w])),page(all.slice(0,1),d));
  assert.deepEqual(await withBudget(1,()=>call(ed2,'list_trash',[w,d])),page(all.slice(1,2),e));
  assert.equal((await db.query('select private.page_budget() b')).rows[0].b,4194304);
  // An owner left out by the document ACL does not see the entry either.
  await setAcl(db,owner,'document',w,f,{[ed1]:'editor'});
  assert.deepEqual((await call(owner,'list_trash',[w])).documents.map(x=>x.id),[d,e]);
  await setAcl(db,owner,'document',w,f,null);
 });

 await t.test('restore checks access, then arguments, then the replay, then the state; refusals store nothing',async()=>{
  for(const [u,args] of [[vi,[w,d,nextOp(),'3']],[vi,[w,d,null,'x']],[reader,[w,e,nextOp(),'2']],[ed1,[w,uuid(39),nextOp(),'1']]]) await refuses(u,'restore_document',args,'forbidden');
  for(const [opId,base] of [[null,'3'],[nextOp(),null],[nextOp(),'0'],[nextOp(),'03'],[nextOp(),' 3'],[nextOp(),'3.0'],[nextOp(),'-3'],[nextOp(),'9223372036854775808'],[nextOp(),'1'.repeat(20)]]) await refuses(ed1,'restore_document',[w,d,opId,base],'invalid_request');
  // A stale base: 'deleted' with the current revision to retry with, stored.
  const staleOp=nextOp(),s=await step(ed2,'restore_document',[w,d,staleOp,'2']);
  assert.deepEqual([s.result,changedTables(s.before,s.after)],[{op_id:staleOp,document_id:d,status:'deleted',revision:'3',head:String(workspaceRow(s.before,w).head)},['receipts']]);
  assert.deepEqual(await unchanged(ed2,'restore_document',[w,d,staleOp,'2']),s.result);
  // One op id namespace with push and create (d's create receipt is keyed by d); arguments are checked before the replay.
  for(const [u,opId,base] of [[ed2,staleOp,'3'],[ed1,editOp,'3'],[ed1,d,'3']]) await refuses(u,'restore_document',[w,d,opId,base],'op_id_reused');
  await refuses(ed2,'restore_document',[w,d,staleOp,'x'],'invalid_request');
 });

 await t.test('an applied restore: live again with the kept content, revision +1, one journal row by the restorer, no epoch bump (I1, I2)',async()=>{
  const restoreOp=nextOp(),s=await step(ed2,'restore_document',[w,d,restoreOp,'3']),head=workspaceRow(s.before,w).head+1;
  assert.deepEqual([s.result,changedTables(s.before,s.after)],[{op_id:restoreOp,document_id:d,status:'applied',revision:'4',head:String(head)},['audit','documents','journal','receipts','user_signals','workspaces']]);
  assert.deepEqual([workspaceRow(s.after,w),docRow(s.after,d)],[{...workspaceRow(s.before,w),head},{...docRow(s.before,d),deleted:false,deleted_at:null,revision:4}]);
  assert.deepEqual(newRows(s.before,s.after,'journal').map(r=>[r.seq,r.document_id,r.actor_id,r.snapshot]),[[head,d,ed2,snapshot(d,content,'4',false)]]);
  assert.deepEqual([newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],[[['document_revision',ed2,d],['restore_document',ed2,d]],everyone]);
  assert.deepEqual(await unchanged(ed2,'restore_document',[w,d,restoreOp,'3']),s.result);
  const epoch=String(workspaceRow(s.after,w).access_epoch);
  assert.deepEqual((await call(vi,'get_documents',[w,[d],epoch])).documents.map(x=>[x.deleted,x.ciphertext,x.revision]),[[false,content,'4']]);
  assert.ok((await call(vi,'list_accessible_documents',[w])).documents.some(x=>x.id===d));
  // A live document is 'conflict' at its revision whatever the base, stored; it has left the trash.
  for(const base of ['4','3','1']){
   const liveOp=nextOp(),c=await step(ed1,'restore_document',[w,d,liveOp,base]);
   assert.deepEqual([c.result,changedTables(c.before,c.after)],[{op_id:liveOp,document_id:d,status:'conflict',revision:'4',head:String(head)},['receipts']]);
  }
  assert.equal((await call(ed1,'list_trash',[w])).documents.some(x=>x.id===d),false);
  assert.equal((await call(ed1,'push_document',[w,d,nextOp(),'4',cipher(w,d,1,'n')])).status,'applied');
 });

 await t.test('720 hours after the delete: restore_expired, purged or not, with nothing stored; a stale base still learns the revision first',async()=>{
  await call(ed1,'create_document',[w,g,null,'note',cipher(w,g)]); await call(ed1,'push_document',[w,g,nextOp(),'1',cipher(w,g),true]); // g: deleted at revision 2
  await deletedAgo(db,w,g,719);
  assert.equal((await dryRun(ed1,'restore_document',[w,g,nextOp(),'2'])).status,'applied');
  assert.ok((await call(ed1,'list_trash',[w])).documents.some(x=>x.id===g));
  await deletedAgo(db,w,g,720);
  const expiredOp=nextOp();
  for(let i=0;i<2;i++) await refuses(ed1,'restore_document',[w,g,expiredOp,'2'],'restore_expired');
  assert.equal((await call(ed1,'list_trash',[w])).documents.some(x=>x.id===g),false);
  assert.deepEqual(docRow(await appState(db),g).ciphertext,cipher(w,g)); // no purge has run yet
  const staleOp=nextOp();
  assert.equal((await call(ed1,'restore_document',[w,g,staleOp,'1'])).status,'deleted');
  // Purged content is gone for good: restore_expired even if the deletion time were inside the window again.
  assert.deepEqual(await asMaintainer(db,()=>rpc(db,'purge_expired_trash',[])),{purged:1,more:false});
  await deletedAgo(db,w,g,1);
  await refuses(ed1,'restore_document',[w,g,nextOp(),'2'],'restore_expired');
  assert.equal((await call(ed1,'list_trash',[w])).documents.some(x=>x.id===g),false);
  assert.equal((await unchanged(ed1,'restore_document',[w,g,staleOp,'1'])).status,'deleted'); // a stored answer is replayed
 });

 await t.test('the window is 720 hours, not 30 days: a DST change in the session time zone does not move it',async()=>{
  // US DST starts on 2026-03-08: 30 days of New York wall time from 2026-03-01 12:00Z would end at 11:00Z.
  const ends=await inTransaction(db,["set local timezone='America/New_York'"],async()=>(await db.query("select private.trash_retention()::text retention,to_char(('2026-03-01 12:00+00'::timestamptz+private.trash_retention()) at time zone 'UTC','YYYY-MM-DD HH24:MI') ends")).rows[0]);
  assert.deepEqual(ends,{retention:'720:00:00',ends:'2026-03-31 12:00'});
 });

 await t.test('the documents table itself refuses a live document without content and a deletion flag without its time',async()=>{
  const write=(set,id)=>db.query(`update app.documents set ${set} where workspace_id=$1 and id=$2`,[w,id]);
  const violates=constraint=>({code:'23514',constraint});
  // d is live, e is in the trash, g is purged.
  await assert.rejects(write('ciphertext=null',d),violates('documents_content_check'));
  await assert.rejects(write('deleted_at=clock_timestamp()',d),violates('documents_deleted_at_check'));
  for(const id of [e,g]) await assert.rejects(write('deleted_at=null',id),violates('documents_deleted_at_check'));
  await assert.rejects(write('deleted=false,deleted_at=null',g),violates('documents_content_check'));
 });

 await t.test("w2's document with d's id went through every delete, list, restore and purge in w untouched",async()=>{
  assert.deepEqual(inW2(await appState(db)),w2Before);
  assert.deepEqual((await call(ed2,'list_trash',[w2])).documents.map(x=>[x.id,x.revision,x.ciphertext]),[[d,'2',cipher(w2,d)]]);
 });
});

test('the AI switch (F29 minimum, sync side): off by default; only the owner flips it, with no epoch bump; an unchanged value writes nothing',async(t)=>{
 const [owner,editor]=[1,2].map(uuid);
 const {db,call,step,refuses,unchanged}=await open(t,[owner,editor]);
 const w=uuid(10);
 await call(owner,'create_workspace',[w,'AI']); await join(db,owner,w,editor,'editor');
 assert.equal(workspaceRow(await appState(db),w).ai_enabled,false);
 assert.deepEqual(await unchanged(owner,'set_ai_enabled',[w,false]),{ai_enabled:false,changed:false});
 for(const value of [true,false]){
  const s=await step(owner,'set_ai_enabled',[w,value]);
  assert.deepEqual([s.result,changedTables(s.before,s.after),workspaceRow(s.after,w),newAudit(s.before,s.after),signalDelta(s.before,s.after,w)],
   [{ai_enabled:value,changed:true},['audit','user_signals','workspaces'],{...workspaceRow(s.before,w),ai_enabled:value},[['set_ai_enabled',owner,null]],{[owner]:1,[editor]:1}]);
  assert.deepEqual(await unchanged(owner,'set_ai_enabled',[w,value]),{ai_enabled:value,changed:false});
  assert.equal((await call(editor,'list_my_workspaces',[])).workspaces[0].ai_enabled,value);
 }
 for(const [u,args,reason] of [[editor,[w,true],'forbidden'],[editor,[w,null],'forbidden'],[owner,[w,null],'invalid_request']]) await refuses(u,'set_ai_enabled',args,reason);
});

test('purge_expired_trash (F27): sync_maintainer only; one workspace per call, lowest id first; every statement scoped to (workspace, document); invisible to clients (I1)',async(t)=>{
 const [owner,ed]=[1,2].map(uuid);
 const {db,call,refuses}=await open(t,[owner,ed]);
 const [wa,wb]=[10,11].map(uuid),[D,K,L,M]=[30,31,32,33].map(uuid);
 let op=100; const nextOp=()=>uuid(op++);
 const purge=(...limit)=>asMaintainer(db,()=>rpc(db,'purge_expired_trash',limit));
 for(const w of [wa,wb]){ await call(owner,'create_workspace',[w,'Purge']); await join(db,owner,w,ed,'editor'); }
 // The same document id D in both workspaces, edited, with a key envelope per member and an attachment.
 for(const [w,n] of [[wa,1],[wb,2]]){
  await call(ed,'create_document',[w,D,null,'note',cipher(w,D)]); await call(ed,'push_document',[w,D,nextOp(),'1',cipher(w,D,1,'b')]);
  for(const u of [owner,ed]) await db.query("insert into app.key_envelopes values($1,$2,$3,1,'{}')",[w,D,u]);
  await db.query("insert into app.attachments values($1,$2,$3,$4,'digest',1)",[w,D,uuid(90+n),`synthetic/${n}/D`]);
 }
 // wa also holds K (expired at exactly 720 hours), L (719 hours) and M (live, with an attachment).
 for(const id of [K,L,M]) await call(ed,'create_document',[wa,id,null,'note',cipher(wa,id)]);
 await db.query("insert into app.attachments values($1,$2,$3,'synthetic/1/M','digest',1)",[wa,M,uuid(95)]);
 for(const [w,id,base] of [[wa,D,'2'],[wa,K,'1'],[wa,L,'1'],[wb,D,'2']]) await call(ed,'push_document',[w,id,nextOp(),base,cipher(w,id,1,'b'),true]);
 for(const [w,id,hours] of [[wa,D,721],[wa,K,720],[wa,L,719],[wb,D,24]]) await deletedAgo(db,w,id,hours);
 // The database after purging the listed (workspace, document) pairs, from the snapshot before: the content leaves the
 // document, its journal snapshots, its key envelopes and its attachments (paths queued for Storage), with one audit row
 // without actor per document. No revision, journal row, head, epoch or signal changes. New rows are checked, then taken
 // from after (their ids and times are unknown).
 const afterPurge=(before,after,pairs)=>{
  const hit=(w,id)=>pairs.some(([pw,pid])=>pw===w&&pid===id);
  const audit=newRows(before,after,'audit'),queued=newRows(before,after,'storage_deletions');
  assert.deepEqual(audit.map(({workspace_id,actor_id,action,target_id,head,access_epoch})=>canonical({workspace_id,actor_id,action,target_id,head,access_epoch})).sort(byText),
   pairs.map(([w,id])=>{ const x=workspaceRow(before,w); return canonical({workspace_id:w,actor_id:null,action:'purge_document',target_id:id,head:x.head,access_epoch:x.access_epoch}); }).sort(byText));
  assert.deepEqual(queued.map(r=>[r.path,r.workspace_id]).sort(),before.attachments.filter(r=>hit(r.workspace_id,r.document_id)).map(r=>[r.storage_path,r.workspace_id]).sort());
  return {...before,
   // purged is the stored generated column (ciphertext is null).
   documents:before.documents.map(r=>hit(r.workspace_id,r.id)?{...r,ciphertext:null,purged:true}:r),
   journal:before.journal.map(r=>hit(r.workspace_id,r.document_id)?{...r,snapshot:{...r.snapshot,ciphertext:null}}:r),
   key_envelopes:before.key_envelopes.filter(r=>!hit(r.workspace_id,r.document_id)),
   attachments:before.attachments.filter(r=>!hit(r.workspace_id,r.document_id)),
   audit:[...before.audit,...audit],storage_deletions:[...before.storage_deletions,...queued]};
 };
 const purged=async(limit,expected,pairs,runner=purge)=>{
  const before=await appState(db);
  assert.deepEqual(await runner(...limit),expected);
  const after=await appState(db);
  assert.deepEqual(asSets(after),asSets(afterPurge(before,after,pairs)));
 };

 await t.test('only sync_maintainer may run it, with a limit of 1..500; refusals change nothing; the role itself is narrow',async()=>{
  const before=await appState(db);
  for(const u of [owner,ed]) await assert.rejects(call(u,'purge_expired_trash',[100]),{code:'42501',message:'permission denied for function purge_expired_trash'});
  await assert.rejects(inTransaction(db,['set local role anon'],()=>rpc(db,'purge_expired_trash',[100])),{code:'42501'});
  for(const limit of [0,-1,501,null]) await assert.rejects(purge(limit),rejected('invalid_limit'));
  assert.deepEqual(await appState(db),before);
  // The purge works on its definer's rights only: the maintainer can log in nowhere, owns nothing and reads no schema.
  assert.deepEqual((await db.query("select rolcanlogin,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,pg_has_role('sync_maintainer','sync_backend','MEMBER') backend from pg_roles where rolname='sync_maintainer'")).rows,
   [{rolcanlogin:false,rolsuper:false,rolinherit:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolbypassrls:false,backend:false}]);
  for(const statement of ['select 1 from app.documents','select private.trash_retention()']) await assert.rejects(asMaintainer(db,()=>db.query(statement)),{code:'42501'});
 });

 await t.test('a call purges the lowest workspace with expired trash, up to the limit by id, and tells whether more remain; clients read the same (I1)',async()=>{
  const reads=async()=>{ const m=await call(ed,'list_accessible_documents',[wa]); return {m,pull:await call(ed,'pull_changes',[wa,'0',500,m.access_epoch]),docs:await call(ed,'get_documents',[wa,[D,K,L,M],m.access_epoch])}; };
  const seen=await reads();
  await purged([1],{purged:1,more:true},[[wa,D]]);
  await purged([],{purged:1,more:false},[[wa,K]]);
  assert.deepEqual(await reads(),seen);
  // L (719 hours) and wb's D (24 hours) are inside the window.
  await purged([500],{purged:0,more:false},[]);
 });

 await t.test('the same document id elsewhere is untouched until its own window ends; then each workspace is purged in its own call',async()=>{
  await deletedAgo(db,wa,L,720); await deletedAgo(db,wb,D,720);
  // This maintainer session carries a JWT subject: the purge must neither need it nor record it (R2).
  const withSubject=(...limit)=>inTransaction(db,['set local role sync_maintainer',["select set_config('request.jwt.claim.sub',$1,true)",[owner]]],()=>rpc(db,'purge_expired_trash',limit));
  await purged([],{purged:1,more:true},[[wa,L]],withSubject);
  await purged([],{purged:1,more:false},[[wb,D]]);
  const after=await appState(db);
  assert.deepEqual(after.storage_deletions.map(r=>[r.path,r.workspace_id]).sort(),[['synthetic/1/D',wa],['synthetic/2/D',wb]].sort());
  assert.deepEqual(after.attachments.map(r=>r.storage_path),['synthetic/1/M']); // M is live
 });

 await t.test('afterwards restore is restore_expired, the trash lists nothing, and list_acls shows the documents purged',async()=>{
  for(const [w,id,base] of [[wa,D,'3'],[wa,K,'2'],[wa,L,'2'],[wb,D,'3']]) await refuses(ed,'restore_document',[w,id,nextOp(),base],'restore_expired');
  for(const w of [wa,wb]) assert.deepEqual((await call(ed,'list_trash',[w])).documents,[]);
  assert.deepEqual((await call(owner,'list_acls',[wa,'document'])).entries.map(x=>[x.id,x.deleted,x.purged]),[[D,true,true],[K,true,true],[L,true,true],[M,false,false]]);
 });
});

// The database after deleting account u, from the snapshot before (F24). Workspaces in `solo` (u is their only member)
// go with every row. Elsewhere u's membership goes as one anonymous removal per workspace: ACL keys stripped with a
// version bump, the offer cleared, the epoch +1, the remaining members signalled. u's invitations, receipts, signals and
// key envelopes go; the members of a workspace where u had a pending invitation are signalled as after a decline (their
// existing rows only, SEC-2); journal and audit rows stay with u unlinked. The rows the deletion adds (one removal audit
// row per workspace, the storage queue) are checked, then taken from after (their ids and times are unknown).
function afterDeletion(before,after,u,solo){
 for(const w of solo) assert.deepEqual(rows(before,'members',{workspace_id:w}).map(m=>[m.user_id,m.role]),[[u,'owner']],'fixture: u is the only member');
 const kept=r=>!solo.includes(r.workspace_id),left=rows(before,'members',{user_id:u}).filter(kept).map(m=>m.workspace_id);
 const invited=rows(before,'invitations',{user_id:u}).map(i=>i.workspace_id);
 const remaining=w=>before.members.filter(m=>m.workspace_id===w&&m.user_id!==u).map(m=>m.user_id);
 const unlink=(r,keys)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,keys.includes(k)&&v===u?null:v]));
 const strip=r=>left.includes(r.workspace_id)&&r.acl&&Object.hasOwn(r.acl,u)?{...r,acl:Object.fromEntries(Object.entries(r.acl).filter(([k])=>k!==u)),acl_version:r.acl_version+1}:r;
 const signals=before.user_signals.filter(r=>kept(r)&&r.user_id!==u).map(r=>(left.includes(r.workspace_id)||invited.includes(r.workspace_id))&&remaining(r.workspace_id).includes(r.user_id)?{...r,generation:r.generation+1}:r);
 for(const w of left) for(const m of remaining(w)) if(!signals.some(r=>r.workspace_id===w&&r.user_id===m)) signals.push({user_id:m,workspace_id:w,generation:1});
 const added=newRows(before,after,'audit'),queued=newRows(before,after,'storage_deletions');
 assert.deepEqual(added.map(({workspace_id,actor_id,action,target_id,head,access_epoch})=>canonical({workspace_id,actor_id,action,target_id,head,access_epoch})).sort(byText),
  left.map(w=>{ const x=workspaceRow(before,w); return canonical({workspace_id:w,actor_id:null,action:'account_deleted',target_id:null,head:x.head,access_epoch:x.access_epoch+1}); }).sort(byText),'one anonymous removal row per workspace left');
 assert.deepEqual(queued.map(r=>[r.path,r.workspace_id]).sort(),before.attachments.filter(r=>!kept(r)).map(r=>[r.storage_path,r.workspace_id]).sort(),'attachment paths of deleted workspaces are queued');
 return {
  ...before,
  'auth.users':before['auth.users'].filter(id=>id!==u),
  workspaces:before.workspaces.filter(x=>!solo.includes(x.id)).map(x=>left.includes(x.id)?{...x,access_epoch:x.access_epoch+1,pending_owner_id:x.pending_owner_id===u?null:x.pending_owner_id}:x),
  members:before.members.filter(r=>kept(r)&&r.user_id!==u),
  invitations:before.invitations.filter(r=>kept(r)&&r.user_id!==u),
  folders:before.folders.filter(kept).map(strip),
  documents:before.documents.filter(kept).map(strip),
  journal:before.journal.filter(kept).map(r=>unlink(r,['actor_id'])),
  audit:[...before.audit.filter(kept).map(r=>unlink(r,['actor_id','target_id'])),...added],
  receipts:before.receipts.filter(r=>kept(r)&&r.actor_id!==u),
  key_envelopes:before.key_envelopes.filter(r=>kept(r)&&r.user_id!==u),
  attachments:before.attachments.filter(kept),
  user_signals:signals,
  storage_deletions:[...before.storage_deletions,...queued],
 };
}

test('account deletion (F24): the auth.users trigger, run by a role without app rights and without a subject, removes the person and unlinks every trace',async(t)=>{
 const [O,M,P,Q,N]=[1,2,3,4,5].map(uuid); // O owns a shared workspace; M is deleted first; P and Q are peers; N has no app rows
 const {db,call,refuses}=await open(t,[O,M,P,Q,N]);
 const [W1,W2,W3,W4,W5,W6,W7]=[10,11,12,13,14,15,16].map(uuid),[F1,P5,C5]=[20,21,22].map(uuid),[d1,d2,d3,d4,x5,y5]=[30,31,32,33,34,35].map(uuid);
 let op=100; const nextOp=()=>uuid(op++);
 // Deletes u and compares the whole database with afterDeletion; nothing anywhere names u afterwards.
 const deleted=async(u,solo,remove=()=>deleteUserAsAuthAdmin(db,u))=>{
  const before=await appState(db);
  assert.equal(await remove(),1);
  const after=await appState(db);
  assert.deepEqual(asSets(after),asSets(afterDeletion(before,after,u,solo)));
  assert.deepEqual(traces(after,u),[]);
  return {before,after};
 };
 // W1 (O): M is an editor with history, ACL keys, a key envelope, a deleted document and the pending ownership offer.
 await call(O,'create_workspace',[W1,'Shared']); await join(db,O,W1,M,'editor'); await join(db,O,W1,P,'viewer');
 await call(O,'create_folder',[W1,F1,null,{[M]:'editor',[O]:'editor'}]);
 await call(M,'create_document',[W1,d1,null,'note',cipher(W1,d1)]); await call(M,'push_document',[W1,d1,nextOp(),'1',cipher(W1,d1,1,'b')]);
 await call(M,'create_document',[W1,d2,null,'note',cipher(W1,d2)]); await setAcl(db,O,'document',W1,d2,{[M]:'viewer',[O]:'editor',[P]:'viewer'});
 await call(M,'create_document',[W1,d3,F1,'note',cipher(W1,d3)]); await call(M,'push_document',[W1,d3,nextOp(),'1',cipher(W1,d3),true]);
 for(const u of [M,O]) await db.query("insert into app.key_envelopes values($1,$2,$3,1,'{}')",[W1,d1,u]);
 await db.query("insert into app.attachments values($1,$2,$3,'synthetic/w1/d1','digest',1)",[W1,d1,uuid(40)]);
 await call(O,'offer_ownership',[W1,M]);
 // W2 (P): M wrote there, then left. W3 (P): M is invited. W4 (Q): M declined, which left audit rows and a signal row naming M.
 await call(P,'create_workspace',[W2,'Left']); await join(db,P,W2,M,'editor');
 await call(M,'create_document',[W2,d4,null,'note',cipher(W2,d4)]); await call(M,'leave_workspace',[W2]);
 await call(P,'create_workspace',[W3,'Invited']); await call(P,'invite_member',[W3,M,'viewer']);
 await call(Q,'create_workspace',[W4,'Declined']); await call(Q,'invite_member',[W4,M,'viewer']); await call(M,'respond_invitation',[W4,false]);
 // W5 (M alone): a folder tree, a document with an attachment and a key envelope, one in the trash, an invitation to Q.
 await call(M,'create_workspace',[W5,'Solo']); await call(M,'create_folder',[W5,P5,null]); await call(M,'create_folder',[W5,C5,P5,{[M]:'editor'}]);
 await call(M,'create_document',[W5,x5,C5,'note',cipher(W5,x5)]); await call(M,'create_document',[W5,y5,null,'note',cipher(W5,y5)]);
 await call(M,'push_document',[W5,y5,nextOp(),'1',cipher(W5,y5),true]);
 await db.query("insert into app.attachments values($1,$2,$3,'synthetic/w5/x5','digest',1)",[W5,x5,uuid(41)]);
 await db.query("insert into app.key_envelopes values($1,$2,$3,1,'{}')",[W5,x5,M]);
 await call(M,'invite_member',[W5,Q,'editor']);
 // W6 (M alone, empty) and W7 (O alone).
 await call(M,'create_workspace',[W6,'Empty']); await call(O,'create_workspace',[W7,'Own']);

 await t.test('an owner whose workspace has other members is refused with owner_must_transfer (PT409) and nothing changes, its solo workspace included',async()=>{
  const before=await appState(db);
  await assert.rejects(deleteUserAsAuthAdmin(db,O),rejected('owner_must_transfer'));
  assert.deepEqual(await appState(db),before);
 });

 await t.test('the deletion locks only the workspaces where the person is a member, not where it is invited, has left or declined, nor any other; the row work there is done unlocked',async()=>{
  // Dry run, rolled back. A workspace row the deletion locked has xmax >= its transaction id (W1's new version too: the
  // removal's audit and signal rows key-share it); W5 and W6 are deleted, so no longer visible. Only current co-members
  // can then delay a deletion (SEC-1). W2 and W4 hold audit rows with actor = target = M (accept, leave, decline), which
  // two UPDATEs of one row would key-share through the foreign key re-check (VS-A1); W3 holds M's invitation.
  const count=(sql,args)=>db.query(`select count(*)::int n from ${sql}`,args).then(r=>r.rows[0].n);
  const seen=await dryRunDeletion(db,M,async({top})=>({
   locked:(await db.query('select id from app.workspaces where xmax::text::bigint>=$1::bigint order by id',[top])).rows.map(r=>r.id),
   rest:[await count('app.invitations where user_id=$1',[M]),await count('app.user_signals where user_id=$1',[M]),await count('app.receipts where actor_id=$1',[M]),
    await count('app.journal where actor_id=$1',[M]),await count('app.audit where actor_id=$1 or target_id=$1',[M])],
  }));
  assert.deepEqual(seen,{locked:[W1],rest:[0,0,0,0,0]});
  // Fixture, and the rollback: each kind of trace still exists outside W1.
  for(const [w,sql] of [[W2,'app.journal where workspace_id=$1 and actor_id=$2'],[W2,'app.receipts where workspace_id=$1 and actor_id=$2'],[W3,'app.invitations where workspace_id=$1 and user_id=$2'],
   [W2,"app.audit where workspace_id=$1 and actor_id=$2 and target_id=$2 and action='leave_workspace'"],[W4,"app.audit where workspace_id=$1 and actor_id=$2 and target_id=$2 and action='decline_invitation'"],
   [W4,'app.user_signals where workspace_id=$1 and user_id=$2']]) assert.equal(await count(sql,[w,M]),1,sql);
 });

 await t.test('a member: its solo workspaces go whole, each shared workspace loses the membership once, and every row naming it goes or is unlinked',async()=>{
  // R8: not even a transient signal row for the user being deleted (user_signals feeds Realtime). A test-only trigger
  // logs every signal write of the deletion.
  await db.exec(`create table public.signal_writes(user_id uuid,workspace_id uuid);
   create function public.log_signal_write() returns trigger language plpgsql security definer set search_path=pg_catalog as $$ begin insert into public.signal_writes values(new.user_id,new.workspace_id); return new; end $$;
   create trigger log_signal_write after insert or update on app.user_signals for each row execute function public.log_signal_write();`);
  let result,writes;
  try { result=await deleted(M,[W5,W6]); writes=(await db.query('select user_id,workspace_id from public.signal_writes order by 1,2')).rows; }
  finally { await db.exec('drop trigger log_signal_write on app.user_signals; drop function public.log_signal_write(); drop table public.signal_writes;'); }
  // W1: the removal signals O and P. W3: M's pending invitation ends as after a decline, so its member P is signalled
  // (SEC-2) and M is not.
  assert.deepEqual(writes,[{user_id:O,workspace_id:W1},{user_id:P,workspace_id:W1},{user_id:P,workspace_id:W3}]);
  const {before,after}=result;
  // The main points of that comparison, spelled out.
  assert.deepEqual(after.workspaces.map(x=>x.id).sort(),[W1,W2,W3,W4,W7]);
  assert.deepEqual([workspaceRow(after,W1).access_epoch-workspaceRow(before,W1).access_epoch,workspaceRow(after,W1).pending_owner_id],[1,null]);
  for(const w of [W2,W3,W4]) assert.deepEqual(workspaceRow(after,w),workspaceRow(before,w));
  assert.deepEqual([rows(after,'folders',{id:F1})[0].acl,rows(after,'documents',{id:d2})[0].acl],[{[O]:'editor'},{[O]:'editor',[P]:'viewer'}]);
  for(const id of [d1,d3,d4]) assert.deepEqual(rows(after,'documents',{id})[0],rows(before,'documents',{id})[0]);
  // Shared history keeps every row (W5's went with W5); M's rows there now have no actor.
  const shared=before.journal.filter(r=>r.workspace_id!==W5);
  assert.deepEqual([after.journal.length,after.journal.filter(r=>r.actor_id===null).length],[shared.length,shared.filter(r=>r.actor_id===M).length]);
  assert.deepEqual(await call(Q,'list_my_invitations',[]),{invitations:[],next_id:null});
 });

 await t.test("the deleted account's still-valid token finds no way back in",async()=>{
  await refuses(M,'create_workspace',[uuid(17),'Back'],'unauthenticated');
  await call(O,'invite_member',[W1,M,'viewer']);
  for(const accept of [true,false]) await refuses(M,'respond_invitation',[W1,accept],'unauthenticated');
  await call(O,'invite_member',[W1,M,null]);
  for(const [name,args] of [['list_members',[W1]],['pull_changes',[W1,'0']],['leave_workspace',[W1]],['respond_invitation',[W3,true]]]) await refuses(M,name,args,'forbidden');
  assert.deepEqual(await call(M,'list_my_workspaces',[]),{workspaces:[],next_id:null});
 });

 await t.test('deleting again, or deleting an account without app rows, changes nothing but the auth row',async()=>{
  const before=await appState(db);
  assert.equal(await deleteUserAsAuthAdmin(db,M),0);
  assert.deepEqual(await appState(db),before);
  assert.equal(await deleteUserAsAuthAdmin(db,N),1);
  assert.deepEqual(await appState(db),{...before,'auth.users':before['auth.users'].filter(id=>id!==N)});
 });

 await t.test('after handing ownership over, the former owner goes like any member, with its solo workspace; the session identity plays no part (R2)',async()=>{
  await call(O,'offer_ownership',[W1,P]); await call(P,'accept_ownership',[W1]);
  // This deleting session carries P's subject: the cleanup must neither need it nor record it.
  await deleted(O,[W7],()=>inTransaction(db,['set local role auth_admin_test',["select set_config('request.jwt.claim.sub',$1,true)",[P]]],async()=>(await db.query('delete from auth.users where id=$1',[O])).affectedRows));
 });

 await t.test('a reference the cleanup does not know fails the whole delete (fail-safe); the deleter holds no app rights',async()=>{
  for(const statement of ['select 1 from app.members','select private.trash_retention()']) await assert.rejects(inTransaction(db,['set local role auth_admin_test'],()=>db.query(statement)),{code:'42501'});
  await db.exec('create table public.unlisted_reference(user_id uuid references auth.users(id))');
  try {
   await db.query('insert into public.unlisted_reference values($1)',[Q]);
   const before=await appState(db);
   await assert.rejects(deleteUserAsAuthAdmin(db,Q),{code:'23503'});
   assert.deepEqual(await appState(db),before);
  } finally { await db.exec('drop table public.unlisted_reference'); }
  await deleted(Q,[W4]);
 });

 await t.test('the hook the AI migration replaces runs once, after the sync cleanup, inside the delete; there is no workspace hook',async()=>{
  const Z=uuid(6),dz=uuid(36);
  await db.query('insert into auth.users values($1)',[Z]);
  await call(P,'invite_member',[W1,Z,'editor']); await call(Z,'respond_invitation',[W1,true]); await call(P,'invite_member',[W3,Z,'viewer']);
  await call(Z,'create_document',[W1,dz,null,'note',cipher(W1,dz)]); // a receipt and a journal row of Z
  const hooks=async()=>(await db.query("select p.proname,pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'forget_user_hook%' order by 1")).rows;
  const shipped=await hooks();
  // The deletion takes no lock for the AI rows (only memberships are locked), so nothing names their workspaces.
  assert.deepEqual(shipped.map(r=>r.proname),['forget_user_hook']);
  // A test-only stand-in (CREATE OR REPLACE keeps owner and grants; the shipped body comes back in finally) records what
  // the hook saw of u. It runs with the trigger's definer rights, so sync_backend may write the record.
  const record=`insert into public.hook_calls(u,seen) select u,array[(select count(*)::int from app.members where user_id=u),(select count(*)::int from app.invitations where user_id=u),
   (select count(*)::int from app.user_signals where user_id=u),(select count(*)::int from app.receipts where actor_id=u),(select count(*)::int from app.journal where actor_id=u)];`;
  const standIn=body=>`create or replace function private.forget_user_hook(u uuid) returns void language plpgsql set search_path=pg_catalog as $$ begin ${record} ${body} end $$;`;
  await db.exec(`create table public.hook_calls(n serial,u uuid,seen int[]);
   grant insert on public.hook_calls to sync_backend; grant usage on sequence public.hook_calls_n_seq to sync_backend; ${standIn("raise exception 'hook failed';")}`);
  try {
   // A failing hook fails the whole delete: nothing changes, the hook's own write included.
   const before=await appState(db);
   await assert.rejects(deleteUserAsAuthAdmin(db,Z),{message:'hook failed'});
   assert.deepEqual([await appState(db),(await db.query('select count(*)::int n from public.hook_calls')).rows[0].n],[before,0]);
   await db.exec(standIn(''));
   await deleted(Z,[]);
   // Once, and after the sync cleanup: Z's memberships, invitations, signals and receipts are gone, its journal unlinked.
   assert.deepEqual((await db.query('select u,seen from public.hook_calls order by n')).rows,[{u:Z,seen:[0,0,0,0,0]}]);
  } finally {
   for(const {d} of shipped) await db.exec(d);
   await db.exec('drop table public.hook_calls');
  }
  assert.deepEqual(await hooks(),shipped);
 });

 await t.test('the last member takes the remaining workspaces with it: only the storage queue is left',async()=>{
  const {after}=await deleted(P,[W1,W2,W3]);
  for(const [table,list] of Object.entries(after)) if(table!=='storage_deletions') assert.deepEqual(list,[],table);
  assert.deepEqual(after.storage_deletions.map(r=>[r.path,r.workspace_id]).sort(),[['synthetic/w1/d1',W1],['synthetic/w5/x5',W5]].sort());
 });
});

test('SEC-2: to the inviting workspace, an invitee\'s account deletion looks like a decline; an invitation to an id without an account stays',async(t)=>{
 // A owns every workspace and B is a member. C was a member and left, X is another pending invitee and N an invited id
 // without an account; C and X have signal rows there. Twins: Y, invited to Wd1 as editor and to Wd2 as viewer,
 // declines both; Z, invited alike to Wx1 and Wx2, is deleted. Each twin pair is built by the same calls.
 const [A,B,C,X,Y,Z,N]=[1,2,3,4,5,6,7].map(uuid);
 const {db,call}=await open(t,[A,B,C,X,Y,Z]);
 const [Wd1,Wd2,Wx1,Wx2]=[10,11,12,13].map(uuid),twins=[[Wd1,Wx1,'editor'],[Wd2,Wx2,'viewer']];
 for(const [wd,wx,role] of twins) for(const [w,invitee] of [[wd,Y],[wx,Z]]){
  await call(A,'create_workspace',[w,'Inviter']); await join(db,A,w,B,'editor'); await join(db,A,w,C,'viewer'); await call(C,'leave_workspace',[w]);
  for(const u of [X,N]) await call(A,'invite_member',[w,u,'viewer']);
  await call(A,'invite_member',[w,invitee,role]);
 }
 // What the inviting side can see of an invitation's end: the owner's list_invitations and each one's own signal row
 // (RLS own_signal, the Realtime source). No RPC reads app.audit and clients hold no privilege on it, so the audit row of
 // a decline, which the deletion does not write, is not visible.
 const view=async w=>{ const signals={}; for(const u of [A,B,C,X]) signals[u]=await asUser(db,u,async()=>(await db.query('select generation::int g from app.user_signals where workspace_id=$1',[w])).rows.map(r=>r.g));
  return {invitations:await call(A,'list_invitations',[w]),signals}; };
 const views=async()=>{ const out={}; for(const w of [Wd1,Wd2,Wx1,Wx2]) out[w]=await view(w); return out; };
 const [v0,s0]=[await views(),await appState(db)];
 for(const w of [Wd1,Wd2]) await call(Y,'respond_invitation',[w,false]);
 const s1=await appState(db);
 assert.equal(await deleteUserAsAuthAdmin(db,Z),1);
 const [v2,s2]=[await views(),await appState(db)];
 // Every signal row of the database, keyed workspace/user: its generation change, or 'gone' or 'new'.
 const moved=(before,after)=>{ const gen=state=>Object.fromEntries(state.user_signals.map(r=>[`${r.workspace_id}/${r.user_id}`,r.generation])),[b,a]=[gen(before),gen(after)];
  return Object.fromEntries([...new Set([...Object.keys(b),...Object.keys(a)])].map(k=>[k,!(k in a)?'gone':!(k in b)?'new':a[k]-b[k]])); };
 const expected=(rows,change)=>Object.fromEntries(Object.keys(rows).map(k=>[k,change(...k.split('/'))]));
 const [declined,deleted]=[moved(s0,s1),moved(s1,s2)];
 // The declines move the members' rows and Y's own in Wd1 and Wd2; the deletion moves the members' rows in Wx1 and Wx2
 // and removes Z's (R8). No other row moves: not the former member's, not the other invitee's, none elsewhere.
 assert.deepEqual(declined,expected(declined,(w,u)=>[Wd1,Wd2].includes(w)&&[A,B,Y].includes(u)?1:0));
 assert.deepEqual(deleted,expected(deleted,(w,u)=>u===Z?'gone':[Wx1,Wx2].includes(w)&&[A,B].includes(u)?1:0));
 // Twin by twin, row by row, the same change, apart from the invitee's own row (a decline signals the decliner).
 const inWorkspace=(rows,w,invitee)=>Object.fromEntries(Object.entries(rows).filter(([k])=>k.startsWith(`${w}/`)).map(([k,v])=>{ const u=k.slice(w.length+1); return [u===invitee?'invitee':u,v]; }));
 for(const [wd,wx,role] of twins){
  const {invitee:decliner,...declineRest}=inWorkspace(declined,wd,Y),{invitee:gone,...deletionRest}=inWorkspace(deleted,wx,Z);
  assert.deepEqual(deletionRest,declineRest,wx);
  assert.deepEqual([declineRest,decliner,gone],[{[A]:1,[B]:1,[C]:0,[X]:0},1,'gone'],'fixture: rows of members, a former member and an invitee');
  // The answered invitation (of the twin's role) is gone, X's and N's stay as they were; members see one signal each.
  for(const [w,invitee] of [[wd,Y],[wx,Z]]){
   const {invitations,signals}=v0[w];
   assert.deepEqual(invitations.invitations.filter(i=>i.user_id===invitee).map(i=>i.role),[role],'fixture');
   assert.deepEqual(v2[w],{invitations:{...invitations,invitations:invitations.invitations.filter(i=>i.user_id!==invitee)},signals:{...signals,[A]:[signals[A][0]+1],[B]:[signals[B][0]+1]}},w);
  }
  const pending=w=>v2[w].invitations.invitations.map(i=>[i.user_id,i.role]);
  assert.deepEqual([pending(wx),pending(wd)],[[[X,'viewer'],[N,'viewer']],[[X,'viewer'],[N,'viewer']]]);
 }
 assert.deepEqual((await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc like '%app.audit%'")).rows,[]);
 // R8: no row names Z afterwards, not even a signal.
 assert.deepEqual(traces(s2,Z),[]);
});

test('I3 and the interface: the caller-wide lists take no workspace lock; parameter names and defaults are the spec\'s (R6, R7)',async(t)=>{
 const [owner,member,invitee]=[1,2,3].map(uuid);
 const {db,call}=await open(t,[owner,member,invitee]);
 const w=uuid(10);
 await call(owner,'create_workspace',[w,'Locks']); await join(db,owner,w,member,'editor'); await call(owner,'invite_member',[w,invitee,'viewer']);

 await t.test('list_my_workspaces and list_my_invitations read without locking the workspace row; workspace RPCs lock it (control)',async()=>{
  // A row lock taken in this transaction leaves the row's xmax at the current transaction id.
  const locks=(u,name,args)=>asUser(db,u,async()=>{ await rpc(db,name,args); await db.exec('reset role'); return (await db.query('select (select xmax::text from app.workspaces where id=$1)=txid_current()::text locked',[w])).rows[0].locked; });
  assert.deepEqual([await locks(member,'list_members',[w]),await locks(member,'list_my_workspaces',[]),await locks(invitee,'list_my_invitations',[])],[true,false,false]);
  assert.equal((await call(member,'list_my_workspaces',[])).workspaces.length,1);
  assert.equal((await call(invitee,'list_my_invitations',[])).invitations.length,1);
 });

 await t.test('parameter names and defaults, which PostgREST matches by name',async()=>{
  const ws='p_workspace_id uuid',page='p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100';
  const expected={
   accept_ownership:ws,create_document:`${ws}, p_document_id uuid, p_folder_id uuid, p_kind text, p_ciphertext jsonb, p_key_epoch integer DEFAULT 1, p_op_id uuid DEFAULT NULL::uuid`,
   create_folder:`${ws}, p_folder_id uuid, p_parent_id uuid DEFAULT NULL::uuid, p_acl jsonb DEFAULT NULL::jsonb`,get_acl:`${ws}, p_kind text, p_id uuid`,
   invite_member:`${ws}, p_user_id uuid, p_role text`,leave_workspace:ws,list_acls:`${ws}, p_kind text, ${page}`,list_folders:`${ws}, ${page}`,
   list_invitations:`${ws}, ${page}`,list_members:`${ws}, ${page}`,list_my_invitations:page,list_my_workspaces:page,list_trash:`${ws}, ${page}`,
   offer_ownership:`${ws}, p_user_id uuid`,purge_expired_trash:'p_limit integer DEFAULT 100',respond_invitation:`${ws}, p_accept boolean`,
   restore_document:`${ws}, p_document_id uuid, p_op_id uuid, p_base_revision text`,set_ai_enabled:`${ws}, p_enabled boolean`,
   set_document_acl:`${ws}, p_document_id uuid, p_acl jsonb, p_expected_version text`,set_folder_acl:`${ws}, p_folder_id uuid, p_acl jsonb, p_expected_version text`,
   set_member:`${ws}, p_user_id uuid, p_role text`,
  };
  const {rows:found}=await db.query("select p.proname,pg_get_function_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1) order by 1",[Object.keys(expected)]);
  assert.deepEqual(Object.fromEntries(found.map(r=>[r.proname,r.a])),expected);
 });

 // Lock order is not observable in one session, so these pin the code (INV-1).
 await t.test('R1: every RPC taking a workspace locks its row as the first statement, except create_workspace, which has no row yet',async()=>{
  const {rows}=await db.query("select p.proname,p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and pg_get_function_arguments(p.oid) like 'p_workspace_id uuid%' order by 1");
  // The declare part may not contain begin, so a lock inside a nested block after another statement does not pass. Its
  // initializers run before the first statement, so none may read data either: no select, and no call into app or
  // private but the constant private.page_budget(). Comments are stripped first, so their words count for nothing.
  const lockFirst=/^\s*(?:declare\b(?:(?!\bbegin\b|(?:=|\bdefault\b)[^;]*?(?:\bselect\b|\bapp\.|\bprivate\.(?!page_budget\(\))))[\s\S])*)?\bbegin\s+(?:\w+\s*:=\s*|perform\s+)private\.lock_workspace\(p_workspace_id\);/i;
  const code=source=>source.replace(/--[^\n]*/g,'');
  const lock='begin\n  w:=private.lock_workspace(p_workspace_id);';
  assert.deepEqual(['b integer:=private.page_budget();','r integer:=private.document_rank(p_workspace_id,p_document_id);',
   'r integer default private.document_rank(p_workspace_id,p_document_id);','h bigint=(select head from app.workspaces where id=p_workspace_id);']
   .map(d=>lockFirst.test(`declare\n  ${d}\n${lock}`)),[true,false,false,false]);
  assert.equal(rows.length,23,'the sync RPCs whose first argument is p_workspace_id');
  // create_workspace inserts the row; its primary key decides between concurrent creators.
  assert.deepEqual(rows.filter(r=>!lockFirst.test(code(r.prosrc))).map(r=>r.proname),['create_workspace']);
 });

 await t.test('R2: the deletion trigger locks only its memberships, first, in id order, under lock_timeout; the purge skips locked workspaces and fixes its boundary once',async()=>{
  const {rows:[fu]}=await db.query("select proconfig,prosrc from pg_proc where oid='private.forget_user()'::regprocedure");
  assert.deepEqual(fu.proconfig,['search_path=pg_catalog','lock_timeout=250ms']);
  assert.match(fu.prosrc,/\bbegin\s+ws:=array\(select workspace_id from app\.members where user_id=u\);\s+perform 1 from app\.workspaces where id=any\(ws\) order by id for update;/);
  // u's invitations go, with the members' signals in the same statement, before u's signal rows: the order invite_member
  // uses (invitation row, then signal rows), so a concurrent invite or revoke cannot wait in a cycle with the deletion.
  const at=statement=>{ const i=fu.prosrc.indexOf(statement); assert.ok(i>=0,statement); return i; };
  const order=['with gone as (delete from app.invitations where user_id=u returning workspace_id)','update app.user_signals s set generation=s.generation+1 from gone g, app.members m',
   'delete from app.user_signals where user_id=u;','delete from app.receipts where actor_id=u;'].map(at);
  assert.deepEqual(order,[...order].sort((a,b)=>a-b));
  const {rows:[purge]}=await db.query("select prosrc from pg_proc where oid='public.purge_expired_trash(integer)'::regprocedure");
  const code=purge.prosrc.replace(/--[^\n]*/g,'');
  assert.match(code,/\border by x\.id for update skip locked limit 1;/);
  assert.match(code,/\bcutoff timestamptz:=clock_timestamp\(\)-private\.trash_retention\(\);/);
  assert.equal(code.match(/clock_timestamp\(\)/g).length,1,'every statement compares with the one cutoff');
 });
});

// Bulk fixtures as the superuser, in the uuid(n) format under another prefix: sqlId('10000000','g') matches bulkId('10000000',g).
const sqlId=(prefix,n)=>`('${prefix}-0000-4000-8000-'||lpad((${n})::text,12,'0'))::uuid`;
const bulkId=(prefix,n)=>`${prefix}-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('purge cost (F61): with only purged or unexpired trash a call reads no document or workspace row; a call locks one workspace until its transaction ends; every purge statement can use documents_trash',async(t)=>{
 const {db}=await open(t,[]);
 // 300 workspaces, each with 5 tombstones purged long ago and 1 document in the trash window (content kept).
 await db.exec(`insert into app.workspaces(id,name) select ${sqlId('10000000','g')},'Synthetic' from generate_series(1,300) g;
  insert into app.documents(workspace_id,id,kind,ciphertext,key_epoch,deleted,deleted_at)
   select ${sqlId('10000000','w')},${sqlId('20000000','d')},'note',case when d<=5 then null else '{}'::jsonb end,1,true,
    clock_timestamp()-case when d<=5 then interval '1000 hours' else interval '1 hour' end
   from generate_series(1,300) w,generate_series(1,6) d;
  analyze;`);
 const reads=()=>tableReads(db,['documents','workspaces']);

 await t.test('nothing expired with content: {purged:0, more:false} without reading a document or workspace row, call after call',async()=>{
  // documents_trash holds only trash with content and the cutoff is an index condition, so neither the tombstones nor a
  // pass over the workspaces is read (PGM-1).
  for(let i=0;i<3;i++){
   const before=await reads();
   assert.deepEqual(await asMaintainer(db,()=>rpc(db,'purge_expired_trash',[100])),{purged:0,more:false});
   assert.deepEqual(await reads(),before);
  }
 });

 await t.test('each call locks one workspace, and the lock lasts until the transaction ends: the caller commits after each call (PGM-4)',async()=>{
  const [w1,w2]=[1,2].map(n=>bulkId('10000000',n));
  await db.query("update app.documents set deleted_at=clock_timestamp()-interval '721 hours' where ciphertext is not null and workspace_id=any($1)",[[w1,w2]]);
  const locked=async()=>{ await db.exec('reset role'); const ids=(await db.query('select id from app.workspaces where xmax::text=txid_current()::text order by id')).rows.map(r=>r.id); await db.exec('set local role sync_maintainer'); return ids; };
  const calls=await asMaintainer(db,async()=>{ const out=[]; for(let i=0;i<2;i++) out.push({result:await rpc(db,'purge_expired_trash',[100]),locked:await locked()}); return out; });
  assert.deepEqual(calls,[{result:{purged:1,more:true},locked:[w1]},{result:{purged:1,more:false},locked:[w1,w2]}]);
 });

 await t.test('the search, the loop and the more check can all use documents_trash: with generic plans a call that purges the last expired document reads a few document rows',async()=>{
  // The cutoff is a variable, so only the statement text (not c.purged, as in the index predicate) lets a generic plan
  // use documents_trash. The next subtest covers custom plans.
  const w3=bulkId('10000000',3);
  await db.query("update app.documents set deleted_at=clock_timestamp()-interval '721 hours' where ciphertext is not null and workspace_id=$1",[w3]);
  const before=await reads();
  assert.deepEqual(await asMaintainer(db,async()=>{ await db.exec('set local plan_cache_mode=force_generic_plan'); return rpc(db,'purge_expired_trash',[100]); }),{purged:1,more:false});
  const after=await reads(),read=after.documents.heap-before.documents.heap+after.documents.entries-before.documents.entries;
  // Measured 10 (w3's entry and row, its update, the earlier calls' dead entries); a statement that cannot use the index
  // reads all 1,800.
  assert.ok(read<=30,`document rows read: ${read}`);
 });

 await t.test('with custom plans, which a new connection starts with, a call that purges also reads a few document rows: the more check takes the first documents_trash entry although old tombstones dominate the statistics',async()=>{
  const w4=bulkId('10000000',4);
  await db.query("update app.documents set deleted_at=clock_timestamp()-interval '721 hours' where ciphertext is not null and workspace_id=$1",[w4]);
  const before=await reads();
  assert.deepEqual(await asMaintainer(db,async()=>{ await db.exec('set local plan_cache_mode=force_custom_plan'); return rpc(db,'purge_expired_trash',[100]); }),{purged:1,more:false});
  const after=await reads(),read=after.documents.heap-before.documents.heap+after.documents.entries-before.documents.entries;
  // An EXISTS for the more check is planned as a sequential scan here and reads all 1,800 rows.
  assert.ok(read<=30,`document rows read: ${read}`);
 });

 await t.test('with custom plans and 100 expired documents left in other workspaces (more: true), the more check still stops at the first entry',async()=>{
  const B=100;
  await db.query("update app.documents set deleted_at=clock_timestamp()-interval '721 hours' where ciphertext is not null and workspace_id=any($1)",[Array.from({length:B+1},(_,i)=>bulkId('10000000',5+i))]);
  const before=await reads();
  assert.deepEqual(await asMaintainer(db,async()=>{ await db.exec('set local plan_cache_mode=force_custom_plan'); return rpc(db,'purge_expired_trash',[100]); }),{purged:1,more:true});
  const after=await reads(),read=after.documents.heap-before.documents.heap+after.documents.entries-before.documents.entries;
  // Measured 318. Before the lock the search reads each of the 101 expired entries and its row; under the lock the loop,
  // planned as a BitmapAnd of the workspace's documents and documents_trash, reads each entry once more (index only), and
  // the more check one entry. A more check that counted the 100 entries left would read 2 more per entry (516).
  assert.ok(read<=3*B+30,`document rows read: ${read}`);
 });
});

test('content pushes stay HOT updates: documents_trash names purged, which a push never changes, not ciphertext (SQLR-1)',async(t)=>{
 const [owner,w,d]=[1,10,30].map(uuid);
 const {db,call}=await open(t,[owner]);
 await call(owner,'create_workspace',[w,'Hot']); await call(owner,'create_document',[w,d,null,'note',cipher(w,d)]);
 await db.exec('vacuum app.documents');
 const updates=async()=>{ await db.query('select pg_stat_force_next_flush()'); await db.query('select pg_stat_clear_snapshot()');
  return (await db.query("select n_tup_upd::int upd,n_tup_hot_upd::int hot from pg_stat_user_tables where relid='app.documents'::regclass")).rows[0]; };
 const before=await updates();
 for(let i=1;i<=20;i++) await call(owner,'push_document',[w,d,uuid(100+i),String(i),cipher(w,d,1,String.fromCharCode(97+i))]);
 const after=await updates();
 // One UPDATE per push (ciphertext, revision, key_epoch). It is HOT when no column an index names, as key or in its
 // predicate, changes and the new version fits on the page; each push commits, so pruning frees the earlier versions
 // (measured: 20 of 20). The margin of 4 allows for a full page. With ciphertext in the predicate none is HOT (0 of 20).
 assert.equal(after.upd-before.upd,20);
 assert.ok(after.hot-before.hot>=16,`HOT updates: ${after.hot-before.hot} of 20`);
});

test('account deletion cost (F24, F61): the indexes of the deletion and purge paths; deleting a sole member reads none of another tenant\'s 5,000 audit and signal rows',async(t)=>{
 const {db}=await open(t,[]);

 await t.test('catalog: the lookups by user, by workspace, document or parent, and documents_trash for trash that still has content',async()=>{
  const btree=(name,table,columns,where)=>[name,`CREATE INDEX ${name} ON app.${table} USING btree (${columns})${where?` WHERE ${where}`:''}`];
  const expected=Object.fromEntries([
   btree('members_user','members','user_id'),btree('invitations_user','invitations','user_id'),btree('receipts_actor','receipts','actor_id'),
   btree('journal_actor','journal','actor_id','(actor_id IS NOT NULL)'),btree('journal_document','journal','workspace_id, document_id'),
   btree('audit_actor','audit','actor_id','(actor_id IS NOT NULL)'),btree('audit_target','audit','target_id','(target_id IS NOT NULL)'),
   btree('workspaces_pending_owner','workspaces','pending_owner_id','(pending_owner_id IS NOT NULL)'),
   btree('documents_folder','documents','workspace_id, folder_id'),btree('folders_parent','folders','workspace_id, parent_id'),btree('audit_workspace','audit','workspace_id'),
   btree('user_signals_workspace','user_signals','workspace_id'),btree('attachments_document','attachments','workspace_id, document_id'),
   btree('documents_trash','documents','deleted_at','(deleted AND (NOT purged))'),
  ]);
  const {rows}=await db.query("select indexname,indexdef from pg_indexes where schemaname='app' and indexname=any($1)",[Object.keys(expected)]);
  assert.deepEqual(Object.fromEntries(rows.map(r=>[r.indexname,r.indexdef]).sort(([a],[b])=>byText(a,b))),Object.fromEntries(Object.entries(expected).sort(([a],[b])=>byText(a,b))));
  // documents_trash's predicate column: generated from ciphertext and STORED ('s'), so it can be indexed.
  assert.deepEqual((await db.query("select a.attgenerated generated,pg_get_expr(d.adbin,d.adrelid) expression from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='app.documents'::regclass and a.attname='purged'")).rows,
   [{generated:'s',expression:'(ciphertext IS NULL)'}]);
 });

 await t.test('three sole members are deleted one by one: app.audit is not read at all, app.user_signals only by the planner',async()=>{
  // Each sole member's workspace is inserted directly, without audit or signal rows of its own; the other tenant's rows
  // are never the deletion's. private.delete_workspace and the foreign key checks of the workspace delete find a
  // workspace's audit and signal rows through audit_workspace and user_signals_workspace (PGM-3).
  const owners=[1,2,3].map(n=>bulkId('30000000',n)),solo=[1,2,3].map(n=>bulkId('40000000',n)),busy=bulkId('40000000',9),busyOwner=bulkId('30000000',9);
  await db.exec(`insert into auth.users select ${sqlId('30000000','g')} from generate_series(1,3) g union all select ${sqlId('30000000','9')};
   insert into app.workspaces(id,name) select ${sqlId('40000000','g')},'Synthetic' from generate_series(1,3) g union all select ${sqlId('40000000','9')},'Busy';
   insert into app.members select ${sqlId('40000000','g')},${sqlId('30000000','g')},'owner' from generate_series(1,3) g union all select ${sqlId('40000000','9')},${sqlId('30000000','9')},'owner';
   insert into app.audit(workspace_id,actor_id,action,target_id,head,access_epoch) select ${sqlId('40000000','9')},${sqlId('30000000','9')},'document_revision',null,g,1 from generate_series(1,5000) g;
   insert into auth.users select ${sqlId('50000000','g')} from generate_series(1,5000) g;
   insert into app.user_signals(user_id,workspace_id) select ${sqlId('50000000','g')},${sqlId('40000000','9')} from generate_series(1,5000) g;
   analyze;`);
  for(const [i,u] of owners.entries()){
   const before=await tableReads(db,['audit','user_signals']);
   assert.equal(await deleteUserAsAuthAdmin(db,u),1);
   const after=await tableReads(db,['audit','user_signals']);
   assert.deepEqual(after.audit,before.audit,`audit read while deleting ${u}`);
   // Planning the SEC-2 bump reads the first and last entry of user_signals_pkey (merge join estimate), whatever the size:
   // 4 reads, measured. The bound leaves room for a planner change, such as dead entries at the index ends, and still
   // fails far below a deletion without user_signals_workspace, which reads the other tenant's rows (10,004).
   const signals=after.user_signals.heap-before.user_signals.heap+after.user_signals.entries-before.user_signals.entries;
   assert.ok(signals<=16,`user_signals read while deleting ${u}: ${signals}`);
   assert.equal((await db.query('select count(*)::int n from app.workspaces where id=$1',[solo[i]])).rows[0].n,0);
  }
  // The other tenant is untouched.
  assert.deepEqual((await db.query('select (select count(*)::int from app.audit where workspace_id=$1) audit,(select count(*)::int from app.user_signals where workspace_id=$1) signals,(select array_agg(user_id) from app.members where workspace_id=$1) members',[busy])).rows[0],
   {audit:5000,signals:5000,members:[busyOwner]});
 });
});

test('account deletion cost (SEC-2, F61): an invitee\'s deletion finds the inviting members\' signal rows by workspace and reads none of another tenant\'s 5,000',async(t)=>{
 const [owner,member,invitee,w]=[1,2,3,10].map(uuid);
 const {db,call}=await open(t,[owner,member,invitee]);
 await call(owner,'create_workspace',[w,'Inviting']); await join(db,owner,w,member,'editor'); await call(owner,'invite_member',[w,invitee,'viewer']);
 // Another tenant: the same 100 members in each of 50 workspaces, each with a signal row (5,000 rows, 50 per user).
 await db.exec(`insert into auth.users select ${sqlId('30000000','g')} from generate_series(1,100) g;
  insert into app.workspaces(id,name) select ${sqlId('40000000','g')},'Synthetic' from generate_series(1,50) g;
  insert into app.members select ${sqlId('40000000','w')},${sqlId('30000000','u')},case when u=1 then 'owner' else 'editor' end from generate_series(1,50) w,generate_series(1,100) u;
  insert into app.user_signals(user_id,workspace_id) select ${sqlId('30000000','u')},${sqlId('40000000','w')} from generate_series(1,50) w,generate_series(1,100) u;
  analyze;`);
 const generations=async()=>(await db.query('select user_id,generation::int g from app.user_signals where workspace_id=$1 order by user_id',[w])).rows.map(r=>[r.user_id,r.g]);
 const before={generations:await generations(),reads:await tableReads(db,['user_signals'])};
 assert.equal(await deleteUserAsAuthAdmin(db,invitee),1);
 const after=await tableReads(db,['user_signals']);
 // As after a decline: each member's row goes up by one, and the invitee's own row goes with the account.
 assert.deepEqual(await generations(),before.generations.filter(([u])=>u!==invitee).map(([u,g])=>[u,g+1]));
 // The SEC-2 bump reads the inviting workspace's rows through user_signals_workspace: 13 reads, measured. With a
 // workspace condition no index serves (measured with a cast on both ids) it scans the whole table: 5,010 reads.
 const signals=after.user_signals.heap-before.reads.user_signals.heap+after.user_signals.entries-before.reads.user_signals.entries;
 assert.ok(signals<=30,`user_signals read while deleting the invitee: ${signals}`);
});
