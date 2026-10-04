// Remote authorization: real RSA-signed JWTs against a purpose-owned fixture
// JWKS server. Nothing here is a production credential — keys are generated
// per run; the fixture issuer only substitutes Cloudflare's endpoint so the
// actual signature/claim verification path runs end to end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { generateKeyPairSync, createHmac } from 'node:crypto'
import { exportJWK, exportSPKI, SignJWT } from 'jose'
import type { IncomingMessage } from 'node:http'
import { createDisabledRemoteAuthorizer, createRemoteAuthorizer, resolveRemoteAccess, type RemoteAccessConfig, type RemoteAccessResolution } from '../src/remote-access.ts'

/** The fail-closed reason of a disabled resolution (undefined when enabled). */
const reasonOf = (r: RemoteAccessResolution): string | undefined => (r.enabled ? undefined : r.reason)

const OWNER = 'fixture-owner-subject-0001'
const AUDIENCE = 'fixture-app-audience-tag'
const ISSUER = 'https://team-name.cloudflareaccess.com'

function requestFixture(overrides: { method?: string; url?: string; headers?: Record<string, string | string[]> } = {}) {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/api/ego/spaces?sessionId=A',
    headers: overrides.headers ?? {},
  } as IncomingMessage
}

describe('resolveRemoteAccess (immutable host configuration)', () => {
  const valid = { origin: 'https://agent.example.com', issuer: ISSUER, audience: AUDIENCE, ownerSubject: OWNER }

  it('disables remote access when the block is absent', () => {
    expect(resolveRemoteAccess(undefined)).toEqual({ enabled: false, reason: 'remote-access-unconfigured' })
    expect(resolveRemoteAccess(null)).toEqual({ enabled: false, reason: 'remote-access-unconfigured' })
  })

  it('rejects partial configuration as unconfigured and malformed values as invalid', () => {
    expect(reasonOf(resolveRemoteAccess({ ...valid, ownerSubject: undefined }))).toBe('remote-access-unconfigured')
    expect(reasonOf(resolveRemoteAccess('yes'))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess([]))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, origin: 'http://agent.example.com' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, origin: 'https://user:pw@agent.example.com' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, origin: 'https://agent.example.com/path' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, origin: 'https://agent.example.com/?x=1' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, issuer: 'https://team.example.com' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, issuer: 'http://team-name.cloudflareaccess.com' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, issuer: 'https://cloudflareaccess.com' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, issuer: 'https://team-name.cloudflareaccess.com/certs' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, audience: 'has space' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, audience: '' }))).toBe('remote-access-invalid')
    expect(reasonOf(resolveRemoteAccess({ ...valid, ownerSubject: '' }))).toBe('remote-access-invalid')
  })

  it('normalizes default ports and derives the issuer JWKS URL', () => {
    const result = resolveRemoteAccess({ ...valid, origin: 'https://Agent.Example.COM:443/', issuer: `${ISSUER}/` })
    expect(result).toMatchObject({
      enabled: true,
      config: {
        origin: 'https://agent.example.com',
        originAuthority: 'agent.example.com',
        issuer: ISSUER,
        audience: AUDIENCE,
        ownerSubject: OWNER,
        jwksUrl: new URL('https://team-name.cloudflareaccess.com/cdn-cgi/access/certs'),
      },
    })
  })

  it('keeps a non-default origin port as part of the exact origin', () => {
    const result = resolveRemoteAccess({ ...valid, origin: 'https://agent.example.com:8443' })
    expect(result.enabled && result.config.originAuthority).toBe('agent.example.com:8443')
  })

  it('accepts a fixture issuer endpoint only when explicitly allowed', () => {
    expect(resolveRemoteAccess({ ...valid, issuer: 'http://127.0.0.1:9/certs' }).enabled).toBe(false)
    const fixture = resolveRemoteAccess({ ...valid, issuer: 'http://127.0.0.1:9' }, { allowFixtureIssuer: true })
    expect(fixture.enabled && fixture.config.jwksUrl.href).toBe('http://127.0.0.1:9/cdn-cgi/access/certs')
  })
})

describe('remote authorizer (real signatures, fixture JWKS server)', () => {
  let server: Server
  let jwksRequests = 0
  let config: RemoteAccessConfig
  let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  let otherKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  const ORIGIN = 'https://agent.example.com'

  const sign = async (claims: { sub?: string; iss?: string; aud?: string; exp?: number } = {}, key = privateKey) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key-1' })
      .setIssuer(claims.iss ?? config.issuer)
      .setAudience(claims.aud ?? AUDIENCE)
      .setSubject(claims.sub ?? OWNER)
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 120)
      .sign(key)

  const signWithNbf = async (nbf: number) =>
    new SignJWT({ nbf })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key-1' })
      .setIssuer(config.issuer)
      .setAudience(AUDIENCE)
      .setSubject(OWNER)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(privateKey)

  beforeAll(async () => {
    const primary = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const secondary = generateKeyPairSync('rsa', { modulusLength: 2048 })
    privateKey = primary.privateKey
    otherKey = secondary.privateKey
    const jwk = { ...(await exportJWK(primary.publicKey)), kid: 'fixture-key-1', alg: 'RS256', use: 'sig' }
    server = createServer((req, res) => {
      jwksRequests += 1
      if (req.url === '/cdn-cgi/access/certs') {
        const body = JSON.stringify({ keys: [jwk] })
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        res.end(body)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const resolved = resolveRemoteAccess(
      { origin: ORIGIN, issuer: `http://127.0.0.1:${port}`, audience: AUDIENCE, ownerSubject: OWNER },
      { allowFixtureIssuer: true },
    )
    if (!resolved.enabled) throw new Error('fixture remote access config rejected')
    config = resolved.config
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const authorizer = () => createRemoteAuthorizer(config)
  const authorized = async (token: string, headers: Record<string, string> = {}) =>
    authorizer().authorize(requestFixture({
      headers: {
        host: 'agent.example.com',
        origin: ORIGIN,
        'cf-access-jwt-assertion': token,
        ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      },
    }))

  it('accepts a correctly signed token for the exact owner and reports its expiry', async () => {
    const exp = Math.floor(Date.now() / 1000) + 120
    const grant = await authorized(await sign({ exp }))
    expect(grant).toEqual({ expiresAtMs: exp * 1000 })
  })

  it('rejects a missing, malformed or whitespace-bearing assertion', async () => {
    const missing = await authorizer().authorize(requestFixture({ headers: { host: 'agent.example.com', origin: ORIGIN } }))
    expect(missing).toMatchObject({ ok: false, status: 401, code: 'remote-assertion-missing' })
    const malformed = await authorized('not-a-jwt')
    expect(malformed).toMatchObject({ status: 401, code: 'remote-assertion-invalid' })
    const spaced = await authorized(` ${(await sign())} `)
    expect(spaced).toMatchObject({ status: 401, code: 'remote-assertion-invalid' })
  })

  it('rejects a token signed by a different key (bad signature)', async () => {
    const forged = await authorized(await sign({}, otherKey))
    expect(forged).toMatchObject({ status: 401, code: 'remote-assertion-invalid' })
  })

  it('rejects an HS256 token signed with public key material (algorithm confusion)', async () => {
    const b64 = (value: string) => Buffer.from(value).toString('base64url')
    const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'fixture-key-1' }))
    const payload = b64(JSON.stringify({
      iss: config.issuer, aud: AUDIENCE, sub: OWNER,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
    }))
    const publicMaterial = await exportSPKI(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey)
    const signature = createHmac('sha256', publicMaterial).update(`${header}.${payload}`).digest('base64url')
    const result = await authorized(`${header}.${payload}.${signature}`)
    expect(result).toMatchObject({ status: 401, code: 'remote-assertion-invalid' })
  })

  it('rejects expired, not-yet-valid, wrong-issuer, wrong-audience and exp-less tokens', async () => {
    const expired = await authorized(await sign({ exp: Math.floor(Date.now() / 1000) - 600 }))
    expect(expired).toMatchObject({ code: 'remote-assertion-invalid' })
    const notYetValid = await authorized(await signWithNbf(Math.floor(Date.now() / 1000) + 600))
    expect(notYetValid).toMatchObject({ code: 'remote-assertion-invalid' })
    const noExp = await new SignJWT({ iss: config.issuer, aud: AUDIENCE, sub: OWNER, iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key-1' }).sign(privateKey)
      .then(token => authorized(token))
    expect(noExp).toMatchObject({ code: 'remote-assertion-invalid' })
    const wrongIssuer = await authorized(await sign({ iss: 'https://other-team.cloudflareaccess.com' }))
    expect(wrongIssuer).toMatchObject({ code: 'remote-assertion-invalid' })
    const wrongAudience = await authorized(await sign({ aud: 'different-application-aud' }))
    expect(wrongAudience).toMatchObject({ code: 'remote-assertion-invalid' })
  })

  it('accepts a valid signature but refuses a different subject (single owner)', async () => {
    const other = await authorized(await sign({ sub: 'someone-else-subject' }))
    expect(other).toMatchObject({ status: 403, code: 'remote-owner-mismatch' })
  })

  it('enforces the precise origin: Host, Origin and Sec-Fetch-Site', async () => {
    const token = await sign()
    const wrongHost = await authorized(token, { host: 'evil.example.com' })
    expect(wrongHost).toMatchObject({ status: 403, code: 'remote-host-mismatch' })
    const wrongOrigin = await authorized(token, { origin: 'https://evil.example.com' })
    expect(wrongOrigin).toMatchObject({ status: 403, code: 'remote-origin-mismatch' })
    const httpOrigin = await authorized(token, { origin: 'http://agent.example.com' })
    expect(httpOrigin).toMatchObject({ code: 'remote-origin-mismatch' })
    const crossSite = await authorized(token, { 'sec-fetch-site': 'cross-site' })
    expect(crossSite).toMatchObject({ status: 403, code: 'remote-fetch-site' })
    // Native EventSource on the same origin sends no Origin header: the
    // Sec-Fetch-Site pin plus Host equality still identify it.
    const eventSource = await authorizer().authorize(requestFixture({
      url: '/api/ego/stream?sessionId=A&targetId=t1',
      headers: { host: 'agent.example.com', 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': token },
    }))
    expect(eventSource).toEqual({ expiresAtMs: expect.any(Number) })
    // A POST without Origin is not a browser fetch (browsers always send it).
    const barePost = await authorizer().authorize(requestFixture({
      method: 'POST',
      headers: { host: 'agent.example.com', 'cf-access-jwt-assertion': token },
    }))
    expect(barePost).toMatchObject({ status: 403, code: 'remote-origin-required' })
  })

  it('rejects malformed and duplicate Host authorities; keeps default :443 equality', async () => {
    const token = await sign()
    // A duplicated Host header value is rejected outright, never "absent".
    const duplicate = await authorizer().authorize(requestFixture({
      headers: { host: ['agent.example.com', 'evil.example.com'], origin: ORIGIN, 'cf-access-jwt-assertion': token },
    }))
    expect(duplicate).toMatchObject({ status: 403, code: 'remote-header-duplicate' })
    // Malformed authorities must not authorize even with a valid owner JWT.
    for (const bad of ['agent.example.com:444:443', 'agent.example.com::443', 'agent.example.com:', 'agent.example.com:443x', 'agent.example.com:999999', ':443', '']) {
      const result = await authorized(token, { host: bad })
      expect(result, `host=${JSON.stringify(bad)}`).toMatchObject({ status: 403, code: 'remote-host-mismatch' })
    }
    // An explicit default port equals the portless pin; case-insensitive.
    const explicit = await authorized(token, { host: 'Agent.Example.COM:443' })
    expect('expiresAtMs' in explicit).toBe(true)
  })

  it('supports bracketed IPv6 origin pins with exact port matching', async () => {
    const resolved = resolveRemoteAccess(
      { origin: 'https://[::1]:8443', issuer: config.issuer, audience: AUDIENCE, ownerSubject: OWNER },
      { allowFixtureIssuer: true },
    )
    expect(resolved.enabled && resolved.config.originAuthority).toBe('[::1]:8443')
    if (!resolved.enabled) return
    const v6 = createRemoteAuthorizer(resolved.config)
    const ask = async (host: string) => v6.authorize(requestFixture({
      headers: { host, origin: 'https://[::1]:8443', 'cf-access-jwt-assertion': await sign() },
    }))
    expect('expiresAtMs' in (await ask('[::1]:8443'))).toBe(true)
    // Wrong port, portless form, unbracketed IPv6 and non-address brackets.
    for (const bad of ['[::1]', '[::1]:443', '[::1]:8444', '::1:8443', '[not-an-address]', '[::1]:8443:443']) {
      const result = await ask(bad)
      expect(result, `host=${JSON.stringify(bad)}`).toMatchObject({ status: 403, code: 'remote-host-mismatch' })
    }
  })

  it('refuses duplicate wire headers on a REAL Node HTTP request (rawHeaders truth)', async () => {
    // Edge-style server: the authorizer sees actual IncomingMessage objects.
    // Node's req.headers view DISCARDS the second Host field, so the check
    // must read req.rawHeaders; the fixture confirms two fields were on the
    // wire while authorization still refused.
    const edge = createServer(async (req, res) => {
      const result = await authorizer().authorize(req)
      const hostCount = req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'host').length
      const rejection = 'expiresAtMs' in result ? null : result
      res.writeHead(200, { 'content-type': 'application/json' })
      // Codes and counts only — no assertion or identity values.
      res.end(JSON.stringify({ authorized: 'expiresAtMs' in result, code: rejection === null ? null : rejection.code, hostCount }))
    })
    await new Promise<void>(resolve => edge.listen(0, '127.0.0.1', resolve))
    const port = (edge.address() as { port: number }).port
    const ask = async (flat: string[]) => new Promise<{ authorized: boolean; code: string | null; hostCount: number }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/api/ego/spaces?sessionId=A', headers: flat }, res => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve(JSON.parse(body)))
      })
      req.on('error', reject)
      req.end()
    })
    const token = await sign()
    const pin = 'agent.example.com'
    try {
      // Two wire Host fields — first one exactly the pin — must not authorize.
      const dupHost = await ask(['Host', pin, 'Host', 'other.example.com', 'Origin', ORIGIN, 'Cf-Access-Jwt-Assertion', token])
      expect(dupHost.hostCount, 'fixture must actually send two Host fields').toBe(2)
      expect(dupHost.authorized).toBe(false)
      expect(dupHost.code).toBe('remote-header-duplicate')
      const dupOrigin = await ask(['Host', pin, 'Origin', ORIGIN, 'Origin', 'https://evil.example.com', 'Cf-Access-Jwt-Assertion', token])
      expect(dupOrigin.authorized).toBe(false)
      expect(dupOrigin.code).toBe('remote-header-duplicate')
      const dupAssertion = await ask(['Host', pin, 'Origin', ORIGIN, 'Cf-Access-Jwt-Assertion', token, 'Cf-Access-Jwt-Assertion', token])
      expect(dupAssertion.authorized).toBe(false)
      expect(dupAssertion.code).toBe('remote-header-duplicate')
      const dupSite = await ask(['Host', pin, 'Origin', ORIGIN, 'Sec-Fetch-Site', 'same-origin', 'Sec-Fetch-Site', 'cross-site', 'Cf-Access-Jwt-Assertion', token])
      expect(dupSite.authorized).toBe(false)
      expect(dupSite.code).toBe('remote-header-duplicate')
      // Single legal fields — including the explicit default :443 — still pass.
      const control = await ask(['Host', `${pin}:443`, 'Origin', ORIGIN, 'Cf-Access-Jwt-Assertion', token])
      expect(control.hostCount).toBe(1)
      expect(control.authorized).toBe(true)
    } finally {
      edge.closeAllConnections()
      await new Promise<void>(resolve => edge.close(() => resolve()))
    }
  })

  it('rejects tokens placed in the URL before any JWKS request, and never honors a request JWKS URL', async () => {
    const before = jwksRequests
    for (const key of ['access_token', 'jwt', 'assertion', 'CF_Authorization']) {
      const result = await authorizer().authorize(requestFixture({
        url: `/api/ego/stream?sessionId=A&${key}=eyJhbGciOiJub25lIn0`,
        headers: { host: 'agent.example.com', origin: ORIGIN },
      }))
      expect(result).toMatchObject({ status: 403, code: 'remote-token-in-url' })
    }
    const jwksInjection = await authorizer().authorize(requestFixture({
      url: '/api/ego/stream?sessionId=A&jwks=http%3A%2F%2F127.0.0.1%3A1%2Fkeys',
      headers: { host: 'agent.example.com', origin: ORIGIN },
    }))
    expect(jwksInjection).toMatchObject({ code: 'remote-token-in-url' })
    expect(jwksRequests).toBe(before)
  })

  it('performs no JWKS fetch for requests refused before verification', async () => {
    const before = jwksRequests
    const disabled = await createDisabledRemoteAuthorizer().authorize(requestFixture())
    expect(disabled).toMatchObject({ status: 403, code: 'remote-access-disabled' })
    const badHost = await authorized(await sign(), { host: 'elsewhere.example.com' })
    expect(badHost).toMatchObject({ code: 'remote-host-mismatch' })
    expect(jwksRequests).toBe(before)
  })

  it('never leaks the assertion or configuration values through rejection results', async () => {
    const token = await sign()
    const results = [
      await authorized('garbage'),
      await authorized(token, { host: 'evil.example.com' }),
      await authorized(await sign({ sub: 'other-subject' })),
    ]
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(token)
      expect(JSON.stringify(result)).not.toContain(OWNER)
      expect(JSON.stringify(result)).not.toContain(AUDIENCE)
    }
  })
})
