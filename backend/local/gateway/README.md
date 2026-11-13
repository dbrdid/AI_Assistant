# AI Gateway (injected, disabled by default)

`createGateway` returns a standard `Request -> Promise<Response>` handler. No listener, credentials, live provider, deployment, or plaintext input store is created. All routes require an injected **cryptographically verifying** `verifyJwt`; `createJwtVerifier` provides JOSE signature verification against server-configured issuer, audience, JWKS and ES256/RS256/EdDSA allowlist. JWT `jku`/`x5u` cannot select keys. Expiry, issued-at and UUID subject are mandatory. The gateway must run behind TLS and deployment-level rate limits; SQL also limits admission.

Routes:

- `POST /v1/ai/consents`: `approved: true`, consent/workspace/document UUIDs, string source revision, lowercase SHA-256 of exact UTF-8 payload, purpose `summary`, immutable `route_id`, retention version, decimal-string `max_cost_microusd`, integer output token cap and ISO expiry (at most 24h). Rejects unknown keys including raw text, URLs, caller actor/provider/model. Server attaches provider/model IDs from trusted route configuration; SQL checks immutable route registry.
- `POST /v1/ai/jobs`: consent/job UUIDs, opaque encrypted `input_ref`, exact payload hash and route ID. Repeated job UUID is the idempotency key. Current access, consent, revision, quotas and budget reservation are checked atomically by SQL.
- `GET /v1/ai/jobs/:id`: owner/current-access checked status, no raw output.
- `POST /v1/ai/jobs/:id/cancel` and `POST /v1/ai/consents/:id/revoke`.

`createGatewayStore({userRpc, privilegedRpc})` maps handler calls to SQL. The user RPC callback must execute in the verified subject's authenticated DB context, not trust caller-supplied claims. Privileged admission runs with `ai_executor`, never a client role. Body parsing is bounded to 16 KiB after authentication. Errors omit SQL/provider diagnostics and responses disable caching.

## Errors

Every error response is JSON `{error: <code>}` with `cache-control: no-store`. Only the codes below reach the client; text from the verifier, the store, the database or a provider is never reflected or logged.

- Gateway checks keep their codes: 400 `invalid_request`, `invalid_json`, `explicit_consent_required`, `route_not_allowed` or `retention_mismatch`; 401 `unauthorized`; 404 `not_found`; 413 `body_too_large`; 415 `json_required`.
- Verifier: an invalid token is 401 `unauthorized`. A verifier error with code `AUTH_UNAVAILABLE` is 503 `auth_unavailable`: the token was not judged, so the client retries later instead of signing in again. `createJwtVerifier` throws `AuthUnavailableError` (code `AUTH_UNAVAILABLE`) when key resolution fails for a reason unrelated to the token: a JWKS timeout (`ERR_JWKS_TIMEOUT`), a non-200 or non-JSON JWKS response (jose's `ERR_JOSE_GENERIC`, which jose throws only there), a malformed remote key set or a configured key that cannot be used (`ERR_JWKS_INVALID`), or any non-JOSE error such as a network failure. An unknown `kid` is an invalid token while the key set can be fetched; with a remote key set, an unknown `kid` seen after jose's 30-second cooldown triggers a refetch, so during an outage it is 503. jose does not cache a failed JWKS fetch: the next request fetches again, so the verifier recovers with the key source. jose also refetches before using keys older than 10 minutes, so a longer outage makes every request 503 even after keys were fetched once.
- Store errors follow `shared/contracts/errors.js`. An error whose contract code (`code`, `PT<status>`) and `message` match a contract entry exactly returns that entry's HTTP status with `{error: <reason>}`, for example 403 `forbidden` (another user's job or consent, or none with that ID), 403 `invalid_consent`, 403 `ai_disabled` (consent or admission while the workspace's AI switch is off, since P0-3), 409 `consent_already_used`, 429 `rate_limited`, 402 `budget_exceeded` or `budget_not_configured`, and 400 `invalid_request`. The exception is `unauthenticated` (kind auth): the gateway verified the subject itself, so a store that reports it has dropped the subject, which is a server fault (500), not a request to sign in again.
- Transient database or network failures are 503 `temporarily_unavailable`: SQLSTATE classes `08` and `53`, `57P01`–`57P03`, `57014`, `40001`, `40P01` and `55P03`, and the Node error codes `ECONNREFUSED`, `ECONNRESET`, `ECONNABORTED`, `ETIMEDOUT`, `EPIPE`, `ENETUNREACH`, `EHOSTUNREACH` and `EAI_AGAIN`. The error's own `code` and one level of `cause.code` are read, which covers fetch's `TypeError` that wraps a socket error.
- Anything else is 500 `internal_error`, including a raw `42501` (a missing privilege is a misconfiguration, never a denial), raw constraint or cast errors, `ENOTFOUND`, and errors without a code. A driver error without a code is also 500, so a store adapter should surface the code.
- Response bodies are `{error: <code>}`, not PostgREST's `{code, message}`, so `classifyRpcFailure` from `shared/contracts/errors.js` cannot classify them. A mobile AI client needs its own table of these codes before it is connected (not done yet). Store errors are not logged; an allowlisted operator hook is part of the AI audit work (P0-6).

Money is **integer micro-USD represented as a decimal string**, never floating-point dollars: `1000000` is USD 1.00. Input/result refs are opaque `[A-Za-z0-9_-]{1,200}` and are not storage URLs. Register an immutable SQL route through `ai_set_route` before granting consent. No route/provider is enabled by default.

Encrypted payload upload, authorization-aware decryption, keys/KMS, encrypted result storage, real HTTP server/Auth/PostgREST transport and live provider billing are deferred integration dependencies. Do not replace them with persistent plaintext or describe injected test storage as encryption.

## 연결된 로컬 어댑터와 검증

../adapters/sqlite-ai.js는 허용된 RPC 이름/인자만 통과시키고, 검증된 사용자 ID는 authenticated 역할로, 실행 RPC는 ai_executor 역할로 SQLite 백엔드(../rpc/index.js)에 넘깁니다. ../adapters/encrypted-vault.js는 서버용 AES-256-GCM 파일 보관을 구현하며 키는 호출자가 공급합니다. 키를 파일에 저장하지 않고 계정·문서·동의·원본 버전을 AAD에 묶습니다. 운영 KMS/키 복구나 모바일 키 보관을 구현한 것은 아닙니다.

루트에서 npm run test:ai / npm run demo:ai로 합성 로컬 파이프라인을 검증할 수 있습니다. 암호화 보관 어댑터는 저수준 서버 모듈입니다. 외부 파일 업로드/다운로드 API, 현재 ACL을 재확인하는 파일 제공 경로, 자동 TTL 정리, 운영 KMS는 아직 연결하지 않았습니다. 실제 제공자도 없으며 데모는 합성 제공자입니다.
