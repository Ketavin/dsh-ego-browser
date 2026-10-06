import { describe, expect, it, vi } from 'vitest'
import { browserCoordinates, createConversationBridge, createInputDispatcher, createScopedTransport,
  DRAFT_TEXT_LIMIT, hostErrorCode, pagePrompt, releaseHumanOnDispose, safePageUrl, scopedRoute,
  validatePageContext, type JsonPayload } from '../src/client/rc2-bridge.ts'
import { frameSource, subscribeAutoOpen, validTargets } from '../src/client/rc2-client.ts'
const scope = { sessionId: 'session-a' }
const context = { ...scope, hostGeneration: 'host-1', targetId: 'owned-a', url: 'https://example.com/path?code=secret&state=hidden#token',
  title: 'Example', text: 'Visible text; cookie=session-secret; https://other.test/read?access_token=hidden' }
const response = (body: JsonPayload, status = 200) => new Response(JSON.stringify(body), { status })

describe('scoped rc.2 transport', () => {
  it('captures GET scope and overrides attempted body scope widening', async () => {
    const send = vi.fn(async (_path: string, _options: RequestInit) => response({ ok: true, sessionId: 'session-a' }))
    const mutable = { ...scope }, transport = createScopedTransport(mutable, send as typeof fetch)
    mutable.sessionId = 'session-b'
    await transport.get('/api/ego/spaces')
    await transport.post('/api/ego/input', { sessionId: 'session-b', requestId: 'req-1' })
    expect(send.mock.calls[0][0]).toBe('/api/ego/spaces?sessionId=session-a')
    expect(JSON.parse(send.mock.calls[1][1].body as string)).toMatchObject({ sessionId: 'session-a', requestId: 'req-1' })
  })
  it('rejects unsafe route construction and missing scope', () => {
    expect(() => scopedRoute('https://external.test', scope)).toThrow('invalid-route')
    expect(() => scopedRoute('/api/ego/spaces?sessionId=other', scope)).toThrow('invalid-route')
    expect(() => scopedRoute('/api/ego/spaces', { sessionId: '' })).toThrow('scope-required')
  })
  it('refuses mismatched scope and hides arbitrary worker exception text', async () => {
    let body: JsonPayload = { ok: true, sessionId: 'session-b' }
    const transport = createScopedTransport(scope, (async () => response(body)) as typeof fetch)
    await expect(transport.get('/api/ego/spaces')).rejects.toThrow('scope-mismatch')
    body = { ok: false, error: 'secret-worker-url', code: 'target-unowned' }
    await expect(transport.post('/api/ego/input')).rejects.toThrow('target-unowned')
  })
})

function fixture() {
  const calls: string[] = []
  const prompt = vi.fn(async (_content: { type: 'text'; text: string }[], _mode: 'queue' | 'steer') => ({ ok: true }))
  const cancel = vi.fn(async () => ({ ok: true }))
  const send = vi.fn(async (path: string, options: RequestInit) => {
    calls.push(path)
    const body = JSON.parse(options.body as string)
    if (path === '/api/ego/context') return response({ ok: true, context })
    if (path === '/api/ego/control/release') return response({ ok: true, ...scope, control: { state: 'paused', leaseEpoch: body.leaseEpoch + 1 } })
    if (path === '/api/ego/control/prepare-continue') return response({ ok: true, ...scope,
      continuation: { continuationId: 'intent-1', leaseEpoch: 5, hostGeneration: 'host-1', marker: '[ego-intent:1]' } })
    return response({ ok: true, ...scope, hostGeneration: 'host-1', control: { state: 'human', leaseEpoch: 4 } })
  })
  const sessions = { binding: (id: string) => id === scope.sessionId ? { sessionId: id, session: { sessionId: id, prompt, cancel } } : undefined }
  const bridge = createConversationBridge(sessions, createScopedTransport(scope, send as typeof fetch))
  return { bridge, calls, prompt, cancel, send }
}

describe('explicit Conversation bridge', () => {
  it('submits bounded sanitized context to the original session with explicit mode', async () => {
    const { bridge, prompt } = fixture()
    await expect(bridge.submit('read-1', 'steer')).resolves.toEqual({ accepted: true })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][1]).toBe('steer')
    const text = prompt.mock.calls[0][0][0].text
    expect(text).toContain('https://example.com/path')
    expect(text).not.toMatch(/session-secret|code=secret|state=hidden|access_token=hidden/)
    expect(text).toContain('仅作为资料')
  })
  it('deduplicates one submission identity, including refused or ambiguous receipts', async () => {
    const { bridge, prompt } = fixture()
    const one = bridge.submit('read-1', 'queue')
    expect(bridge.submit('read-1', 'queue')).toBe(one)
    await one
    prompt.mockResolvedValueOnce({ ok: false })
    const refused = bridge.submit('read-2', 'queue')
    await expect(refused).rejects.toThrow('conversation-admission-unconfirmed')
    expect(bridge.submit('read-2', 'queue')).toBe(refused)
    expect(prompt).toHaveBeenCalledTimes(2)
  })
  it('holds Agent maintenance, admits the exact intent, then commits browser permission', async () => {
    const { bridge, calls, prompt } = fixture()
    await bridge.submit('continue-1', 'queue', { leaseEpoch: 4, hostGeneration: 'host-1' })
    expect(calls).toEqual(['/api/ego/context', '/api/ego/control/prepare-continue', '/api/ego/control/commit-continue'])
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0][1]).toEqual({ type: 'text', text: '[ego-intent:1]' })
  })
  it('aborts prepared continuation after unconfirmed admission without arming', async () => {
    const { bridge, prompt, send } = fixture()
    prompt.mockResolvedValueOnce({ ok: false })
    await expect(bridge.submit('continue-1', 'queue', { leaseEpoch: 4, hostGeneration: 'host-1' })).rejects.toThrow('conversation-admission-unconfirmed')
    expect(send.mock.calls.at(-1)![0]).toBe('/api/ego/control/abort-continue')
    expect(JSON.parse(send.mock.calls.at(-1)![1].body as string)).toMatchObject({ leaseEpoch: 5, hostGeneration: 'host-1', continuationId: 'intent-1' })
  })
  it('allows a new safe attempt after a refusal before prompt admission', async () => {
    const { bridge, send, prompt } = fixture()
    send.mockImplementationOnce(async () => response({ ok: false, code: 'control-busy' }, 409))
    await expect(bridge.submit('read-1', 'queue')).rejects.toThrow('control-busy')
    await expect(bridge.submit('read-1', 'queue')).resolves.toEqual({ accepted: true })
    expect(prompt).toHaveBeenCalledTimes(1)
  })
  it('cancels the conversation only on a verified fresh interruption, never an unproven pause denial', async () => {
    const { bridge, cancel, send } = fixture()
    // An already unsafe-paused lease denial carries no proof THIS request
    // interrupted anything: no conversation may be cancelled on it alone.
    send.mockImplementationOnce(async () => response({ ok: false, code: 'cancellation-unverified' }, 409))
    await expect(bridge.takeOver('denied-1')).rejects.toThrow('cancellation-unverified')
    expect(cancel).not.toHaveBeenCalled()
    // The explicit fresh-interruption receipt — and only it (plus a genuine
    // takeover timeout) — justifies stopping the whole Conversation.
    send.mockImplementationOnce(async () => response({ ok: false, code: 'takeover-interrupted-run' }, 409))
    await expect(bridge.takeOver('takeover-1')).rejects.toThrow('takeover-interrupted-run')
    expect(cancel).toHaveBeenCalledTimes(1)
    send.mockImplementationOnce(async () => response({ ok: false, code: 'takeover-timeout' }, 409))
    await expect(bridge.takeOver('takeover-2')).rejects.toThrow('takeover-timeout')
    expect(cancel).toHaveBeenCalledTimes(2)
  })
  it('releases a granted human lease when whole Conversation cancellation is refused', async () => {
    const { bridge, cancel, calls } = fixture()
    cancel.mockResolvedValueOnce({ ok: false })
    await expect(bridge.takeOver('takeover-1')).rejects.toThrow('conversation-cancel-refused')
    expect(calls).toEqual(['/api/ego/control/takeover', '/api/ego/control/release'])
  })
  it('refuses context from another scope or without a valid target', () => {
    expect(() => validatePageContext({ context: { ...context, sessionId: 'session-b' } }, scope)).toThrow('invalid-page-context')
    expect(() => validatePageContext({ context: { ...context, targetId: '' } }, scope)).toThrow('invalid-page-context')
  })
  it('rejects a changed generation or a different owned target before prompt admission', async () => {
    const { bridge, prompt } = fixture()
    await expect(bridge.submit('read-1', 'queue', undefined, { targetId: 'owned-b', hostGeneration: 'host-1' })).rejects.toThrow('page-generation-changed')
    await expect(bridge.submit('read-2', 'queue', undefined, { targetId: 'owned-a', hostGeneration: 'old-host' })).rejects.toThrow('page-generation-changed')
    expect(prompt).not.toHaveBeenCalled()
  })
})

describe('cold background Session metadata auto-open', () => {
  function feed() {
    let reconcile!: () => void
    const snapshot = { ids: ['a', 'b', 'disk'], current: 'a', byId: { a: { running: true }, b: { running: true }, disk: { running: false } } }
    const binding = vi.fn(() => { throw new Error('histories-must-stay-cold') })
    const sessions = { list: { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { reconcile = fn; return () => {} } }, binding }
    const streams: { url: string; event?: (event: unknown) => void; close: ReturnType<typeof vi.fn> }[] = []
    const connect = (url: string) => {
      const source = { url, close: vi.fn(), event: undefined as ((event: unknown) => void) | undefined }
      streams.push(source)
      return { close: source.close, addEventListener: (_name: string, fn: any) => { source.event = fn } } as any
    }
    const sidebar = { isTabEnabled: vi.fn(() => true), openTab: vi.fn() }
    const dispose = subscribeAutoOpen(sessions, sidebar, connect)
    const event = (source: number, body: unknown) => streams[source].event!({ data: JSON.stringify(body) })
    return { snapshot, binding, streams, sidebar, dispose, reconcile: () => reconcile(), event }
  }
  it('opens a calling cold background session once without selecting or loading history', () => {
    const f = feed()
    expect(new URL(f.streams[0].url, 'http://fixture').searchParams.get('sessionIds')).toBe('["a","b"]')
    f.event(0, { sessionId: 'b', hostGeneration: 'host-1', count: 1 })
    f.event(0, { sessionId: 'b', hostGeneration: 'host-1', count: 2 })
    expect(f.sidebar.openTab).toHaveBeenCalledExactlyOnceWith({ type: 'ego-browser:watch' }, { sessionId: 'b' })
    expect(f.binding).not.toHaveBeenCalled(); f.dispose(); expect(f.streams[0].close).toHaveBeenCalledTimes(1)
  })
  it('rejects other scopes, disabled modes, stale sources and inactive rows', () => {
    const f = feed()
    f.event(0, { sessionId: 'disk', hostGeneration: 'host-1', count: 1 })
    f.sidebar.isTabEnabled.mockReturnValue(false)
    f.event(0, { sessionId: 'b', hostGeneration: 'host-1', count: 1 })
    f.sidebar.isTabEnabled.mockReturnValue(true)
    f.snapshot.byId.b.running = false; f.reconcile()
    f.event(0, { sessionId: 'a', hostGeneration: 'host-1', count: 1 })
    f.event(1, { sessionId: 'b', hostGeneration: 'host-1', count: 1 })
    expect(f.sidebar.openTab).not.toHaveBeenCalled(); f.dispose()
  })
})

describe('ordered human input and exact lease disposal', () => {
  const capture = { targetId: 'owned-a', hostGeneration: 'host-1', leaseEpoch: 4 }
  it('reports draft sends as sent, refused, unconfirmed or stale without ever losing the text', async () => {
    const replies: Response[] = []
    let networkFailure = false
    const transport = createScopedTransport(scope, (async () => {
      if (networkFailure) throw new TypeError('Failed to fetch')
      return replies.shift() ?? response({ ok: true })
    }) as typeof fetch)
    let current = true
    const dispatcher = createInputDispatcher(transport, leased => current && leased.leaseEpoch === capture.leaseEpoch)
    // A positive reply is delivery, not page acceptance — but it is 'sent'.
    await expect(dispatcher.submitText(capture, '中文输入')).resolves.toEqual({ state: 'sent' })
    replies.push(response({ ok: false, code: 'control-busy' }, 409))
    await expect(dispatcher.submitText(capture, '再次')).resolves.toEqual({ state: 'refused', code: 'control-busy' })
    // A host code that itself reports an unverified outcome is ambiguity.
    replies.push(response({ ok: false, code: 'input-outcome-unverified' }, 502))
    await expect(dispatcher.submitText(capture, '未证实时')).resolves.toEqual({ state: 'unconfirmed' })
    networkFailure = true
    await expect(dispatcher.submitText(capture, '第三次')).resolves.toEqual({ state: 'unconfirmed' })
    networkFailure = false
    // A lease/page that is no longer current drops the send before dispatch.
    current = false
    await expect(dispatcher.submitText(capture, '过期草稿')).resolves.toEqual({ state: 'stale' })
    current = true
    await expect(dispatcher.submitText(capture, '')).resolves.toEqual({ state: 'refused', code: 'draft-empty' })
    await expect(dispatcher.submitText(capture, 'x'.repeat(DRAFT_TEXT_LIMIT + 1))).resolves.toEqual({ state: 'refused', code: 'draft-too-long' })
    expect(hostErrorCode(new Error('lease-not-owned'))).toBe('lease-not-owned')
    expect(hostErrorCode(new TypeError('Failed to fetch'))).toBeUndefined()
  })
  it('orders a draft send behind earlier accepted input with the next input sequence', async () => {
    const bodies: JsonPayload[] = []
    const transport = createScopedTransport(scope, (async (_path, options) => {
      bodies.push(JSON.parse(options!.body as string)); return response({ ok: true })
    }) as typeof fetch)
    const dispatcher = createInputDispatcher(transport, () => true)
    dispatcher.enqueue(capture, 'keyDown', { key: 'Enter', code: 'Enter' })
    await expect(dispatcher.submitText(capture, '后续文字')).resolves.toEqual({ state: 'sent' })
    expect(bodies.map(body => body.type)).toEqual(['keyDown', 'insertText'])
    expect(bodies.map(body => body.inputSeq)).toEqual([1, 2])
    expect(bodies[1]).toMatchObject({ ...capture, text: '后续文字' })
  })
  it('assigns monotonic sequence numbers and drains accepted input before ups', async () => {
    const bodies: JsonPayload[] = []
    const transport = createScopedTransport(scope, (async (_path, options) => {
      bodies.push(JSON.parse(options!.body as string)); return response({ ok: true })
    }) as typeof fetch)
    const dispatcher = createInputDispatcher(transport, () => true)
    dispatcher.enqueue(capture, 'keyDown', { key: 'Control', code: 'ControlLeft' })
    dispatcher.enqueue(capture, 'insertText', { text: '末尾' })
    await dispatcher.flush()
    expect(bodies.map(body => body.type)).toEqual(['keyDown', 'insertText', 'keyUp'])
    expect(bodies.map(body => body.inputSeq)).toEqual([1, 2, 3])
    expect(bodies.every(body => body.hostGeneration === 'host-1' && body.leaseEpoch === 4)).toBe(true)
  })
  it('keeps ambiguous downs for captured-target cleanup and resets sequence for a new epoch', async () => {
    const bodies: JsonPayload[] = []
    const transport = createScopedTransport(scope, (async (_path, options) => {
      const body = JSON.parse(options!.body as string); bodies.push(body)
      if (bodies.length === 1) throw new Error('lost-response')
      return response({ ok: true })
    }) as typeof fetch)
    let current = true
    const dispatcher = createInputDispatcher(transport, () => current)
    dispatcher.enqueue(capture, 'mousePressed', { button: 'left', x: 4, y: 5, buttons: 1 })
    await dispatcher.drain(); current = false; await dispatcher.flush()
    expect(bodies[1]).toMatchObject({ ...capture, type: 'mouseReleased', inputSeq: 2, buttons: 0 })
    current = true
    dispatcher.enqueue({ ...capture, leaseEpoch: 8 }, 'insertText', { text: 'new' }); await dispatcher.drain()
    expect(bodies[2].inputSeq).toBe(1)
  })
  it('does not release a resumable lease after unconfirmed key cleanup', async () => {
    const send = vi.fn(async () => response({ ok: true }))
    await expect(releaseHumanOnDispose(createScopedTransport(scope, send as typeof fetch), capture,
      async () => { throw new Error('input-outcome-unverified') })).rejects.toThrow('input-outcome-unverified')
    expect(send).not.toHaveBeenCalled()
  })
  it('waits for drain and retries busy release with distinct identities and exact generation', async () => {
    const bodies: JsonPayload[] = []
    const order: string[] = []
    const transport = createScopedTransport(scope, (async (_path, options) => {
      order.push('release'); bodies.push(JSON.parse(options!.body as string))
      return bodies.length === 1 ? response({ ok: false, code: 'control-busy' }, 409) : response({ ok: true })
    }) as typeof fetch)
    await releaseHumanOnDispose(transport, capture, async () => { order.push('drain') }, async () => {})
    expect(order).toEqual(['drain', 'release', 'release'])
    expect(bodies.map(body => body.hostGeneration)).toEqual(['host-1', 'host-1'])
    expect(bodies[0].requestId).not.toBe(bodies[1].requestId)
  })
})

describe('bounded frame/page and IME', () => {
  it('strips credentials/query/fragment and bounds submitted visible text', () => {
    expect(safePageUrl('https://name:password@example.com/read?code=secret#hidden')).toBe('https://example.com/read')
    expect(safePageUrl('javascript:alert(1)')).toBe('')
    expect(pagePrompt({ ...context, text: 'x'.repeat(30000) }).length).toBeLessThan(13000)
  })
  it('accepts only bounded JPEG base64 and valid target rows', () => {
    expect(frameSource('/private/local.png')).toBeUndefined()
    expect(frameSource('data:text/html;base64,YQ==')).toBeUndefined()
    expect(frameSource('YQ==')).toBe('data:image/jpeg;base64,YQ==')
    expect(frameSource('A'.repeat(4_000_001))).toBeUndefined()
    expect(validTargets([{ targetId: 'a', url: 'https://example.test', title: 'a' }, { targetId: '' }])).toHaveLength(1)
  })
  it('maps contain-scaled frames and rejects letterbox or missing dimensions', () => {
    const rect = { left: 0, top: 0, width: 400, height: 400 }
    expect(browserCoordinates({ clientX: 200, clientY: 200 }, rect, { width: 800, height: 400 })).toEqual({ x: 400, y: 200 })
    expect(browserCoordinates({ clientX: 200, clientY: 50 }, rect, { width: 800, height: 400 })).toBeUndefined()
    expect(browserCoordinates({ clientX: 1, clientY: 1 }, rect, { width: 0, height: 0 })).toBeUndefined()
  })
})
