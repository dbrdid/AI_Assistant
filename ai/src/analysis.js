import { DocumentAIError } from './documents.js';

const fail = code => { throw new DocumentAIError(code); };
const object = properties => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const LENGTHS = Object.freeze({ short: 300, standard: 800, detailed: 1600 });
const quoteSchema = object({ chunkId: string(20), quote: string(300) });
const answerSchema = object({ answer: string(1000), insufficientEvidence: { type: 'boolean' },
  citations: array(quoteSchema, 5) });
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const keys = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
function document(input) {
  if (!keys(input, ['documentId', 'revision', 'text']) ||
      typeof input.documentId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.documentId) ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 || !text(input.text, 80000)) fail('INVALID_INPUT');
  return { ...input };
}

// Offsets are UTF-16 indices into the unchanged original document.
export function splitDocument(source) {
  if (!text(source, 80000)) fail('INVALID_INPUT');
  const chunks = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(start + 4000, source.length);
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
    chunks.push({ chunkId: 'chunk-' + chunks.length, start, end, text: source.slice(start, end) });
    if (end === source.length) break;
    start = end - 200;
    if (/[\uDC00-\uDFFF]/.test(source[start])) start--;
  }
  return chunks;
}
function summarySchema(limit) {
  return object({ summary: string(limit), keywords: array(string(50), 8),
    keyPoints: array(object({ text: string(200), citation: quoteSchema }), 5, 1) });
}
function validCitation(citation, chunks, allowed) {
  if (!keys(citation, ['chunkId', 'quote']) || !text(citation.quote, 300)) return false;
  const chunk = chunks.find(item => item.chunkId === citation.chunkId);
  return Boolean(chunk?.text.includes(citation.quote)) && (!allowed || allowed.some(item =>
    item.chunkId === citation.chunkId && item.quote === citation.quote));
}
function validateSummary(value, limit, chunks, allowed) {
  if (!keys(value, ['summary', 'keywords', 'keyPoints']) || !text(value.summary, limit) ||
      !Array.isArray(value.keywords) || value.keywords.length > 8 ||
      value.keywords.some(word => !text(word, 50)) || new Set(value.keywords).size !== value.keywords.length ||
      !Array.isArray(value.keyPoints) || value.keyPoints.length < 1 || value.keyPoints.length > 5 ||
      value.keyPoints.some(point => !keys(point, ['text', 'citation']) || !text(point.text, 200) ||
        !validCitation(point.citation, chunks, allowed))) fail('INVALID_MODEL_OUTPUT');
  return value;
}
function validateAnswer(value, chunks, allowed) {
  if (!keys(value, ['answer', 'insufficientEvidence', 'citations']) || !text(value.answer, 1000) ||
      typeof value.insufficientEvidence !== 'boolean' || !Array.isArray(value.citations) ||
      value.citations.length > 5 || (value.insufficientEvidence ? value.citations.length !== 0 : value.citations.length === 0) ||
      value.citations.some(item => !validCitation(item, chunks, allowed))) fail('INVALID_MODEL_OUTPUT');
  return value;
}
async function run(options, work) {
  const { provider, signal, timeoutMs = 120000 } = options;
  if (!provider || typeof provider.generate !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 600000) fail('INVALID_CONFIGURATION');
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let remove = () => {};
  try {
    combined.throwIfAborted();
    const aborted = new Promise((resolve, reject) => {
      const listener = () => reject(combined.reason);
      combined.addEventListener('abort', listener, { once: true });
      remove = () => combined.removeEventListener('abort', listener);
    });
    return await Promise.race([work(async request => {
      combined.throwIfAborted();
      const output = await provider.generate({ ...request, signal: combined });
      combined.throwIfAborted();
      return output;
    }), aborted]);
  } catch (error) {
    if (signal?.aborted) fail('CANCELLED');
    if (deadline.aborted) fail('MODEL_TIMEOUT');
    if (error instanceof DocumentAIError) throw error;
    fail('MODEL_UNAVAILABLE');
  } finally { remove(); }
}
async function reducePairs(values, merge) {
  while (values.length > 1) {
    const next = [];
    for (let i = 0; i < values.length; i += 2) {
      next.push(i + 1 < values.length ? await merge(values.slice(i, i + 2)) : values[i]);
    }
    values = next;
  }
  return values[0];
}
function metadata(doc, chunks) {
  return { documentId: doc.documentId, inputRevision: doc.revision,
    chunks: chunks.map(({ chunkId, start, end }) => ({ chunkId, start, end })) };
}

export async function summarizeLongDocument(input, options = {}) {
  const doc = document(input);
  const { summaryLength = 'standard' } = options;
  if (!Object.hasOwn(LENGTHS, summaryLength)) fail('INVALID_INPUT');
  const limit = LENGTHS[summaryLength];
  const chunks = splitDocument(doc.text);
  return run(options, async generate => {
    const values = [];
    for (const chunk of chunks) {
      values.push(validateSummary(await generate({ task: 'summary-chunk',
        payload: { chunkId: chunk.chunkId, document: chunk.text, summaryLength },
        schema: summarySchema(limit) }), limit, [chunk]));
    }
    const result = await reducePairs(values, async parts => {
      const allowed = parts.flatMap(part => part.keyPoints.map(point => point.citation));
      return validateSummary(await generate({ task: 'summary-merge',
        payload: { parts, summaryLength }, schema: summarySchema(limit) }), limit, chunks, allowed);
    });
    return { ...metadata(doc, chunks), summaryLength, result };
  });
}

export async function answerDocument(input, question, options = {}) {
  const doc = document(input);
  if (!text(question, 1000)) fail('INVALID_INPUT');
  const chunks = splitDocument(doc.text);
  return run(options, async generate => {
    const values = [];
    for (const chunk of chunks) {
      values.push(validateAnswer(await generate({ task: 'answer-chunk',
        payload: { question, chunkId: chunk.chunkId, document: chunk.text },
        schema: answerSchema }), [chunk]));
    }
    const supported = values.filter(value => !value.insufficientEvidence);
    const result = supported.length === 0 ? { answer: '문서에서 답변 근거를 찾지 못했습니다.',
      insufficientEvidence: true, citations: [] } : await reducePairs(supported, async parts => {
        const allowed = parts.flatMap(part => part.citations);
        return validateAnswer(await generate({ task: 'answer-merge', payload: { question, parts },
          schema: answerSchema }), chunks, allowed);
      });
    return { ...metadata(doc, chunks), result };
  });
}
