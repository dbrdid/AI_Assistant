// 공유 정책만 포함합니다. I/O, SDK, 인증 정보, 모델 주소는 포함하지 않습니다.
export class AIPolicyError extends Error {
  constructor(code) { super(code); this.name = 'AIPolicyError'; this.code = code; }
}

export function requireRoute(value = 'external') {
  if (value !== 'external' && value !== 'self_hosted') throw new AIPolicyError('INVALID_AI_ROUTE');
  return value;
}

/** 정책은 신뢰할 수 있는 애플리케이션 스냅샷이며 문서의 지시문에서 추론하지 않습니다. */
export function requireTransmission(route, sources, consent) {
  requireRoute(route);
  if (!consent || consent[route] !== true) throw new AIPolicyError('CONSENT_REQUIRED');
  if (!Array.isArray(sources) || sources.length === 0) throw new AIPolicyError('NO_SOURCES');
  for (const source of sources) {
    if (!source || source.deleted || source.excluded || !Array.isArray(source.allowedProviders)
      || !source.allowedProviders.includes(route)) throw new AIPolicyError('TRANSMISSION_DENIED');
  }
}
