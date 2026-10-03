import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlLease } from '../src/control-lease.ts'
import { ContinuationGate, type ContinuationAgent } from '../src/continuation-gate.ts'
import { ScopeError, SessionSpaceRegistry } from '../src/session-spaces.ts'
import { isolatedRuntimeEnv } from '../src/runtime-isolation.ts'
import { filterScopedSse, initCastServer, markEgoToolCall, resetEgoToolCounts } from '../src/cast-server.ts'
import { resolveConfig } from '../src/config.ts'
import type { ScopedBrowserHost } from '../src/types.ts'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'ego-scoped-host-'))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const env = isolatedRuntimeEnv({ ...process.env, DSH_HOME: home, DSH_EGO_ISOLATED_RUNTIME: '1' })!
  const scopes = new SessionSpaceRegistry(), control = new ControlLease()
  const live = new Set(['A', 'B']), routes = new Map<string, (req: unknown, res: unknown) => unknown>()
  const spawns = vi.fn(() => { throw new Error('real worker launch forbidden in this fixture') })
  const navigate = vi.fn(async (sessionId: string, _url: string) => ({ ok: true, page: { url: 'https://example.org' }, sessionId }))
  const context = vi.fn(async () => ({ targetId: 'target-A', url: 'https://example.org', title: 'A', text: 'Owned context' }))
  const nextTurn: Array<ContinuationAgent['inbox']['nextTurn'][number]> = []
  const agent: ContinuationAgent = { session: { id: 'A' }, inbox: { nextTurn, nextStep: [] }, whenIdle: async () => {}, runMaintenance: job => job(new AbortController().signal) }
  const continuation = new ContinuationGate(scopes, control, id => id === 'A' ? agent : undefined)
  cleanup.push(() => continuation.dispose())
  const host: ScopedBrowserHost = { scopes, control, runtimeEnv: env, navigate, context, continuation,
    validateSession(id) {
      if (typeof id !== 'string' || !live.has(id)) throw new ScopeError('session-not-live')
      scopes.bind(id); return id
    } }
  host.validateSession('A'); host.validateSession('B')
  scopes.record('A', { name: scopes.require('A').name, targets: ['target-A'] })
  scopes.record('B', { name: scopes.require('B').name, targets: ['target-B'] })
  const workerBodies: Array<Record<string, unknown>> = []
  const worker = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += String(chunk)
    if (raw) workerBodies.push(JSON.parse(raw))
    const spaces = [{ targetId: 'target-A', title: 'A', url: 'https://a.example' }, { targetId: 'target-B', title: 'B-secret', url: 'https://b.example/secret' }]
    const payload = req.url === '/api/spaces' ? { ok: true, spaces } : req.url === '/api/health' ? { workerOk: true, pid: process.pid, bootId: 'in-process-fixture-worker', profileDir: env.EGO_LINUX_PROFILE, capture: { targetId: 'target-B' } } : { ok: true, targetId: 'target-A', state: 'watching' }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload))
  })
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => worker.close(() => resolve())))
  mkdirSync(env.EGO_LINUX_STATE_DIR!, { recursive: true })
  writeFileSync(join(env.EGO_LINUX_STATE_DIR!, 'ego-cast.json'), JSON.stringify({ port: (worker.address() as { port: number }).port, pid: process.pid, bootId: 'in-process-fixture-worker', profileDir: env.EGO_LINUX_PROFILE }))
  const ctx = { subprocess: { spawn: spawns }, get: (name: string) => name === 'webServer' ? {
    register: (o: { path: string; handler: (req: unknown, res: unknown) => unknown }) => { routes.set(o.path, o.handler); return () => routes.delete(o.path) },
  } : name === 'connection' ? { requestRejection: (req: IncomingMessage) => req.headers['x-fixture-trust'] === 'yes' ? undefined : 403 } : undefined,
    effect: (fn: () => unknown) => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(() => { dispose() }) },
  }
  initCastServer(ctx as never, resolveConfig({ captureBackend: 'cdp' }), { onChange: () => () => {} } as never, null, undefined, undefined, host)
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const handler = routes.get(new URL(req.url!, 'http://fixture').pathname)
    if (!handler) { res.writeHead(404); res.end(); return }
    await handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const read = async (path: string, trusted = true) => fetch(base + path, { headers: trusted ? { 'x-fixture-trust': 'yes' } : { cookie: 'dsh-auth-forged=1' } })
  const post = async (path: string, body: object) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-trust': 'yes' }, body: JSON.stringify(body) })
  return { host, live, read, post, spawns, navigate, context, workerBodies, nextTurn }
}

describe('scoped HTTP host routes (loopback fixtures, no browser)', () => {
  it('keeps the Host trust fence ahead of scope handling and rejects missing or dead sessions', async () => {
    const h = await harness()
    expect((await h.read('/api/ego/spaces?sessionId=A', false)).status).toBe(403)
    expect((await h.read('/api/ego/spaces')).status).toBe(409)
    expect((await h.read('/api/ego/spaces?sessionId=not-live')).status).toBe(409)
    h.live.delete('A')
    expect((await h.read('/api/ego/spaces?sessionId=A')).status).toBe(409)
    expect(h.spawns).not.toHaveBeenCalled()
  })
  it('filters global worker spaces and refuses foreign target input/watch/close before the worker', async () => {
    const h = await harness()
    const spaces = await (await h.read('/api/ego/spaces?sessionId=A')).json()
    expect(spaces.spaces.map((x: { targetId: string }) => x.targetId)).toEqual(['target-A'])
    expect(spaces.sessionId).toBe('A')
    expect(JSON.stringify(spaces)).not.toContain('B-secret')
    for (const path of ['input', 'close', 'watch/start', 'watch/switch']) {
      const res = await h.post('/api/ego/' + path, { sessionId: 'A', requestId: path, targetId: 'target-B', clientId: 'same' })
      expect((await res.json()).code).toBe('target-not-owned')
    }
    expect(h.workerBodies).toHaveLength(0)
    expect(h.spawns).not.toHaveBeenCalled()
  })
  it('requires a request id, explicit human epoch, and keeps Agent and UI input under one lease', async () => {
    const h = await harness()
    expect((await h.post('/api/ego/input', { sessionId: 'A', targetId: 'target-A' })).status).toBe(409)
    expect((await h.post('/api/ego/input', { sessionId: 'A', requestId: 'input', targetId: 'target-A' })).status).toBe(409)
    const human = await (await h.post('/api/ego/control/takeover', { sessionId: 'A', requestId: 'takeover' })).json()
    expect(human.control.state).toBe('human')
    expect((await h.post('/api/ego/input', { sessionId: 'A', requestId: 'input-ok', targetId: 'target-A', leaseEpoch: human.control.leaseEpoch, inputSeq: 1, type: 'click', x: 4, y: 8 })).status).toBe(200)
    await expect(h.host.control.runAgent('A', undefined, async () => {})).rejects.toThrow('agent-control-blocked')
    const released = await (await h.post('/api/ego/control/release', { sessionId: 'A', requestId: 'continue', leaseEpoch: human.control.leaseEpoch })).json()
    expect(released.control.state).toBe('paused')
    expect((await (await h.post('/api/ego/control/arm', { sessionId: 'A', requestId: 'unsafe-arm', leaseEpoch: released.control.leaseEpoch })).json()).code).toBe('continuation-gate-required')
    const prepared = await (await h.post('/api/ego/control/prepare-continue', { sessionId: 'A', requestId: 'prepare', leaseEpoch: released.control.leaseEpoch })).json()
    h.nextTurn.push({ id: 'durable-new-user-message', source: { kind: 'user' }, content: [{ type: 'text', text: prepared.continuation.marker }] })
    const armed = await (await h.post('/api/ego/control/commit-continue', { sessionId: 'A', requestId: 'commit', continuationId: prepared.continuation.continuationId, leaseEpoch: prepared.continuation.leaseEpoch })).json()
    expect(armed.control.state).toBe('armed')
    const rollback = await (await h.post('/api/ego/control/release', { sessionId: 'A', requestId: 'continue', leaseEpoch: armed.control.leaseEpoch })).json()
    expect(rollback.control.state).toBe('paused')
  })
  it('deduplicates navigation and supplies scoped context with explicit metadata', async () => {
    const h = await harness(), body = { sessionId: 'A', requestId: 'url-intent', url: 'https://example.org' }
    const [a, b] = await Promise.all([h.post('/api/ego/navigate', body), h.post('/api/ego/navigate', body)])
    expect(a.status).toBe(200); expect(b.status).toBe(200)
    expect(h.navigate).toHaveBeenCalledTimes(1)
    const data = await (await h.post('/api/ego/context', { sessionId: 'A', requestId: 'read-page' })).json()
    expect(data.context).toMatchObject({ sessionId: 'A', hostGeneration: h.host.scopes.generation, targetId: 'target-A', text: 'Owned context' })
  })
  it('rejects unscoped streams and keeps profile/global/native-window routes explicitly disabled', async () => {
    const h = await harness()
    expect((await h.read('/api/ego/stream?sessionId=A')).status).toBe(409)
    expect((await h.read('/api/ego/stream?sessionId=A&targetId=target-B')).status).toBe(409)
    for (const path of ['raise', 'login-import', 'flush']) expect((await h.post('/api/ego/' + path, { sessionId: 'A', requestId: path })).status).toBe(409)
    expect((await h.read('/api/ego/video?sessionId=A')).status).toBe(409)
    expect(h.workerBodies).toHaveLength(0)
  })
  it('rejects stale host generations and foreign selected context/navigation targets', async () => {
    const h = await harness()
    expect((await h.read('/api/ego/control/status?sessionId=A&hostGeneration=old-host')).status).toBe(409)
    for (const path of ['context', 'navigate']) {
      const res = await h.post('/api/ego/' + path, { sessionId: 'A', requestId: path, targetId: 'target-B', url: 'https://example.org' })
      expect((await res.json()).code).toBe('target-not-owned')
    }
    expect(h.navigate).not.toHaveBeenCalled(); expect(h.context).not.toHaveBeenCalled()
  })
  it('namespaces watch clients, so the same UI client id cannot stop another session watch', async () => {
    const h = await harness()
    await h.post('/api/ego/watch/start', { sessionId: 'A', requestId: 'watch-A', targetId: 'target-A', clientId: 'same' })
    await h.post('/api/ego/watch/stop', { sessionId: 'B', requestId: 'stop-B', clientId: 'same' })
    expect(h.workerBodies[0]!.clientId).not.toBe(h.workerBodies[1]!.clientId)
  })
  it('events-only stream does not start capture and only signals its own session', async () => {
    const h = await harness(), abort = new AbortController()
    const res = await h.read('/api/ego/stream?sessionId=A&eventsOnly=1')
    const reader = res.body!.getReader()
    await reader.read()
    markEgoToolCall('B', h.host.scopes.generation); markEgoToolCall('A', h.host.scopes.generation)
    const output = new TextDecoder().decode((await reader.read()).value)
    expect(output).toContain('"sessionId":"A"')
    expect(output).not.toContain('"sessionId":"B"')
    expect(h.spawns).not.toHaveBeenCalled()
    await reader.cancel(); abort.abort()
  })
  it('one metadata stream watches only validated live sessions of this host and contains no page data', async () => {
    const h = await harness()
    expect((await h.read('/api/ego/tool-events?sessionIds=' + encodeURIComponent(JSON.stringify(['A', 'not-live'])))).status).toBe(409)
    const res = await h.read('/api/ego/tool-events?sessionIds=' + encodeURIComponent(JSON.stringify(['A', 'B'])))
    const reader = res.body!.getReader(); await reader.read()
    markEgoToolCall('A', 'other-host'); markEgoToolCall('B', h.host.scopes.generation)
    const output = new TextDecoder().decode((await reader.read()).value)
    expect(output).toContain('"sessionId":"B"')
    expect(output).toContain(h.host.scopes.generation)
    for (const field of ['targetId', 'url', 'frame', 'text', 'title']) expect(output).not.toContain(`"${field}"`)
    expect(h.spawns).not.toHaveBeenCalled()
    await reader.cancel()
  })
  it('includes current-run metadata baseline and stops replaying it after a public activity boundary', async () => {
    const h = await harness()
    markEgoToolCall('A', h.host.scopes.generation)
    const path = '/api/ego/tool-events?sessionIds=' + encodeURIComponent(JSON.stringify(['A']))
    const first = await h.read(path), reader = first.body!.getReader()
    const initial = new TextDecoder().decode((await reader.read()).value)
    expect(initial).toContain('"count":1'); expect(initial).toContain('"sessionId":"A"')
    await reader.cancel()
    resetEgoToolCounts('A', h.host.scopes.generation)
    const next = await h.read(path), resetReader = next.body!.getReader()
    expect(new TextDecoder().decode((await resetReader.read()).value)).toBe(':ok\n\n')
    await resetReader.cancel(); expect(h.spawns).not.toHaveBeenCalled()
  })
  it('blocks release until held target input is drained without resuming Agent tools', async () => {
    const h = await harness()
    const human = await (await h.post('/api/ego/control/takeover', { sessionId: 'A', requestId: 'take' })).json()
    const body = { sessionId: 'A', targetId: 'target-A', leaseEpoch: human.control.leaseEpoch, key: 'Shift', code: 'ShiftLeft' }
    expect((await h.post('/api/ego/input', { ...body, requestId: 'down', inputSeq: 1, type: 'keyDown' })).status).toBe(200)
    expect((await (await h.post('/api/ego/control/release', { ...body, requestId: 'release-before-drain' })).json()).code).toBe('human-input-held')
    expect((await h.post('/api/ego/input', { ...body, requestId: 'up', inputSeq: 5, type: 'keyUp' })).status).toBe(200)
    const released = await (await h.post('/api/ego/control/release', { ...body, requestId: 'release-after-drain' })).json()
    expect(released.control.state).toBe('paused')
  })
})

describe('per-event stream fences', () => {
  it('drops foreign frames, unknown events, untracked popups, and stale membership', () => {
    const scopes = new SessionSpaceRegistry(), binding = scopes.bind('A')
    scopes.record('A', { name: binding.name, targets: ['owned'] })
    const host = { scopes, validateSession: () => 'A' } as unknown as ScopedBrowserHost
    const frame = (id: string) => `event: frame\ndata: ${JSON.stringify({ targetId: id, data: 'jpeg-fixture' })}`
    expect(filterScopedSse(frame('foreign'), host, 'A', 'owned')).toBe('')
    expect(filterScopedSse(frame('popup'), host, 'A', 'owned')).toBe('')
    expect(filterScopedSse('event: download\ndata: {"path":"private"}', host, 'A', 'owned')).toBe('')
    expect(filterScopedSse(frame('owned'), host, 'A', 'owned')).toContain('"sessionId":"A"')
    scopes.forgetTarget('A', 'owned')
    expect(filterScopedSse(frame('owned'), host, 'A', 'owned')).toBe('')
  })
})
