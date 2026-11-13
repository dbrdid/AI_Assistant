import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, errors } from 'jose';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The signing keys could not be obtained or used, so the token was not judged. Callers answer 503, not 401. */
export class AuthUnavailableError extends Error {
  constructor() { super('Authentication keys unavailable'); this.name = 'AuthUnavailableError'; this.code = 'AUTH_UNAVAILABLE'; }
}
// Key resolution failures that say nothing about the token: JWKS timeout, malformed key set or key, and jose's
// generic error, which it throws only for a non-200 or non-JSON JWKS response. Non-JOSE errors (network) as well.
const KEY_SOURCE_FAILURES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC']);
function keySource(resolve) {
  return async (header, token) => {
    try { return await resolve(header, token); }
    catch (error) {
      // No cause is attached, so response bodies and network text stay out of the error.
      if (!(error instanceof errors.JOSEError) || KEY_SOURCE_FAILURES.has(error.code)) throw new AuthUnavailableError();
      throw error;
    }
  };
}
/** Trust configuration is server-owned, never obtained from JWT headers or requests. */
export function createJwtVerifier({ issuer, audience, jwks, jwksUrl, algorithms = ['ES256'] }) {
  if (typeof issuer !== 'string' || !issuer || typeof audience !== 'string' || !audience || !!jwks === !!jwksUrl || !algorithms.length || algorithms.some(a => !['ES256','RS256','EdDSA'].includes(a))) throw new Error('Invalid JWT trust configuration');
  if (jwksUrl && new URL(jwksUrl).protocol !== 'https:') throw new Error('HTTPS JWKS required');
  const key = keySource(jwks ? createLocalJWKSet(jwks) : createRemoteJWKSet(new URL(jwksUrl)));
  return async token => {
    const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms, requiredClaims: ['sub','exp','iat'], clockTolerance: 0 });
    if (!UUID.test(payload.sub) || payload.iat > Date.now() / 1000 + 5) throw new Error('Invalid identity');
    return { id: payload.sub };
  };
}
