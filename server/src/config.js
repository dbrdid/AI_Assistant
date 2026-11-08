import { ApiError } from './errors.js';

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error('Invalid configuration: ' + name);
  }
  return value;
}

export function loadConfig(env = process.env) {
  let tokens;
  try {
    tokens = JSON.parse(env.AI_AUTH_TOKENS ?? '[]');
  } catch {
    throw new Error('Invalid configuration: AI_AUTH_TOKENS JSON');
  }
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 100) {
    throw new Error('Configure 1-100 per-user AI_AUTH_TOKENS records');
  }
  const hashes = new Set();
  for (const token of tokens) {
    if (!token || typeof token !== 'object' ||
        Object.keys(token).some(key => !['userId', 'sha256', 'expiresAt'].includes(key)) ||
        typeof token.userId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(token.userId) ||
        typeof token.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(token.sha256) ||
        typeof token.expiresAt !== 'string' || !Number.isFinite(Date.parse(token.expiresAt)) ||
        hashes.has(token.sha256)) {
      throw new Error('Invalid per-user authentication record');
    }
    hashes.add(token.sha256);
  }
  const url = new URL(env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') {
    throw new Error('OLLAMA_BASE_URL must be an HTTP(S) origin');
  }
  const model = env.OLLAMA_MODEL?.trim();
  if (!model || model.length > 200) throw new Error('OLLAMA_MODEL is required');
  return {
    host: env.HOST ?? '127.0.0.1',
    port: integer(env, 'PORT', 3000, 1, 65535),
    model,
    ollamaBaseUrl: url.origin,
    tokens,
    modelTimeoutMs: integer(env, 'MODEL_TIMEOUT_MS', 30000, 100, 120000),
    maxConcurrent: integer(env, 'MAX_CONCURRENT', 2, 1, 16),
    requestsPerMinute: integer(env, 'REQUESTS_PER_MINUTE', 10, 1, 1000),
  };
}

export function requireActiveToken(token, now) {
  if (Date.parse(token.expiresAt) <= now) throw new ApiError(401, 'UNAUTHORIZED');
}
