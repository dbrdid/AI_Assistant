import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { runInNewContext } from 'node:vm';

const text = url => readFileSync(new URL(url, import.meta.url), 'utf8');
const casesText = text('./mobile-cases.json');
const cases = JSON.parse(casesText);
const base = '../../backend/supabase/functions/ai-gateway/';
// Only render prompts. Node's type stripper cannot parse the Deno HTTP error constructor.
const renderModule = text(base + 'assist.ts').replace(/export class InputError extends Error \{[\s\S]*?\n\}/,
  'class InputError extends Error {}');
const assist = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(renderModule)).toString('base64'));
// Read only tracked gateway constants. Importing the entire Edge entry would start Deno.serve.
const gateway = text(base + 'index.ts');
const constants = gateway.match(/const NULLABLE_STR = [\s\S]*?(?=type AnalyzeDraft =)/);
if (!constants) throw Error('analyze contract moved');
const [analyzeSchema, analyzeSystem] = runInNewContext(stripTypeScriptTypes(constants[0]) +
  '\n;[ANALYZE_SCHEMA, ANALYZE_INSTRUCTIONS]');
const organize = gateway.match(/const ORGANIZE_SCHEMA = [\s\S]*?(?=type OrganizeDraft =)/);
if (!organize) throw Error('organize contract moved');
const organizeContract = runInNewContext(stripTypeScriptTypes(organize[0]) +
  '\n;[ORGANIZE_SCHEMA, ORGANIZE_INSTRUCTIONS]');
const today = { today: '2026-11-23', weekday: '월', timezone: 'Asia/Seoul' };

function request(c) {
  const context = { ...today, ...c, history: c.history ?? [] };
  if (c.route === 'organize') return [...organizeContract, '<memo>\n' + c.memo + '\n</memo>'];
  if (c.route === 'plan') return [assist.PLAN_SCHEMA, assist.PLAN_INSTRUCTIONS, assist.planInputText(context)];
  if (c.route === 'answer') {
    context.sources = c.sources.map((source, i) => ({ alias: 'S' + (i + 1), type: 'memo', title: '합성 기록', text: source }));
    return [assist.ANSWER_SCHEMA, assist.ANSWER_INSTRUCTIONS, assist.answerInputText(context)];
  }
  if (c.route === 'agenda') {
    context.items = [{ alias: 'I1', kind: 'task', status: 'added', title: c.item, after: c.item, before: null }];
    context.discussions = [{ alias: 'D1', kind: 'memo', title: '합성 회의', text: c.discussion }];
    return [assist.AGENDA_SCHEMA, assist.AGENDA_INSTRUCTIONS, assist.agendaInputText(context)];
  }
  return [analyzeSchema, analyzeSystem,
    '<context>\n오늘: 2026-11-23 (월) 09:00\n시간대: Asia/Seoul\n종류: 메모\n</context>\n<memo>\n' + c.memo + '\n</memo>'];
}

// The four gateway schemas use this subset. Reject additional keys even if the app normalizes them.
function matches(schema, value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = [schema.type].flat();
  if (!types.includes(type) && !(types.includes('integer') && Number.isInteger(value))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (type === 'array') return value.every(item => matches(schema.items, item));
  if (type !== 'object') return true;
  return schema.required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => Object.hasOwn(schema.properties, key) && matches(schema.properties[key], value[key]));
}

function failures(c, actual) {
  const expected = c.expect;
  const errors = [];
  const check = (name, pass) => { if (!pass) errors.push(name); };
  if (c.route === 'organize') {
    check('title', actual.title.trim().length > 0 && actual.title.length <= 40);
    check('facts', expected.facts.every(word => actual.organized.includes(word)));
    check('keywords', actual.keywords.length <= 5);
  } else if (c.route === 'plan') {
    for (const key of ['intent','date_from','date_to','status']) if (key in expected) check(key, actual[key] === expected[key]);
    if (expected.type) check('types', actual.types.includes(expected.type));
    if (expected.keyword) check('keywords', actual.keywords.some(word => word.includes(expected.keyword)));
    check('reply', expected.intent === 'search' ? actual.reply === null : /[가-힣]/.test(actual.reply ?? ''));
  } else if (c.route === 'answer') {
    check('insufficient', actual.insufficient === expected.insufficient);
    check('한국어', /[가-힣]/.test(actual.answer));
    if (expected.text) check('answer', actual.answer.includes(expected.text));
    if (expected.source) check('source', actual.citations.some(cit => cit.source_id === expected.source));
    if (expected.noCitations) check('noCitations', !actual.citations.length);
    check('quote', actual.citations.every(cit => /^S[1-9]\d*$/.test(cit.source_id) && cit.quote.trim() &&
      c.sources[Number(cit.source_id.slice(1)) - 1]?.includes(cit.quote)));
  } else if (c.route === 'agenda') {
    const [item] = actual.judgments;
    check('status', actual.judgments.length === 1 && item.item_id === 'I1' && item.status === expected.status);
    if (expected.status === 'discussed') check('quote', item?.discussion_id === 'D1' && item.evidence.trim() && c.discussion.includes(item.evidence));
  } else {
    check('summary', /[가-힣]/.test(actual.summary) && [expected.text, expected.also].every(word => !word || actual.summary.includes(word)));
    for (const key of ['tasks', 'events']) check(key, actual[key].length === expected[key]);
    const item = actual.tasks[0] ?? actual.events[0];
    for (const key of ['due_date','assignee_name','date','start_time','location']) if (key in expected) check(key, item?.[key] === expected[key]);
    if (expected.title) check('title', item?.title.includes(expected.title));
    check('evidence', [...actual.tasks,...actual.events].every(row => row.evidence.trim() && c.memo.includes(row.evidence)));
  }
  return errors;
}

const [quant, variant = 'baseline'] = process.argv.slice(2);
if (quant === 'check') {
  for (const c of cases) if (!request(c).every(Boolean)) throw Error(c.id);
  console.log(cases.length, 'contracts prepared');
} else {
  if (!['Q4_K_M','Q5_K_M'].includes(quant) || !['baseline','repair'].includes(variant)) throw Error('expected Q4_K_M or Q5_K_M and baseline or repair');
  const model = 'hf.co/bartowski/Qwen_Qwen3.5-4B-GGUF:' + quant;
  const origin = 'http://127.0.0.1:11459';
  const inventory = await (await fetch(origin + '/api/tags')).json();
  const installed = inventory.models.find(entry => entry.name.toLowerCase() === model.toLowerCase());
  if (installed?.details?.quantization_level !== quant) throw Error('missing or incorrect quantization: ' + model);
  const options = {temperature:0,seed:42,num_ctx:4096,num_predict:768};
  const results = {model, digest:installed.digest, quant, variant, options, think:false, cpu:cpus()[0].model,
    engine:(await (await fetch(origin + '/api/version')).json()).version, casesHash:createHash('sha256').update(casesText).digest('hex'), rows:[]};
  for (const c of cases) {
    let [format, system, input] = request(c);
    if (variant === 'repair') system += '\n' + text('./repair-prompt.txt').trim();
    const res = await fetch(origin + '/api/chat', {method:'POST', signal:AbortSignal.timeout(180000),
      headers:{'content-type':'application/json'},body:JSON.stringify({model,options,format,think:false,stream:false,
        messages:[{role:'system',content:system},{role:'user',content:input}]})});
    if (!res.ok) throw Error(await res.text());
    const out = await res.json();
    const content = out.message.content;
    let value, parseError;
    try {value = JSON.parse(content);} catch (error) {parseError = error.message;}
    const schema = matches(format,value);
    const errors = schema ? failures(c,value) : ['schema'];
    if (!out.done || out.done_reason !== 'stop') errors.push('incomplete');
    const row = {id:c.id, schema, errors, content, parseError, promptTokens:out.prompt_eval_count, tokens:out.eval_count,
      decodeMs:out.eval_duration/1e6,totalMs:out.total_duration/1e6};
    results.rows.push(row);
    console.log(quant,c.id,errors.length ? errors.join(',') : 'PASS');
  }
  const destination = new URL('./' + quant + '-' + variant + '.json', import.meta.url);
  const temporary = new URL(destination.href + '.' + process.pid + '.tmp');
  writeFileSync(temporary, JSON.stringify(results,null,2) + '\n');
  renameSync(temporary, destination);
}
