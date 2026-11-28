import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../../tools/atria-mcp.mjs', import.meta.url));
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (id, name, args) => request(id, 'tools/call', { name, arguments: args });

test('MCP client can discover tools and read only the selected Markdown exports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atria-mcp-'));
  try {
    const file = join(directory, '회의록.md');
    writeFileSync(file, '# 회의록\n행사 준비 자료');
    writeFileSync(join(directory, '미선택.md'), '숨겨진 준비 자료');
    const messages = [
      request(0, 'tools/list'),
      request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration', version: '1' } }),
      request(undefined, 'notifications/initialized'),
      request(2, 'tools/list'),
      call(3, 'search_documents', { query: '준비' }),
      call(4, 'get_document', { id: '1' }),
      call(5, 'get_document', { id: '2' }),
      call(6, 'get_document', { id: '1', path: '../미선택.md' }),
      call(7, 'delete_document', { id: '1' }),
    ].map(message => JSON.stringify(message)).join('\n') + '\n';
    const child = spawnSync(process.execPath, [server, file], { input: messages, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    const responses = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(responses.map(message => message.id), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(responses[0].error.code, -32000);
    assert.equal(responses[1].result.protocolVersion, '2025-11-25');
    assert.deepEqual(responses[2].result.tools.map(tool => tool.name), ['search_documents', 'get_document']);
    const payload = index => JSON.parse(responses[index].result.content[0].text);
    assert.deepEqual(payload(3), [{ id: '1', title: '회의록' }]);
    assert.match(payload(4).text, /행사 준비 자료/u);
    for (const index of [5, 6, 7]) assert.equal(responses[index].result.isError, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
