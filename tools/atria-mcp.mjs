import { lstat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createInterface } from 'node:readline';
import { rankSearchRows, searchTerms } from '../frontend/Frontend_UI/src/data/memos/memoSearch.mjs';

const MAX_FILES = 40;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_OUTPUT_CHARS = 8_000;
const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const schema = (key, limit) => ({
  type: 'object', properties: { [key]: { type: 'string', minLength: 1, maxLength: limit } },
  required: [key], additionalProperties: false,
});
const definitions = [
  { name: 'search_documents', description: 'Search the titles and text of the selected Markdown exports.', inputSchema: schema('query', 200) },
  { name: 'get_document', description: 'Read up to 8,000 characters of a selected export by its result ID.', inputSchema: schema('id', 32) },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true, openWorldHint: false } }));

async function selectedDocuments(paths) {
  if (!paths.length || paths.length > MAX_FILES) throw new Error('Select 1 to 40 Atria Markdown export files.');
  const documents = [];
  for (const [index, path] of [...new Set(paths)].entries()) {
    const info = await lstat(path, { bigint: true });
    if (extname(path).toLowerCase() !== '.md' || !info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new Error('Only regular .md files up to 128 KiB can be selected.');
    }
    const file = await open(path, 'r');
    try {
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || info.ino !== opened.ino || info.dev !== opened.dev) throw new Error('A selected file changed.');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new Error('A selected file exceeds 128 KiB.');
      documents.push({
        id: String(index + 1),
        title: basename(path, '.md'),
        text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      });
    } finally { await file.close(); }
  }
  return documents;
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const content = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError });

function runTool(params, documents) {
  const tool = definitions.find(entry => entry.name === params?.name);
  if (!tool) return content({ error: 'Unknown tool' }, true);
  const args = params.arguments;
  const [key] = tool.inputSchema.required;
  const value = args?.[key];
  if (!args || Object.keys(args).length !== 1 || typeof value !== 'string' || !value.trim()
      || value.length > tool.inputSchema.properties[key].maxLength) return content({ error: 'Invalid arguments' }, true);
  if (key === 'query') {
    const matches = rankSearchRows(documents, searchTerms(value));
    return content(matches.slice(0, 12).map(({ id, title }) => ({ id, title })));
  }
  const document = documents.find(entry => entry.id === value);
  if (!document) return content({ error: 'Document not found among selected exports' }, true);
  return content({ ...document, text: document.text.slice(0, MAX_OUTPUT_CHARS), truncated: document.text.length > MAX_OUTPUT_CHARS });
}

async function main() {
  const documents = await selectedDocuments(process.argv.slice(2));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let initialized = false;
  let negotiated = false;
  function respond(message) {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return failure(null, -32600, 'Invalid request');
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/initialized' && negotiated) initialized = true;
      return null;
    }
    if (!['string', 'number'].includes(typeof id)) return failure(null, -32600, 'Invalid request ID');
    if (method === 'ping') return reply(id, {});
    if (method === 'initialize' && !negotiated) {
      if (typeof params?.protocolVersion !== 'string') return failure(id, -32602, 'Missing protocol version');
      negotiated = true;
      return reply(id, {
        protocolVersion: versions.has(params.protocolVersion) ? params.protocolVersion : '2025-11-25',
        serverInfo: { name: 'atria-markdown', version: '1.0.0' },
        capabilities: { tools: { listChanged: false } },
      });
    }
    if (!initialized) return failure(id, -32000, 'Initialize the session first');
    if (method === 'tools/list') return reply(id, { tools: definitions });
    if (method === 'tools/call') return reply(id, runTool(params, documents));
    return failure(id, -32601, 'Method not found');
  }
  for await (const line of input) {
    let message;
    try { message = JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify(failure(null, -32700, 'Invalid JSON')) + '\n'); continue; }
    const result = respond(message);
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  }
}

main().catch(error => {
  process.stderr.write(`Atria MCP: ${error.code ? 'Unable to open a selected export' : error.message}\n`);
  process.exitCode = 1;
});
