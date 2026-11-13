import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { uuid, cipher } from './harness.mjs';

// Synthetic fixture only. Never opens production paths or sends model requests.
export function performanceFixture(count = 20000) {
  const db = new DatabaseSync(':memory:');
  db.exec('pragma foreign_keys=on');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  db.exec('pragma user_version=1');
  db.exec('begin');
  try {
    const user = db.prepare('insert into users(id) values(?)');
    const workspace = db.prepare('insert into workspaces(id,name,ai_enabled) values(?,?,1)');
    const member = db.prepare('insert into members(workspace_id,user_id,role) values(?,?,?)');
    const budget = db.prepare('insert into ai_budgets(workspace_id,scope,period,limit_microusd) values(?,?,?,?)');
    for (let i = 1; i <= 16; i++) user.run(uuid(i));
    for (let i = 0; i < 8; i++) {
      const w = uuid(100 + i); workspace.run(w, 'Synthetic ' + i);
      for (let u = 1; u <= 16; u++) {
        member.run(w, uuid(u), u === 1 ? 'owner' : 'editor');
        budget.run(w, uuid(u), '2026-11', 1000000);
      }
      budget.run(w, '', '2026-11', 1000000);
    }
    db.prepare('insert into ai_routes values(?,?,?,?,?,?)').run('synthetic', 'mock', 'mock', 'v1', 100, 100);
    const folder = db.prepare('insert into folders(workspace_id,id,acl) values(?,?,?)');
    const document = db.prepare('insert into documents(workspace_id,id,kind,ciphertext,key_epoch,acl) values(?,?,?,?,1,?)');
    const consent = db.prepare(`insert into ai_consents(id,workspace_id,actor_id,document_id,source_revision,payload_sha256,route_id,purpose,retention_version,max_cost_microusd,max_output_tokens,expires_at)
      values(?,?,?,?,1,?,'synthetic','summary','v1',100,100,999999999999999)`);
    const job = db.prepare(`insert into ai_jobs(id,workspace_id,actor_id,consent_id,request_hash,input_ref,period,reserved_microusd,state,created_at,actor_scope)
      values(?,?,?,?,?,?,'2026-11',1,?,?,?)`);
    for (let i = 0; i < count; i++) {
      const w = uuid(100 + i % 8), d = uuid(1000 + i), actor = uuid(1 + i % 16);
      folder.run(w, uuid(500000 + i), i % 5 === 0 ? '{}' : null);
      document.run(w, d, 'note', JSON.stringify(cipher(w, d)), i % 5 === 0 ? '{}' : null);
      consent.run(uuid(100000 + i), w, actor, d, 'a'.repeat(64));
      job.run(uuid(200000 + i), w, actor, uuid(100000 + i), Buffer.alloc(32), 'synthetic',
        i % 17 === 0 ? 'queued' : 'succeeded', i, actor);
    }
    db.exec('commit');
  } catch (error) { db.exec('rollback'); db.close(); throw error; }
  return db;
}
