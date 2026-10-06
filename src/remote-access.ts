/**
 * Plugin-owned remote authorization for the /api/ego/* routes.
 *
 * The deployed Core fence (connection.requestRejection) stays authoritative for
 * local desktop requests and is never loosened, patched or fed a fabricated
 * Origin/cookie. This module is a SEPARATE, explicit path that is consulted
 * only after that fence has already refused a request: a caller that reached
 * the DSH host through the pinned HTTPS origin behind Cloudflare Access must
 * present a valid `Cf-Access-Jwt-Assertion` (injected by the Access edge from
 * the user's CF_Authorization session) verified against the issuer-derived
 * Cloudflare JWKS. Forwarded headers alone are never authority — the signature
 * is.
 *
 * Configuration is a mount-time host snapshot (composition entry
 * `remoteAccess`), resolved once in apply(): exact HTTPS origin, exact Access
 * issuer, application audience and the single allowed owner subject. It is not
 * part of SettingsConfig, the settings namespace schema, the gateway
 * ALLOWED_KEYS or the live settings bridge, so no browser Settings/gateway
 * preference write can move it. Absent, partial or malformed configuration
 * leaves remote access disabled (fail closed). The real owner subject is never
 * inferred — the host operator supplies it.
 *
 * Tokens are read only from the assertion header. They are never accepted from
 * a URL, never written into responses, client persistence or logs. Refusals
 * made during the pre-verification checks (malformed request/URL, duplicate
 * or mismatched Host/Origin/Sec-Fetch-Site, missing/malformed assertion)
 * perform no JWKS fetch and change no state; the verification step itself may
 * fetch the JWKS even when the signature or claims ultimately fail. Only
 * rejection codes leave this module.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { IncomingMessage } from 'node:http'

/** Only Cloudflare Access issuance is supported; Access signs with RS256. */
const SUPPORTED_ALGORITHMS = ['RS256'] as const
const CLOCK_TOLERANCE_S = 30
/** Cloudflare publishes the team JWKS at <issuer>/cdn-cgi/access/certs. */
const JWKS_PATH = '/cdn-cgi/access/certs'
const MAX_ASSERTION_CHARS = 8192
const MAX_CONFIG_FIELD_CHARS = 256
/** Query-parameter names that must never carry credentials in a URL. */
const URL_TOKEN_PATTERN = /token|jwt|jwks|assertion|authorization|credential|secret/i

export interface RemoteAccessConfig {
  /** Normalized exact origin, e.g. https://agent.example.com (no path/query). */
  readonly origin: string
  /** Authority (host[:port]) the request's Host header must carry exactly. */
  readonly originAuthority: string
  /** Normalized exact issuer, e.g. https://team.cloudflareaccess.com. */
  readonly issuer: string
  readonly audience: string
  readonly ownerSubject: string
  /** Derived from the issuer — a request can never supply its own JWKS URL. */
  readonly jwksUrl: URL
}

export type RemoteAccessResolution =
  | { enabled: true; config: RemoteAccessConfig }
  | { enabled: false; reason: 'remote-access-unconfigured' | 'remote-access-invalid' }

/** What a verified remote request grants: nothing beyond the JWT's expiry. */
export interface RemoteGrant {
  expiresAtMs: number
}

export type RemoteRejectionCode =
  | 'remote-access-disabled'
  | 'remote-request-malformed'
  | 'remote-token-in-url'
  | 'remote-header-duplicate'
  | 'remote-host-mismatch'
  | 'remote-origin-mismatch'
  | 'remote-origin-required'
  | 'remote-fetch-site'
  | 'remote-assertion-missing'
  | 'remote-assertion-invalid'
  | 'remote-owner-mismatch'

export interface RemoteRejection {
  readonly ok: false
  readonly status: 401 | 403
  readonly code: RemoteRejectionCode
}

export interface RemoteAuthorizer {
  authorize(req: IncomingMessage): Promise<RemoteGrant | RemoteRejection>
}

interface ParsedHttpsUrl {
  origin: string
  authority: string
  hostname: string
  port: string
}

/** Parse and normalize an https URL used as an exact-origin/issuer pin. */
function parseHttpsUrl(value: string): ParsedHttpsUrl | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_CONFIG_FIELD_CHARS) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.pathname !== '' && parsed.pathname !== '/') return null
  if (parsed.search !== '' || parsed.hash !== '') return null
  const hostname = parsed.hostname.toLowerCase()
  // URL.hostname keeps IPv6 addresses bracketed (`[::1]`), which is exactly
  // the legal wire form a Host header carries.
  // Default :443 and an omitted port are the same origin; keep any other port.
  const port = parsed.port === '' || parsed.port === '443' ? '' : parsed.port
  const authority = port === '' ? hostname : `${hostname}:${port}`
  return { origin: `https://${authority}`, authority, hostname, port }
}

/**
 * Strictly parse one legal Host-header authority: `name`, `name:port`,
 * `[ipv6]` or `[ipv6]:port` (case-insensitive). Malformed values — multiple
 * colons (`host:444:443`), non-numeric/oversized/empty ports (`host:`,
 * `host:443x`, `host:999999`), unbracketed IPv6, empty names — return null
 * and never authorize. This is a parse of one legal authority, not a
 * substring heuristic.
 */
function parseAuthority(value: string): { hostname: string; port: string } | null {
  if (value === '' || value.length > MAX_CONFIG_FIELD_CHARS) return null
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null
  const lower = value.toLowerCase()
  if (lower.startsWith('[')) {
    const match = /^(\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/.exec(lower)
    if (match === null) return null
    if (match[2] !== undefined && Number(match[2]) > 65535) return null
    return { hostname: match[1]!, port: match[2] ?? '' }
  }
  const colon = lower.indexOf(':')
  if (colon === -1) return { hostname: lower, port: '' }
  if (lower.indexOf(':', colon + 1) !== -1) return null
  const port = lower.slice(colon + 1)
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return null
  const hostname = lower.slice(0, colon)
  if (hostname === '') return null
  return { hostname, port }
}

function printableToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_CONFIG_FIELD_CHARS) return null
  // The pinned subject/audience are opaque identifiers: no whitespace/control.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

/**
 * Resolve the immutable host `remoteAccess` configuration. Returns
 * `{ enabled: false, reason }` for absent/partial/malformed input so callers
 * fail closed with a safe diagnostic; `allowFixtureIssuer` widens issuer
 * validation to a fixture endpoint for signed-token tests only — production
 * mounts never set it.
 */
export function resolveRemoteAccess(raw: unknown, opts: { allowFixtureIssuer?: boolean } = {}): RemoteAccessResolution {
  if (raw === undefined || raw === null) return { enabled: false, reason: 'remote-access-unconfigured' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { enabled: false, reason: 'remote-access-invalid' }
  const source = raw as Record<string, unknown>
  const fields = ['origin', 'issuer', 'audience', 'ownerSubject'] as const
  if (fields.some(field => source[field] === undefined)) return { enabled: false, reason: 'remote-access-unconfigured' }

  const origin = parseHttpsUrl(String(source.origin))
  if (origin === null) return { enabled: false, reason: 'remote-access-invalid' }

  let issuer: { origin: string } | null = null
  if (opts.allowFixtureIssuer === true) {
    // Test fixtures: any http(s) URL (a loopback JWKS server) is accepted so
    // real signature/claim verification runs against generated purpose-owned
    // keys instead of production Cloudflare.
    const value = String(source.issuer)
    try {
      const parsed = new URL(value)
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:')
        && parsed.hostname.length > 0 && parsed.username === '' && parsed.password === ''
        && (parsed.pathname === '' || parsed.pathname === '/')) {
        issuer = { origin: value.replace(/\/$/, '') }
      }
    } catch {
      issuer = null
    }
  } else {
    const candidate = parseHttpsUrl(String(source.issuer))
    if (candidate !== null && candidate.hostname.endsWith('.cloudflareaccess.com')
      && candidate.hostname.length > '.cloudflareaccess.com'.length) {
      issuer = { origin: candidate.origin }
    }
  }
  if (issuer === null) return { enabled: false, reason: 'remote-access-invalid' }

  const audience = printableToken(source.audience)
  const ownerSubject = printableToken(source.ownerSubject)
  if (audience === null || ownerSubject === null) return { enabled: false, reason: 'remote-access-invalid' }

  return {
    enabled: true,
    config: {
      origin: origin.origin,
      originAuthority: origin.authority,
      issuer: issuer.origin,
      audience,
      ownerSubject,
      jwksUrl: new URL(`${issuer.origin}${JWKS_PATH}`),
    },
  }
}

function reject(status: 401 | 403, code: RemoteRejectionCode): RemoteRejection {
  return { ok: false, status, code }
}

/**
 * Read one authorization-relevant header, refusing ambiguity. On a real Node
 * request `req.rawHeaders` is the wire truth: Node's `req.headers` view
 * DISCARDS duplicate Host fields (keeping only the first) and joins most
 * others, so two wire fields would otherwise hide behind one visible value.
 * A name appearing more than once on the wire — or as an array in the parsed
 * view — is an ambiguity attack and is refused outright, never treated as
 * absent or "first wins". Returns 'duplicate' | 'absent' | the single value.
 */
function readAuthHeader(req: IncomingMessage, name: string): { duplicate: true } | { duplicate: false; value: string | null } {
  const raw = (req as IncomingMessage & { rawHeaders?: readonly string[] }).rawHeaders
  if (Array.isArray(raw)) {
    let count = 0
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (raw[i]!.toLowerCase() === name) count += 1
    }
    if (count > 1) return { duplicate: true }
  }
  const value = req.headers[name]
  if (Array.isArray(value)) return { duplicate: true }
  return { duplicate: false, value: typeof value === 'string' ? value : null }
}

/**
 * Build the remote authorizer for one mount. The JWKS set is created once and
 * cached by jose (fetch on first use, refetch on unknown `kid` at most once
 * per cooldown) — the URL always comes from the resolved issuer, never from
 * the request.
 */
export function createRemoteAuthorizer(config: RemoteAccessConfig): RemoteAuthorizer {
  const jwks = createRemoteJWKSet(config.jwksUrl, {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    timeoutDuration: 5_000,
  })
  // The pinned authority is parsed once with the same strict parser the
  // request Host gets; if it cannot be parsed (defensive — parseHttpsUrl
  // produced it), every request fails closed as a Host mismatch.
  const pin = parseAuthority(config.originAuthority)
  return {
    async authorize(req: IncomingMessage): Promise<RemoteGrant | RemoteRejection> {
      // 1. A request we cannot even parse is refused without side effects.
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'https://dsh.internal.invalid')
      } catch {
        return reject(403, 'remote-request-malformed')
      }
      // 2. Credentials never ride in URLs — reject before any verification.
      for (const key of url.searchParams.keys()) {
        if (URL_TOKEN_PATTERN.test(key)) return reject(403, 'remote-token-in-url')
      }
      // 3. Precise origin binding: the Host header must parse as exactly one
      //    legal authority equal to the pin (hostname + port; an explicit
      //    default :443 equals the portless pin). Malformed values
      //    (`host:444:443`, `host:`), duplicate wire fields and any other
      //    vhost never authorize — they are rejected, not treated as absent.
      const hostHeader = readAuthHeader(req, 'host')
      if (hostHeader.duplicate) return reject(403, 'remote-header-duplicate')
      const parsedHost = hostHeader.value === null ? null : parseAuthority(hostHeader.value)
      const hostMatches = pin !== null && parsedHost !== null
        && parsedHost.hostname === pin.hostname
        && (parsedHost.port === '443' ? '' : parsedHost.port) === pin.port
      if (!hostMatches) return reject(403, 'remote-host-mismatch')
      // 4. Same-origin checks that hold for both fetch and native
      //    EventSource: browsers send Origin on every cross-origin request
      //    and every non-GET/HEAD request (so a POST without Origin is not a
      //    browser), while same-origin GETs may carry only Sec-Fetch-Site.
      //    When one of these headers is present it must pin to the
      //    configured origin. Duplicates of any of these authorization
      //    headers are ambiguity attacks and are refused before verification.
      const originHeader = readAuthHeader(req, 'origin')
      if (originHeader.duplicate) return reject(403, 'remote-header-duplicate')
      if (originHeader.value !== null) {
        const parsed = parseHttpsUrl(originHeader.value)
        if (parsed === null || parsed.origin !== config.origin) return reject(403, 'remote-origin-mismatch')
      } else if (req.method !== undefined && req.method.toUpperCase() !== 'GET' && req.method.toUpperCase() !== 'HEAD') {
        return reject(403, 'remote-origin-required')
      }
      const fetchSite = readAuthHeader(req, 'sec-fetch-site')
      if (fetchSite.duplicate) return reject(403, 'remote-header-duplicate')
      if (fetchSite.value !== null && fetchSite.value.toLowerCase() !== 'same-origin') return reject(403, 'remote-fetch-site')
      // 5. The signed assertion is the only credential. Forwarded headers
      //    without a verifiable signature grant nothing; two assertion fields
      //    on the wire are refused before any verification.
      const assertionHeader = readAuthHeader(req, 'cf-access-jwt-assertion')
      if (assertionHeader.duplicate) return reject(403, 'remote-header-duplicate')
      const assertion = assertionHeader.value
      if (assertion === null || assertion === '') return reject(401, 'remote-assertion-missing')
      if (assertion.length > MAX_ASSERTION_CHARS || /[\s\u0000-\u001f\u007f]/.test(assertion)) {
        return reject(401, 'remote-assertion-invalid')
      }
      // 6. Real cryptographic verification: supported algorithm, signature
      //    against the issuer JWKS, issuer, audience, exp (and nbf when
      //    present). jose errors carry no secrets; only the code leaves this
      //    module.
      let payload: { sub?: unknown; exp?: unknown }
      try {
        const result = await jwtVerify(assertion, jwks, {
          algorithms: [...SUPPORTED_ALGORITHMS],
          issuer: config.issuer,
          audience: config.audience,
          clockTolerance: CLOCK_TOLERANCE_S,
          requiredClaims: ['iss', 'aud', 'exp', 'sub'],
        })
        payload = result.payload
      } catch {
        return reject(401, 'remote-assertion-invalid')
      }
      // 7. Exactly one human owner subject is allowed.
      if (payload.sub !== config.ownerSubject) return reject(403, 'remote-owner-mismatch')
      const expiresAtMs = typeof payload.exp === 'number' ? payload.exp * 1000 : Number.NaN
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return reject(401, 'remote-assertion-invalid')
      return { expiresAtMs }
    },
  }
}

/** Create the always-refusing authorizer used when remote access is disabled. */
export function createDisabledRemoteAuthorizer(): RemoteAuthorizer {
  return { authorize: async () => reject(403, 'remote-access-disabled') }
}
