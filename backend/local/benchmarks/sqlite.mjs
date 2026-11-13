import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { performanceFixture } from '../tests/performance-fixture.mjs';
import { migrate } from '../db/database.js';
import { uuid } from '../tests/harness.mjs';

const count = Number(process.env.BENCH_ROWS ?? 20000);
if (!Number.isSafeInteger(count) || count < 1000 || count > 100000) throw new Error('BENCH_ROWS must be 1000..100000');
const cases = [
  ['queue', "select id from ai_jobs where workspace_id=? and state='queued' order by created_at,rowid limit 1", [uuid(100)]],
  ['recent_jobs', 'select count(*) n from ai_jobs where workspace_id=? and actor_id=? and created_at>?', [uuid(100), uuid(1), count - 1000]],
  ['members', 'select workspace_id,role from members where user_id=? order by workspace_id', [uuid(1)]],
];
function measure(fn) {
  for (let i = 0; i < 10; i++) fn();
  const times = [];
  for (let i = 0; i < 60; i++) { const start = performance.now(); fn(); times.push(performance.now() - start); }
  times.sort((a,b) => a-b);
  return { medianMs: times[30], p95Ms: times[57] };
}
function run(optimized) {
  const db = performanceFixture(count);
  try {
    if (optimized) migrate(db);
    // The same full statistics collection is used in both benchmark arms.
    db.exec('analyze');
    const queries = Object.fromEntries(cases.map(([name, sql, args]) => {
      const stmt = db.prepare(sql);
      return [name, { ...measure(() => stmt.all(...args)),
        result: stmt.all(...args), plan: db.prepare('explain query plan '+sql).all(...args).map(x=>x.detail) }];
    }));
    const after = uuid(1000 + Math.floor(count / 2));
    const oldSql = 'select id,revision from documents where workspace_id=? and (? is null or id>?) and deleted=0 order by id';
    const newSql = 'select id,revision from documents where workspace_id=? and id>? and deleted=0 order by id';
    const stmt = db.prepare(optimized ? newSql : oldSql);
    const args = optimized ? [uuid(100), after] : [uuid(100), after, after];
    const page = () => {
      const rows = optimized ? stmt.iterate(...args) : stmt.all(...args);
      const result=[];
      for(const row of rows) { result.push(row.id); if(result.length===21) break; }
      return result;
    };
    queries.page = { ...measure(page), result: page(),
      plan: db.prepare('explain query plan '+(optimized?newSql:oldSql)).all(...args).map(x=>x.detail) };
    // Same atomic insert/delete workload; extra indexes have a write cost too.
    const mutate = db.prepare('update ai_jobs set created_at=created_at+1 where id=?');
    const reset = db.prepare('update ai_jobs set created_at=created_at-1 where id=?');
    queries.write = measure(() => { db.exec('begin'); mutate.run(uuid(200000)); reset.run(uuid(200000)); db.exec('commit'); });
    return { sqlite: db.prepare('select sqlite_version() v').get().v,
      bytes: db.prepare('pragma page_count').get().page_count * db.prepare('pragma page_size').get().page_size, queries };
  } finally { db.close(); }
}
const baseline=run(false), optimized=run(true);
for(const name of ['queue','recent_jobs','members','page']) assert.deepEqual(baseline.queries[name].result, optimized.queries[name].result);
console.log(JSON.stringify({ mode:'SYNTHETIC_IN_MEMORY_SQL_MICROBENCHMARK', node:process.version,
  rowsPerDocumentsFoldersJobs:count, repetitions:60, baseline, optimized }, null, 2));
