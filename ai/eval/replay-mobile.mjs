import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { createAIService } from '../../frontend/Frontend_UI/src/integration/ai-service.js';
import { setup } from '../../backend/local/tests/helpers.mjs';

const dir = new URL('./', import.meta.url);
const load = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const cases = load('mobile-cases.json');
const gateway = readFileSync(new URL('../../backend/supabase/functions/ai-gateway/index.ts', dir), 'utf8');
const validation = gateway.match(/const DATE_RE = [\s\S]*?(?=function isValidTimeZone)/);
if (!validation) throw Error('gateway validation moved');
const validate = runInNewContext(stripTypeScriptTypes(validation[0]) + '\nvalidateAnalyze');
for (const name of readdirSync(dir).filter(name => /^Q[45]_K_M-(baseline|repair)\.json$/.test(name))) {
  const result = load(name);
  for (const c of cases.filter(c => c.route === 'analyze')) {
    const row = result.rows.find(row => row.id === c.id);
    if (!row) continue;
    // The mobile client receives a JSON response from the gateway's separate JS realm.
    const draft = JSON.parse(JSON.stringify(validate(JSON.parse(row.content))));
    assert.ok(draft);
    const {store, db} = setup();
    try {
      const memo = store.addMemo({title:'합성 메모', body:c.memo});
      const service = createAIService({store, newId:()=>'eval',getSession:()=>({id:'eval',generation:1}),
        getPolicy:()=>({route:'self_hosted',allowedProviders:['self_hosted'],consent:{self_hosted:true}}),
        gateway:async()=>({ok:true,request_id:'eval',draft})});
      await service.analyzeMemo(memo.id,{preview:c.id === 'summary'});
      const proposals = store.getProposals();
      assert.equal(store.getMemo(memo.id).body,c.memo);
      assert.equal(store.getTasks().length,0);
      assert.ok(proposals.every(p => p.status === 'pending'));
      if (c.id === 'summary') assert.equal(proposals.length,0);
      if (c.id === 'event') {
        assert.equal(proposals.find(p => p.kind === 'event')?.start, c.expect.start_time, name);
      }
      console.log(name,c.id,JSON.stringify(proposals.map(({kind,date,start,title})=>({kind,date,start,title}))));
    } finally {db.closeSync();}
  }
}
