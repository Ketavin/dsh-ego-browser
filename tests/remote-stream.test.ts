// Remote stream bounds: per-frame bytes, frame frequency, concurrency, JWT
// expiry deadlines, backpressure and cleanup. All time is either injected
// (pure limiter) or short real waits on owned loopback servers.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { ScopeError, SessionSpaceRegistry } from '../src/session-spaces.ts'
import {
  acquireRemoteStreamTicket, activeRemoteStreams, createRemoteFrameLimiter,
  REMOTE_FRAME_WINDOW_MS, REMOTE_MAX_FRAMES_PER_WINDOW, REMOTE_MAX_FRAME_BYTES, REMOTE_MAX_STREAMS,
  proxyWorkerStream, type RemoteStreamTicket,
} from '../src/cast-server.ts'
import type { ScopedBrowserHost } from '../src/types.ts'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

function scopedHost() {
  const scopes = new SessionSpaceRegistry()
  scopes.bind('A')
  scopes.record('A', { name: scopes.require('A').name, targets: ['target-A'] })
  const host: ScopedBrowserHost = { scopes, control: null as never,
    validateSession(id) {
      if (id !== 'A') throw new ScopeError('session-not-live')
      return id
    }, navigate: async () => ({}), context: async () => ({}) }
  return host
}

describe('createRemoteFrameLimiter (injected clock)', () => {
  it('drops oversized frames and counts violations', () => {
    const limiter = createRemoteFrameLimiter({ maxFrameBytes: 64, windowMs: 1000, maxFramesPerWindow: 100, maxViolations: 2 })
    expect(limiter.allow('event: frame\ndata: small\n\n')).toBe(true)
    expect(limiter.allow(`event: frame\ndata: ${'0123456789'.repeat(10)}\n\n`)).toBe(false)
    expect(limiter.allow(`event: frame\ndata: ${'0123456789'.repeat(10)}\n\n`)).toBe(false)
    expect(limiter.exhausted()).toBe(false)
    expect(limiter.allow(`event: frame\ndata: ${'0123456789'.repeat(10)}\n\n`)).toBe(false)
    expect(limiter.exhausted()).toBe(true)
  })

  it('bounds frame frequency inside the sliding window and frees it after', () => {
    let now = 0
    const limiter = createRemoteFrameLimiter({ maxFrameBytes: 1000, windowMs: REMOTE_FRAME_WINDOW_MS, maxFramesPerWindow: 3, maxViolations: 100 }, () => now)
    const frame = 'event: frame\ndata: f\n\n'
    expect(limiter.allow(frame)).toBe(true)
    expect(limiter.allow(frame)).toBe(true)
    expect(limiter.allow(frame)).toBe(true)
    expect(limiter.allow(frame)).toBe(false) // 4th inside the window
    now += REMOTE_FRAME_WINDOW_MS + 1
    expect(limiter.allow(frame)).toBe(true) // window slid
  })

  it('uses the production defaults: sustained 30fps headroom within 10s', () => {
    let now = 0
    const limiter = createRemoteFrameLimiter(undefined, () => now)
    const frame = 'event: frame\ndata: f\n\n'
    let forwarded = 0
    for (let i = 0; i < REMOTE_MAX_FRAMES_PER_WINDOW + 10; i++) {
      now += Math.floor(REMOTE_FRAME_WINDOW_MS / 30) // 30fps cadence
      if (limiter.allow(frame)) forwarded += 1
    }
    expect(forwarded).toBeGreaterThanOrEqual(REMOTE_MAX_FRAMES_PER_WINDOW - 5)
    expect(limiter.exhausted()).toBe(false)
  })
})

describe('acquireRemoteStreamTicket', () => {
  it('refuses already-expired grants and caps the deadline by the max window', () => {
    const now = Date.now()
    expect(acquireRemoteStreamTicket(now - 1000, now)).toBeNull()
    expect(acquireRemoteStreamTicket(Number.NaN, now)).toBeNull()
    const short = acquireRemoteStreamTicket(now + 1000, now)!
    expect(short.deadlineAtMs).toBe(now + 1000)
    const long = acquireRemoteStreamTicket(now + 60 * 60_000, now)!
    expect(long.deadlineAtMs).toBe(now + 10 * 60_000) // REMOTE_MAX_STREAM_MS cap
    // Module state is shared: return both tickets through real stream teardown
    // so later capacity assertions see a clean counter.
    const host = scopedHost()
    for (const ticket of [short, long]) proxyWorkerStream(-1, fakeResponse() as never, '/api/stream', { host, sessionId: 'A', remote: ticket })()
  })

  it('enforces stream capacity and releases slots through stream teardown', async () => {
    const host = scopedHost()
    const base = activeRemoteStreams()
    const stops: Array<() => void> = []
    for (let i = 0; i < REMOTE_MAX_STREAMS; i++) {
      const ticket = acquireRemoteStreamTicket(Date.now() + 60_000)!
      const res = fakeResponse()
      stops.push(proxyWorkerStream(-1, res as never, '/api/stream', { host, sessionId: 'A', remote: ticket }))
    }
    expect(activeRemoteStreams()).toBe(base + REMOTE_MAX_STREAMS)
    expect(acquireRemoteStreamTicket(Date.now() + 60_000)).toBeNull()
    for (const stop of stops) stop()
    expect(activeRemoteStreams()).toBe(base)
  })
})

/** ServerResponse double on a REAL EventEmitter so listener bookkeeping
 * (once/removeListener/listenerCount) behaves exactly like the production
 * downstream and teardown can be asserted on it. */
class FakeResponse extends EventEmitter {
  written: string[] = []
  headers: Record<string, unknown> = {}
  ended = false
  writeHead(_status: number, headers: Record<string, unknown>) { Object.assign(this.headers, headers) }
  write(chunk: string) { this.written.push(chunk); return true }
  end() {
    if (this.ended) return
    this.ended = true
    this.emit('close')
  }
}

function fakeResponse() {
  return new FakeResponse()
}

/** An owned loopback upstream that pushes SSE blocks on demand. */
async function upstreamServer() {
  const pushes: Array<(block: string) => void> = []
  const opened: Array<() => void> = []
  const closed: Array<() => void> = []
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(':upstream\n\n')
    opened.push(() => undefined)
    pushes.push(block => res.write(block))
    res.on('close', () => closed.push(() => undefined))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) })
  return {
    port: (server.address() as { port: number }).port,
    push: (block: string) => pushes.at(-1)?.(block),
    closedCount: () => closed.length,
  }
}

const frame = (targetId: string, data: string) => `event: frame\ndata: ${JSON.stringify({ targetId, data })}\n\n`

describe('proxyWorkerStream remote bounds (owned upstream servers)', () => {
  it('forwards owned frames, drops foreign targets, and drops an oversized frame without dying', async () => {
    const host = scopedHost()
    const upstream = await upstreamServer()
    const res = fakeResponse()
    const stop = proxyWorkerStream(upstream.port, res as never, '/api/stream', { host, sessionId: 'A', targetId: 'target-A', remote: acquireRemoteStreamTicket(Date.now() + 60_000)! })
    await tick()
    upstream.push(frame('target-A', 'good-1'))
    upstream.push(frame('target-B', 'foreign')) // foreign target — filtered
    upstream.push(frame('target-A', 'x'.repeat(REMOTE_MAX_FRAME_BYTES))) // oversized — dropped
    upstream.push(frame('target-A', 'good-2'))
    await tick()
    expect(res.written.join('')).toContain('good-1')
    expect(res.written.join('')).toContain('good-2')
    expect(res.written.join('')).not.toContain('foreign')
    expect(res.ended).toBe(false)
    stop()
    expect(res.ended).toBe(true)
  })

  it('terminates the stream once the violation budget is exhausted by a frame flood', async () => {
    const host = scopedHost()
    const upstream = await upstreamServer()
    const res = fakeResponse()
    const base = activeRemoteStreams()
    proxyWorkerStream(upstream.port, res as never, '/api/stream', { host, sessionId: 'A', targetId: 'target-A', remote: acquireRemoteStreamTicket(Date.now() + 60_000)! })
    await tick()
    // 30fps would be ~360/10s; a flood well beyond that burns the violation
    // budget and the stream is cut instead of forwarding unbounded frames.
    for (let i = 0; i < REMOTE_MAX_FRAMES_PER_WINDOW + 80; i++) upstream.push(frame('target-A', 'f'))
    await tick(100)
    expect(res.ended).toBe(true)
    const forwarded = res.written.join('').split('event: frame').length - 1
    expect(forwarded).toBeLessThanOrEqual(REMOTE_MAX_FRAMES_PER_WINDOW)
    expect(activeRemoteStreams()).toBe(base)
  })

  it('ends the remote stream at the JWT-expiry deadline and releases the slot', async () => {
    const host = scopedHost()
    const upstream = await upstreamServer()
    const res = fakeResponse()
    const base = activeRemoteStreams()
    const stop = proxyWorkerStream(upstream.port, res as never, '/api/stream', { host, sessionId: 'A', targetId: 'target-A', remote: acquireRemoteStreamTicket(Date.now() + 250)! })
    expect(activeRemoteStreams()).toBe(base + 1)
    await tick() // let the upstream connection register its writer
    upstream.push(frame('target-A', 'before-deadline'))
    await tick()
    expect(res.written.join('')).toContain('before-deadline')
    await new Promise(resolve => setTimeout(resolve, 450))
    expect(res.ended).toBe(true)
    expect(activeRemoteStreams()).toBe(base)
    stop() // idempotent
    expect(activeRemoteStreams()).toBe(base)
  })

  it('destroys the upstream at the deadline even when the downstream never flushes or closes', async () => {
    const host = scopedHost()
    const upstream = await upstreamServer()
    const base = activeRemoteStreams()
    // A blocked downstream: writes return false and end() emits no close — a
    // res.end() alone must not be the only cleanup. Only the deadline
    // teardown actively destroying the worker request closes the upstream.
    const res = new BlockedResponse()
    proxyWorkerStream(upstream.port, res as never, '/api/stream', { host, sessionId: 'A', targetId: 'target-A', remote: acquireRemoteStreamTicket(Date.now() + 250)! })
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(res.ended).toBe(true)
    expect(activeRemoteStreams()).toBe(base)
    expect(upstream.closedCount(), 'expiry must destroy the worker connection').toBe(1)
  })

  it('detaches its own drain/close subscriptions at the deadline (no downstream close)', async () => {
    const host = scopedHost()
    const upstream = await upstreamServer()
    const base = activeRemoteStreams()
    const res = new BlockedResponse()
    proxyWorkerStream(upstream.port, res as never, '/api/stream', { host, sessionId: 'A', targetId: 'target-A', remote: acquireRemoteStreamTicket(Date.now() + 300)! })
    await tick() // let the upstream connection register its writer
    upstream.push(frame('target-A', 'blocked')) // write()=false installs the drain
    await tick(80)
    expect(res.listenerCount('drain'), 'blocked frame must hold exactly our drain subscription').toBe(1)
    expect(res.listenerCount('close')).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 450)) // deadline passes
    expect(res.ended).toBe(true)
    expect(activeRemoteStreams()).toBe(base)
    expect(res.listenerCount('drain'), 'ended stream must not retain the upstream via drain').toBe(0)
    expect(res.listenerCount('close'), 'ended stream must release its close listener too').toBe(0)
  })

  it('detaches its own drain/close subscriptions immediately on explicit stop', async () => {
    const host = scopedHost()
    const upstream = await upstreamServer()
    const res = new BlockedResponse()
    const stop = proxyWorkerStream(upstream.port, res as never, '/api/stream', { host, sessionId: 'A', targetId: 'target-A', remote: acquireRemoteStreamTicket(Date.now() + 60_000)! })
    await tick() // let the upstream connection register its writer
    upstream.push(frame('target-A', 'blocked'))
    await tick(80) // drain installed while blocked
    expect(res.listenerCount('drain')).toBe(1)
    stop()
    expect(res.ended).toBe(true)
    expect(res.listenerCount('drain')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('detaches the quiet-stream close listener when stopped', async () => {
    const host = scopedHost()
    const res = fakeResponse()
    const base = activeRemoteStreams()
    const stop = proxyWorkerStream(-1, res as never, '/api/stream', { host, sessionId: 'A', remote: acquireRemoteStreamTicket(Date.now() + 60_000)! })
    expect(res.listenerCount('close')).toBe(1)
    stop()
    expect(res.ended).toBe(true)
    expect(res.listenerCount('close')).toBe(0)
    expect(activeRemoteStreams()).toBe(base)
  })

  it('enforces backpressure: a full downstream pauses the upstream until drain', async () => {
    const host = scopedHost()
    const upstream = await upstreamServer()
    const res = fakeResponse()
    let writable = false // downstream buffer full: every write returns false
    res.write = (chunk: string) => { res.written.push(chunk); return writable }
    const stop = proxyWorkerStream(upstream.port, res as never, '/api/stream', { host, sessionId: 'A', targetId: 'target-A', remote: acquireRemoteStreamTicket(Date.now() + 5_000)! })
    await tick()
    upstream.push(frame('target-A', 'one'))
    await tick()
    expect(res.written.join('')).toContain('one') // buffered locally, upstream paused
    writable = true
    res.emit('drain')
    upstream.push(frame('target-A', 'two'))
    await tick()
    expect(res.written.join('')).toContain('two') // resumed after drain
    stop()
  })

  it('destroys the upstream when malformed data overflows the pending buffer', async () => {
    const host = scopedHost()
    const upstream = await upstreamServer()
    const res = fakeResponse()
    const base = activeRemoteStreams()
    proxyWorkerStream(upstream.port, res as never, '/api/stream', { host, sessionId: 'A', targetId: 'target-A', remote: acquireRemoteStreamTicket(Date.now() + 60_000)! })
    await tick()
    // 9MB with no blank line: never a complete block, pending grows unbounded
    // unless the cap destroys the connection.
    upstream.push(`event: frame\ndata: ${'x'.repeat(9 * 1024 * 1024)}`)
    await tick(150)
    expect(res.ended).toBe(true)
    expect(activeRemoteStreams()).toBe(base)
    expect(res.written.join('')).not.toContain('xxxxx') // nothing leaked through
  })

  it('releases the remote slot when the downstream closes mid-stream', async () => {
    const host = scopedHost()
    const upstream = await upstreamServer()
    const res = fakeResponse()
    const base = activeRemoteStreams()
    proxyWorkerStream(upstream.port, res as never, '/api/stream', { host, sessionId: 'A', targetId: 'target-A', remote: acquireRemoteStreamTicket(Date.now() + 60_000)! })
    await tick()
    expect(activeRemoteStreams()).toBe(base + 1)
    res.emit('close')
    await tick(100)
    expect(activeRemoteStreams()).toBe(base)
  })
})

/** A blocked downstream that never flushes or closes: write()=false and
 * end() marks ended without emitting close — only active teardown counts. */
class BlockedResponse extends EventEmitter {
  ended = false
  writeHead() { /* headers ignored */ }
  write() { return false }
  end() { this.ended = true }
}

function tick(ms = 30): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
