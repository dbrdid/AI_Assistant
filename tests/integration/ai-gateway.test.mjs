import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayMessages, readReply, sendToProvider, serverBase, setSessionKey, listServerModels } from '../../frontend/Frontend_UI/src/integration/aiGateway.mjs';
import { commandPrompt } from '../../frontend/Frontend_UI/src/features/stella/appCommands.mjs';
import { planProjectCommand, routeProjectCommand } from '../../frontend/Frontend_UI/src/features/stella/projectCommands.mjs';
import { DEFAULT_DEVICE_MODEL, deviceModels, loadCandidates, profiles } from '../../frontend/Frontend_UI/src/integration/mobileModelPolicy.mjs';

function fakeFetch(reply, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return { ok: status < 400, status, json: async () => reply };
  };
  return { calls, fetchImpl };
}

test('every provider receives the same gateway instructions', async () => {
  const command = gatewayMessages('맨 아래에 결정 사항 제목 추가해줘', 'command');
  assert.equal(command.user, commandPrompt('맨 아래에 결정 사항 제목 추가해줘'));
  const chat = gatewayMessages('회의록 문서 만들어줘', 'chat');
  assert.match(chat.system, /앱 작업: <명령>/);
  assert.match(chat.system, /프로젝트 만들기: 신제품 출시/);
  assert.match(chat.system, /"대상: 현재 문서의 N번 블록" 줄이 있으면 그 블록 번호를 그대로 쓴다/);
  assert.throws(() => gatewayMessages('  ', 'chat'), /입력/);
  // 모델이 연도를 지어내지 않도록 기기의 오늘 날짜를 함께 보낸다
  const dated = gatewayMessages('12월 1일까지 포스터 제출 할 일 추가해줘', 'chat', new Date(2026, 10, 26));
  assert.match(dated.system, /오늘 날짜: 2026-11-26 \(목요일\)/);
  assert.match(gatewayMessages('표 블록 추가', 'command', new Date(2026, 10, 26)).system, /오늘 날짜: 2026-11-26/);

  setSessionKey('openai', 'sk-test');
  setSessionKey('anthropic', 'ak-test');
  const openai = fakeFetch({ choices: [{ message: { content: '앱 작업: 문서 만들기: 회의록' } }] });
  assert.equal((await sendToProvider({ provider: 'openai', openaiModel: 'm1' }, chat, openai)).text, '앱 작업: 문서 만들기: 회의록');
  assert.equal(openai.calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(openai.calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(openai.calls[0].body.messages, [{ role: 'system', content: chat.system }, { role: 'user', content: chat.user }]);

  const anthropic = fakeFetch({ content: [{ type: 'text', text: '안녕하세요' }] });
  assert.equal((await sendToProvider({ provider: 'anthropic' }, chat, anthropic)).text, '안녕하세요');
  assert.equal(anthropic.calls[0].body.system, chat.system);
  assert.equal(anthropic.calls[0].init.headers['x-api-key'], 'ak-test');

  const server = fakeFetch({ choices: [{ message: { content: '좋아요' } }] });
  await sendToProvider({ provider: 'server', serverUrl: 'http://192.168.0.10:11434/', serverModel: 'gemma4:e2b' }, chat, server);
  assert.equal(server.calls[0].url, 'http://192.168.0.10:11434/v1/chat/completions');
  assert.equal(server.calls[0].body.model, 'gemma4:e2b');
  assert.equal(server.calls[0].body.messages[0].content, chat.system);

  let cloudBody;
  const cloud = async (path, body) => { cloudBody = { path, ...body }; return { model: 'cloud-m', draft: { text: '앱 작업: 캘린더 열어줘' } }; };
  assert.equal((await sendToProvider({ provider: 'cloud' }, chat, { cloud, newId: () => 'id-1' })).model, 'cloud-m');
  assert.deepEqual(cloudBody, { path: 'command', client_request_id: 'id-1', system: chat.system, user: chat.user });

  const device = async ({ system, user }) => ({ text: system.length && user, model: DEFAULT_DEVICE_MODEL });
  assert.equal((await sendToProvider({ provider: 'device' }, chat, { device })).model, DEFAULT_DEVICE_MODEL);
});

test('provider errors never echo keys and missing keys stop before sending', async () => {
  setSessionKey('openai', '');
  const none = fakeFetch({});
  await assert.rejects(sendToProvider({ provider: 'openai' }, gatewayMessages('안녕', 'chat'), none), /API 키/);
  assert.equal(none.calls.length, 0);
  setSessionKey('openai', 'sk-secret-value');
  await assert.rejects(sendToProvider({ provider: 'openai' }, gatewayMessages('안녕', 'chat'), fakeFetch({}, 401)),
    error => /인증/.test(error.message) && !error.message.includes('sk-secret-value'));
  await assert.rejects(sendToProvider({ provider: 'server', serverUrl: 'http://x:1', serverModel: '' }, gatewayMessages('안녕', 'chat'), fakeFetch({})), /모델/);
});

test('server addresses accept origins or /v1 bases only', async () => {
  assert.equal(serverBase('http://localhost:11434'), 'http://localhost:11434/v1');
  assert.equal(serverBase('https://ai.example.com/v1/'), 'https://ai.example.com/v1');
  assert.throws(() => serverBase('ftp://host'), /주소/);
  assert.throws(() => serverBase('http://user:pw@host'), /계정/);
  const list = fakeFetch({ data: [{ id: 'gemma4:e2b' }, { id: 'qwen' }, {}] });
  assert.deepEqual(await listServerModels({ serverUrl: 'http://localhost:11434' }, list), ['gemma4:e2b', 'qwen']);
});

test('a local model reply in exact command shape without the 앱 작업 prefix is still a command; rewritten text stays text', () => {
  assert.deepEqual(readReply('일정 추가 2026-11-27 15:00: Dentist checkup', 'chat'), { command: '일정 추가 2026-11-27 15:00: Dentist checkup' });
  assert.deepEqual(readReply('할 일 추가 2026-11-27: 포스터 제출', 'chat'), { command: '할 일 추가 2026-11-27: 포스터 제출' });
  // 되묻는 답은 블록에 넣을 글이 아니라 질문으로 표시
  assert.deepEqual(readReply('질문: 할 일 날짜를 알려주세요.', 'chat'), { text: '할 일 날짜를 알려주세요.', question: true });
  assert.deepEqual(readReply('문서 만들기: 회의록', 'chat'), { command: '문서 만들기: 회의록' });
  assert.deepEqual(readReply('3번 블록 삭제', 'chat'), { command: '3번 블록 삭제' });
  assert.deepEqual(readReply('캘린더 열어줘', 'chat'), { command: '캘린더 열어줘' });
  assert.deepEqual(readReply('회의는 내일 3시에 있습니다', 'chat'), { text: '회의는 내일 3시에 있습니다' });
  assert.deepEqual(readReply('First sentence. Second and third sentences.', 'chat'), { text: 'First sentence. Second and third sentences.' });
  assert.equal(readReply('문서 만들기: 회의록\n그리고 다른 설명', 'chat').text, '문서 만들기: 회의록\n그리고 다른 설명');
});
test('replies become app commands only through the explicit command line', () => {
  assert.deepEqual(readReply('```\n앱 작업: 문서 만들기: 회의록\n```', 'chat'), { command: '문서 만들기: 회의록' });
  assert.deepEqual(readReply('일반 답변입니다.', 'chat'), { text: '일반 답변입니다.' });
  assert.deepEqual(readReply('"제목 블록 추가: 결정 사항"', 'command'), { command: '제목 블록 추가: 결정 사항' });
  assert.ok(readReply('지원불가', 'command').clarify);
  assert.throws(() => readReply('', 'chat'), /비어/);
});
test('several app actions come back in order (at most five), one stays a single command', () => {
  const reply = readReply('앱 작업: 문서 만들기: 회의록\n앱 작업: 제목 블록 추가: 결정 사항\n앱 작업: 할 일 추가 2026-11-27: 포스터 제출', 'chat');
  assert.deepEqual(reply, { command: '문서 만들기: 회의록', commands: ['문서 만들기: 회의록', '제목 블록 추가: 결정 사항', '할 일 추가 2026-11-27: 포스터 제출'] });
  const many = readReply(Array.from({ length: 7 }, (_, i) => `앱 작업: ${i + 1}번 블록 삭제`).join('\n'), 'chat');
  assert.equal(many.commands.length, 5);
  assert.deepEqual(readReply('앱 작업: 캘린더 열어줘', 'chat'), { command: '캘린더 열어줘' });
});

test('project commands run only after approval and only with stated values', () => {
  assert.deepEqual(routeProjectCommand('신제품 출시라는 프로젝트 만들어줘'), { command: '프로젝트 만들기: 신제품 출시' });
  const projects = [{ id: 'p1', title: '신제품 출시', status: '진행 전' }];
  const tasks = [{ id: 't1', kind: 'task', title: '포스터 제출', projectId: null }];
  const calls = [];
  const tools = {
    getProjects: () => projects, getTasks: () => tasks, getTask: id => tasks.find(t => t.id === id), canWrite: () => true,
    addProject: fields => { calls.push(['add', fields]); return { id: 'p2', ...fields }; },
    updateProject: (id, fields) => { calls.push(['update', id, fields]); return true; },
    setTaskProject: (id, projectId) => { tasks.find(t => t.id === id).projectId = projectId; },
  };
  assert.equal(planProjectCommand(tools, '문서 만들기: 회의록'), null);
  const create = planProjectCommand(tools, '프로젝트 만들기: 겨울 행사', '겨울 행사 프로젝트를 만들어 줘');
  assert.equal(calls.length, 0, 'nothing changes before approval');
  assert.deepEqual(create.approve(), { route: 'ProjectDetail', params: { projectId: 'p2' } });
  assert.throws(() => create.approve(), /이미 처리/);
  assert.throws(() => planProjectCommand(tools, '프로젝트 만들기: 여름 행사', '겨울 행사 만들어줘'), /요청에 없는 값/);
  assert.throws(() => planProjectCommand(tools, '프로젝트 만들기: 신제품 출시'), /이미 있습니다/);
  planProjectCommand(tools, '프로젝트 상태 변경: 신제품 출시 / 진행 중').approve();
  assert.deepEqual(calls.at(-1), ['update', 'p1', { status: '진행 중' }]);
  assert.throws(() => planProjectCommand(tools, '프로젝트 상태 변경: 신제품 출시 / 끝'), /상태는/);
  planProjectCommand(tools, '할 일 프로젝트 연결: 포스터 제출 / 신제품 출시').approve();
  assert.equal(tasks[0].projectId, 'p1');
  const denied = planProjectCommand({ ...tools, canWrite: () => false }, '프로젝트 상태 변경: 신제품 출시 / 보류');
  assert.throws(() => denied.approve(), /권한/);
});

test('Gemma 4 E2B is the pinned device default and Qwen stays available', () => {
  const gemma = deviceModels[DEFAULT_DEVICE_MODEL];
  assert.match(gemma.url, /^https:\/\/huggingface\.co\/ggml-org\/gemma-4-E2B-it-GGUF\/resolve\/[0-9a-f]{40}\/gemma-4-E2B-it-Q4_0\.gguf$/);
  assert.match(gemma.sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(deviceModels)[0], DEFAULT_DEVICE_MODEL);
  for (const key of Object.keys(profiles)) assert.equal(deviceModels[key].sha256, profiles[key].sha256);
  const installed = Object.keys(deviceModels);
  assert.deepEqual(loadCandidates(DEFAULT_DEVICE_MODEL, installed, { total: 8e9, available: 1.6 * 1024 ** 3 }), [DEFAULT_DEVICE_MODEL]);
  assert.deepEqual(loadCandidates(DEFAULT_DEVICE_MODEL, installed, { total: 8e9, available: 1e9 }), []);
  assert.deepEqual(loadCandidates('Q4_K_M', installed, { total: 8e9, available: 2e9 }), []);
});
