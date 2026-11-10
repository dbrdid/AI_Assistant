import Fastify from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';
import { requireActiveToken } from './config.js';
import { requestSchemas, validateRequestContext, validateResult } from './contracts.js';

export function buildApp({ config, provider, now = Date.now }) {
  const app = Fastify({
    logger: false,
    bodyLimit: 49152,
    requestTimeout: 10000,
    connectionTimeout: 10000,
    keepAliveTimeout: 5000,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });
  const tokenByHash = new Map(config.tokens.map(token => [token.sha256, token]));
  const windows = new Map();
  const activeUsers = new Set();
  let activeCount = 0;

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof ApiError ? error.statusCode :
      error.validation || error.statusCode === 400 ? 400 :
      error.statusCode === 413 ? 413 : error.statusCode === 415 ? 415 : 500;
    const code = error instanceof ApiError ? error.code :
      status === 400 ? 'INVALID_REQUEST' : status === 413 ? 'PAYLOAD_TOO_LARGE' :
      status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INTERNAL_ERROR';
    if (status === 429) reply.header('retry-after', code === 'RATE_LIMITED' ? '60' : '1');
    // Never serialize error.message, validation details, headers or model/user text.
    reply.code(status).send({ error: { code }, requestId: request.id });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND' }, requestId: request.id });
  });
  app.get('/healthz', async () => ({ status: 'ok' }));

  async function authenticate(request) {
    const match = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
    if (!match) throw new ApiError(401, 'UNAUTHORIZED');
    const hash = createHash('sha256').update(match[1]).digest('hex');
    const token = tokenByHash.get(hash);
    if (!token) throw new ApiError(401, 'UNAUTHORIZED');
    requireActiveToken(token, now());
    const userId = token.userId;
    let window = windows.get(userId);
    const current = now();
    if (!window || current >= window.resetAt) {
      window = { count: 0, resetAt: current + 60000 };
      windows.set(userId, window);
    }
    window.count++;
    if (window.count > config.requestsPerMinute) throw new ApiError(429, 'RATE_LIMITED');
    request.aiUserId = userId;
  }
  app.decorateRequest('aiUserId', '');

  for (const task of Object.keys(requestSchemas)) {
    app.post('/v1/ai/' + task, {
      onRequest: authenticate,
      schema: { body: requestSchemas[task] },
    }, async (request, reply) => {
      const input = request.body;
      validateRequestContext(task, input);
      if (activeCount >= config.maxConcurrent || activeUsers.has(request.aiUserId)) {
        throw new ApiError(429, 'SERVER_BUSY');
      }
      if (task === 'answer' && input.evidence.length === 0) {
        return {
          requestId: request.id, clientRequestId: input.clientRequestId,
          inputRevision: input.inputRevision, task,
          result: { answer: '답변에 필요한 기록 근거가 없습니다.', insufficientEvidence: true, citations: [] },
        };
      }
      activeCount++;
      activeUsers.add(request.aiUserId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new ApiError(504, 'MODEL_TIMEOUT')), config.modelTimeoutMs);
      const disconnect = () => {
        if (!reply.raw.writableEnded) controller.abort(new ApiError(499, 'CLIENT_CLOSED'));
      };
      request.raw.on('aborted', disconnect);
      reply.raw.on('close', disconnect);
      try {
        const result = await provider.generate(task, input, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        validateResult(task, result, input);
        return {
          requestId: request.id, clientRequestId: input.clientRequestId,
          inputRevision: input.inputRevision, task, result,
        };
      } finally {
        clearTimeout(timeout);
        request.raw.off('aborted', disconnect);
        reply.raw.off('close', disconnect);
        activeCount--;
        activeUsers.delete(request.aiUserId);
      }
    });
  }
  return app;
}
