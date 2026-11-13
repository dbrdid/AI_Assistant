import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SERVER_ERRORS} from '../../contracts/errors.js';
import {aiDatabase,asExecutor,asUser,rpc,uuid,cipher} from './ai-harness.mjs';
import {inTransaction,enableAi,setAcl,join,deleteUserAsAuthAdmin,dryRunDeletion,tableReads,appState} from './harness.mjs';
test('durable AI SQL permissions, consent, reservation and settlement',async t=>{
 const db=await aiDatabase();t.after(()=>db.close());
 const owner=uuid(1),outsider=uuid(2),w=uuid(10),d=uuid(20),hash='a'.repeat(64);
 const user=(name,args=[],actor=owner)=>asUser(db,actor,()=>rpc(db,name,args));
 const exec=(name,args=[])=>asExecutor(db,()=>rpc(db,name,args));
 const asAnon=fn=>inTransaction(db,['set local role anon'],fn);
 // Business errors follow shared/contracts/errors.js: SQLSTATE PT<status> with the exact reason as message.
 const named=reason=>{assert.ok(Object.hasOwn(SERVER_ERRORS,reason),`not a contract reason: ${reason}`);return {code:SERVER_ERRORS[reason].sqlstate,message:reason};};
 const invalidConsent=named('invalid_consent'),forbidden=named('forbidden'),invalidRequest=named('invalid_request');
 // A missing EXECUTE grant stays PostgreSQL's 42501: an infrastructure error, never a business denial.
 const denied=name=>({code:'42501',message:`permission denied for function ${name}`});
 const omit=(object,key)=>Object.fromEntries(Object.entries(object).filter(([k])=>k!==key));
 const count=async(from,params)=>(await db.query(`select count(*)::int n from ${from}`,params)).rows[0].n;
 const job=async id=>(await db.query('select state,hold_released,result_ref from app.ai_jobs where id=$1',[id])).rows[0];
 await db.query('insert into auth.users values($1),($2)',[owner,outsider]);
 await user('create_workspace',[w,'Synthetic']);await user('create_document',[w,d,null,'note',cipher(w,d)]);
 // AI is off in a new workspace (F29 minimum); the owner turns it on. The F29 test below covers the switch itself.
 await enableAi(db,owner,w);
 const route={route_id:'synthetic-v1',provider_id:'synthetic',model_id:'test',retention_version:'none-v1',max_cost_microusd:'100',max_output_tokens:100};
 await exec('ai_set_route',[route]);
 const period=(await db.query("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM') p")).rows[0].p;
 for(const actor of [null,owner])await exec('ai_set_budget',[w,actor,period,'300']);
 let counter=100;
 const consent=()=>({approved:true,provider_id:route.provider_id,model_id:route.model_id,consent_id:uuid(counter++),workspace_id:w,document_id:d,source_revision:'1',payload_sha256:hash,route_id:route.route_id,purpose:'summary',retention_version:route.retention_version,max_cost_microusd:'100',max_output_tokens:100,expires_at:new Date(Date.now()+3600000).toISOString()});
 const admit=c=>({job_id:uuid(counter++),consent_id:c.consent_id,input_ref:'opaque_input',payload_sha256:hash,route_id:route.route_id});
 const newJob=async()=>{const c=consent();await user('ai_grant_consent',[c]);const request=admit(c);return {c,request,j:await exec('ai_admit_job',[owner,request])};};
 // One workspace's rows (default w), workspace scope first.
 const budgets=async(workspace=w)=>(await db.query('select held_microusd::text held,spent_microusd::text spent from app.ai_budgets where workspace_id=$1 order by scope',[workspace])).rows;
 await t.test('RLS, direct access and RPC allowlists',async()=>{
  // Only authenticated has USAGE on schema app, so anon and ai_executor stop at the schema.
  const schemaDenied={code:'42501',message:'permission denied for schema app'};
  for(const [scope,jobs,budgetRows] of [
   [fn=>asUser(db,owner,fn),{code:'42501',message:'permission denied for table ai_jobs'},{code:'42501',message:'permission denied for table ai_budgets'}],
   [asAnon,schemaDenied,schemaDenied],
   [fn=>asExecutor(db,fn),schemaDenied,schemaDenied],
  ]){
   await assert.rejects(scope(()=>db.exec('select * from app.ai_jobs')),jobs);
   await assert.rejects(scope(()=>db.exec('update app.ai_budgets set limit_microusd=999')),budgetRows);
  }
  // EXECUTE is checked before a body runs, so arguments only need valid types.
  for(const [name,args] of [['ai_set_route',[route]],['ai_set_budget',[w,owner,period,'300']],['ai_admit_job',[owner,{}]],['ai_claim_job',[]],['ai_begin_dispatch',[uuid(1),'1']],['ai_fail_before_dispatch',[uuid(1),'1']],['ai_mark_unknown',[uuid(1),'1']],['ai_settle_job',[uuid(1),'1','event-denied','0','failed',null]],['ai_reap_jobs',[]]]){
   await assert.rejects(user(name,args),denied(name));
   await assert.rejects(asAnon(()=>rpc(db,name,args)),denied(name));
  }
  for(const [name,args] of [['ai_grant_consent',[{}]],['ai_revoke_consent',[uuid(1)]],['ai_cancel_job',[uuid(1)]],['ai_job_status',[uuid(1)]]]){
   await assert.rejects(asAnon(()=>rpc(db,name,args)),denied(name));
   await assert.rejects(exec(name,args),denied(name));
  }
  // Controls: the granted roles pass EXECUTE and reach the function bodies.
  assert.deepEqual(await exec('ai_reap_jobs'),{reaped:0});
  await assert.rejects(user('ai_job_status',[uuid(1)]),forbidden);
  assert.equal((await db.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app' and c.relname like 'ai_%' and c.relkind='r' and c.relrowsecurity")).rows[0].n,6);
 });
 await t.test('every raise in an AI function names a contract reason with its SQLSTATE',async()=>{
  // Covers paths no single-session test can reach, such as the unique-violation backstops.
  const {rows}=await db.query("select n.nspname||'.'||p.proname fn,p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname like 'ai\\_%' order by 1");
  assert.equal(rows.length,17,'AI functions found');
  const offending=[];let checked=0;
  for(const {fn,prosrc} of rows)for(const statement of prosrc.match(/\braise\b[^;]*;/gi)??[]){
   const match=statement.match(/^raise exception '([a-z_]+)' using errcode='(PT[0-9]{3})';$/);
   if(match&&Object.hasOwn(SERVER_ERRORS,match[1])&&SERVER_ERRORS[match[1]].sqlstate===match[2])checked++;
   else if(statement!=='raise;')offending.push(`${fn}: ${statement}`); // a bare re-raise keeps an unexpected error a server fault
  }
  assert.deepEqual(offending,[]);
  assert.ok(checked>=40,`only ${checked} contract raises found`);
  // Handlers name specific conditions; a catch-all would turn server faults into business errors.
  for(const {fn,prosrc} of rows)assert.doesNotMatch(prosrc,/\bwhen\s+others\b/i,fn);
 });
 await t.test('consent requires explicit approval, registered immutable exact route, current ACL and revision',async()=>{
  const c=consent();
  const invalidRoute=named('invalid_route');
  // Each case changes or removes one field of c, which is then granted.
  const rejected=[
   [{approved:false},invalidRequest],
   [{purpose:'other'},invalidRequest],
   // More than 24 hours ahead is request validation, not a consent decision.
   [{expires_at:new Date(Date.now()+25*3600000).toISOString()},invalidRequest],
   [{expires_at:new Date(Date.now()+24*3600000+60000).toISOString()},invalidRequest], // one minute past the limit
   // The largest bigint revision is well formed (it reaches the revision check); one more is not.
   [{source_revision:'9223372036854775807'},invalidConsent],[{source_revision:'9223372036854775808'},invalidRequest],
   [{provider_id:'other'},invalidRoute],[{model_id:'other'},invalidRoute],[{route_id:'unregistered'},invalidRoute],
   [{retention_version:'other'},invalidRoute],[{max_cost_microusd:'101'},invalidRoute],[{max_output_tokens:101},invalidRoute],
   [{source_revision:'2'},invalidConsent],[{expires_at:'2000-01-01T00:00:00Z'},invalidConsent],
   [{payload_sha256:'wrong'},invalidRequest],
   [{plaintext:'never-store'},invalidRequest],
   // Malformed fields fail before any cast or table constraint (formerly raw 22P02, 22003, 22007, 22008, 22009, 22023 or 23514).
   ...[...['consent_id','workspace_id','document_id'].flatMap(key=>[{[key]:'not-a-uuid'},{[key]:7}]),
    {source_revision:'abc'},{source_revision:'0'},{source_revision:'01'},{source_revision:1},{source_revision:'9'.repeat(19)},
    {max_cost_microusd:'0'},{max_cost_microusd:'-1'},{max_cost_microusd:'1.5'},{max_cost_microusd:100},{max_cost_microusd:'9'.repeat(19)},
    {max_output_tokens:'100'},{max_output_tokens:0},{max_output_tokens:1.5},{max_output_tokens:1000001},{max_output_tokens:2**31},
    {expires_at:'not-a-date'},{expires_at:'2026-02-30T00:00:00Z'},{expires_at:'2026-01-01T00:00:00+16:00'},{expires_at:'2026-01-01T00:00:00 Foo/Bar'},{expires_at:Date.now()+3600000},
    // 1e63 reads back as 64 digits, so only the JSON type check rejects it.
    {payload_sha256:'A'.repeat(64)},{payload_sha256:1e63},{purpose:null},{retention_version:''},{retention_version:'x'.repeat(201)},{retention_version:7},
   ].map(change=>[change,invalidRequest]),
  ];
  for(const [change,expected] of rejected)await assert.rejects(user('ai_grant_consent',[{...c,...change}]),expected,JSON.stringify(change));
  // A missing field is malformed (formerly raw 23502 for most); a missing route field matches no registered route.
  for(const key of Object.keys(c))await assert.rejects(user('ai_grant_consent',[omit(c,key)]),['provider_id','model_id','route_id'].includes(key)?invalidRoute:invalidRequest,key);
  for(const request of [null,'null','[]','"consent"'])await assert.rejects(user('ai_grant_consent',[request]),invalidRequest,String(request));
  await assert.rejects(user('ai_grant_consent',[c],''),named('unauthenticated'));
  // The other user RPCs also ask for a subject first, before looking anything up.
  for(const [name,args] of [['ai_job_status',[uuid(1)]],['ai_cancel_job',[uuid(1)]],['ai_revoke_consent',[uuid(1)]]])await assert.rejects(user(name,args,''),named('unauthenticated'),name);
  assert.equal(await count('app.ai_consents where id=$1',[c.consent_id]),0);
  await assert.rejects(user('ai_grant_consent',[c],outsider),invalidConsent);
  await assert.rejects(exec('ai_set_route',[{...route,model_id:'changed'}]),named('route_immutable'));
  // Malformed routes: each case changes or removes one field of route2, which is then registered.
  const route2={...route,route_id:'synthetic-v2'};
  for(const change of [{route_id:''},{route_id:'r'.repeat(201)},{provider_id:null},{model_id:''},{retention_version:'x'.repeat(201)},
   {max_cost_microusd:'0'},{max_cost_microusd:'-1'},{max_cost_microusd:'1.5'},{max_cost_microusd:'abc'},{max_cost_microusd:'9'.repeat(20)},{max_cost_microusd:[1]},
   {max_output_tokens:0},{max_output_tokens:1000001},{max_output_tokens:1.5},{max_output_tokens:2**31},{max_output_tokens:'many'},{extra:true}])
   await assert.rejects(exec('ai_set_route',[{...route2,...change}]),invalidRoute,JSON.stringify(change));
  for(const key of Object.keys(route2))await assert.rejects(exec('ai_set_route',[omit(route2,key)]),invalidRoute,key);
  for(const request of [null,'[]','"route"'])await assert.rejects(exec('ai_set_route',[request]),invalidRoute,String(request));
  assert.equal(await count('app.ai_routes where route_id=$1',[route2.route_id]),0);
  assert.deepEqual(await exec('ai_set_route',[route2]),route2);
  await assert.rejects(exec('ai_set_budget',[w,owner,period,'999']),named('budget_immutable'));
  const a=await user('ai_grant_consent',[c]);assert.equal(a.max_cost_microusd,'100');assert.equal(a.source_revision,'1');
  assert.deepEqual(await user('ai_grant_consent',[c]),a);
  await assert.rejects(user('ai_grant_consent',[{...c,max_output_tokens:99}]),named('consent_id_reused'));
 });
 await t.test('atomic reservation, hash-bound retry, budget/rate limit and scoped cancellation',async()=>{
  const {c,request,j}=await newJob();assert.equal(j.state,'queued');assert.equal(j.provider_id,'synthetic');assert.equal(j.fencing_token,'0');
  assert.deepEqual(await budgets(),[{held:'100',spent:'0'},{held:'100',spent:'0'}]);
  assert.deepEqual(await exec('ai_admit_job',[owner,request]),j);
  // Single-use consent: a second job ID for the same consent (formerly a raw 23505 unique violation).
  const reuse={...request,job_id:uuid(counter++)};
  await assert.rejects(exec('ai_admit_job',[owner,reuse]),named('consent_already_used'));
  assert.deepEqual(await budgets(),[{held:'100',spent:'0'},{held:'100',spent:'0'}]);
  assert.equal(await count('app.ai_jobs where id=$1',[reuse.job_id]),0);
  await assert.rejects(exec('ai_admit_job',[owner,{...request,input_ref:'changed'}]),named('job_id_reused'));
  await assert.rejects(exec('ai_admit_job',[owner,{...request,job_id:uuid(counter++),payload_sha256:'b'.repeat(64)}]),invalidConsent);
  await assert.rejects(user('ai_job_status',[j.id],outsider),forbidden);
  await assert.rejects(user('ai_cancel_job',[j.id],outsider),forbidden);
  const second=await newJob(),third=await newJob();await assert.rejects(newJob(),named('rate_limited'));
  // Consent reuse is decided before quotas: still consent_already_used while the active quota is full.
  await assert.rejects(exec('ai_admit_job',[owner,{...request,job_id:uuid(counter++)}]),named('consent_already_used'));
  assert.deepEqual(await budgets(),[{held:'300',spent:'0'},{held:'300',spent:'0'}]);
  assert.equal((await user('ai_cancel_job',[j.id])).state,'cancelled');await user('ai_cancel_job',[j.id]);
  await user('ai_revoke_consent',[second.c.consent_id]);
  await assert.rejects(exec('ai_admit_job',[owner,second.request]),invalidConsent);
  await user('ai_cancel_job',[third.j.id]);
  assert.deepEqual(await budgets(),[{held:'0',spent:'0'},{held:'0',spent:'0'}]);
  // Fresh consent: each rejected request changes or removes one field of valid, which is then admitted.
  const fresh=consent();await user('ai_grant_consent',[fresh]);const valid=admit(fresh);
  const rejected=[
   // Malformed fields (an input_ref URL was formerly a raw 23514 CHECK violation).
   ...[{input_ref:'https://example.invalid/payload'},{input_ref:''},{input_ref:'r'.repeat(201)},{input_ref:7},{job_id:'not-a-uuid'},{consent_id:'not-a-uuid'},
    {payload_sha256:'B'.repeat(64)},{payload_sha256:'wrong'},{payload_sha256:1e63},{route_id:1},{extra:true}].map(change=>[[owner,{...valid,...change}],invalidRequest]),
   ...Object.keys(valid).map(key=>[[owner,omit(valid,key)],invalidRequest]),
   [[null,valid],invalidRequest],...[null,'null','[]','"job"'].map(request=>[[owner,request],invalidRequest]),
   // Well formed, but not what the consent approved.
   [[owner,{...valid,payload_sha256:'b'.repeat(64)}],invalidConsent],
   [[owner,{...valid,route_id:'unregistered'}],invalidConsent],
   // A well-formed consent ID that does not exist, and the owner's consent admitted for another actor.
   [[owner,{...valid,consent_id:uuid(counter++)}],invalidConsent],
   [[outsider,valid],invalidConsent],
  ];
  for(const [args,expected] of rejected){
   await assert.rejects(exec('ai_admit_job',args),expected,JSON.stringify(args));
   assert.deepEqual(await budgets(),[{held:'0',spent:'0'},{held:'0',spent:'0'}]);
   assert.equal(await count('app.ai_jobs where id=$1',[valid.job_id]),0);
  }
  const control=await exec('ai_admit_job',[owner,valid]);assert.equal(control.state,'queued');assert.equal(control.input_ref,'opaque_input');
  assert.equal((await user('ai_cancel_job',[control.id])).state,'cancelled');
  assert.deepEqual(await budgets(),[{held:'0',spent:'0'},{held:'0',spent:'0'}]);
 });
 await t.test('expired claim requeues safely with fence, dispatched timeout keeps hold',async()=>{
  const {j}=await newJob();
  for(const lease of [0,901,null])await assert.rejects(exec('ai_claim_job',[lease]),named('invalid_lease'),String(lease));
  assert.equal((await job(j.id)).state,'queued');
  const claim=await exec('ai_claim_job',[60]);assert.equal(claim.id,j.id);assert.equal(claim.fencing_token,'1');
  await db.query("update app.ai_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[j.id]);
  await exec('ai_reap_jobs');const newer=await exec('ai_claim_job',[60]);assert.equal(newer.fencing_token,'2');
  await assert.rejects(exec('ai_begin_dispatch',[j.id,'1']),named('stale_fence'));
  assert.equal((await exec('ai_begin_dispatch',[j.id,'2'])).state,'dispatched');
  await assert.rejects(exec('ai_begin_dispatch',[j.id,'2']),named('not_claimed'));
  await assert.rejects(exec('ai_fail_before_dispatch',[j.id,'2']),named('not_claimed'));
  await user('ai_cancel_job',[j.id]);assert.equal((await budgets())[0].held,'100');
  await db.query("update app.ai_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[j.id]);
  await exec('ai_reap_jobs');assert.equal((await user('ai_job_status',[j.id])).state,'outcome_unknown');assert.equal(await exec('ai_claim_job',[60]),null);
  await assert.rejects(exec('ai_settle_job',[j.id,'2','event-one','101','succeeded','draft_one']),named('invalid_cost'));
  assert.equal((await budgets())[0].held,'100');
  const args=[j.id,'2','event-one','40','succeeded','draft_one'];const done=await exec('ai_settle_job',args);assert.equal(done.state,'cancelled');assert.equal(done.result_ref,null);
  assert.deepEqual(await exec('ai_settle_job',args),done);
  await assert.rejects(exec('ai_settle_job',[j.id,'2','event-one','41','succeeded','draft_one']),named('settlement_conflict'));
  assert.deepEqual(await budgets(),[{held:'0',spent:'40'},{held:'0',spent:'40'}]);
  assert.equal((await db.query('select count(*)::int n from app.ai_attempts')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from app.ai_usage_ledger')).rows[0].n,1);
  assert.equal((await db.query('select revision::text r from app.documents where id=$1',[d])).rows[0].r,'1');
 });
 await t.test('begin dispatch rechecks ACL, revision, expiry and revocation',async()=>{
  for(const scenario of ['acl','revision','expiry','revocation']){
   const {j,c}=await newJob();const claim=await exec('ai_claim_job',[60]);
   // set_document_acl is compare-and-set on the ACL version now (F02); setAcl reads the version first. Same {} ACL as before.
   if(scenario==='acl'){await setAcl(db,owner,'document',w,d,{});await assert.rejects(exec('ai_admit_job',[owner,{job_id:j.id,consent_id:c.consent_id,input_ref:'opaque_input',payload_sha256:hash,route_id:route.route_id}]),invalidConsent);assert.equal((await user('ai_job_status',[j.id])).input_ref,undefined);}
   if(scenario==='revision'){await db.query('update app.documents set revision=2 where id=$1',[d]);assert.equal((await user('ai_job_status',[j.id])).source_stale,true);}
   if(scenario==='expiry')await db.query("update app.ai_consents set expires_at=clock_timestamp()-interval '1 second' where id=$1",[c.consent_id]);
   if(scenario==='revocation')await user('ai_revoke_consent',[c.consent_id]);
   if(scenario==='revocation')await assert.rejects(exec('ai_begin_dispatch',[j.id,claim.fencing_token]),named('not_claimed'));
   else assert.equal((await exec('ai_begin_dispatch',[j.id,claim.fencing_token])).state,'cancelled');
   await db.query('update app.documents set revision=1,acl=$2::jsonb where id=$1',[d,JSON.stringify({[owner]:'editor'})]);
  }
  assert.equal((await budgets())[0].held,'0');
 });
 await t.test('budget exhaustion rolls back admission; revoked dispatched work retains held funds',async()=>{
  await db.exec("update app.ai_jobs set created_at=clock_timestamp()-interval '2 minutes'");
  const first=await newJob(),second=await newJob();
  await assert.rejects(newJob(),named('budget_exceeded'));
  assert.deepEqual(await budgets(),[{held:'200',spent:'40'},{held:'200',spent:'40'}]);
  const claim=await exec('ai_claim_job',[60]);assert.equal(claim.id,first.j.id);
  await exec('ai_begin_dispatch',[first.j.id,claim.fencing_token]);
  await user('ai_revoke_consent',[first.c.consent_id]);
  assert.equal((await user('ai_job_status',[first.j.id])).state,'dispatched');
  await exec('ai_mark_unknown',[first.j.id,claim.fencing_token]);
  await user('ai_cancel_job',[second.j.id]);
  // Event IDs are unique across jobs (formerly a raw 23505 unique violation); nothing settles.
  await assert.rejects(exec('ai_settle_job',[first.j.id,claim.fencing_token,'event-one','0','failed',null]),named('event_id_reused'));
  assert.deepEqual(await job(first.j.id),{state:'outcome_unknown',hold_released:false,result_ref:null});
  assert.equal(await count('app.ai_usage_ledger where job_id=$1',[first.j.id]),0);
  assert.equal((await budgets())[0].held,'100');
  await exec('ai_settle_job',[first.j.id,claim.fencing_token,'event-two','0','succeeded','discarded_draft']);
  const cancelled=await user('ai_job_status',[first.j.id]);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.result_ref,null);
  assert.deepEqual(await budgets(),[{held:'0',spent:'40'},{held:'0',spent:'40'}]);
  await assert.rejects(exec('ai_admit_job',[owner,{...first.request,job_id:uuid(counter++)}]),invalidConsent);
  // The line above has two defects (consent revoked and already used). Single defect: revoked, never used.
  const revoked=consent();await user('ai_grant_consent',[revoked]);await user('ai_revoke_consent',[revoked.consent_id]);
  const unused=admit(revoked);
  await assert.rejects(exec('ai_admit_job',[owner,unused]),invalidConsent);
  assert.equal(await count('app.ai_jobs where id=$1',[unused.job_id]),0);
  assert.deepEqual(await budgets(),[{held:'0',spent:'40'},{held:'0',spent:'40'}]);
 });
 await t.test('pre-dispatch failure releases once; rolling rate limit independent of budgets',async()=>{
  // Age prior admissions only in fixture to isolate quota behavior.
  await db.exec("update app.ai_jobs set created_at=clock_timestamp()-interval '2 minutes'");
  for(let i=0;i<10;i++){
   const {j}=await newJob();const claim=await exec('ai_claim_job',[60]);assert.equal(claim.id,j.id);
   assert.equal((await exec('ai_fail_before_dispatch',[j.id,claim.fencing_token])).state,'failed');
   await assert.rejects(exec('ai_fail_before_dispatch',[j.id,claim.fencing_token]),named('not_claimed'));
  }
  await assert.rejects(newJob(),named('rate_limited'));assert.equal((await budgets())[0].held,'0');
 });
 await t.test('workspaces isolate consent binding, reservation and release',async()=>{
  const w2=uuid(11),d2=uuid(21);
  await user('create_workspace',[w2,'Synthetic two']);await user('create_document',[w2,d2,null,'note',cipher(w2,d2)]);await enableAi(db,owner,w2);
  for(const actor of [null,owner])await exec('ai_set_budget',[w2,actor,period,'300']);
  // Non-member actor budget: actor_not_member (formerly an errcode-less 'forbidden', P0001).
  await assert.rejects(exec('ai_set_budget',[w2,outsider,period,'300']),named('actor_not_member'));
  assert.equal(await count('app.ai_budgets where workspace_id=$1 and scope=$2',[w2,outsider]),0);
  // Each case changes one argument of the workspace budget call above (formerly raw 23502, 23503 or 23514).
  // A missing workspace is reported as such even when an actor is given (not as actor_not_member).
  for(const [args,reason] of [[[uuid(99),null,period,'300'],'workspace_not_found'],[[uuid(99),owner,period,'300'],'workspace_not_found'],[[null,null,period,'300'],'invalid_request'],
   [[w2,null,'2026-13','300'],'invalid_request'],[[w2,null,'202611','300'],'invalid_request'],[[w2,null,null,'300'],'invalid_request'],
   [[w2,null,period,'-1'],'invalid_request'],[[w2,null,period,null],'invalid_request']]){
   await assert.rejects(exec('ai_set_budget',args),named(reason),JSON.stringify(args));
   assert.equal(await count('app.ai_budgets where workspace_id is distinct from $1 and workspace_id is distinct from $2',[w,w2]),0);
   assert.equal(await count('app.ai_budgets where workspace_id=$1',[w2]),2);
  }
  assert.equal((await exec('ai_set_budget',[w2,null,period,'300'])).limit_microusd,'300');
  // Each cross-workspace binding changes one field of c2, which is then granted.
  const c2={...consent(),workspace_id:w2,document_id:d2};
  for(const change of [{workspace_id:w},{document_id:d}])await assert.rejects(user('ai_grant_consent',[{...c2,...change}]),invalidConsent);
  assert.equal(await count('app.ai_consents where id=$1',[c2.consent_id]),0);
  const granted=await user('ai_grant_consent',[c2]);assert.equal(granted.workspace_id,w2);assert.equal(granted.document_id,d2);
  const untouched=await budgets();
  const j2=await exec('ai_admit_job',[owner,admit(c2)]);assert.equal(j2.state,'queued');assert.equal(j2.workspace_id,w2);
  assert.deepEqual(await budgets(w2),[{held:'100',spent:'0'},{held:'100',spent:'0'}]);
  assert.deepEqual(await budgets(),untouched);
  assert.equal((await user('ai_cancel_job',[j2.id])).state,'cancelled');
  assert.deepEqual(await budgets(w2),[{held:'0',spent:'0'},{held:'0',spent:'0'}]);
  assert.deepEqual(await budgets(),untouched);
 });
 await t.test('failed settlement releases the hold, spends the actual cost and replays idempotently',async()=>{
  // Age prior admissions only in fixture to isolate quota behavior.
  await db.exec("update app.ai_jobs set created_at=clock_timestamp()-interval '2 minutes'");
  const {j}=await newJob();const claim=await exec('ai_claim_job',[60]);assert.equal(claim.id,j.id);
  // A claimed job has not passed ai_begin_dispatch's recheck, so it can be neither settled nor marked unknown.
  for(const [name,args] of [['ai_settle_job',[j.id,claim.fencing_token,'event-early','7','failed',null]],['ai_mark_unknown',[j.id,claim.fencing_token]]]){
   await assert.rejects(exec(name,args),named('not_dispatched'));
   assert.deepEqual(await job(j.id),{state:'claimed',hold_released:false,result_ref:null});
  }
  assert.equal(await count('app.ai_usage_ledger where job_id=$1',[j.id]),0);
  assert.equal((await exec('ai_begin_dispatch',[j.id,claim.fencing_token])).state,'dispatched');
  const reserved=await budgets(),otherWorkspace=await budgets(uuid(11));assert.deepEqual(reserved.map(b=>b.held),['100','100']);
  const token=claim.fencing_token,args=[j.id,token,'event-three','7','failed',null];
  // A succeeded settlement differs from args in outcome and result reference; its cases change one argument of it.
  const succeeded=[j.id,token,'event-three','7','succeeded','draft_three'];
  // Each rejection changes one argument and leaves job, budgets and ledger unchanged.
  for(const [rejected,reason] of [
   [args.with(1,String(BigInt(token)-1n)),'stale_fence'],[args.with(0,uuid(counter++)),'job_not_found'],
   [args.with(5,'draft_failed'),'invalid_outcome'],[args.with(4,'succeeded'),'invalid_outcome'],[args.with(4,'bogus'),'invalid_outcome'],
   [args.with(3,'101'),'invalid_cost'],[args.with(3,'-1'),'invalid_cost'],
   // The ledger CHECKs on event ID and result reference (formerly raw 23502 or 23514), and an event settled for another job.
   [args.with(2,''),'invalid_request'],[args.with(2,'e'.repeat(201)),'invalid_request'],[args.with(2,null),'invalid_request'],
   [succeeded.with(5,'https://example.invalid/draft'),'invalid_request'],[succeeded.with(5,''),'invalid_request'],[succeeded.with(5,'r'.repeat(201)),'invalid_request'],
   [args.with(2,'event-one'),'event_id_reused'],
  ]){
   await assert.rejects(exec('ai_settle_job',rejected),named(reason),JSON.stringify(rejected));
   assert.deepEqual(await job(j.id),{state:'dispatched',hold_released:false,result_ref:null});
   assert.deepEqual(await budgets(),reserved);
   assert.equal(await count('app.ai_usage_ledger where job_id=$1',[j.id]),0);
  }
  const settled=await exec('ai_settle_job',args);
  assert.equal(settled.state,'failed');assert.equal(settled.result_ref,null);assert.equal(settled.hold_released,true);
  const spent=reserved.map(b=>({held:String(BigInt(b.held)-100n),spent:String(BigInt(b.spent)+7n)}));
  assert.deepEqual(await budgets(),spent);
  assert.deepEqual(await budgets(uuid(11)),otherWorkspace); // settlement charges only this job's workspace
  assert.deepEqual((await db.query('select provider_event_id,cost_microusd::text cost,outcome,result_ref from app.ai_usage_ledger where job_id=$1',[j.id])).rows,[{provider_event_id:'event-three',cost:'7',outcome:'failed',result_ref:null}]);
  assert.deepEqual(await exec('ai_settle_job',args),settled);
  // Any changed field of a settled job conflicts: event, cost, outcome or result reference.
  for(const [index,value] of [[2,'event-four'],[3,'8'],[4,'succeeded'],[5,'draft_x']])await assert.rejects(exec('ai_settle_job',args.with(index,value)),named('settlement_conflict'));
  assert.deepEqual(await budgets(),spent);
  const status=await user('ai_job_status',[j.id]);assert.equal(status.state,'failed');assert.equal(status.result_ref,null);
 });
 await t.test('admission needs both budget rows for the month: budget_not_configured, distinct from budget_exceeded',async()=>{
  // Fresh workspaces keep the quotas and budgets of earlier cases out of the way.
  const setup=async(workspace,document,limits)=>{
   await user('create_workspace',[workspace,'Synthetic budgets']);await user('create_document',[workspace,document,null,'note',cipher(workspace,document)]);await enableAi(db,owner,workspace);
   for(const [actor,limit] of limits)await exec('ai_set_budget',[workspace,actor,period,limit]);
   const c={...consent(),workspace_id:workspace,document_id:document};await user('ai_grant_consent',[c]);return admit(c);
  };
  // Single defect each: only the workspace row, or only the actor row, exists.
  for(const [workspace,document,present,missing] of [[uuid(12),uuid(22),null,owner],[uuid(13),uuid(23),owner,null]]){
   const request=await setup(workspace,document,[[present,'300']]);
   await assert.rejects(exec('ai_admit_job',[owner,request]),named('budget_not_configured'));
   assert.equal(await count('app.ai_jobs where id=$1',[request.job_id]),0);
   assert.deepEqual(await budgets(workspace),[{held:'0',spent:'0'}]);
   // Control: configuring the missing row admits the same request.
   await exec('ai_set_budget',[workspace,missing,period,'300']);
   const admitted=await exec('ai_admit_job',[owner,request]);assert.equal(admitted.state,'queued');
   assert.deepEqual(await budgets(workspace),[{held:'100',spent:'0'},{held:'100',spent:'0'}]);
   assert.equal((await user('ai_cancel_job',[admitted.id])).state,'cancelled');
  }
  // Both rows exist but the actor row cannot hold the consent cap: budget_exceeded.
  const short=await setup(uuid(14),uuid(24),[[null,'300'],[owner,'99']]);
  await assert.rejects(exec('ai_admit_job',[owner,short]),named('budget_exceeded'));
  assert.equal(await count('app.ai_jobs where id=$1',[short.job_id]),0);
  assert.deepEqual(await budgets(uuid(14)),[{held:'0',spent:'0'},{held:'0',spent:'0'}]);
 });
});

// The tests below each open a fresh database with the route of the suite above.
const ROUTE={route_id:'synthetic-v1',provider_id:'synthetic',model_id:'test',retention_version:'none-v1',max_cost_microusd:'100',max_output_tokens:100};
const HASH='a'.repeat(64);
const contract=reason=>{assert.ok(Object.hasOwn(SERVER_ERRORS,reason),`not a contract reason: ${reason}`);return {code:SERVER_ERRORS[reason].sqlstate,message:reason};};
// Rows as sorted canonical JSON: appState orders rows by content, which a change of content reorders.
const canonical=rows=>rows.map(row=>JSON.stringify(Object.keys(row).sort().map(key=>[key,row[key]]))).sort();
async function open(t,users,options={}){
 const db=await aiDatabase(options);t.after(()=>db.close());
 for(const u of users)await db.query('insert into auth.users values($1)',[u]);
 const call=(u,name,args=[])=>asUser(db,u,()=>rpc(db,name,args));
 const exec=(name,args=[])=>asExecutor(db,()=>rpc(db,name,args));
 await exec('ai_set_route',[ROUTE]);
 const period=(await db.query("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM') p")).rows[0].p;
 let n=1000;const next=()=>uuid(n++);
 const consent=(w,d,change={})=>({approved:true,provider_id:ROUTE.provider_id,model_id:ROUTE.model_id,consent_id:next(),workspace_id:w,document_id:d,source_revision:'1',payload_sha256:HASH,route_id:ROUTE.route_id,purpose:'summary',retention_version:ROUTE.retention_version,max_cost_microusd:'100',max_output_tokens:100,expires_at:new Date(Date.now()+3600000).toISOString(),...change});
 const admission=c=>({job_id:next(),consent_id:c.consent_id,input_ref:'opaque_input',payload_sha256:HASH,route_id:ROUTE.route_id});
 // Every budget row, so a test sees exactly which rows a call touched.
 const budgets=async()=>(await db.query('select workspace_id,scope,held_microusd::text held,spent_microusd::text spent from app.ai_budgets order by workspace_id,scope')).rows;
 // A refused call writes nothing anywhere.
 const refused=async(run,reason,label)=>{const before=await appState(db);await assert.rejects(run(),contract(reason),label);assert.deepEqual(await appState(db),before,label);};
 return {db,call,exec,period,consent,admission,budgets,refused};
}

test('F29 minimum: AI stays off until the owner turns it on; consent, admission and dispatch need edit access to the document',async t=>{
 const [owner,editor,viewer,limited,outsider]=[1,2,3,4,5].map(uuid),w=uuid(10),missing=uuid(99),[d,restricted]=[20,21].map(uuid);
 const {db,call,exec,period,consent,admission,budgets,refused}=await open(t,[owner,editor,viewer,limited,outsider]);
 await call(owner,'create_workspace',[w,'Synthetic F29']);
 for(const [u,role] of [[editor,'editor'],[viewer,'viewer'],[limited,'editor']])await join(db,owner,w,u,role);
 // d inherits the workspace roles (F01); the ACL of restricted limits `limited`, an editor, to viewer.
 for(const id of [d,restricted])await call(owner,'create_document',[w,id,null,'note',cipher(w,id)]);
 await setAcl(db,owner,'document',w,restricted,{[owner]:'editor',[editor]:'editor',[viewer]:'viewer',[limited]:'viewer'});
 for(const actor of [null,owner,editor,viewer,limited])await exec('ai_set_budget',[w,actor,period,'1000']);
 const idle=await budgets();

 await t.test('off by default: a member gets ai_disabled; anyone else invalid_consent, whether or not the workspace exists',async()=>{
  assert.equal((await call(owner,'list_my_workspaces')).workspaces[0].ai_enabled,false);
  for(const u of [owner,editor,viewer,limited])await refused(()=>call(u,'ai_grant_consent',[consent(w,d)]),'ai_disabled',u);
  // Membership is decided before the switch is read, so a non-member cannot tell these cases apart.
  for(const [u,workspace] of [[outsider,w],[outsider,missing],[editor,missing]])await refused(()=>call(u,'ai_grant_consent',[consent(workspace,d)]),'invalid_consent',`${u} ${workspace}`);
  // The route is still checked first.
  await refused(()=>call(editor,'ai_grant_consent',[consent(w,d,{route_id:'unregistered'})]),'invalid_route');
 });

 await t.test('only the owner turns it on',async()=>{
  await refused(()=>call(editor,'set_ai_enabled',[w,true]),'forbidden');
  assert.deepEqual(await call(owner,'set_ai_enabled',[w,true]),{ai_enabled:true,changed:true});
 });

 await t.test('consent needs edit access: a viewer, and an editor whom the document ACL limits to viewer, get invalid_consent',async()=>{
  for(const [u,document] of [[viewer,d],[viewer,restricted],[limited,restricted]])await refused(()=>call(u,'ai_grant_consent',[consent(w,document)]),'invalid_consent',`${u} ${document}`);
  // Controls: people with edit access to the same documents, `limited` included on the inheriting one.
  for(const [u,document] of [[limited,d],[editor,restricted],[editor,d],[owner,d]])assert.equal((await call(u,'ai_grant_consent',[consent(w,document)])).actor_id,u,`${u} ${document}`);
 });

 await t.test('admission: AI off is ai_disabled, a replay included; an actor without edit access gets invalid_consent; nothing is reserved',async()=>{
  const first=consent(w,d),second=consent(w,d);
  for(const c of [first,second])await call(editor,'ai_grant_consent',[c]);
  const [replay,fresh]=[admission(first),admission(second)];
  const queued=await exec('ai_admit_job',[editor,replay]);assert.equal(queued.state,'queued');
  await call(owner,'set_ai_enabled',[w,false]);
  for(const request of [replay,fresh])await refused(()=>exec('ai_admit_job',[editor,request]),'ai_disabled',request.job_id);
  await call(owner,'set_ai_enabled',[w,true]);
  await call(owner,'set_member',[w,editor,'viewer']);
  for(const request of [replay,fresh])await refused(()=>exec('ai_admit_job',[editor,request]),'invalid_consent',request.job_id);
  await call(owner,'set_member',[w,editor,'editor']);
  // Controls: with edit access back, the replay returns the same job and the second consent is admitted.
  assert.deepEqual(await exec('ai_admit_job',[editor,replay]),queued);
  assert.equal((await exec('ai_admit_job',[editor,fresh])).state,'queued');
  for(const request of [replay,fresh])assert.equal((await call(editor,'ai_cancel_job',[request.job_id])).state,'cancelled');
  assert.deepEqual(await budgets(),idle);
 });

 await t.test('dispatch cancels a queued job once AI is off or its actor lost edit access, releasing both holds',async()=>{
  for(const [label,change,undo] of [
   ['AI turned off',()=>call(owner,'set_ai_enabled',[w,false]),()=>call(owner,'set_ai_enabled',[w,true])],
   ['actor demoted to viewer',()=>call(owner,'set_member',[w,editor,'viewer']),()=>call(owner,'set_member',[w,editor,'editor'])],
   ['document ACL limits the actor to viewer',()=>setAcl(db,owner,'document',w,d,{[owner]:'editor',[editor]:'viewer'}),()=>setAcl(db,owner,'document',w,d,null)],
   ['control: nothing changed',async()=>{},async()=>{}],
  ]){
   const c=consent(w,d);await call(editor,'ai_grant_consent',[c]);
   const j=await exec('ai_admit_job',[editor,admission(c)]);
   await change();
   const claim=await exec('ai_claim_job',[60]);assert.equal(claim.id,j.id,label);
   const result=await exec('ai_begin_dispatch',[j.id,claim.fencing_token]);
   await undo();
   if(label.startsWith('control')){
    assert.equal(result.state,'dispatched',label);
    // Settled at no cost, so the budgets compare equal below.
    await exec('ai_settle_job',[j.id,claim.fencing_token,'event-control','0','failed',null]);
   } else assert.deepEqual([result.state,result.hold_released],['cancelled',true],label);
   assert.deepEqual(await budgets(),idle,label);
  }
 });
});

test('account deletion (F24) with AI rows: shared workspaces keep them unlinked, a solo workspace takes them along',async t=>{
 // Claims-only identity, as PostgREST sends it: the mode in which auth.uid() falls back to request.jwt.claims.
 const [O,E]=[1,2].map(uuid),[W,W2,W3,WE,W4,W5]=[10,11,12,13,14,15].map(uuid),[dW,dW2,dE,dW5]=[20,21,22,23].map(uuid);
 const {db,call,exec,period,consent,admission,budgets,refused}=await open(t,[O,E],{auth:'supabase'});
 // W (O's): E is an editor with a succeeded, a dispatched, a claimed and a queued job. W2, W3 and W5 (O's): E left,
 // keeping a job and a budget row in W2, only a budget row in W3 and only a consent in W5. WE: E alone, with a settled
 // and a claimed job. W4 (O's, alone) has nothing of E.
 for(const x of [W,W2,W3,W4,W5])await call(O,'create_workspace',[x,'Synthetic shared']);
 for(const x of [W,W2,W3,W5])await join(db,O,x,E,'editor');
 for(const [x,document] of [[W,dW],[W2,dW2],[W5,dW5]])await call(O,'create_document',[x,document,null,'note',cipher(x,document)]);
 await call(E,'create_workspace',[WE,'Synthetic solo']);await call(E,'create_document',[WE,dE,null,'note',cipher(WE,dE)]);
 for(const [x,owner] of [[W,O],[W2,O],[W5,O],[WE,E]])await enableAi(db,owner,x);
 for(const [x,actors] of [[W,[null,O,E]],[W2,[null,E]],[W3,[null,E]],[WE,[null,E]]])for(const actor of actors)await exec('ai_set_budget',[x,actor,period,'1000']);
 // A claim takes the oldest queued job of the lowest workspace id that has one, so each claim below gets its own job.
 const job=async(actor,x,document,{claim=false,dispatch=false}={})=>{
  const c=consent(x,document);await call(actor,'ai_grant_consent',[c]);const request=admission(c);
  const id=(await exec('ai_admit_job',[actor,request])).id;let token=null;
  if(claim){const claimed=await exec('ai_claim_job',[60]);assert.equal(claimed.id,id);token=claimed.fencing_token;}
  if(dispatch)assert.equal((await exec('ai_begin_dispatch',[id,token])).state,'dispatched');
  return {request,id,token};
 };
 const settledSolo=await job(E,WE,dE,{claim:true,dispatch:true});
 await exec('ai_settle_job',[settledSolo.id,settledSolo.token,'event-solo','5','succeeded','draft_solo']);
 const claimedSolo=await job(E,WE,dE,{claim:true});
 const left=await job(E,W2,dW2);
 await call(E,'ai_grant_consent',[consent(W5,dW5)]);
 for(const x of [W2,W3,W5])await call(E,'leave_workspace',[x]);
 // Finished first: a finished job no longer counts against E's 3 active jobs.
 const succeeded=await job(E,W,dW,{claim:true,dispatch:true});
 await exec('ai_settle_job',[succeeded.id,succeeded.token,'event-finished','7','succeeded','draft_finished']);
 const dispatched=await job(E,W,dW,{claim:true,dispatch:true}),claimed=await job(E,W,dW,{claim:true}),queued=await job(E,W,dW);
 const unused=consent(W,dW);await call(E,'ai_grant_consent',[unused]);
 const others=await job(O,W,dW);
 // ai_admit_job's request hash: sha256 of the actor id and the request.
 const hashedWith=async({id,request},actor)=>(await db.query("select request_hash=sha256(convert_to(jsonb_build_object('actor_id',$2::uuid,'request',$3::jsonb)::text,'UTF8')) same from app.ai_jobs where id=$1",[id,actor,request])).rows[0].same;
 // The budget rows after a change of the workspace row (scope '') of x.
 const charged=(rows,x,held,spent=0n)=>rows.map(b=>b.workspace_id===x&&b.scope===''?{...b,held:String(BigInt(b.held)+held),spent:String(BigInt(b.spent)+spent)}:b);

 await t.test('the AI hook replaced the no-op and kept owner sync_backend, the pinned search_path and no EXECUTE for PUBLIC or a client role; no other hook exists',async()=>{
  const {rows}=await db.query(`select p.proname,pg_get_userbyid(p.proowner) owner,p.prosecdef definer,p.proconfig config,p.prosrc like '%app.ai_budgets%' replaced,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute,
    array(select r from unnest(array['anon','authenticated','ai_executor','sync_maintainer']) r where has_function_privilege(r,p.oid,'EXECUTE')) roles
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'forget_user_hook%' order by 1`);
  assert.deepEqual(rows,[{proname:'forget_user_hook',owner:'sync_backend',definer:false,config:['search_path=pg_catalog'],replaced:true,public_execute:false,roles:[]}]);
 });

 await t.test('catalog: actor columns indexed, the cascade and budget checks of a deletion indexed, actor foreign keys still NO ACTION (a missed reference fails the delete), AI rows cascade from their document or workspace only',async()=>{
  const {rows}=await db.query("select indexdef from pg_indexes where schemaname='app' and indexname in ('ai_consents_actor','ai_jobs_actor','ai_consents_document','ai_jobs_actor_budget','ai_jobs_workspace_budget','ai_jobs_budget') order by indexname");
  assert.deepEqual(rows.map(r=>r.indexdef),[...['ai_consents','ai_jobs'].map(table=>`CREATE INDEX ${table}_actor ON app.${table} USING btree (actor_id) WHERE (actor_id IS NOT NULL)`),
   'CREATE INDEX ai_consents_document ON app.ai_consents USING btree (workspace_id, document_id)',
   // The exact columns of the two budget foreign keys; the earlier (workspace_id, period) index is gone.
   'CREATE INDEX ai_jobs_actor_budget ON app.ai_jobs USING btree (workspace_id, actor_scope, period)','CREATE INDEX ai_jobs_workspace_budget ON app.ai_jobs USING btree (workspace_id, workspace_scope, period)'].sort());
  const {rows:keys}=await db.query("select conname,confdeltype::text action from pg_constraint where contype='f' and conrelid::regclass::text like 'app.ai\\_%' order by conname");
  const cascade='c',noAction='a';
  assert.deepEqual(Object.fromEntries(keys.map(r=>[r.conname,r.action])),{
   ai_attempts_workspace_id_job_id_fkey:cascade,ai_budgets_workspace_id_fkey:cascade,ai_consents_actor_id_fkey:noAction,ai_consents_route_id_fkey:noAction,
   ai_consents_workspace_id_document_id_fkey:cascade,ai_jobs_actor_id_fkey:noAction,ai_jobs_workspace_id_actor_scope_period_fkey:noAction,
   ai_jobs_workspace_id_consent_id_fkey:cascade,ai_jobs_workspace_id_workspace_scope_period_fkey:noAction,ai_usage_ledger_workspace_id_job_id_fkey:cascade,
  });
 });

 // E's AI rows, by kind, as workspace ids.
 const aiRows=async()=>(await db.query(`select array(select distinct workspace_id from app.ai_consents where actor_id=$1 order by 1) consents,
   array(select distinct workspace_id from app.ai_jobs where actor_id=$1 order by 1) jobs,array(select distinct workspace_id from app.ai_budgets where scope=$1::text order by 1) budgets`,[E])).rows[0];

 await t.test("before: E is a member of W and WE only, has AI rows in W2, W3 and W5 too, and each job hash is bound to its actor",async()=>{
  assert.deepEqual((await db.query('select array_agg(workspace_id order by workspace_id) ws from app.members where user_id=$1',[E])).rows[0].ws,[W,WE]);
  // W3 has only a budget row, W5 only a consent.
  assert.deepEqual(await aiRows(),{consents:[W,W2,WE,W5],jobs:[W,W2,WE],budgets:[W,W2,W3,WE]});
  // Positive control for the check after the deletion: the stored hash is recomputable from actor and request.
  for(const j of [succeeded,dispatched,claimed,queued,left])assert.equal(await hashedWith(j,E),true);
  assert.deepEqual((await db.query('select state,actor_id from app.ai_jobs where id=$1',[succeeded.id])).rows,[{state:'succeeded',actor_id:E}]);
  assert.equal(await hashedWith(others,O),true);
 });

 await t.test('the deletion locks W only, where E is a member (WE goes); E\'s AI rows in W2, W3 and W5 are unlinked without a lock on those workspaces',async()=>{
  // Dry run without a subject, rolled back. A workspace row the deletion locked has xmax >= its transaction id (W's new
  // version too: the removal's audit and signal rows key-share it). E left W2, W3 and W5: their members cannot delay
  // the deletion (VS-A2), although E's accept and leave audit rows there have actor = target = E (VS-A1). W4 holds
  // nothing of E, and WE is deleted.
  const seen=await dryRunDeletion(db,E,async({top})=>({
   locked:(await db.query('select id from app.workspaces where xmax::text::bigint>=$1::bigint order by id',[top])).rows.map(r=>r.id),
   rows:await aiRows(),
   // The hook's row work in an unlocked workspace: the consent and the job stay, unlinked, with the actor-free hash.
   left:(await db.query("select j.actor_id job_actor,c.actor_id consent_actor,j.request_hash=sha256(uuid_send(j.id)) rehashed from app.ai_jobs j join app.ai_consents c on c.id=j.consent_id where j.id=$1",[left.id])).rows,
  }));
  assert.deepEqual(seen,{locked:[W],rows:{consents:[],jobs:[],budgets:[]},left:[{job_actor:null,consent_actor:null,rehashed:true}]});
 });

 await t.test("E is deleted: its solo workspace goes with every AI row; elsewhere E's rows lose the actor and the actor-bound hash, and its budget rows go",async()=>{
  const before=await appState(db);
  assert.equal(await deleteUserAsAuthAdmin(db,E),1);
  const after=await appState(db);
  const kept=row=>row.workspace_id!==WE,unlinkedHash=id=>`\\x${createHash('sha256').update(Buffer.from(id.replaceAll('-',''),'hex')).digest('hex')}`;
  const expected={
   ai_routes:before.ai_routes,
   ai_consents:before.ai_consents.filter(kept).map(r=>r.actor_id===E?{...r,actor_id:null}:r),
   ai_jobs:before.ai_jobs.filter(kept).map(r=>r.actor_id===E?{...r,actor_id:null,actor_scope:null,request_hash:unlinkedHash(r.id)}:r),
   ai_budgets:before.ai_budgets.filter(r=>kept(r)&&r.scope!==E),
   ai_attempts:before.ai_attempts.filter(kept),ai_usage_ledger:before.ai_usage_ledger.filter(kept),
  };
  for(const [table,rows] of Object.entries(expected))assert.deepEqual(canonical(after[table]),canonical(rows),table);
  // WE had rows in every AI table, and its workspace budget row (not E's scope) can only have gone by cascade.
  for(const table of Object.keys(expected).filter(name=>name!=='ai_routes'))assert.ok(before[table].some(r=>r.workspace_id===WE),table);
  assert.ok(before.ai_budgets.some(r=>r.workspace_id===WE&&r.scope===''));
  assert.deepEqual(after.workspaces.map(x=>x.id).sort(),[W,W2,W3,W4,W5].sort());
  // E's id appears nowhere, and no job hash matches a recomputation with it; O's job is still bound to O.
  assert.equal(JSON.stringify(after).includes(E),false);
  for(const j of [succeeded,dispatched,claimed,queued,left])assert.equal(await hashedWith(j,E),false);
  assert.equal(await hashedWith(others,O),true);
  // A finished job in a shared workspace is unlinked like the others: no actor, and the hash of its id only.
  assert.deepEqual((await db.query('select state,actor_id,request_hash=sha256(uuid_send(id)) rehashed from app.ai_jobs where id=$1',[succeeded.id])).rows,[{state:'succeeded',actor_id:null,rehashed:true}]);
 });

 await t.test('a claimed job of the deleted account is cancelled at dispatch and releases the workspace hold only',async()=>{
  const before=await budgets();
  const result=await exec('ai_begin_dispatch',[claimed.id,claimed.token]);
  assert.deepEqual([result.state,result.actor_id,result.hold_released],['cancelled',null,true]);
  assert.deepEqual(await budgets(),charged(before,W,-100n));
 });

 await t.test('a dispatched job of the deleted account still settles, charging the workspace budget only',async()=>{
  const before=await budgets();
  const result=await exec('ai_settle_job',[dispatched.id,dispatched.token,'event-shared','7','succeeded','draft_shared']);
  assert.deepEqual([result.state,result.actor_id,result.result_ref],['succeeded',null,'draft_shared']);
  assert.deepEqual(await budgets(),charged(before,W,-100n,7n));
  assert.equal((await db.query('select count(*)::int n from app.ai_usage_ledger where job_id=$1',[dispatched.id])).rows[0].n,1);
 });

 await t.test("with a member's JWT claims in the executor session, a queued job of the deleted account is still cancelled",async()=>{
  // As if a bridge forwarded O's claims: the hosted auth.uid() is then O, which must not stand in for the missing actor.
  const withClaims=run=>inTransaction(db,["select set_config('request.jwt.claim.sub','',true)",["select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:O,role:'authenticated'})]]],async()=>{
   const uid=(await db.query('select auth.uid()::text u')).rows[0].u;
   await db.exec('set local role ai_executor');
   return {uid,result:await run()};
  });
  const before=await budgets();
  let claim=await exec('ai_claim_job',[60]);assert.equal(claim.id,queued.id);
  let seen=await withClaims(()=>rpc(db,'ai_begin_dispatch',[queued.id,claim.fencing_token]));
  assert.deepEqual([seen.uid,seen.result.state,seen.result.hold_released],[O,'cancelled',true]);
  assert.deepEqual(await budgets(),charged(before,W,-100n));
  // Control: O's own job dispatches in the same kind of session.
  claim=await exec('ai_claim_job',[60]);assert.equal(claim.id,others.id);
  seen=await withClaims(()=>rpc(db,'ai_begin_dispatch',[others.id,claim.fencing_token]));
  assert.equal(seen.result.state,'dispatched');
  await exec('ai_settle_job',[others.id,claim.fencing_token,'event-others','0','failed',null]);
 });

 await t.test('the job left in a former workspace is cancelled at dispatch the same way',async()=>{
  const before=await budgets();
  const claim=await exec('ai_claim_job',[60]);assert.equal(claim.id,left.id);
  const result=await exec('ai_begin_dispatch',[left.id,claim.fencing_token]);
  assert.deepEqual([result.state,result.actor_id],['cancelled',null]);
  assert.deepEqual(await budgets(),charged(before,W2,-100n));
 });

 await t.test('the claimed job of the deleted solo workspace is gone: every fenced call gets job_not_found',async()=>{
  for(const [name,args] of [['ai_begin_dispatch',[claimedSolo.id,claimedSolo.token]],['ai_fail_before_dispatch',[claimedSolo.id,claimedSolo.token]],
   ['ai_mark_unknown',[claimedSolo.id,claimedSolo.token]],['ai_settle_job',[claimedSolo.id,claimedSolo.token,'event-gone','1','failed',null]]])await refused(()=>exec(name,args),'job_not_found',name);
 });

 await t.test("the deleted account's still-valid token reaches nothing, and its unused consent admits nothing",async()=>{
  for(const [name,args] of [['ai_job_status',[queued.id]],['ai_cancel_job',[queued.id]],['ai_job_status',[claimedSolo.id]],['ai_revoke_consent',[unused.consent_id]]])await refused(()=>call(E,name,args),'forbidden',name);
  for(const [x,document] of [[W,dW],[WE,dE]])await refused(()=>call(E,'ai_grant_consent',[consent(x,document)]),'invalid_consent',x);
  await refused(()=>exec('ai_admit_job',[E,admission(unused)]),'invalid_consent');
 });
});

test('account deletion cost (F24, F61): consents go through their own index, budget rows without a scan of the workspace\'s jobs',async t=>{
 const db=await aiDatabase();t.after(()=>db.close());
 const sqlId=(prefix,n)=>`('${prefix}-0000-4000-8000-'||lpad((${n})::text,12,'0'))::uuid`;
 // Bulk fixtures as the superuser. Consents are single-use, so a workspace holds one per AI request ever made.
 const consents=(w,actor,documentSql,n,prefix)=>`insert into app.ai_consents(id,workspace_id,actor_id,document_id,source_revision,payload_sha256,route_id,purpose,retention_version,max_cost_microusd,max_output_tokens,expires_at)
  select ${sqlId(prefix,'g')},'${w}','${actor}',${documentSql},1,'${HASH}','${ROUTE.route_id}','summary','${ROUTE.retention_version}',100,100,clock_timestamp()+interval '1 hour' from generate_series(1,${n}) g;`;
 await db.query(`insert into app.ai_routes values($1,$2,$3,$4,100,100)`,[ROUTE.route_id,ROUTE.provider_id,ROUTE.model_id,ROUTE.retention_version]);

 await t.test('a solo workspace with N documents of one consent each: about N consents read, not a scan of them per document',async()=>{
  const u=uuid(1),w=uuid(10),N=500;
  await db.exec(`insert into auth.users values('${u}');insert into app.workspaces(id,name,ai_enabled) values('${w}','Synthetic solo',true);insert into app.members values('${w}','${u}','owner');
   insert into app.documents(workspace_id,id,kind,ciphertext,key_epoch) select '${w}',${sqlId('20000000','g')},'note','{}'::jsonb,1 from generate_series(1,${N}) g;
   ${consents(w,u,sqlId('20000000','g'),N,'30000000')} analyze;`);
  const before=await tableReads(db,['ai_consents']);
  assert.equal(await deleteUserAsAuthAdmin(db,u),1);
  const after=await tableReads(db,['ai_consents']);
  // Each deleted document's cascade finds its consents through ai_consents_document (PGM-2): about N rows in all. Without
  // it, every cascade scans the workspace's remaining consents (about N*N/2 rows).
  const read=after.ai_consents.heap-before.ai_consents.heap;
  assert.ok(read>=N&&read<=3*N,`ai_consents rows read: ${read}`);
  assert.deepEqual((await db.query('select (select count(*)::int from app.ai_consents where workspace_id=$1) consents,(select count(*)::int from app.documents where workspace_id=$1) documents',[w])).rows[0],{consents:0,documents:0});
 });

 await t.test("a member's budget rows for 13 months, the jobs' own month included, go without reading the workspace's 1,000 jobs",async()=>{
  // Deleting a budget row checks both budget foreign keys of ai_jobs. ai_jobs_actor_budget and ai_jobs_workspace_budget
  // have each key's exact columns, so neither check reads another actor's jobs, not even those of the row's own month
  // (2026-01 here, SQLR-8): an index on (workspace_id, period) alone reads all 1,000 jobs twice for that row. Without
  // either, each of the 26 checks reads every job of the workspace (VPG-A1).
  const [o,m,w,d]=[uuid(2),uuid(3),uuid(11),uuid(21)],J=1000;
  await db.exec(`insert into auth.users values('${o}'),('${m}');insert into app.workspaces(id,name,ai_enabled) values('${w}','Synthetic shared',true);
   insert into app.members values('${w}','${o}','owner'),('${w}','${m}','editor');insert into app.documents(workspace_id,id,kind,ciphertext,key_epoch) values('${w}','${d}','note','{}'::jsonb,1);
   insert into app.ai_budgets(workspace_id,scope,period,limit_microusd) values('${w}','','2026-01',100000000),('${w}','${o}','2026-01',100000000),('${w}','${m}','2026-01',1000);
   insert into app.ai_budgets(workspace_id,scope,period,limit_microusd) select '${w}','${m}','2025-'||lpad(g::text,2,'0'),1000 from generate_series(1,12) g;
   ${consents(w,o,`'${d}'`,J,'40000000')}
   insert into app.ai_jobs(id,workspace_id,actor_id,consent_id,request_hash,input_ref,period,reserved_microusd,state)
    select ${sqlId('50000000','g')},'${w}','${o}',${sqlId('40000000','g')},sha256(uuid_send(${sqlId('50000000','g')})),'input_'||g,'2026-01',10,'succeeded' from generate_series(1,${J}) g;
   analyze;`);
  const before=await tableReads(db,['ai_jobs']);
  assert.equal(await deleteUserAsAuthAdmin(db,m),1);
  assert.deepEqual((await tableReads(db,['ai_jobs'])).ai_jobs,before.ai_jobs);
  assert.deepEqual((await db.query('select (select count(*)::int from app.ai_budgets where workspace_id=$1) budgets,(select count(*)::int from app.ai_jobs where workspace_id=$1) jobs',[w])).rows[0],{budgets:2,jobs:J});
 });
});

test('a job or consent that goes with its workspace while a call waits for the lock is reported, never half-processed',async t=>{
 const owner=uuid(1),w=uuid(10),d=uuid(20);
 const {db,call,exec,period,consent,admission}=await open(t,[owner]);
 await call(owner,'create_workspace',[w,'Synthetic vanish']);await call(owner,'create_document',[w,d,null,'note',cipher(w,d)]);await enableAi(db,owner,w);
 for(const actor of [null,owner])await exec('ai_set_budget',[w,actor,period,'1000']);
 const granted=async()=>{const c=consent(w,d);await call(owner,'ai_grant_consent',[c]);return c;};
 const claimedConsent=await granted(),claimedJob=await exec('ai_admit_job',[owner,admission(claimedConsent)]),claim=await exec('ai_claim_job',[60]);
 assert.equal(claim.id,claimedJob.id);
 const queuedConsent=await granted(),queuedJob=await exec('ai_admit_job',[owner,admission(queuedConsent)]);
 const unused=await granted(),unusedAdmission=admission(unused);
 // Test-only instrumentation. One session cannot commit delete_workspace while a call waits for the workspace lock, so
 // FORCE ROW LEVEL SECURITY on app.workspaces adds an UPDATE policy whose check deletes the consent (its job goes by
 // cascade) while the call locks the row: SELECT ... FOR UPDATE applies UPDATE policies. Later statements of the call no
 // longer see the rows, as after a concurrent delete that committed. A raise rolls the deletion back with the call.
 const whileLocking=async(consentId,run)=>{
  await db.exec(`create function public.vanish() returns boolean language plpgsql security definer set search_path=pg_catalog as $$
    begin delete from app.ai_consents where id='${consentId}'; return true; end $$;
   alter table app.workspaces force row level security;
   create policy test_read on app.workspaces for select using (true);
   create policy test_vanish on app.workspaces for update using (public.vanish());`);
  try { return await run(); }
  finally { await db.exec('drop policy test_vanish on app.workspaces; drop policy test_read on app.workspaces; alter table app.workspaces no force row level security; drop function public.vanish();'); }
 };
 const fenced=[claimedJob.id,claim.fencing_token];
 for(const [name,c,run,reason] of [
  ...['ai_begin_dispatch','ai_fail_before_dispatch','ai_mark_unknown'].map(name=>[name,claimedConsent,()=>exec(name,fenced),'job_not_found']),
  ['ai_settle_job',claimedConsent,()=>exec('ai_settle_job',[...fenced,'event-vanished','1','failed',null]),'job_not_found'],
  ['ai_cancel_job',queuedConsent,()=>call(owner,'ai_cancel_job',[queuedJob.id]),'job_not_found'],
  ['ai_revoke_consent',unused,()=>call(owner,'ai_revoke_consent',[unused.consent_id]),'forbidden'],
  ['ai_admit_job',unused,()=>exec('ai_admit_job',[owner,unusedAdmission]),'invalid_consent'],
 ]){
  const before=await appState(db);
  await assert.rejects(whileLocking(c.consent_id,run),contract(reason),name);
  assert.deepEqual(await appState(db),before,name);
 }
 // Controls: the instrumentation alone changes no answer when the consent it deletes does not exist.
 const nothing=uuid(999);
 assert.equal((await whileLocking(nothing,()=>call(owner,'ai_cancel_job',[queuedJob.id]))).state,'cancelled');
 assert.equal((await whileLocking(nothing,()=>exec('ai_begin_dispatch',fenced))).state,'dispatched');
 assert.equal((await whileLocking(nothing,()=>exec('ai_admit_job',[owner,unusedAdmission]))).state,'queued');
 assert.equal((await whileLocking(nothing,()=>call(owner,'ai_revoke_consent',[unused.consent_id]))).consent_id,unused.consent_id);
 assert.deepEqual((await db.query("select c.relforcerowsecurity forced,(select count(*)::int from pg_policy p where p.polrelid=c.oid) policies from pg_class c where c.oid='app.workspaces'::regclass")).rows[0],{forced:false,policies:0});
});
