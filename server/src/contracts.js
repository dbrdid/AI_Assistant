import Ajv from 'ajv';
import { ApiError } from './errors.js';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const identifier = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9_-]+$' };
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const object = properties => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const common = {
  clientRequestId: identifier,
  inputRevision: revision,
  consent: { const: true, type: 'boolean' },
  timeZone: text(80),
  referenceTime: { type: 'string', maxLength: 35,
    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$' },
};
const evidence = object({ id: identifier, revision, text: text(1200) });
export const requestSchemas = {
  organize: object({ ...common, text: text(8000) }),
  conditions: object({ ...common, question: text(1000) }),
  answer: object({ ...common, question: text(1000), evidence: array(evidence, 3) }),
};
const citation = object({ id: identifier, revision, quote: text(1200) });
export const resultSchemas = {
  organize: object({
    summary: text(8000),
    candidates: array(object({
      kind: { type: 'string', enum: ['task', 'event'] },
      title: text(200),
      dueDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      sourceQuote: text(1200),
    }), 20),
  }),
  conditions: object({
    keywords: array(text(100), 8),
    recordType: { type: 'string', enum: ['all', 'note', 'task', 'event'] },
  }),
  answer: object({
    answer: text(8000),
    insufficientEvidence: { type: 'boolean' },
    citations: array(citation, 3),
  }),
};
const validator = new Ajv({ allErrors: false, coerceTypes: false, removeAdditional: false });
const resultValidators = Object.fromEntries(
  Object.entries(resultSchemas).map(([task, schema]) => [task, validator.compile(schema)]),
);

export function validateRequestContext(task, input) {
  if ((task === 'organize' && input.text.length > 8000) ||
      (task !== 'organize' && input.question.length > 1000) ||
      (task === 'answer' && input.evidence.some(item => item.text.length > 1200))) {
    throw new ApiError(400, 'INPUT_TOO_LONG');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
  } catch {
    throw new ApiError(400, 'INVALID_TIME_ZONE');
  }
  const datePart = new Date(input.referenceTime.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(Date.parse(input.referenceTime)) ||
      !Number.isFinite(datePart.getTime()) ||
      datePart.toISOString().slice(0, 10) !== input.referenceTime.slice(0, 10)) {
    throw new ApiError(400, 'INVALID_REFERENCE_TIME');
  }
  if (task === 'answer' && new Set(input.evidence.map(item => item.id)).size !== input.evidence.length) {
    throw new ApiError(400, 'DUPLICATE_EVIDENCE');
  }
}

export function validateResult(task, result, input) {
  if (!resultValidators[task](result)) throw new ApiError(502, 'INVALID_MODEL_OUTPUT');
  if (task === 'organize') {
    for (const candidate of result.candidates) {
      if (!input.text.includes(candidate.sourceQuote)) throw new ApiError(502, 'INVALID_MODEL_OUTPUT');
      if (candidate.dueDate !== null) {
        const date = new Date(candidate.dueDate + 'T00:00:00Z');
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== candidate.dueDate) {
          throw new ApiError(502, 'INVALID_MODEL_OUTPUT');
        }
      }
    }
  }
  if (task === 'answer') {
    for (const citation of result.citations) {
      const source = input.evidence.find(item => item.id === citation.id && item.revision === citation.revision);
      if (!source || !source.text.includes(citation.quote)) throw new ApiError(502, 'INVALID_MODEL_OUTPUT');
    }
    if ((!result.insufficientEvidence && result.citations.length === 0) ||
        (result.insufficientEvidence && result.citations.length !== 0)) {
      throw new ApiError(502, 'INVALID_MODEL_OUTPUT');
    }
  }
  return result;
}
