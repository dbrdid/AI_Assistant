import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, errors } from 'jose';
import { SERVER_ERRORS } from '../../contracts/errors.js';
import { createJwtVerifier, AuthUnavailableError } from '../auth.js';
import { createGateway } from '../index.js';
const actor = '11111111-1111-4111-8111-111111111111';
const job = '22222222-2222-4222-8222-222222222222';
const route = { id: 'synthetic-v1', provider: 'synthetic', model: 'synthetic-v1', retention_version: 'none-v1', max_cost_microusd: '10000', max_output_tokens: 500 };
const consent = { approved: true, consent_id: actor, workspace_id: actor, document_id: actor, source_revision: '1', payload_sha256: 'a'.repeat(64), purpose: 'summary', route_id: route.id, retention_version: route.retention_version, max_cost_microusd: '1000', max_output_tokens: 100, expires_at: new Date(Date.now()+60000).toISOString() };
// What store.createConsent receives for the valid consent: provider/model come from the trusted route.
const storedConsent = { ...consent, provider_id: route.provider, model_id: route.model };
const admission = { consent_id: actor, job_id: job, input_ref: 'ciphertext_123', payload_sha256: 'a'.repeat(64), route_id: route.id };
function request(path, value, auth = 'Bearer verified') { return new Request('https://local.invalid'+path, {method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify(value)}); }
// Like request(), but every part can change; null omits a header and an undefined body sends none.
function send(gateway, path, { method = 'POST', auth = 'Bearer verified', type = 'application/json', body } = {}) {
 const headers = {}; if (auth !== null) headers.authorization = auth; if (type !== null) headers['content-type'] = type;
 return gateway(new Request('https://local.invalid'+path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
// Error bodies are pinned exactly: gateway-local codes, or contract reasons from shared/contracts/errors.js for store errors.
async function expectJson(response, status, body) { assert.equal(response.status, status); assert.deepEqual(await response.json(), body); }
// The verifier's outage error, without a cause, so fetch errors and JWKS response bodies stay out of it.
const outageError=error=>error instanceof AuthUnavailableError&&error.code==='AUTH_UNAVAILABLE'&&error.message==='Authentication keys unavailable'&&!('cause' in error);
// Store double that records every call and answers with the method name.
function recordingStore() {
 const calls = [];
 const store = Object.fromEntries(['createConsent','enqueue','getJob','cancelJob','revokeConsent'].map(name => [name, async (...args) => { calls.push([name, ...args]); return { method: name }; }]));
 return { store, calls };
}
test('JWT cryptographic trust verifies signature, issuer, audience, expiry and UUID', async () => {
 const {privateKey,publicKey}=await generateKeyPair('ES256'); const jwk=await exportJWK(publicKey); jwk.kid='test';
 const verify=createJwtVerifier({issuer:'https://issuer.invalid',audience:'authenticated',jwks:{keys:[jwk]}});
 const now=Math.floor(Date.now()/1000);
 const claims = overrides => ({sub:actor,iss:'https://issuer.invalid',aud:'authenticated',iat:now,exp:now+60,...overrides});
 const sign = (overrides = {}, key = privateKey, header = {alg:'ES256',kid:'test'}) => new SignJWT(claims(overrides)).setProtectedHeader(header).sign(key);
 assert.equal((await verify(await sign({}))).id,actor);
 // Each row changes one claim of the valid token above; undefined drops the claim from the payload.
 // 'Invalid identity' is the plain Error thrown by auth.js; the gateway answers 401 for every verifier error except AUTH_UNAVAILABLE.
 const claimDefects = [
  [{iss:'https://attacker.invalid'}, {code:'ERR_JWT_CLAIM_VALIDATION_FAILED',claim:'iss',reason:'check_failed'}],
  [{aud:'other'}, {code:'ERR_JWT_CLAIM_VALIDATION_FAILED',claim:'aud',reason:'check_failed'}],
  [{exp:1}, {code:'ERR_JWT_EXPIRED',claim:'exp',reason:'check_failed'}],
  // Expired one second ago: catches any clock tolerance added to auth.js (clockTolerance: 0).
  [{exp:now-1}, {code:'ERR_JWT_EXPIRED',claim:'exp',reason:'check_failed'}],
  [{sub:'attacker'}, {message:'Invalid identity'}],
  // auth.js allows iat at most 5 s in the future; +30 s catches a widened allowance.
  [{iat:now+30}, {message:'Invalid identity'}],
  [{sub:undefined}, {code:'ERR_JWT_CLAIM_VALIDATION_FAILED',claim:'sub',reason:'missing'}],
  [{exp:undefined}, {code:'ERR_JWT_CLAIM_VALIDATION_FAILED',claim:'exp',reason:'missing'}],
  [{iat:undefined}, {code:'ERR_JWT_CLAIM_VALIDATION_FAILED',claim:'iat',reason:'missing'}],
 ];
 for (const [overrides, expected] of claimDefects) await assert.rejects(verify(await sign(overrides)), expected);
 // Valid claims and kid signed by an unpublished key: only signature verification can reject this token.
 // This is the only assertion that detects a signature bypass that keeps every claim check; keep it.
 const other=await generateKeyPair('ES256');
 await assert.rejects(verify(await sign({},other.privateKey)), {code:'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'});
 await assert.rejects(verify(await sign({},privateKey,{alg:'ES256',kid:'unknown'})), {code:'ERR_JWKS_NO_MATCHING_KEY'});
 // HS256 (keyed with the published public JWK) and alg none are refused with or without the algorithm
 // allowlist, because the JWKS resolver only returns asymmetric keys. The allowlist itself is tested below.
 await assert.rejects(verify(await sign({},new TextEncoder().encode(JSON.stringify(jwk)),{alg:'HS256',kid:'test'})), {code:'ERR_JOSE_ALG_NOT_ALLOWED'});
 const unsigned=[{alg:'none',kid:'test'},claims({})].map(part=>Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')+'.';
 await assert.rejects(verify(unsigned), {code:'ERR_JOSE_ALG_NOT_ALLOWED'});
 await assert.rejects(verify('eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.'), {code:'ERR_JOSE_ALG_NOT_ALLOWED'});
});
test('algorithm allowlist rejects validly signed tokens from other published key types', async () => {
 const issuer='https://issuer.invalid',audience='authenticated',now=Math.floor(Date.now()/1000);
 const pairs={test:['ES256',await generateKeyPair('ES256')],ed:['EdDSA',await generateKeyPair('EdDSA',{crv:'Ed25519'})],rs:['RS256',await generateKeyPair('RS256')]};
 const keys=await Promise.all(Object.entries(pairs).map(async([kid,[,pair]])=>({...await exportJWK(pair.publicKey),kid})));
 const token=kid=>new SignJWT({sub:actor,iss:issuer,aud:audience,iat:now,exp:now+60}).setProtectedHeader({alg:pairs[kid][0],kid}).sign(pairs[kid][1].privateKey);
 const strict=createJwtVerifier({issuer,audience,jwks:{keys}}); // default policy: ES256 only
 for (const kid of ['ed','rs']) await assert.rejects(strict(await token(kid)),{code:'ERR_JOSE_ALG_NOT_ALLOWED'});
 // Controls: the same tokens are valid, so only the allowlist rejects them.
 assert.equal((await strict(await token('test'))).id,actor);
 const permissive=createJwtVerifier({issuer,audience,jwks:{keys},algorithms:['ES256','EdDSA','RS256']});
 for (const kid of ['ed','rs']) assert.equal((await permissive(await token(kid))).id,actor);
});
test('JWT trust configuration is validated when the verifier is created', async () => {
 const issuer='https://issuer.invalid',audience='authenticated',jwks={keys:[{...await exportJWK((await generateKeyPair('ES256')).publicKey),kid:'test'}]};
 assert.throws(()=>createJwtVerifier({issuer,audience,jwksUrl:'http://issuer.invalid/jwks'}),{message:'HTTPS JWKS required'});
 for (const config of [{jwks,algorithms:['HS256']},{jwks,algorithms:['ES256','none']},{jwks,algorithms:[]},{jwks,jwksUrl:'https://issuer.invalid/jwks'},{},{jwks,issuer:''},{jwks,audience:''}]) {
  assert.throws(()=>createJwtVerifier({issuer,audience,...config}),{message:'Invalid JWT trust configuration'});
 }
 // Controls: valid local and remote configurations construct (the remote JWKS is fetched lazily, not here).
 assert.equal(typeof createJwtVerifier({issuer,audience,jwks}),'function');
 assert.equal(typeof createJwtVerifier({issuer,audience,jwksUrl:'https://issuer.invalid/jwks'}),'function');
});
test('authentication happens before body parse and no actor from request', async () => {
 // A real verification failure: an invalid token is 401, unlike a key source outage (503, tested below).
 let calls=0; const gateway=createGateway({verifyJwt:async()=>{throw new errors.JWSSignatureVerificationFailed();},store:{createConsent(){calls++;}},routes:[route]});
 await expectJson(await gateway(new Request('https://local.invalid/v1/ai/consents',{method:'POST',headers:{authorization:'Bearer forged'},body:'broken'})),401,{error:'unauthorized'}); assert.equal(calls,0);
});
test('explicit bounded consent binds trusted provider and rejects escalation/plaintext', async () => {
 const calls=[]; const gateway=createGateway({verifyJwt:async()=>({id:actor}),store:{createConsent:async(id,body)=>{calls.push({id,body});return {id:body.consent_id};}},routes:[route]});
 await expectJson(await gateway(request('/v1/ai/consents',consent)),201,{id:actor}); assert.deepEqual(calls,[{id:actor,body:storedConsent}]);
 for(const [patch,error] of [
  [{approved:false},'explicit_consent_required'],[{actor_id:actor},'invalid_request'],[{provider:'other'},'invalid_request'],[{model:'other'},'invalid_request'],
  [{url:'https://attacker.invalid'},'invalid_request'],[{plaintext:'secret'},'invalid_request'],[{route_id:'unknown'},'route_not_allowed'],[{retention_version:'other'},'retention_mismatch'],
  [{max_cost_microusd:'10001'},'invalid_request'],[{max_output_tokens:9999},'invalid_request'],[{expires_at:'bad'},'invalid_request'],[{source_revision:'0'},'invalid_request'],
 ]) await expectJson(await gateway(request('/v1/ai/consents',{...consent,...patch})),400,{error});
 assert.equal(calls.length,1);
});
test('bounded streaming JSON and sanitized database errors', async()=>{
 const gateway=createGateway({verifyJwt:async()=>({id:actor}),store:{createConsent:async()=>{throw Error('secret provider response');}},routes:[route]});
 await expectJson(await gateway(request('/v1/ai/consents',{payload:'x'.repeat(17000)})),413,{error:'body_too_large'});
 // Single defect: the valid consent padded past 16 KiB with JSON whitespace.
 const padded=new Request('https://local.invalid/v1/ai/consents',{method:'POST',headers:{authorization:'Bearer verified','content-type':'application/json'},body:JSON.stringify(consent)+' '.repeat(16384)});
 await expectJson(await gateway(padded),413,{error:'body_too_large'});
 // A generic store error is a server fault: 500 without its text (the full mapping is tested below).
 await expectJson(await gateway(request('/v1/ai/consents',consent)),500,{error:'internal_error'});
});
test('enqueue accepts only opaque references; status/cancel/revoke actor is verified', async()=>{
 const seen=[]; const store=Object.fromEntries(['enqueue','getJob','cancelJob','revokeConsent'].map(key=>[key,async(id,input)=>{seen.push({key,id,input});return {state:'queued'};}]));
 const gateway=createGateway({verifyJwt:async()=>({id:actor}),store,routes:[route]});
 const body={consent_id:actor,job_id:actor,input_ref:'ciphertext_123',payload_sha256:'a'.repeat(64),route_id:route.id};
 assert.equal((await gateway(request('/v1/ai/jobs',body))).status,202);
 await expectJson(await gateway(request('/v1/ai/jobs',{...body,input_ref:'https://private.invalid'})),400,{error:'invalid_request'});
 for(const path of [`/v1/ai/jobs/${actor}/cancel`,`/v1/ai/consents/${actor}/revoke`]) assert.equal((await gateway(request(path,{}))).status,200);
 assert.equal((await gateway(new Request(`https://local.invalid/v1/ai/jobs/${actor}`,{headers:{authorization:'Bearer verified'}}))).status,200);
 assert.equal(seen.length,4); assert.ok(seen.every(c=>c.id===actor));
});
test('every consent and job field is required', async () => {
 const {store,calls}=recordingStore(); const gateway=createGateway({verifyJwt:async()=>({id:actor}),store,routes:[route]});
 const without=(value,key)=>Object.fromEntries(Object.entries(value).filter(([name])=>name!==key));
 // exact() rejects only unknown keys, so each missing field must fail its own check. If exact() is made to
 // require every key (review F56), the three field-specific codes below become invalid_request.
 const consentErrors={approved:'explicit_consent_required',route_id:'route_not_allowed',retention_version:'retention_mismatch'};
 for (const key of Object.keys(consent)) await expectJson(await send(gateway,'/v1/ai/consents',{body:without(consent,key)}),400,{error:consentErrors[key]??'invalid_request'});
 for (const key of Object.keys(admission)) await expectJson(await send(gateway,'/v1/ai/jobs',{body:without(admission,key)}),400,{error:key==='route_id'?'route_not_allowed':'invalid_request'});
 assert.deepEqual(calls,[]);
 await expectJson(await send(gateway,'/v1/ai/consents',{body:consent}),201,{method:'createConsent'});
 await expectJson(await send(gateway,'/v1/ai/jobs',{body:admission}),202,{method:'enqueue'});
 assert.deepEqual(calls,[['createConsent',actor,storedConsent],['enqueue',actor,admission]]);
});
test('malformed or oversized Authorization is rejected before the verifier and the store', async () => {
 const tokens=[]; const {store,calls}=recordingStore();
 const gateway=createGateway({verifyJwt:async token=>{tokens.push(token);return {id:actor};},store,routes:[route]});
 const getJob=auth=>send(gateway,`/v1/ai/jobs/${job}`,{method:'GET',auth});
 // 'Basic Bearer abc' pins the ^ anchor; 'Bearer ' + 8186 characters is the first header length over 8192.
 for (const auth of [null,'Basic abc','Bearer a b','Basic Bearer abc','Bearer '+'a'.repeat(8186)]) await expectJson(await getJob(auth),401,{error:'unauthorized'});
 assert.deepEqual(tokens,[]); assert.deepEqual(calls,[]);
 // Controls: a well-formed bearer and the longest accepted header (8192 characters) each reach the verifier once.
 await expectJson(await getJob('Bearer verified'),200,{method:'getJob'});
 await expectJson(await getJob('Bearer '+'a'.repeat(8185)),200,{method:'getJob'});
 assert.deepEqual(tokens,['verified','a'.repeat(8185)]); assert.deepEqual(calls,[['getJob',actor,job],['getJob',actor,job]]);
});
test('verifier result without a UUID actor id is unauthorized', async () => {
 let identity; const {store,calls}=recordingStore();
 const gateway=createGateway({verifyJwt:async()=>identity,store,routes:[route]});
 for (const value of [{id:'not-a-uuid'},{id:`${actor}0`},{sub:actor},null]) {
  identity=value; await expectJson(await send(gateway,`/v1/ai/jobs/${job}`,{method:'GET'}),401,{error:'unauthorized'});
 }
 assert.deepEqual(calls,[]);
 identity={id:actor}; await expectJson(await send(gateway,`/v1/ai/jobs/${job}`,{method:'GET'}),200,{method:'getJob'});
 assert.deepEqual(calls,[['getJob',actor,job]]);
});
test('consent body must be declared application/json before the store is called', async () => {
 const {store,calls}=recordingStore(); const gateway=createGateway({verifyJwt:async()=>({id:actor}),store,routes:[route]});
 await expectJson(await send(gateway,'/v1/ai/consents',{type:'text/plain',body:consent}),415,{error:'json_required'});
 assert.deepEqual(calls,[]);
 await expectJson(await send(gateway,'/v1/ai/consents',{body:consent}),201,{method:'createConsent'});
 assert.deepEqual(calls,[['createConsent',actor,storedConsent]]);
});
test('unknown paths and methods return not_found without reaching the store', async () => {
 const {store,calls}=recordingStore(); const gateway=createGateway({verifyJwt:async()=>({id:actor}),store,routes:[route]});
 await expectJson(await send(gateway,'/v1/ai/unknown',{body:consent}),404,{error:'not_found'});
 await expectJson(await send(gateway,'/v1/ai/consents',{method:'GET'}),404,{error:'not_found'});
 await expectJson(await send(gateway,`/v1/ai/jobs/${job}`,{body:{}}),404,{error:'not_found'});
 assert.deepEqual(calls,[]);
 // Controls: the registered method or suffix reaches the store.
 await expectJson(await send(gateway,'/v1/ai/consents',{body:consent}),201,{method:'createConsent'});
 await expectJson(await send(gateway,`/v1/ai/jobs/${job}`,{method:'GET'}),200,{method:'getJob'});
 await expectJson(await send(gateway,`/v1/ai/jobs/${job}/cancel`,{body:{}}),200,{method:'cancelJob'});
 assert.deepEqual(calls,[['createConsent',actor,storedConsent],['getJob',actor,job],['cancelJob',actor,job]]);
});
test('path ids must be UUIDs before the store is called', async () => {
 const {store,calls}=recordingStore(); const gateway=createGateway({verifyJwt:async()=>({id:actor}),store,routes:[route]});
 const idRoutes=[['GET',id=>`/v1/ai/jobs/${id}`,'getJob'],['POST',id=>`/v1/ai/jobs/${id}/cancel`,'cancelJob'],['POST',id=>`/v1/ai/consents/${id}/revoke`,'revokeConsent']];
 const call=(method,path)=>send(gateway,path,{method,body:method==='POST'?{}:undefined});
 for (const [method,path] of idRoutes) await expectJson(await call(method,path('not-a-uuid')),400,{error:'invalid_request'});
 assert.deepEqual(calls,[]);
 for (const [method,path,name] of idRoutes) await expectJson(await call(method,path(job)),200,{method:name});
 assert.deepEqual(calls,idRoutes.map(([,,name])=>[name,actor,job]));
});
test('store errors: contract reasons keep their status, transient failures are 503, anything else is 500', async t => {
 // Marks text that must never reach a response or a log: messages, details and hints of store errors.
 const secret='synthetic-secret-diagnostic';
 let failure; const gateway=createGateway({verifyJwt:async()=>({id:actor}),store:{getJob:async()=>{throw failure;}},routes:[route]});
 const dbError=(code,message)=>Object.assign(new Error(message),{code,detail:secret,hint:secret});
 const unavailable={error:'temporarily_unavailable'},internal={error:'internal_error'};
 const cases=[
  // Every contract reason, shaped like a backend RpcError: PT<status> in code, reason in message. The gateway verified the
  // subject itself, so a store 'unauthenticated' (kind auth) is a server fault, not a request to sign in again.
  ...Object.entries(SERVER_ERRORS).map(([reason,{status,sqlstate,kind}])=>[dbError(sqlstate,reason),kind==='auth'?500:status,kind==='auth'?internal:{error:reason}]),
  // A plain object, such as a parsed PostgREST body, is read the same way.
  [{code:'PT429',message:'rate_limited',details:secret},429,{error:'rate_limited'}],
  // Transient: SQLSTATE classes 08 and 53, shutdown, cancel or statement timeout, serialization failure, deadlock, lock not available.
  ...['08000','08001','08003','08004','08006','08P01','53000','53100','53200','53300','53400','57P01','57P02','57P03','57014','40001','40P01','55P03'].map(code=>[dbError(code,secret),503,unavailable]),
  ...['ECONNREFUSED','ECONNRESET','ECONNABORTED','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN'].map(code=>[Object.assign(new Error(secret),{code}),503,unavailable]),
  // fetch-based adapters wrap the socket error: one level of cause is read, and its text is never reflected.
  [Object.assign(new TypeError(secret),{cause:Object.assign(new Error(secret),{code:'ECONNRESET'})}),503,unavailable],
  // Server faults: a missing privilege, raw constraint and cast errors, codes next to the transient ones and malformed codes.
  ...['42501','23505','23503','23502','23514','22P02','22003','P0001','57P04','40000','55000','08','080000'].map(code=>[dbError(code,secret),500,internal]),
  // Near-contract errors: untrusted text with a contract SQLSTATE, another reason's SQLSTATE, a reason without one,
  // and an infrastructure 42501 whose text happens to be a reason. None of them is a business decision.
  [dbError('PT403',secret),500,internal],[dbError('PT403','consent_already_used'),500,internal],[dbError('P0001','forbidden'),500,internal],[dbError('42501','forbidden'),500,internal],
  // Other Node errors, plain errors and thrown non-errors.
  [Object.assign(new Error(secret),{code:'ENOTFOUND'}),500,internal],[new Error(secret),500,internal],[secret,500,internal],[null,500,internal],
 ];
 const logs=['log','info','warn','error','debug'].map(level=>t.mock.method(console,level));
 for (const [error,status,body] of cases) {
  failure=error; const response=await send(gateway,`/v1/ai/jobs/${job}`,{method:'GET'});
  assert.equal(response.status,status);
  assert.equal(response.headers.get('cache-control'),'no-store'); assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const text=await response.text(); assert.deepEqual(JSON.parse(text),body); assert.equal(text.includes(secret),false);
 }
 assert.deepEqual(logs.map(log=>log.mock.callCount()),[0,0,0,0,0]);
});
test('only a verifier error coded AUTH_UNAVAILABLE is 503; every other verifier error is 401', async () => {
 let thrown; const {store,calls}=recordingStore();
 const gateway=createGateway({verifyJwt:async()=>{throw thrown;},store,routes:[route]});
 const unauthorized={error:'unauthorized'};
 for (const [error,status,body] of [
  [new AuthUnavailableError(),503,{error:'auth_unavailable'}],
  // The code, not the class, is the signal, so any injected verifier can report an outage.
  [Object.assign(new Error('keys down'),{code:'AUTH_UNAVAILABLE'}),503,{error:'auth_unavailable'}],
  [new Error('Invalid identity'),401,unauthorized],
  // A jose key source error that the verifier did not convert is not an outage signal; nor is a different spelling.
  [new errors.JWKSTimeout(),401,unauthorized],[Object.assign(new Error('keys down'),{code:'auth_unavailable'}),401,unauthorized],[null,401,unauthorized],
 ]) { thrown=error; await expectJson(await send(gateway,`/v1/ai/jobs/${job}`,{method:'GET'}),status,body); }
 assert.deepEqual(calls,[]);
});
test('a JWKS outage is 503 auth_unavailable; the same verifier recovers and invalid tokens stay 401', async () => {
 const issuer='https://issuer.invalid',audience='authenticated',jwksUrl='https://issuer.invalid/jwks',now=Math.floor(Date.now()/1000);
 const {privateKey,publicKey}=await generateKeyPair('ES256'); const jwk={...await exportJWK(publicKey),kid:'test'};
 const sign=key=>new SignJWT({sub:actor,iss:issuer,aud:audience,iat:now,exp:now+60}).setProtectedHeader({alg:'ES256',kid:'test'}).sign(key);
 const token=await sign(privateKey);
 const original=globalThis.fetch; const fetched=[]; let serve;
 globalThis.fetch=async url=>{fetched.push(String(url));return serve();};
 try {
  const verify=createJwtVerifier({issuer,audience,jwksUrl}); const {store,calls}=recordingStore();
  const gateway=createGateway({verifyJwt:verify,store,routes:[route]});
  const getJob=bearer=>send(gateway,`/v1/ai/jobs/${job}`,{method:'GET',auth:`Bearer ${bearer}`});
  // Each reaches jose differently: a network error (non-JOSE), ERR_JWKS_TIMEOUT, ERR_JOSE_GENERIC (non-200, non-JSON), ERR_JWKS_INVALID.
  const outages=[
   ()=>Promise.reject(new TypeError('fetch failed')),
   ()=>Promise.reject(new DOMException('synthetic timeout','TimeoutError')),
   ()=>new Response('unavailable',{status:503}),
   ()=>new Response('<html>',{status:200}),
   ()=>Response.json({keys:'none'}),
  ];
  for (const outage of outages) {
   serve=outage;
   await assert.rejects(verify(token),outageError);
   await expectJson(await getJob(token),503,{error:'auth_unavailable'});
  }
  // Every attempt fetched the configured URL again: a failed fetch is not cached.
  assert.deepEqual(fetched,Array(outages.length*2).fill(jwksUrl)); assert.deepEqual(calls,[]);
  // Control: once the JWKS is served, the same verifier accepts the same token.
  serve=()=>Response.json({keys:[jwk]});
  assert.equal((await verify(token)).id,actor);
  await expectJson(await getJob(token),200,{method:'getJob'});
  // With keys available, a token signed by another key is invalid, not unavailable.
  const forged=await sign((await generateKeyPair('ES256')).privateKey);
  await assert.rejects(verify(forged),{code:'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'});
  await expectJson(await getJob(forged),401,{error:'unauthorized'});
  assert.deepEqual(calls,[['getJob',actor,job]]);
 } finally { globalThis.fetch=original; }
});
test('a configured key that cannot be used is AUTH_UNAVAILABLE, not an invalid token', async () => {
 const issuer='https://issuer.invalid',audience='authenticated',now=Math.floor(Date.now()/1000);
 const pair=await generateKeyPair('ES256',{extractable:true});
 const token=await new SignJWT({sub:actor,iss:issuer,aud:audience,iat:now,exp:now+60}).setProtectedHeader({alg:'ES256',kid:'test'}).sign(pair.privateKey);
 // jose refuses a private JWK in a key set when it resolves the key (ERR_JWKS_INVALID).
 const misconfigured=createJwtVerifier({issuer,audience,jwks:{keys:[{...await exportJWK(pair.privateKey),kid:'test'}]}});
 await assert.rejects(misconfigured(token),outageError);
 // Control: the public half of the same pair verifies the same token.
 assert.equal((await createJwtVerifier({issuer,audience,jwks:{keys:[{...await exportJWK(pair.publicKey),kid:'test'}]}})(token)).id,actor);
});
