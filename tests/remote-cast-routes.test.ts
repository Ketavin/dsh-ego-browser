// Remote /api/ego/* route integration: the plugin-owned JWT path sits strictly
// AFTER the Host fence refuses a request, and every downstream guard (method,
// body, session, target, generation, lease) still applies to remote callers.
// Keys are generated per run against a fixture JWKS server — test fixtures
// only, never production credentials.
import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { exportJWK, SignJWT } from 'jose'
import { ControlLease } from '../src/control-lease.ts'
import { ContinuationGate } from '../src/continuation-gate.ts'
import { ScopeError, SessionSpaceRegistry } from '../src/session-spaces.ts'
import { isolatedRuntimeEnv } from '../src/runtime-isolation.ts'
import { activeRemoteStreams, initCastServer } from '../src/cast-server.ts'
import { createRemoteAuthorizer, resolveRemoteAccess, type RemoteAuthorizer } from '../src/remote-access.ts'
import { resolveConfig } from '../src/config.ts'
import type { ScopedBrowserHost } from '../src/types.ts'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

const OWNER = 'fixture-owner-subject-0001'
const AUDIENCE = 'fixture-app-aud'

async function harness(mountRemote = true, opts: { grantMs?: number; healthDelayMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ego-remote-routes-'))
  cleanup.push(() => {
    // Validate the owned fixture directory before any recursive removal.
    const target = resolve(home)
    if (!target.startsWith(`${resolve(tmpdir())}${sep}ego-remote-routes-`)) throw new Error('refuse cleanup outside owned fixture directory')
    rmSync(target, { recursive: true, force: true })
  })
  const env = isolatedRuntimeEnv({ ...process.env, DSH_HOME: home, DSH_EGO_ISOLATED_RUNTIME: '1' })!
  const scopes = new SessionSpaceRegistry(), control = new ControlLease()
  const live = new Set(['A']), routes = new Map<string, (req: unknown, res: unknown) => unknown>()
  const workerCalls: string[] = []
  // Mirror the real host's lease interaction (index.ts): a human-lease
  // navigate/context goes through runHuman with the requesting device's
  // identity, and the continuation gate drains under the same identity.
  const host: ScopedBrowserHost = { scopes, control, runtimeEnv: env,
    continuation: new ContinuationGate(scopes, control, () => undefined),
    validateSession(id) {
      if (typeof id !== 'string' || !live.has(id)) throw new ScopeError('session-not-live')
      scopes.bind(id); return id
    },
    async navigate(sessionId, _url, leaseEpoch, _targetId, holder) {
      return leaseEpoch !== undefined
        ? control.runHuman(sessionId, leaseEpoch, async () => ({ ok: true }), holder)
        : { ok: true }
    },
    async context(sessionId, leaseEpoch, _targetId, holder) {
      return leaseEpoch !== undefined
        ? control.runHuman(sessionId, leaseEpoch, async () => ({ targetId: 'target-A', url: 'https://example.org', title: 'A', text: 'ctx' }), holder)
        : { targetId: 'target-A', url: 'https://example.org', title: 'A', text: 'ctx' }
    } }
  host.validateSession('A')
  scopes.record('A', { name: scopes.require('A').name, targets: ['target-A'] })
  // In-process fixture cast worker (spaces/input), plus its state file so
  // ensureWorker() finds a live worker and never spawns a process.
  let notifyHealth!: () => void
  const healthEntered = new Promise<void>(resolve => { notifyHealth = resolve })
  const healthTimers = new Set<ReturnType<typeof setTimeout>>()
  let streamOpens = 0
  const worker = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    workerCalls.push(`${req.method} ${req.url}`)
    if (req.url === '/api/health') {
      notifyHealth()
      const payload = JSON.stringify({ workerOk: true, pid: process.pid, bootId: 'remote-fixture-worker', profileDir: env.EGO_LINUX_PROFILE })
      if (opts.healthDelayMs !== undefined) {
        const timer = setTimeout(() => { healthTimers.delete(timer); res.writeHead(200, { 'content-type': 'application/json' }); res.end(payload) }, opts.healthDelayMs)
        healthTimers.add(timer)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(payload)
      return
    }
    if (req.url === '/api/stream') {
      streamOpens += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':worker\n\n')
      return
    }
    const payload = req.url === '/api/spaces'
      ? { ok: true, spaces: [{ targetId: 'target-A', title: 'A', url: 'https://a.example' }, { targetId: 'target-B', title: 'foreign', url: 'https://b.example' }] }
      : { ok: true }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload))
  })
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => {
    for (const timer of healthTimers) clearTimeout(timer)
    worker.closeAllConnections()
    return new Promise<void>(resolve => worker.close(() => resolve()))
  })
  mkdirSync(env.EGO_LINUX_STATE_DIR!, { recursive: true })
  writeFileSync(join(env.EGO_LINUX_STATE_DIR!, 'ego-cast.json'), JSON.stringify({ port: (worker.address() as { port: number }).port, pid: process.pid, bootId: 'remote-fixture-worker', profileDir: env.EGO_LINUX_PROFILE }))
  const disposers: Array<() => void> = []
  const ctx = { subprocess: { spawn: () => { throw new Error('spawn forbidden in fixture') } },
    get: (name: string) => name === 'webServer' ? {
      register: (o: { path: string; handler: (req: unknown, res: unknown) => unknown }) => { routes.set(o.path, o.handler); return () => { routes.delete(o.path) } },
    } : name === 'connection' ? { requestRejection: (req: IncomingMessage) => req.headers['x-fixture-trust'] === 'yes' ? undefined : 403 } : undefined,
    effect: (fn: () => unknown) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose as () => void) } }
  // Fixture JWKS server serving the purpose-owned signing key's PUBLIC half.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'remote-key-1', alg: 'RS256', use: 'sig' }
  const jwks = createServer((req, res) => {
    const body = JSON.stringify({ keys: [jwk] })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(body)
  })
  await new Promise<void>(resolve => jwks.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => jwks.close(() => resolve())))
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const handler = routes.get(new URL(req.url!, 'http://fixture').pathname)
    if (!handler) { res.writeHead(404); res.end(); return }
    await handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) })
  const port = (server.address() as { port: number }).port
  const issuer = `http://127.0.0.1:${(jwks.address() as { port: number }).port}`
  const origin = `https://127.0.0.1:${port}`
  let remoteAuth: RemoteAuthorizer | null = null
  if (opts.grantMs !== undefined) {
    // Lifecycle fixtures: a controlled grant clock exercises post-authorization
    // expiry paths; the real RSA/JWKS verification is covered by the other
    // mounts and tests/remote-access.test.ts.
    remoteAuth = { authorize: async () => ({ expiresAtMs: Date.now() + opts.grantMs! }) }
  } else if (mountRemote) {
    const resolved = resolveRemoteAccess({ origin, issuer, audience: AUDIENCE, ownerSubject: OWNER }, { allowFixtureIssuer: true })
    if (!resolved.enabled) throw new Error('fixture remote config rejected')
    remoteAuth = createRemoteAuthorizer(resolved.config)
  }
  initCastServer(ctx as never, resolveConfig({ captureBackend: 'cdp' }), { onChange: () => () => {} } as never, null, undefined, undefined, host, remoteAuth)
  const token = async (seconds = 120, sub: string = OWNER) =>
    new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'remote-key-1' })
      .setIssuer(issuer).setAudience(AUDIENCE).setSubject(sub).setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(privateKey)
  const base = `http://127.0.0.1:${port}`
  const headers = (jwt: string, extra: Record<string, string> = {}) => ({ origin, 'cf-access-jwt-assertion': jwt, ...extra })
  return {
    base, origin, port, token, host, live, workerCalls, disposers, activeRemoteStreams,
    healthEntered, route: (path: string) => routes.get(path),
    get streamOpens() { return streamOpens },
    remoteGet: (path: string, jwt: string, extra: Record<string, string> = {}) => fetch(base + path, { headers: headers(jwt, extra) }),
    remotePost: (path: string, body: object, jwt: string) => fetch(base + path, { method: 'POST', headers: { ...headers(jwt), 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    localGet: (path: string) => fetch(base + path, { headers: { 'x-fixture-trust': 'yes' } }),
    noTrustGet: (path: string, extra: Record<string, string> = {}) => fetch(base + path, { headers: extra }),
  }
}

describe('remote /api/ego routes behind the plugin-owned JWT path', () => {
  it('keeps the plain 403 refusal when remote authorization is not mounted', async () => {
    const h = await harness(false)
    const res = await h.noTrustGet('/api/ego/spaces?sessionId=A', { cookie: 'dsh-auth-forged=1' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'forbidden' })
  })

  it('authorizes a verified remote owner but still applies every downstream guard', async () => {
    const h = await harness()
    const jwt = await h.token()
    // Session guard: valid JWT does not conjure a live session.
    expect((await h.remoteGet('/api/ego/spaces?sessionId=not-live', jwt)).status).toBe(409)
    expect(h.workerCalls).toHaveLength(0)
    // Authorized request for the live session reaches the worker and keeps
    // target filtering (foreign target-B never leaves the host).
    const res = await h.remoteGet('/api/ego/spaces?sessionId=A', jwt)
    expect(res.status).toBe(200)
    const body = await res.json() as { spaces: Array<{ targetId: string }>; sessionId: string }
    expect(body.spaces.map(x => x.targetId)).toEqual(['target-A'])
    expect(JSON.stringify(body)).not.toContain('foreign')
    // Foreign-target control is still refused before the worker.
    expect((await h.remotePost('/api/ego/watch/start', { requestId: 'w', targetId: 'target-B', clientId: 'c1' }, jwt)).status).toBe(409)
  })

  it('rejects missing, forged, expired and wrong-subject assertions before any worker call', async () => {
    const h = await harness()
    const missing = await h.remoteGet('/api/ego/spaces?sessionId=A', '')
    expect(missing.status).toBe(401)
    expect((await missing.json()).code).toBe('remote-assertion-missing')
    const garbage = await h.noTrustGet('/api/ego/spaces?sessionId=A', { origin: h.origin, 'cf-access-jwt-assertion': 'abc.def.ghi' })
    expect((await garbage.json()).code).toBe('remote-assertion-invalid')
    const expired = await h.token(-60)
    const expiredRes = await h.remoteGet('/api/ego/spaces?sessionId=A', expired)
    expect(expiredRes.status).toBe(401)
    expect((await expiredRes.json()).code).toBe('remote-assertion-invalid')
    const stranger = await h.token(120, 'someone-else')
    const strangerRes = await h.remoteGet('/api/ego/spaces?sessionId=A', stranger)
    expect(strangerRes.status).toBe(403)
    expect((await strangerRes.json()).code).toBe('remote-owner-mismatch')
    expect(h.workerCalls).toHaveLength(0)
  })

  it('enforces precise origin and rejects URL tokens for remote callers', async () => {
    const h = await harness()
    const jwt = await h.token()
    // fetch() cannot forge a Host header (forbidden header name), so drive
    // the raw socket for the Host/Origin mismatch cases.
    const raw = (headers: Record<string, string>) => new Promise<{ status: number; body: string }>(resolve => {
      const req = request(new URL(`${h.base}/api/ego/spaces?sessionId=A`), { method: 'GET', headers }, res => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', () => resolve({ status: 0, body: '' }))
      req.end()
    })
    const wrongHost = await raw({ host: 'evil.example.com', origin: h.origin, 'cf-access-jwt-assertion': jwt })
    expect(wrongHost.status).toBe(403)
    expect(JSON.parse(wrongHost.body).code).toBe('remote-host-mismatch')
    const crossOrigin = await raw({ host: h.base.replace('http://', ''), origin: 'https://evil.example.org', 'cf-access-jwt-assertion': jwt })
    expect(JSON.parse(crossOrigin.body).code).toBe('remote-origin-mismatch')
    const urlToken = await h.remoteGet('/api/ego/spaces?sessionId=A&access_token=abc', jwt)
    expect(urlToken.status).toBe(403)
    expect((await urlToken.json()).code).toBe('remote-token-in-url')
    expect(h.workerCalls).toHaveLength(0)
  })

  it('requires the pinned method/media for remote mutations (405/415 before actions)', async () => {
    const h = await harness()
    const jwt = await h.token()
    const res = await fetch(`${h.base}/api/ego/control/takeover`, { method: 'GET', headers: { origin: h.origin, 'cf-access-jwt-assertion': jwt } })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
    const badType = await fetch(`${h.base}/api/ego/control/takeover`, { method: 'POST', headers: { origin: h.origin, 'cf-access-jwt-assertion': jwt, 'content-type': 'text/plain' }, body: 'x' })
    expect(badType.status).toBe(415)
  })

  it('lets a verified remote owner take over, input and release under the lease; arming stays gated', async () => {
    const h = await harness()
    const jwt = await h.token()
    const takeover = await (await h.remotePost('/api/ego/control/takeover', { sessionId: 'A', requestId: 'take', clientId: 'remote-device-1' }, jwt)).json()
    expect(takeover.control.state).toBe('human')
    expect(takeover.control.held).toBe(true)
    const epoch = takeover.control.leaseEpoch
    expect((await h.remotePost('/api/ego/input', { sessionId: 'A', requestId: 'in1', targetId: 'target-A', leaseEpoch: epoch, inputSeq: 1, type: 'click', x: 1, y: 2, clientId: 'remote-device-1' }, jwt)).status).toBe(200)
    expect(h.workerCalls.some(call => call.includes('/api/input'))).toBe(true)
    const released = await (await h.remotePost('/api/ego/control/release', { sessionId: 'A', requestId: 'rel', leaseEpoch: epoch, clientId: 'remote-device-1' }, jwt)).json()
    expect(released.control.state).toBe('paused')
    expect((await (await h.remotePost('/api/ego/control/arm', { sessionId: 'A', requestId: 'arm', leaseEpoch: released.control.leaseEpoch }, jwt)).json()).code).toBe('continuation-gate-required')
  })

  it('keeps local fence behavior unchanged (no assertion needed for trusted local callers)', async () => {
    const h = await harness()
    const res = await h.localGet('/api/ego/spaces?sessionId=A')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { spaces: Array<{ targetId: string }> }).spaces.map(x => x.targetId)).toEqual(['target-A'])
  })
})

describe('two devices of one session: one holds the lease, both keep watching', () => {
  it('refuses the second device on every control route while passive reads stay open', async () => {
    const h = await harness()
    const jwt = await h.token()
    const take = await (await h.remotePost('/api/ego/control/takeover', { sessionId: 'A', requestId: 'take', clientId: 'device-A' }, jwt)).json()
    const epoch = take.control.leaseEpoch
    // Control mutations name a DIFFERENT device of the same session/epoch: refused.
    const refused: Array<[string, Record<string, unknown>]> = [
      ['/api/ego/input', { sessionId: 'A', requestId: 'b-in', targetId: 'target-A', leaseEpoch: epoch, inputSeq: 1, type: 'click', x: 1, y: 2 }],
      ['/api/ego/close', { sessionId: 'A', requestId: 'b-close', targetId: 'target-A', leaseEpoch: epoch }],
      ['/api/ego/control/release', { sessionId: 'A', requestId: 'b-rel', leaseEpoch: epoch }],
      ['/api/ego/navigate', { sessionId: 'A', requestId: 'b-nav', url: 'https://example.org', targetId: 'target-A', leaseEpoch: epoch }],
      ['/api/ego/context', { sessionId: 'A', requestId: 'b-ctx', targetId: 'target-A', leaseEpoch: epoch }],
      ['/api/ego/control/prepare-continue', { sessionId: 'A', requestId: 'b-prep', leaseEpoch: epoch }],
      ['/api/ego/control/takeover', { sessionId: 'A', requestId: 'b-take' }],
    ]
    for (const [path, body] of refused) {
      const res = await h.remotePost(path, { ...body, clientId: 'device-B' }, jwt)
      expect(res.status, path).toBe(409)
      expect(((await res.json()) as { code: string }).code, path).toBe(path === '/api/ego/control/takeover' ? 'lease-held-elsewhere' : 'lease-holder-mismatch')
    }
    expect(h.workerCalls.filter(call => call.includes('/api/input')), 'second device never reaches the worker').toHaveLength(0)
    // Passive same-session reads stay open to the watching device, and the
    // status answer says who holds WITHOUT exposing the holder value.
    expect((await h.remoteGet('/api/ego/spaces?sessionId=A', jwt)).status).toBe(200)
    const forB = await (await h.remoteGet('/api/ego/control/status?sessionId=A&clientId=device-B', jwt)).json()
    expect(forB.control.state).toBe('human')
    expect(forB.control.held).toBe(false)
    expect(JSON.stringify(forB)).not.toContain('device-A')
    const forA = await (await h.remoteGet('/api/ego/control/status?sessionId=A&clientId=device-A', jwt)).json()
    expect(forA.control.held).toBe(true)
    const seen = await fetch(`${h.base}/api/ego/stream?eventsOnly=1&sessionId=A`, { headers: { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt } })
    expect(seen.status).toBe(200)
    await seen.body!.cancel()
  })
  it('requires a device identity on control mutations, then rebinds after release (contention → release → reacquire)', async () => {
    const h = await harness()
    const jwt = await h.token()
    const anonymous = await h.remotePost('/api/ego/control/takeover', { sessionId: 'A', requestId: 'anon' }, jwt)
    expect(anonymous.status).toBe(409)
    expect(((await anonymous.json()) as { code: string }).code).toBe('client-id-required')
    // device-A holds; device-B cannot act…
    const a = await (await h.remotePost('/api/ego/control/takeover', { sessionId: 'A', requestId: 'take-a', clientId: 'device-A' }, jwt)).json()
    expect((await h.remotePost('/api/ego/input', { sessionId: 'A', requestId: 'b-in', targetId: 'target-A', leaseEpoch: a.control.leaseEpoch, inputSeq: 1, type: 'click', x: 1, y: 2, clientId: 'device-B' }, jwt)).status).toBe(409)
    // …until the holder releases; then the second device may take over and
    // the FIRST device becomes the refused one.
    expect((await h.remotePost('/api/ego/control/release', { sessionId: 'A', requestId: 'rel-a', leaseEpoch: a.control.leaseEpoch, clientId: 'device-A' }, jwt)).status).toBe(200)
    const b = await (await h.remotePost('/api/ego/control/takeover', { sessionId: 'A', requestId: 'take-b', clientId: 'device-B' }, jwt)).json()
    expect(b.control.state).toBe('human')
    expect(b.control.held).toBe(true)
    expect((await h.remotePost('/api/ego/input', { sessionId: 'A', requestId: 'a-in', targetId: 'target-A', leaseEpoch: b.control.leaseEpoch, inputSeq: 1, type: 'click', x: 1, y: 2, clientId: 'device-A' }, jwt)).status).toBe(409)
    expect((await h.remotePost('/api/ego/input', { sessionId: 'A', requestId: 'b-in', targetId: 'target-A', leaseEpoch: b.control.leaseEpoch, inputSeq: 1, type: 'click', x: 1, y: 2, clientId: 'device-B' }, jwt)).status).toBe(200)
    expect(h.workerCalls.filter(call => call.includes('/api/input'))).toHaveLength(1)
  })
  it('never serves one device idempotent receipt to another device replaying its requestId', async () => {
    const h = await harness()
    const jwt = await h.token()
    const take = await (await h.remotePost('/api/ego/control/takeover', { sessionId: 'A', requestId: 'reused', clientId: 'device-A' }, jwt)).json()
    const epoch = take.control.leaseEpoch
    // B replays A's exact takeover requestId: refused, never A's held=true receipt.
    const bTake = await h.remotePost('/api/ego/control/takeover', { sessionId: 'A', requestId: 'reused', clientId: 'device-B' }, jwt)
    expect(bTake.status).toBe(409)
    expect(((await bTake.json()) as { code: string }).code).toBe('lease-held-elsewhere')
    // B replays A's explicit-context requestId: no cached page text crosses devices.
    expect((await h.remotePost('/api/ego/context', { sessionId: 'A', requestId: 'read', targetId: 'target-A', leaseEpoch: epoch, clientId: 'device-A' }, jwt)).status).toBe(200)
    const bRead = await h.remotePost('/api/ego/context', { sessionId: 'A', requestId: 'read', targetId: 'target-A', leaseEpoch: epoch, clientId: 'device-B' }, jwt)
    expect(bRead.status).toBe(409)
    expect(((await bRead.json()) as { code: string }).code).toBe('lease-holder-mismatch')
    // A genuine same-device release retry keeps its receipt after the state
    // change; B replaying the same requestId is refused.
    expect((await h.remotePost('/api/ego/control/release', { sessionId: 'A', requestId: 'rel', leaseEpoch: epoch, clientId: 'device-A' }, jwt)).status).toBe(200)
    expect((await h.remotePost('/api/ego/control/release', { sessionId: 'A', requestId: 'rel', leaseEpoch: epoch, clientId: 'device-A' }, jwt)).status).toBe(200)
    expect((await h.remotePost('/api/ego/control/release', { sessionId: 'A', requestId: 'rel', leaseEpoch: epoch, clientId: 'device-B' }, jwt)).status).toBe(409)
  })
})

describe('remote grant expiry and reservation lifecycle (controlled grant clock)', () => {
  const openRemoteStream = (h: Awaited<ReturnType<typeof harness>>, path = '/api/ego/stream?sessionId=A&targetId=target-A') => {
    const req = request({ host: '127.0.0.1', port: h.port, path, method: 'GET', headers: { origin: h.origin, 'cf-access-jwt-assertion': 'controlled-grant' } })
    req.on('error', () => {})
    req.end()
    return req
  }

  it('refuses a mutation whose request body completes after the grant expires', async () => {
    const h = await harness(true, { grantMs: 70 })
    const body = JSON.stringify({ sessionId: 'A', requestId: 'slow-body' })
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: h.port, path: '/api/ego/control/takeover', method: 'POST', headers: { origin: h.origin, 'cf-access-jwt-assertion': 'controlled-grant', 'content-type': 'application/json' } }, res => {
        let response = ''
        res.on('data', (chunk: Buffer) => { response += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: response }))
      })
      req.on('error', reject)
      req.write(body.slice(0, 1))
      setTimeout(() => req.end(body.slice(1)), 200) // body completes long after the 70ms grant
    })
    expect([401, 403]).toContain(result.status)
    expect(JSON.parse(result.body).code).toBe('remote-authorization-expired')
    expect(h.host.control.status('A').state).toBe('idle') // no takeover side effect
  })

  it('refuses an expired grant before worker dispatch after health discovery', async () => {
    const h = await harness(true, { grantMs: 60, healthDelayMs: 150 })
    // The body completes immediately; the 150ms health discovery is the
    // asynchronous gap after which the 60ms grant must no longer dispatch a
    // NEW worker operation (watch/start needs no human lease to reach it).
    const result = await h.remotePost('/api/ego/watch/start', { sessionId: 'A', requestId: 'late', targetId: 'target-A', clientId: 'c1' }, 'controlled-grant')
    expect([401, 403]).toContain(result.status)
    expect(((await result.json()) as { code: string }).code).toBe('remote-authorization-expired')
    expect(h.workerCalls.some(call => call.includes('/api/watch/start'))).toBe(false)
  })

  it('returns the reserved slot and opens no worker stream when the client disconnects during discovery', async () => {
    const h = await harness(true, { grantMs: 20_000, healthDelayMs: 250 })
    const base = activeRemoteStreams()
    const req = openRemoteStream(h)
    await h.healthEntered
    req.destroy()
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(activeRemoteStreams(), 'aborted discovery must release the slot').toBe(base)
    expect(h.streamOpens, 'no worker stream for a closed downstream').toBe(0)
    req.destroy()
  })

  it('releases the reserved slot when the grant expires during worker discovery', async () => {
    const h = await harness(true, { grantMs: 150, healthDelayMs: 400 })
    const base = activeRemoteStreams()
    const req = openRemoteStream(h)
    await h.healthEntered
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(activeRemoteStreams(), 'expired discovery must release the slot').toBe(base)
    expect(h.streamOpens, 'no worker stream for an expired grant').toBe(0)
    req.destroy()
  })

  it('releases a reserved slot when the plugin unloads during worker discovery', async () => {
    const h = await harness(true, { grantMs: 20_000, healthDelayMs: 300 })
    const base = activeRemoteStreams()
    const req = openRemoteStream(h)
    await h.healthEntered
    for (const disposer of h.disposers) disposer()
    await new Promise(resolve => setTimeout(resolve, 450))
    expect(activeRemoteStreams(), 'unload must release the reserved slot').toBe(base)
    expect(h.streamOpens, 'no worker stream after unload').toBe(0)
    req.destroy()
  })

  it('deregisters a deadline-ended stream so unload afterwards does not double-release', async () => {
    const h = await harness(true, { grantMs: 400 })
    const base = activeRemoteStreams()
    const req = openRemoteStream(h)
    // Health is immediate: the worker stream opens, then the 400ms grant
    // deadline ends it while the client deliberately keeps its socket open.
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(h.streamOpens).toBe(1)
    expect(activeRemoteStreams(), 'deadline must release the slot without downstream close').toBe(base)
    // Unloading after the natural end must find nothing left to release.
    for (const disposer of h.disposers) disposer()
    expect(activeRemoteStreams(), 'no double release').toBe(base)
    req.destroy()
  })

  it('quiet remote route detaches its own close listener at deadline, preserving foreign subscriptions', async () => {
    // Drive the REGISTERED route handler directly with an EventEmitter double
    // whose end() never emits close — the strictest case: nothing about the
    // route-layer registration may depend on the downstream closing. A foreign
    // close listener installed beforehand must survive untouched.
    const h = await harness(true, { grantMs: 200 })
    const res = new EventEmitter() as EventEmitter & { writeHead: () => void; write: () => boolean; end: () => void; ended: boolean }
    res.writeHead = () => {}
    res.write = () => true
    res.ended = false
    res.end = () => { res.ended = true } // never emits close
    const foreignClose = () => {}
    res.on('close', foreignClose)
    const base = activeRemoteStreams()
    try {
      const handler = h.route('/api/ego/stream')!
      await handler({ method: 'GET', url: '/api/ego/stream?sessionId=A&eventsOnly=1', headers: {} }, res)
      expect(activeRemoteStreams()).toBe(base + 1)
      await new Promise(resolve => setTimeout(resolve, 450))
      expect(res.ended, 'deadline must end the quiet stream').toBe(true)
      expect(activeRemoteStreams(), 'deadline must release the slot').toBe(base)
      expect(res.listeners('close'), 'only the foreign close subscriber may remain').toEqual([foreignClose])
      expect(res.listenerCount('drain')).toBe(0)
    } finally {
      for (const disposer of h.disposers.reverse()) disposer()
      res.removeListener('close', foreignClose)
    }
  })
})

describe('remote SSE streams (bounded lifetime, capacity, cleanup)', () => {
  const openStream = async (h: Awaited<ReturnType<typeof harness>>, seconds: number) => {
    const jwt = await h.token(seconds)
    const controller = new AbortController()
    const response = await fetch(`${h.base}/api/ego/stream?eventsOnly=1&sessionId=A`, { headers: { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt }, signal: controller.signal })
    return { response, controller }
  }

  it('opens a verified remote stream and ends it at JWT expiry without arming the Agent', async () => {
    const h = await harness()
    const { response, controller } = await openStream(h, 1)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const start = Date.now()
    const text = await response.text() // resolves when the server ends the stream
    const elapsed = Date.now() - start
    expect(text.startsWith(':ok')).toBe(true)
    expect(elapsed).toBeLessThan(5000)
    expect(h.host.control.status('A').state).toBe('idle') // expiry never arms/resumes anything
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.activeRemoteStreams()).toBe(0)
  })

  it('caps concurrent remote streams and frees slots on disconnect', async () => {
    const h = await harness()
    const held: Array<{ response: Response; controller: AbortController }> = []
    for (let i = 0; i < 4; i++) {
      const stream = await openStream(h, 120)
      expect(stream.response.status).toBe(200)
      held.push(stream)
    }
    expect(h.activeRemoteStreams()).toBe(4)
    const fifth = await openStream(h, 120)
    expect(fifth.response.status).toBe(429)
    expect((await fifth.response.json()).code).toBe('remote-stream-capacity')
    // The read-only classification aid on watch/status reflects the exhausted
    // remote budget (it grants and reserves nothing).
    const jwt = await h.token(120)
    const full = await fetch(`${h.base}/api/ego/watch/status?sessionId=A`, { headers: { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt } })
    expect((await full.json()).remoteStreamFull).toBe(true)
    for (const { controller } of held) controller.abort()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(h.activeRemoteStreams()).toBe(0)
    const drained = await fetch(`${h.base}/api/ego/watch/status?sessionId=A`, { headers: { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt } })
    expect((await drained.json()).remoteStreamFull).toBe(false)
    const reopen = await openStream(h, 120)
    expect(reopen.response.status).toBe(200)
    reopen.controller.abort()
  })

  it('refuses remote streams for dead sessions and unowned targets before opening', async () => {
    const h = await harness()
    const jwt = await h.token()
    const dead = await fetch(`${h.base}/api/ego/stream?eventsOnly=1&sessionId=not-live`, { headers: { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt } })
    expect(dead.status).toBe(409)
    expect((await dead.json()).code).toBe('session-not-live')
    h.live.delete('A')
    const gone = await fetch(`${h.base}/api/ego/stream?sessionId=A&targetId=target-A`, { headers: { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt } })
    expect(gone.status).toBe(409)
    expect((await gone.json()).code).toBe('session-not-live')
  })

  it('stops remote streams and returns every slot on plugin unload', async () => {
    const h = await harness()
    const streams = [await openStream(h, 120), await openStream(h, 120)]
    expect(h.activeRemoteStreams()).toBe(2)
    for (const disposer of h.disposers) disposer()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(h.activeRemoteStreams()).toBe(0)
    for (const { controller } of streams) controller.abort()
  })
})
