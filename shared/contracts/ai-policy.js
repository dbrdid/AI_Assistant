// Shared policy only: no I/O, SDK, credentials, or model addresses.
export class AIPolicyError extends Error {
  constructor(code) { super(code); this.name = 'AIPolicyError'; this.code = code; }
}

export function requireRoute(value = 'external') {
  if (value !== 'external' && value !== 'self_hosted') throw new AIPolicyError('INVALID_AI_ROUTE');
  return value;
}

/** Policies are trusted application snapshots, never inferred from document instructions. */
export function requireTransmission(route, sources, consent) {
  requireRoute(route);
  if (!consent || consent[route] !== true) throw new AIPolicyError('CONSENT_REQUIRED');
  if (!Array.isArray(sources) || sources.length === 0) throw new AIPolicyError('NO_SOURCES');
  for (const source of sources) {
    if (!source || source.deleted || source.excluded || !Array.isArray(source.allowedProviders)
      || !source.allowedProviders.includes(route)) throw new AIPolicyError('TRANSMISSION_DENIED');
  }
}
