import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_ERRORS } from '../../contracts/errors.js';
import { createWorker, sha256 } from '../index.js';
// A contract error as the backend reports it: PT<status> in code, reason in message.
const contractError=reason=>Object.assign(new Error(reason),{code:SERVER_ERRORS[reason].sqlstate});
const route={id:'synthetic-v1',provider:'synthetic',model:'synthetic-model',retention_version:'none-v1',max_cost_microusd:'1000',max_output_tokens:500};
function fixture(options={}) {
 const calls=[]; let count=0; const job={id:'job',provider_id:route.provider,model_id:route.model,route_id:route.id,input_ref:'ciphertext',retention_version:route.retention_version,purpose:'summary',max_output_tokens:100,reserved_microusd:'1000',max_cost_microusd:'1000',payload_sha256:sha256('synthetic input'),source_revision:'1',fencing_token:'1',...options.job};
 const store={claim:async()=>count++===0?job:null,beginDispatch:async()=>{calls.push('begin');return {state:'dispatched'};},failBeforeDispatch:async()=>{calls.push('fail');return {state:'failed'};},markUnknown:async()=>{calls.push('unknown');return {state:'outcome_unknown'};},settle:async()=>{calls.push('settle');return {state:'succeeded'};},...options.store};
 const provider={noRetries:true,maximumCostMicrousd:()=> '1000',complete:async()=>{calls.push('complete');return {draft:{summary:'Synthetic test draft',action_items:[],citations:[{start:0,end:9,quote:'synthetic'}]},cost_microusd:'10',provider_event_id:'event_1'};},...options.provider};
 const worker=createWorker({store,loadInput:async()=>{calls.push('load');return options.input??'synthetic input';},saveDraft:async({kind})=>{assert.equal(kind,'ai_draft');calls.push('save');return 'encrypted_result';},routes:[route],providers:{synthetic:provider},...options.config});
 return {worker,calls};
}
test('one attempt, hash checked, final dispatch check, encrypted draft then settlement',async()=>{const {worker,calls}=fixture();assert.equal((await worker()).state,'succeeded');assert.deepEqual(calls,['load','begin','complete','save','settle']);assert.equal((await worker()).state,'idle');});
test('hash mismatch or unbounded cost never dispatches',async()=>{for(const options of [{input:'changed source'},{provider:{maximumCostMicrousd:()=> '1001'}},{provider:{noRetries:false}},{job:{route_id:'attacker'}},{job:{provider_id:'attacker'}},{job:{model_id:'changed'}},{job:{retention_version:'changed'}}]){const {worker,calls}=fixture(options);assert.equal((await worker()).state,'failed');assert.ok(!calls.includes('complete'));assert.ok(!calls.includes('begin'));}});
test('revocation/cancel at final SQL check prevents provider call',async()=>{const {worker,calls}=fixture({store:{beginDispatch:async()=>({state:'cancelled'})}});assert.equal((await worker()).state,'cancelled');assert.ok(!calls.includes('complete'));});
test('provider exception after dispatch is unknown with hold retained and no retry',async()=>{let count=0;const {worker,calls}=fixture({provider:{complete:async()=>{count++;throw Error('sensitive details');}}});assert.equal((await worker()).state,'outcome_unknown');assert.equal(count,1);assert.ok(calls.includes('unknown'));assert.ok(!calls.includes('fail'));assert.equal((await worker()).state,'idle');});
test('timeout never retries even when provider ignores AbortSignal',async()=>{let count=0;const {worker,calls}=fixture({provider:{complete:async()=>{count++;return new Promise(()=>{});}},config:{timeoutMs:5}});assert.equal((await worker()).state,'outcome_unknown');assert.equal(count,1);assert.ok(calls.includes('unknown'));});
test('malformed output or citations retain hold',async()=>{for(const draft of [{summary:'x',action_items:[],citations:[{start:0,end:2,quote:'invented'}]},{summary:'x',action_items:[],citations:[],edit_source:true}]){const {worker,calls}=fixture({provider:{complete:async()=>({draft,cost_microusd:'1',provider_event_id:'event'})}});assert.equal((await worker()).state,'outcome_unknown');assert.ok(!calls.includes('save'));}});
test('stale lease settlement cannot silently claim success; storage failure keeps hold',async()=>{
 // After dispatch a contract error is not 'not_dispatched': a stale fence at settlement and at mark_unknown needs reconciliation.
 const stale=fixture({store:{settle:async()=>{throw contractError('stale_fence');},markUnknown:async()=>{throw contractError('stale_fence');}}});
 assert.deepEqual(await stale.worker(),{id:'job',state:'reconciliation_required'}); assert.deepEqual(stale.calls,['load','begin','complete','save']);
 const storage=fixture({config:{saveDraft:async()=>{throw Error('KMS unavailable');}}});
 assert.deepEqual(await storage.worker(),{id:'job',state:'outcome_unknown'}); assert.deepEqual(storage.calls,['load','begin','complete','unknown']);
});
test('a contract error before dispatch is not_dispatched with its reason; any other failure needs reconciliation',async()=>{
 const notDispatched=reason=>({id:'job',state:'not_dispatched',reason}),reconcile={id:'job',state:'reconciliation_required'};
 const cases=[
  // Raised inside the RPC's transaction, which rolled back, so nothing was dispatched.
  [contractError('stale_fence'),notDispatched('stale_fence')],[contractError('not_claimed'),notDispatched('not_claimed')],[contractError('job_not_found'),notDispatched('job_not_found')],
  // The commit outcome is unknown: a transport error, an infrastructure SQLSTATE, a reason without its SQLSTATE or with another one, a plain error.
  [Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'}),reconcile],[Object.assign(new Error('permission denied for function ai_begin_dispatch'),{code:'42501'}),reconcile],
  [Object.assign(new Error('stale_fence'),{code:'P0001'}),reconcile],[Object.assign(new Error('stale_fence'),{code:'PT403'}),reconcile],[new Error('socket hang up'),reconcile],
 ];
 for (const [error,expected] of cases) {
  // ai_begin_dispatch fails after every local pre-dispatch check passed.
  let begun=0; const begin=fixture({store:{beginDispatch:async()=>{begun++;throw error;}}});
  assert.deepEqual(await begin.worker(),expected); assert.equal(begun,1); assert.deepEqual(begin.calls,['load']);
  // ai_fail_before_dispatch fails after a local check rejected the input.
  let failed=0; const fail=fixture({input:'changed source',store:{failBeforeDispatch:async()=>{failed++;throw error;}}});
  assert.deepEqual(await fail.worker(),expected); assert.equal(failed,1); assert.deepEqual(fail.calls,['load']);
 }
 // Controls: the same two paths when the RPC succeeds.
 assert.deepEqual(await fixture().worker(),{id:'job',state:'succeeded'});
 assert.deepEqual(await fixture({input:'changed source'}).worker(),{id:'job',state:'failed'});
});

test('oversized draft bytes are rejected before storage',async()=>{const input='x'.repeat(16000);const {worker,calls}=fixture({input,job:{payload_sha256:sha256(input)},provider:{complete:async()=>({draft:{summary:'x',action_items:[],citations:Array.from({length:20},()=>({start:0,end:16000,quote:input}))},cost_microusd:'1',provider_event_id:'event'})}});assert.equal((await worker()).state,'outcome_unknown');assert.ok(!calls.includes('save'));});

test('late cancellation deletes encrypted draft after cost settlement without marking unknown',async()=>{const deleted=[];const {worker,calls}=fixture({store:{settle:async()=>({state:'cancelled'})},config:{deleteDraft:async ref=>deleted.push(ref)}});assert.deepEqual(await worker(),{id:'job',state:'cancelled'});assert.deepEqual(deleted,['encrypted_result']);assert.ok(!calls.includes('unknown'));assert.equal(calls.filter(c=>c==='complete').length,1);});
test('missing or failed cleanup returns truthful status after settled cancellation',async()=>{for(const config of [{},{deleteDraft:async()=>{throw Error('storage offline');}}]){let settlements=0;const {worker,calls}=fixture({store:{settle:async()=>{settlements++;return {state:'cancelled'};}},config});assert.deepEqual(await worker(),{id:'job',state:'cleanup_required',job_state:'cancelled'});assert.equal(settlements,1);assert.ok(!calls.includes('unknown'));assert.equal(calls.filter(c=>c==='complete').length,1);}});
test('late source revision is surfaced as stale draft without source mutation',async()=>{const {worker}=fixture({store:{settle:async()=>({state:'succeeded',source_stale:true})},config:{deleteDraft:async()=>{assert.fail('Valid stale draft must remain for review');}}});assert.deepEqual(await worker(),{id:'job',state:'succeeded',source_stale:true});});
