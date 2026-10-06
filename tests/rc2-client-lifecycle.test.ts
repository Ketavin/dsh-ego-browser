import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyRc2 } from '../src/client/rc2-client.ts'

// Use the existing Sidebar's single React installation; do not install a second
// copy or start a DSH server. All requests and EventSources stay in this fixture.
const requireEgo = createRequire(new URL('../package.json', import.meta.url))
const requireSidebar = createRequire(new URL('../../sidebar/package.json', import.meta.url))
const React = requireSidebar('react') as typeof import('react')
const { JSDOM } = requireEgo('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
type Root = { render(node: import('react').ReactNode): void; unmount(): void }
type Act = (operation: () => void | Promise<void>) => Promise<void>
type Payload = Record<string, unknown>
type RequestRecord = { path: string; method: string; sessionId: string; body: Payload; clientKey?: string }
type Tab = {
  component(props: { scope: { sessionId: string }; visible: boolean }): import('react').ReactNode
  onOpenUrl?(request: { url: string; requestId: string; scope: { sessionId: string } }): Promise<void>
}
type HostState = { generation: string; state: string; epoch: number; targetId: string; holder?: string }

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let settled = false
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return { promise, resolve(value: T) { if (!settled) { settled = true; resolvePromise(value) } }, get settled() { return settled } }
}
const json = (body: Payload, status = 200) => new Response(JSON.stringify(body), { status })

function harness() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://fixture.local/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('navigator', dom.window.navigator)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const nodeModule = requireEgo('node:module') as { _load(request: string, parent?: unknown, isMain?: boolean): unknown }
  const originalLoad = nodeModule._load
  // Vitest supplies a native module-local require to this client entry. Route
  // that peer to Sidebar's actual React without altering the entry or installing.
  vi.spyOn(nodeModule, '_load').mockImplementation((request, parent, isMain) => {
    if (request === 'react') return React
    return originalLoad.call(nodeModule, request, parent, isMain)
  })
  // ReactDOM must first load after the fixture DOM exists so it selects its DOM
  // event path, rather than its server/legacy input-event fallback.
  const { createRoot } = requireSidebar('react-dom/client') as { createRoot(container: Element): Root }
  const { act } = requireSidebar('react-dom/test-utils') as { act: Act }
  const requests: RequestRecord[] = []
  const states = new Map<string, HostState>([
    ['a', { generation: 'host-1', state: 'idle', epoch: 0, targetId: 'owned-a' }],
    ['b', { generation: 'host-1', state: 'idle', epoch: 0, targetId: 'owned-b' }],
  ])
  const control = (sessionId: string, requester?: string) => {
    const state = states.get(sessionId)!
    return { state: state.state, leaseEpoch: state.epoch, sessionId: state.state === 'human' ? sessionId : null,
      // The host answers only whether THIS requester holds the lease.
      ...(state.holder !== undefined && requester !== undefined ? { held: state.holder === requester } : {}) }
  }
  const receipt = (sessionId: string, requester?: string) => ({ ok: true, sessionId, hostGeneration: states.get(sessionId)!.generation, control: control(sessionId, requester) })
  const grants = new Map<string, { gate: ReturnType<typeof deferred<Response>>; epoch: number }>()
  let inputGate: { sessionId: string; gate: ReturnType<typeof deferred<Response>> } | undefined
  // One-shot channel faults: an authorization refusal (control status 401) and
  // a partial spaces failure are distinct from each other and from the lease.
  let authRefusals = 0
  let spacesFailures = 0
  let spacesDelayMs = 0
  let inputRefusal: { code: string; status: number } | undefined
  let inputNetworkFailures = 0
  // Whether the host would report its remote stream budget as exhausted.
  let remoteStreamsFull = false
  const fetchMock = vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://fixture.local')
    const body = options.body ? JSON.parse(String(options.body)) as Payload : {}
    const sessionId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    const state = states.get(sessionId)
    if (!state) throw new Error(`unexpected fixture scope: ${sessionId}`)
    const requester = typeof body.clientId === 'string' ? body.clientId : url.searchParams.get('clientId') ?? undefined
    requests.push({ path: url.pathname, method: options.method ?? 'GET', sessionId, body, clientKey: requester })
    if (url.pathname === '/api/ego/control/status') {
      if (authRefusals > 0) { authRefusals--; return json({ ok: false, code: 'remote-assertion-invalid' }, 401) }
      return json(receipt(sessionId, requester))
    }
    if (url.pathname === '/api/ego/navigate') return json({ ok: true, sessionId, hostGeneration: state.generation })
    if (url.pathname === '/api/ego/context') {
      // A valid scoped page context for explicit read/continue submissions.
      return json({ ok: true, sessionId, hostGeneration: state.generation,
        targetId: typeof body.targetId === 'string' ? body.targetId : state.targetId,
        url: `https://example.test/${sessionId}`, title: `Page ${sessionId}`, text: `page text ${sessionId}` })
    }
    if (url.pathname === '/api/ego/watch/status') return json({ ok: true, sessionId, hostGeneration: state.generation, frameRelay: true, remoteStreamFull: remoteStreamsFull })
    if (url.pathname === '/api/ego/spaces') {
      // The answer is stamped with the host generation observed at REQUEST
      // time, so a delayed reply can model a genuinely obsolete completion.
      const generationAtRequest = state.generation
      if (spacesDelayMs) await new Promise(resolve => setTimeout(resolve, spacesDelayMs))
      if (spacesFailures > 0) { spacesFailures--; return json({ ok: false, code: 'browser-request-502' }, 502) }
      return json({ ok: true, sessionId, hostGeneration: generationAtRequest, control: control(sessionId, requester), spaces: [
        { targetId: state.targetId, title: `Page ${sessionId}`, url: `https://example.test/${sessionId}` },
        { targetId: `${state.targetId}2`, title: `Page ${sessionId}2`, url: `https://example.test/${sessionId}/2` },
      ] })
    }
    if (url.pathname === '/api/ego/control/takeover') {
      const grant = grants.get(sessionId)
      if (!grant) throw new Error('takeover must be deliberately deferred by the test')
      return grant.gate.promise
    }
    if (url.pathname === '/api/ego/input') {
      // Like the real host, input answers only for the holding device and the
      // exact live epoch.
      if (state.holder !== undefined && requester !== state.holder) {
        return json({ ok: false, code: 'lease-holder-mismatch' }, 409)
      }
      if (body.leaseEpoch !== state.epoch) return json({ ok: false, code: 'lease-not-owned' }, 409)
      if (inputNetworkFailures > 0) { inputNetworkFailures--; throw new TypeError('Failed to fetch') }
      if (inputRefusal !== undefined) { const refusal = inputRefusal; inputRefusal = undefined; return json({ ok: false, code: refusal.code }, refusal.status) }
      if ((body.type === 'keyDown' || body.type === 'insertText') && inputGate?.sessionId === sessionId) return inputGate.gate.promise
      return json({ ok: true, sessionId, hostGeneration: state.generation })
    }
    if (url.pathname === '/api/ego/control/release') {
      if (body.hostGeneration !== state.generation || body.leaseEpoch !== state.epoch
        || (state.holder !== undefined && body.clientId !== state.holder)) {
        return json({ ok: false, code: state.holder !== undefined && body.leaseEpoch === state.epoch ? 'lease-holder-mismatch' : 'lease-not-owned' }, 409)
      }
      state.state = 'paused'; state.epoch++
      return json(receipt(sessionId, requester))
    }
    if (url.pathname === '/api/ego/watch/start' || url.pathname === '/api/ego/watch/stop') {
      return json(body.hostGeneration === state.generation ? { ok: true, sessionId, hostGeneration: state.generation }
        : { ok: false, code: 'host-generation-stale' }, body.hostGeneration === state.generation ? 200 : 409)
    }
    throw new Error(`unexpected fixture request: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const sources: FixtureSource[] = []
  class FixtureSource {
    private readonly listeners = new Map<string, (event: { data: string }) => void>()
    readonly close = vi.fn()
    constructor(readonly url: string) { sources.push(this) }
    addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener) }
    // Intentionally permit a callback after close, modelling an already queued
    // delivery. The real component must reject its obsolete captured closure.
    emit(name: string, body: Payload) { this.listeners.get(name)?.({ data: JSON.stringify(body) }) }
  }
  vi.stubGlobal('EventSource', FixtureSource)
  const faces = new Map(['a', 'b'].map(sessionId => [sessionId, {
    sessionId,
    prompt: vi.fn(async (_content: { type: 'text'; text: string }[], _mode: 'queue' | 'steer') => ({ ok: true })),
    cancel: vi.fn(async () => ({ ok: true })),
  }]))
  const sessions = {
    binding: (sessionId: string) => {
      const face = faces.get(sessionId)
      return face ? { sessionId, session: face } : undefined
    },
    list: { getSnapshot: () => ({ ids: ['a', 'b'], byId: { a: { running: false }, b: { running: false } } }), subscribe: () => () => {} },
  }
  let tab!: Tab
  const unregister = vi.fn()
  const sidebar = {
    features: ['browserUrl'], isTabEnabled: () => true, openTab: vi.fn(),
    registerTab: vi.fn((value: Tab) => { tab = value; return unregister }),
  }
  const disposers: (() => void)[] = []
  applyRc2({
    get: name => name === 'sessions' ? sessions : name === 'betterSidebar' ? sidebar : undefined,
    effect: operation => { const dispose = operation(); if (typeof dispose === 'function') disposers.push(dispose) },
  })
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  let unmounted = false
  const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
  const render = async (sessionId = 'a', visible = true) => {
    await act(async () => { root.render(tab.component({ scope: { sessionId }, visible })); await Promise.resolve() })
    await flush()
  }
  const unmount = async () => {
    if (!unmounted) { unmounted = true; await act(async () => { root.unmount(); await Promise.resolve() }) }
    await flush()
  }
  const button = (text: string) => {
    const found = [...container.querySelectorAll('button')].find(entry => entry.textContent === text)
    if (!found) throw new Error(`missing UI button: ${text}`)
    return found
  }
  const keyboardToggle = () => button('键盘输入')
  const click = async (text: string) => {
    const target = button(text)
    expect(target.disabled).toBe(false)
    await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await Promise.resolve() })
    await flush()
  }
  const advance = async (milliseconds: number) => {
    await act(async () => { vi.advanceTimersByTime(milliseconds); await Promise.resolve() })
    await flush()
  }
  return {
    container, states, requests, sources, faces, sidebar, unregister, flush, render, unmount, click, advance,
    deferGrant(sessionId: string, epoch: number) { grants.set(sessionId, { gate: deferred<Response>(), epoch }) },
    // Granting binds the lease to the device that asked (its takeover body
    // named a clientId), so the receipt is requester-bound like the real host.
    async grant(sessionId: string) {
      const grant = grants.get(sessionId)!
      const state = states.get(sessionId)!
      const requester = requests.find(request => request.path.endsWith('/takeover') && request.sessionId === sessionId)?.clientKey
      state.state = 'human'; state.epoch = grant.epoch; if (requester !== undefined) state.holder = requester
      await act(async () => { grant.gate.resolve(json(receipt(sessionId, requester))); await Promise.resolve() })
      await flush()
    },
    refuseAuthOnce: () => { authRefusals++ },
    failSpacesOnce: () => { spacesFailures++ },
    delaySpaces: (duration: number) => { spacesDelayMs = duration },
    refuseInputOnce: (code: string, status = 409) => { inputRefusal = { code, status } },
    breakInputNetworkOnce: () => { inputNetworkFailures++ },
    fillRemoteStreams: (on = true) => { remoteStreamsFull = on },
    deferKeyDown(sessionId: string) { inputGate = { sessionId, gate: deferred<Response>() } },
    // Native draft editing: set the field value through the prototype's native
    // setter (React's instance value tracker would otherwise dedupe the change
    // event) and deliver a real input event, exactly as a browser does for
    // typed, composed or pasted text.
    async type(text: string) {
      await act(async () => {
        const field = container.querySelector('textarea')!
        expect(field.disabled).toBe(false)
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
        setter.call(field, text)
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        await Promise.resolve()
      })
      await flush()
    },
    async compose(name: string) {
      await act(async () => {
        container.querySelector('textarea')!.dispatchEvent(new dom.window.Event(name, { bubbles: true }))
        await Promise.resolve()
      })
      await flush()
    },
    // The keyboard disclosure toggle (present only for a proven human holder).
    keyboardToggle,
    keyboardPanel(): Element { return container.querySelector('.dsh-ego-rc2-keyboard-panel')! },
    draftBlock(): Element { return container.querySelector('.dsh-ego-rc2-draft')! },
    // The panel consults the (stubbed) window's matchMedia; a test opts INTO a
    // coarse-pointer ANSWER here. This stub only replies to the media query —
    // it never claims a real device, pointer or touchscreen exists.
    pointerCoarse(on = true) {
      Object.assign(dom.window, { matchMedia: (query: string): MediaQueryList =>
        ({ matches: on && query === '(pointer: coarse)', media: query }) as MediaQueryList })
    },
    // Native select editing: set the chosen option through the prototype's
    // native setter and deliver a real change event, as a browser does.
    async selectMode(value: string) {
      await act(async () => {
        const select = container.querySelector('select')!
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!
        setter.call(select, value)
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
        await Promise.resolve()
      })
      await flush()
    },
    // A native key event on a chosen element (page region or draft editor).
    async key(target: Element, name: 'keydown' | 'keyup', init: Record<string, unknown> = {}) {
      await act(async () => {
        target.dispatchEvent(new dom.window.KeyboardEvent(name, { bubbles: true, cancelable: true, ...init }))
        await Promise.resolve()
      })
      await flush()
    },
    // Focus leaving the draft editor (React's blurred focusout).
    async blur(target: Element) {
      await act(async () => {
        target.dispatchEvent(new dom.window.Event('focusout', { bubbles: true }))
        await Promise.resolve()
      })
      await flush()
    },
    // A frame tap as a pointer of the given kind, with page coordinates that
    // browserCoordinates can map (the img rect is stubbed per test).
    async tapFrame(name: 'pointerdown' | 'pointerup', pointerType: string, clientX = 200, clientY = 120, buttons = 1) {
      await act(async () => {
        const event = new dom.window.Event(name, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>
        Object.assign(event, { pointerType, pointerId: 1, button: 0, buttons, clientX, clientY, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false })
        container.querySelector('img')!.dispatchEvent(event)
        await Promise.resolve()
      })
      await flush()
    },
    async finishKeyDown() {
      await act(async () => {
        const gate = inputGate!
        // The host answers according to the lease state at REPLY time: the
        // gated request was admitted earlier, but the holder may since have
        // changed (a takeover on another device), and then only that device's
        // input is acknowledged.
        const last = requests.filter(request => request.path === '/api/ego/input').at(-1)!
        const state = states.get(gate.sessionId)!
        if (state.holder !== undefined && last.clientKey !== state.holder) {
          gate.gate.resolve(json({ ok: false, code: 'lease-holder-mismatch' }, 409))
        } else if (last.body.leaseEpoch !== state.epoch) {
          gate.gate.resolve(json({ ok: false, code: 'lease-not-owned' }, 409))
        } else {
          gate.gate.resolve(json(receipt(gate.sessionId, last.clientKey)))
        }
        await Promise.resolve()
      })
      await flush()
    },
    async emit(source: FixtureSource, name: string, body: Payload) {
      await act(async () => { source.emit(name, body); await Promise.resolve() })
      await flush()
    },
    async destroy() {
      await unmount()
      for (const [sessionId, grant] of grants) {
        if (!grant.gate.settled) {
          const state = states.get(sessionId)!
          const requester = requests.find(request => request.path.endsWith('/takeover') && request.sessionId === sessionId)?.clientKey
          state.state = 'human'; state.epoch = grant.epoch; if (requester !== undefined) state.holder = requester
          grant.gate.resolve(json(receipt(sessionId, requester)))
        }
      }
      if (inputGate && !inputGate.gate.settled) inputGate.gate.resolve(json(receipt(inputGate.sessionId)))
      await flush()
      for (const dispose of disposers.reverse()) dispose()
      dom.window.close()
    },
  }
}

let fixture: ReturnType<typeof harness> | undefined
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }) })
afterEach(async () => {
  try { await fixture?.destroy() } finally {
    fixture = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  }
})

describe('mounted rc.2 Sidebar lifecycle', () => {
  it.each(['hidden', 'unmounted'] as const)('releases a late human grant after the original view is %s', async close => {
    const f = fixture = harness()
    f.deferGrant('a', 7)
    await f.render(); await f.click('停止本次运行并接管')
    expect(f.requests.filter(request => request.path.endsWith('/takeover'))).toHaveLength(1)
    // The conversation is cancelled only AFTER the Host allows the takeover.
    expect(f.faces.get('a')!.cancel).toHaveBeenCalledTimes(0)
    if (close === 'hidden') await f.render('a', false)
    else await f.unmount()
    expect(f.requests.filter(request => request.path.endsWith('/release'))).toHaveLength(0)
    await f.grant('a')
    expect(f.faces.get('a')!.cancel).toHaveBeenCalledTimes(1)
    const releases = f.requests.filter(request => request.path.endsWith('/release'))
    expect(releases).toHaveLength(1)
    expect(releases[0].body).toMatchObject({ sessionId: 'a', leaseEpoch: 7, hostGeneration: 'host-1' })
    expect(f.states.get('a')!.state).toBe('paused')
    expect(f.sources.every(source => source.close.mock.calls.length === 1)).toBe(true)
    expect(f.faces.get('a')!.prompt).not.toHaveBeenCalled()
  })

  it('remounts by Session key and confines an old delayed grant and cleanup to A after switching to B', async () => {
    const f = fixture = harness()
    f.deferGrant('a', 9)
    await f.render('a'); await f.click('停止本次运行并接管')
    const aSource = f.sources[0]
    await f.render('b')
    expect(f.container.querySelector('[data-ego-session]')?.getAttribute('data-ego-session')).toBe('b')
    expect(aSource.close).toHaveBeenCalledTimes(1)
    await f.grant('a')
    const releases = f.requests.filter(request => request.path.endsWith('/release'))
    expect(releases.map(request => request.sessionId)).toEqual(['a'])
    expect(releases[0].body).toMatchObject({ leaseEpoch: 9, hostGeneration: 'host-1' })
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('控制状态：idle')
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    expect(f.faces.get('b')!.cancel).not.toHaveBeenCalled()
    expect(f.faces.get('b')!.prompt).not.toHaveBeenCalled()
    const switchedAt = f.requests.length
    await f.advance(5000)
    expect(f.requests.slice(switchedAt).filter(request => request.path === '/api/ego/watch/start').every(request => request.sessionId === 'b')).toBe(true)
    expect(f.requests.filter(request => request.path === '/api/ego/watch/stop' && request.sessionId === 'a')[0].body.hostGeneration).toBe('host-1')
  })

  it('waits for an in-flight remote Enter key, sends the captured keyUp, then releases on unmount', async () => {
    const f = fixture = harness()
    await f.render()
    // Human input needs THIS device's requester-bound held proof first.
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    f.deferKeyDown('a')
    await f.click('回车'); await f.unmount()
    expect(f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.type)).toEqual(['keyDown'])
    expect(f.requests.filter(request => request.path.endsWith('/release'))).toHaveLength(0)
    await f.finishKeyDown()
    const inputAndRelease = f.requests.filter(request => request.path === '/api/ego/input' || request.path.endsWith('/release'))
    expect(inputAndRelease.map(request => request.body.type ?? 'release')).toEqual(['keyDown', 'keyUp', 'release'])
    expect(inputAndRelease[1].body).toMatchObject({ sessionId: 'a', targetId: 'owned-a', leaseEpoch: 4, hostGeneration: 'host-1', inputSeq: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 })
    expect(inputAndRelease[2].body).toMatchObject({ sessionId: 'a', leaseEpoch: 4, hostGeneration: 'host-1' })
    expect(f.states.get('a')!.state).toBe('paused')
  })

  it('rejects queued G1 frame/control callbacks after a G2 refresh and keeps watch mutations generation-fenced', async () => {
    const f = fixture = harness()
    await f.render()
    const oldSource = f.sources[0]
    await f.emit(oldSource, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-1', data: 'YQ==', vw: 640, vh: 480 })
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,YQ==')
    const oldClient = f.requests.find(request => request.path === '/api/ego/watch/start')!.body.clientId
    Object.assign(f.states.get('a')!, { generation: 'host-2', epoch: 0 })
    await f.advance(2500)
    expect(oldSource.close).toHaveBeenCalledTimes(1)
    const newSource = f.sources.find(source => new URL(source.url, 'http://fixture.local').searchParams.get('hostGeneration') === 'host-2')!
    expect(newSource).toBeDefined()
    await f.emit(newSource, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-2', data: 'Yg==', vw: 640, vh: 480 })
    await f.emit(oldSource, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-1', data: 'YQ==', vw: 640, vh: 480 })
    await f.emit(oldSource, 'control', { sessionId: 'a', hostGeneration: 'host-1', control: { state: 'human', sessionId: 'a', leaseEpoch: 99 } })
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,Yg==')
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('控制状态：idle')
    await f.advance(5000)
    const oldWatch = f.requests.filter(request => request.body.clientId === oldClient)
    expect(oldWatch.every(request => request.body.hostGeneration === 'host-1')).toBe(true)
    expect(oldWatch.filter(request => request.path === '/api/ego/watch/start')).toHaveLength(1)
    expect(oldWatch.filter(request => request.path === '/api/ego/watch/stop')).toHaveLength(1)
    const newStarts = f.requests.filter(request => request.path === '/api/ego/watch/start' && request.body.clientId !== oldClient)
    expect(newStarts.length).toBeGreaterThanOrEqual(2)
    expect(newStarts.every(request => request.body.hostGeneration === 'host-2')).toBe(true)
  })

  it('names one device identity on all control traffic and yields controls while another device holds', async () => {
    const f = fixture = harness()
    await f.render()
    // One per-mount device identity backs every status poll of this tab.
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey
    expect(own).toMatch(/^sidebar:a:/)
    expect(f.requests.filter(request => request.path === '/api/ego/control/status').every(request => request.clientKey === own)).toBe(true)
    // Another device of the same session holds human control: this device
    // keeps watching passively but its input surface is disabled.
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: 'another-device' })
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    expect(f.container.querySelector('[role="status"]')!.textContent).toContain('另一设备持有控制')
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
    // The lease lands on THIS device: the same identity now backs its input
    // and the disposal release.
    Object.assign(f.states.get('a')!, { holder: own })
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
    await f.click('回车')
    await f.unmount()
    expect(f.requests.find(request => request.path === '/api/ego/input')!.body.clientId).toBe(own)
    expect(f.requests.find(request => request.path.endsWith('/release'))!.body.clientId).toBe(own)
  })

  it('never mints input authority from an identity-less SSE control payload', async () => {
    const f = fixture = harness()
    await f.render()
    const source = f.sources[0]
    // An SSE control event — even a forged held:true — is not requester-bound
    // proof: no input surface may open from the stream alone.
    await f.emit(source, 'control', { sessionId: 'a', hostGeneration: 'host-1',
      control: { state: 'human', sessionId: 'a', leaseEpoch: 4, held: true } })
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    // A status poll of an UNBOUND human lease (host says nothing about this
    // device) keeps the watching device read-only — not only for 2.5s.
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4 })
    await f.advance(2500)
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
    // Authority arrives only from THIS device's requester-bound receipt.
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { holder: own })
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
  })

  it('fails closed on stream loss: frame and permission clear until a fresh requester-bound status', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 3, holder: own })
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
    const source = f.sources.at(-1)!
    await f.emit(source, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-1', data: 'QQ==', vw: 640, vh: 480 })
    expect(f.container.querySelector('img')).not.toBeNull()
    // Transport loss: the stream closes, the stale frame and the locally
    // proven permission are revoked, and the failure is visible.
    await f.emit(source, 'error', {})
    expect(source.close).toHaveBeenCalled()
    expect(f.container.querySelector('img')).toBeNull()
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    expect(f.container.querySelector('[role="status"]')!.textContent).toContain('画面连接中断')
    expect(f.states.get('a')!.state).toBe('human') // a channel loss never touches the host lease
    // Recovery requires a NEW requester-bound status answer; nothing replays.
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
  })

  it('reports a stream capacity refusal precisely instead of a generic disconnect', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 3, holder: own })
    await f.advance(2500)
    // The EventSource cannot read the 429 body of the stream route; the panel
    // asks watch/status once and names the real reason.
    f.fillRemoteStreams(true)
    await f.emit(f.sources.at(-1)!, 'error', {})
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('已达上限')
    expect(f.container.querySelector('[role="status"]')?.textContent).not.toContain('画面连接中断')
    // With budget available again, the same connect failure on the retried
    // stream is reported as a channel loss — one probe per failure.
    f.fillRemoteStreams(false)
    await f.advance(1000) // the bounded retry opens a fresh stream
    const before = f.requests.length
    await f.emit(f.sources.at(-1)!, 'error', {})
    expect(f.requests.slice(before).filter(request => request.path === '/api/ego/watch/status')).toHaveLength(1)
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('画面连接中断')
  })

  it('replaces an obsolete capacity notice when a valid frame recovers the picture', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 3, holder: own })
    await f.advance(2500)
    f.fillRemoteStreams(true)
    await f.emit(f.sources.at(-1)!, 'error', {})
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('已达上限')
    // A slot frees; the bounded retry opens a fresh stream and its first
    // VALID frame replaces the stale capacity warning with a recovery notice.
    f.fillRemoteStreams(false)
    await f.advance(1000)
    await f.emit(f.sources.at(-1)!, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-1', data: 'Wcvv', vw: 640, vh: 480 })
    const status = f.container.querySelector('[role="status"]')?.textContent ?? ''
    expect(status).toContain('画面连接已恢复')
    expect(status).not.toContain('已达上限')
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,Wcvv')
    // The recovered picture grants no input authority of its own: before the
    // next requester-bound status poll the draft stays disabled.
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
  })

  it('keeps the capacity notice through malformed, stale and unrelated frames', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 3, holder: own })
    await f.advance(2500)
    f.fillRemoteStreams(true)
    const source = f.sources.at(-1)!
    await f.emit(source, 'error', {})
    // Malformed frame data never parses into a picture...
    await f.emit(source, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-1', data: '####not-base64####', vw: 640, vh: 480 })
    // ...and stale or unrelated frames (other target, other session, other
    // host generation) are refused before any notice may be replaced.
    await f.emit(source, 'frame', { sessionId: 'a', targetId: 'owned-zzz', hostGeneration: 'host-1', data: 'Wcvv', vw: 640, vh: 480 })
    await f.emit(source, 'frame', { sessionId: 'b', targetId: 'owned-b', hostGeneration: 'host-1', data: 'Wcvv', vw: 640, vh: 480 })
    await f.emit(source, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-0', data: 'Wcvv', vw: 640, vh: 480 })
    const status = f.container.querySelector('[role="status"]')?.textContent ?? ''
    expect(status).toContain('已达上限')
    expect(status).not.toContain('画面连接已恢复')
    expect(f.container.querySelector('img')).toBeNull()
  })

  it('keeps a newer action result message through picture recovery frames', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    f.fillRemoteStreams(true)
    await f.emit(f.sources.at(-1)!, 'error', {})
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('已达上限')
    f.fillRemoteStreams(false)
    await f.advance(1000) // the bounded retry opens a fresh stream
    await f.advance(2500) // the next status poll re-proves this device's lease
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
    // A NEWER message (an explicit draft send result) takes the screen…
    await f.type('恢复后文字')
    await f.click('输入到网页')
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('文字已发送')
    // …and later valid frames must not erase it with the recovery notice.
    await f.emit(f.sources.at(-1)!, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-1', data: 'Wczz', vw: 640, vh: 480 })
    const status = f.container.querySelector('[role="status"]')?.textContent ?? ''
    expect(status).toContain('文字已发送')
    expect(status).not.toContain('画面连接已恢复')
    expect(status).not.toContain('已达上限')
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,Wczz')
  })

  it('distinguishes an authorization refusal from a channel or partial spaces failure', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 2, holder: own })
    await f.advance(2500)
    // A spaces-only failure is not an authorization refusal: control state and
    // the proven lease stay, and the partial failure is surfaced.
    f.failSpacesOnce()
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
    expect(f.container.querySelector('[role="status"]')!.textContent).toContain('页面列表暂时不可用')
    // A refused status poll fails closed locally with the auth message and
    // never resumes or releases anything on its own.
    f.refuseAuthOnce()
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    expect(f.container.querySelector('[role="status"]')!.textContent).toContain('远程认证未通过')
    expect(f.states.get('a')!.state).toBe('human') // the refusal did not touch the host lease
    expect(f.requests.filter(request => request.path.endsWith('/release'))).toHaveLength(0)
    // Re-authenticated polls restore authority.
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
  })

  it('binds the Sidebar openUrl callback to the mounted tab device identity without touching control', async () => {
    const f = fixture = harness()
    await f.render()
    // The mounted tab's session identity…
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    expect(own).toMatch(/^sidebar:a:/)
    const descriptor = f.sidebar.registerTab.mock.calls[0][0] as Tab
    const openUrl = descriptor.onOpenUrl
    if (openUrl === undefined) throw new Error('registered tab lacks the openBrowser callback')
    const before = f.requests.length
    // …is the SAME identity the extension callback names, and a repeated
    // open intent keeps both its identity and its requestId.
    await openUrl({ url: 'https://example.test/open', requestId: 'same-open', scope: { sessionId: 'a' } })
    await openUrl({ url: 'https://example.test/open', requestId: 'same-open', scope: { sessionId: 'a' } })
    const opens = f.requests.slice(before)
    expect(opens.map(request => request.path)).toEqual(['/api/ego/navigate', '/api/ego/navigate'])
    expect(opens.every(request => request.clientKey === own)).toBe(true)
    expect(opens.map(request => request.body.requestId)).toEqual(['same-open', 'same-open'])
    expect(opens.every(request => request.body.leaseEpoch === undefined)).toBe(true)
    // The callback only navigates: it never acquires or releases control.
    expect(f.requests.filter(request => request.path.endsWith('/takeover') || request.path.endsWith('/release'))).toHaveLength(0)
    expect(f.faces.get('a')!.cancel).not.toHaveBeenCalled()
  })

  it('keeps healthy control and target updates flowing while a spaces reply is slower than the interval', async () => {
    const f = fixture = harness()
    f.delaySpaces(4000)
    Object.assign(f.states.get('a')!, { state: 'paused', epoch: 9 })
    await f.render()
    await f.advance(2500)
    await f.advance(1500)
    await f.advance(1000)
    await f.advance(1500)
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('控制状态：paused')
    expect(f.container.querySelector('.dsh-ego-rc2-targets')?.textContent).toContain('Page a')
  })

  it('fails closed on an auth refusal immediately while spaces replies slowly and never overlaps pulls', async () => {
    const f = fixture = harness()
    // Spaces are so slow they never settle inside this test: only the control
    // channel speaks, and its refusal must not wait for anything.
    f.delaySpaces(60000)
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
    f.refuseAuthOnce()
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('远程认证未通过')
    expect(f.states.get('a')!.state).toBe('human') // the refusal did not touch the host lease
    expect(f.requests.filter(request => request.path.endsWith('/release'))).toHaveLength(0)
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
    // Single-flight: one outstanding membership pull satisfies every tick.
    expect(f.requests.filter(request => request.path === '/api/ego/spaces')).toHaveLength(1)
  })

  it('discards an obsolete spaces completion after a host generation change until a fresh one commits', async () => {
    const f = fixture = harness()
    f.delaySpaces(4000)
    await f.render()
    await f.advance(1000)
    // Host replacement while the first (host-1) spaces pull is still flying.
    Object.assign(f.states.get('a')!, { generation: 'host-2', epoch: 0 })
    await f.advance(1500)
    await f.advance(1500) // the host-1 completion lands after the flip
    expect(f.container.querySelector('.dsh-ego-rc2-targets')?.textContent ?? '').not.toContain('Page a')
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    await f.advance(1000)
    await f.advance(4000) // a spaces pull of the CURRENT generation commits
    expect(f.container.querySelector('.dsh-ego-rc2-targets')?.textContent).toContain('Page a')
  })

  it('keeps a native draft editable through composition and paste without any implicit send', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    const field = f.container.querySelector('textarea')!
    expect(field.disabled).toBe(false)
    // IME composition events must be inert for dispatch purposes: the text
    // simply stays a local draft (no partial send, no clearing).
    await f.compose('compositionstart')
    await f.type('中文')
    await f.compose('compositionupdate')
    await f.compose('compositionend')
    await f.type('中文更多') // a final input after compositionEnd: value-driven, no duplicate
    expect(field.value).toBe('中文更多')
    // Local editing keys edit the draft; nothing reaches the browser.
    await f.type('中文更多\n两行') // Enter and paste-sized edits stay local
    expect(field.value).toBe('中文更多\n两行')
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
  })

  it('sends the committed draft once under the captured lease and clears only the sent text', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.type('中文草稿')
    await f.click('输入到网页')
    const inputs = f.requests.filter(request => request.path === '/api/ego/input')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].body).toMatchObject({ type: 'insertText', text: '中文草稿', sessionId: 'a', targetId: 'owned-a', leaseEpoch: 4, hostGeneration: 'host-1' })
    expect(inputs[0].clientKey).toBe(own)
    expect(f.container.querySelector('textarea')!.value).toBe('')
    const status = f.container.querySelector('[role="status"]')?.textContent ?? ''
    expect(status).toContain('文字已发送')
    expect(status).toContain('确认')
  })

  it('preserves edits made while a send is pending and reports both facts', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.type('第一版')
    f.deferKeyDown('a') // gates the insertText reply
    await f.click('输入到网页')
    // Editing stays possible while the send is pending.
    await f.type('第二版')
    await f.finishKeyDown()
    const texts = f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.text)
    expect(texts).toEqual(['第一版'])
    expect(f.container.querySelector('textarea')!.value).toBe('第二版')
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('保留在草稿')
  })

  it('keeps the draft when the page input is refused or the reply is unknown', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.type('被拒文字')
    f.refuseInputOnce('control-busy')
    await f.click('输入到网页')
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('control-busy')
    expect(f.container.querySelector('textarea')!.value).toBe('被拒文字')
    f.breakInputNetworkOnce()
    await f.click('输入到网页')
    const status = f.container.querySelector('[role="status"]')?.textContent ?? ''
    expect(status).toContain('未确认')
    expect(status).toContain('草稿保留')
    expect(f.container.querySelector('textarea')!.value).toBe('被拒文字')
    // Nothing was retried on its own; a fresh explicit click still sends. Each
    // explicit click attempted exactly one POST (the recorded attempts include
    // the refused and the network-broken one).
    await f.click('输入到网页')
    expect(f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.text))
      .toEqual(['被拒文字', '被拒文字', '被拒文字'])
    expect(f.container.querySelector('textarea')!.value).toBe('')
  })

  it('drops a queued send as stale when the lease is lost before dispatch', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.type('排队文字')
    f.deferKeyDown('a')
    await f.click('回车') // keyDown in flight; keyUp queues behind it
    await f.click('输入到网页') // the draft send queues behind the keyUp
    // Another device takes over while the queue is still busy.
    Object.assign(f.states.get('a')!, { holder: 'another-device' })
    await f.advance(2500)
    await f.finishKeyDown()
    const inputs = f.requests.filter(request => request.path === '/api/ego/input')
    expect(inputs.map(request => request.body.type)).toEqual(['keyDown'])
    expect(f.container.querySelector('textarea')!.value).toBe('排队文字')
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('未发送')
  })

  it('reports a mid-flight lease loss as a refusal and never clears the draft', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.type('飞行中')
    f.deferKeyDown('a')
    await f.click('输入到网页')
    // The POST is already out; the host answers for the NEW holder only.
    Object.assign(f.states.get('a')!, { holder: 'another-device' })
    await f.finishKeyDown()
    const inputs = f.requests.filter(request => request.path === '/api/ego/input')
    expect(inputs.map(request => request.body.type)).toEqual(['insertText'])
    expect(f.container.querySelector('textarea')!.value).toBe('飞行中')
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('lease-holder-mismatch')
  })

  it('clears the draft when the host generation or the watched target changes', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.type('旧页面文字')
    await f.click('Page a2') // another owned page of the same session
    expect(f.container.querySelector('textarea')!.value).toBe('')
    await f.type('新页面文字')
    Object.assign(f.states.get('a')!, { generation: 'host-2' })
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.value).toBe('')
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
  })

  it('prevents a duplicate send while one is pending', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.type('只发一次')
    f.deferKeyDown('a')
    await f.click('输入到网页')
    const send = [...f.container.querySelectorAll('button')].find(entry => entry.textContent === '发送中…')!
    expect(send.disabled).toBe(true)
    await f.finishKeyDown()
    expect(f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.text)).toEqual(['只发一次'])
    expect(f.container.querySelector('textarea')!.value).toBe('')
  })

  it('does not raise the local keyboard on a touch tap but keeps ordered down/up', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    const source = f.sources[0]
    await f.emit(source, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-1', data: 'YQ==', vw: 640, vh: 480 })
    const image = f.container.querySelector('img')!
    Object.assign(image, { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }) })
    const field = f.container.querySelector('textarea')!
    // Touch tap: no local keyboard focus, correct mapped coordinates.
    await f.tapFrame('pointerdown', 'touch', 200, 120)
    await f.tapFrame('pointerup', 'touch', 200, 120, 0)
    expect(f.container.ownerDocument.activeElement).not.toBe(field)
    const taps = f.requests.filter(request => request.path === '/api/ego/input')
    expect(taps.map(request => request.body.type)).toEqual(['mousePressed', 'mouseReleased'])
    expect(taps[0].body).toMatchObject({ x: 320, y: 192, targetId: 'owned-a', leaseEpoch: 4, hostGeneration: 'host-1' })
    expect(taps[1].body).toMatchObject({ x: 320, y: 192, buttons: 0 })
    // A desktop click focuses the PAGE keyboard region (the image), not the
    // draft editor: following Ctrl+A/arrows act on the page, never the draft.
    await f.tapFrame('pointerdown', 'mouse', 200, 120)
    expect(f.container.ownerDocument.activeElement).toBe(f.container.querySelector('[aria-label="直接输入网页（支持中文和粘贴）"]'))
  })

  it('keeps a viewer read-only: draft actions stay disabled and nothing is dispatched', async () => {
    const f = fixture = harness()
    await f.render()
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: 'another-device' })
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    const send = [...f.container.querySelectorAll('button')].find(entry => entry.textContent === '输入到网页')!
    expect(send.disabled).toBe(true)
    expect([...f.container.querySelectorAll('button')].find(entry => entry.textContent === '回车')!.disabled).toBe(true)
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
  })

  it('refuses to send a half-finished composition, then commits once on explicit send', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    const send = () => [...f.container.querySelectorAll('button')].find(entry => entry.textContent === '输入到网页')!
    // Candidate selection active: the send is disabled and nothing is sent.
    await f.compose('compositionstart')
    await f.type('中文候选')
    expect(send().disabled).toBe(true)
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
    // Committed composition: the final value is sendable exactly once.
    await f.compose('compositionend')
    expect(send().disabled).toBe(false)
    await f.click('输入到网页')
    const texts = f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.text)
    expect(texts).toEqual(['中文候选'])
    expect(f.container.querySelector('textarea')!.value).toBe('')
    // A cancelled composition reverts to the empty draft: still nothing sent.
    await f.compose('compositionstart')
    await f.type('又一段')
    await f.compose('compositionend')
    await f.type('') // cancel reverts the native value
    expect(send().disabled).toBe(true)
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(1)
  })

  it('unsticks the composing flag on blur without any automatic send', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    const send = () => [...f.container.querySelectorAll('button')].find(entry => entry.textContent === '输入到网页')!
    const field = f.container.querySelector('textarea')!
    await f.compose('compositionstart')
    await f.type('未完成组合')
    expect(send().disabled).toBe(true)
    // Focus moves away mid-composition (e.g. a popup steals it): the flag
    // cannot stick — but nothing is dispatched either.
    await f.blur(field)
    expect(send().disabled).toBe(false)
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
  })

  it('routes desktop page keys from the focused frame and keeps draft keys local', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    const source = f.sources[0]
    await f.emit(source, 'frame', { sessionId: 'a', targetId: 'owned-a', hostGeneration: 'host-1', data: 'YQ==', vw: 640, vh: 480 })
    const image = f.container.querySelector('img')!
    Object.assign(image, { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }) })
    await f.tapFrame('pointerdown', 'mouse', 200, 120)
    await f.tapFrame('pointerup', 'mouse', 200, 120, 0)
    expect(f.container.ownerDocument.activeElement).toBe(f.container.querySelector('[aria-label="直接输入网页（支持中文和粘贴）"]'))
    // Ctrl+A on the focused page region: exactly one ordered remote down/up
    // pair with the ctrl modifier — after the click's pressed/released pair.
    const ctrlA = { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true }
    await f.key(image, 'keydown', ctrlA)
    await f.key(image, 'keyup', ctrlA)
    const inputs = f.requests.filter(request => request.path === '/api/ego/input')
    expect(inputs.map(request => request.body.type)).toEqual(['mousePressed', 'mouseReleased', 'keyDown', 'keyUp'])
    expect(inputs[2].body).toMatchObject({ key: 'a', code: 'KeyA', modifiers: 2, targetId: 'owned-a', leaseEpoch: 4 })
    expect(inputs[3].body).toMatchObject({ key: 'a', modifiers: 2 })
    // The same gesture on the DRAFT editor stays entirely local.
    const field = f.container.querySelector('textarea')!
    await f.type('本地草稿')
    await f.key(field, 'keydown', ctrlA)
    await f.key(field, 'keyup', ctrlA)
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(4)
    expect(field.value).toBe('本地草稿')
  })

  it('clears a quarantined draft on a new proven Host and ignores its old pending reply', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.type('旧主机草稿')
    f.deferKeyDown('a') // the insertText reply stays in flight
    await f.click('输入到网页')
    // A transient auth failure wipes the page state but not the draft.
    f.refuseAuthOnce()
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.value).toBe('旧主机草稿')
    // Recovery proves a DIFFERENT Host generation: the old draft is cleared
    // with a concise notice and nothing is sent onto the new Host.
    Object.assign(f.states.get('a')!, { generation: 'host-2' })
    await f.advance(2500)
    expect(f.container.querySelector('textarea')!.value).toBe('')
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('原草稿已清空')
    expect(f.requests.filter(request => request.path === '/api/ego/input' && request.body.hostGeneration === 'host-2')).toHaveLength(0)
    // The old in-flight completion landing late restores nothing.
    await f.finishKeyDown()
    expect(f.container.querySelector('textarea')!.value).toBe('')
    expect(f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.text)).toEqual(['旧主机草稿'])
  })

  it('keeps the remote keyboard hidden until this tab proves human control, then discloses a collapsed desktop toggle', async () => {
    const f = fixture = harness()
    await f.render()
    // Idle: the whole keyboard block is hidden and the editor stays mounted
    // but disabled — no placeholder keyboard chrome for a watcher.
    expect(f.draftBlock().hasAttribute('hidden')).toBe(true)
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    // Another device's lease: still a read-only watcher, still hidden.
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: 'another-device' })
    await f.advance(2500)
    expect(f.draftBlock().hasAttribute('hidden')).toBe(true)
    // This device's own requester-bound receipt opens the disclosure: one
    // small collapsed toggle (desktop default) wired to its panel by id.
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { holder: own })
    await f.advance(2500)
    expect(f.draftBlock().hasAttribute('hidden')).toBe(false)
    const toggle = f.keyboardToggle()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const panel = f.keyboardPanel()
    expect(panel.hasAttribute('hidden')).toBe(true)
    expect(toggle.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.contains(f.container.querySelector('textarea'))).toBe(true)
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
    await f.click('键盘输入')
    expect(f.keyboardToggle().getAttribute('aria-expanded')).toBe('true')
    expect(f.keyboardPanel().hasAttribute('hidden')).toBe(false)
    expect(f.container.querySelector('textarea')!.disabled).toBe(false)
  })

  it('preserves the draft and its explicit-send lifecycle across keyboard collapse and expand', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.click('键盘输入') // expand the collapsed desktop panel
    await f.type('收起后再展开')
    await f.click('键盘输入') // collapse: layout only, never the draft state
    expect(f.keyboardPanel().hasAttribute('hidden')).toBe(true)
    expect(f.container.querySelector('textarea')!.value).toBe('收起后再展开')
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
    await f.click('键盘输入') // expand again: the same draft is still there
    expect(f.container.querySelector('textarea')!.value).toBe('收起后再展开')
    await f.click('输入到网页')
    const texts = f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.text)
    expect(texts).toEqual(['收起后再展开'])
    expect(f.container.querySelector('textarea')!.value).toBe('')
  })

  it('collapsing mid-composition never sends and keeps the candidate text local', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.click('键盘输入')
    await f.compose('compositionstart')
    await f.type('未确认候选')
    await f.click('键盘输入') // collapse while the candidate is still active
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
    expect(f.container.querySelector('textarea')!.value).toBe('未确认候选')
    // Expanding again changes no fence: the composition still blocks sending
    // until it ends, and only an explicit click may ever transmit the text.
    await f.click('键盘输入')
    const send = () => [...f.container.querySelectorAll('button')].find(entry => entry.textContent === '输入到网页')!
    expect(send().disabled).toBe(true)
    await f.compose('compositionend')
    await f.click('输入到网页')
    expect(f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.text))
      .toEqual(['未确认候选'])
    expect(f.container.querySelector('textarea')!.value).toBe('')
  })

  it('auto-expands the keyboard once per coarse-pointer acquisition and recovers the draft untouched', async () => {
    const f = fixture = harness()
    f.pointerCoarse(true) // a stubbed media answer, not a device claim
    await f.render()
    expect(f.draftBlock().hasAttribute('hidden')).toBe(true)
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    // The touch takeover expanded the panel once, by itself.
    expect(f.keyboardToggle().getAttribute('aria-expanded')).toBe('true')
    expect(f.keyboardPanel().hasAttribute('hidden')).toBe(false)
    await f.type('触屏草稿')
    await f.click('键盘输入') // an explicit collapse still wins and keeps the draft
    expect(f.keyboardPanel().hasAttribute('hidden')).toBe(true)
    expect(f.container.querySelector('textarea')!.value).toBe('触屏草稿')
    // Another device takes over: the block hides, the draft survives hidden.
    Object.assign(f.states.get('a')!, { holder: 'another-device' })
    await f.advance(2500)
    expect(f.draftBlock().hasAttribute('hidden')).toBe(true)
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    expect(f.container.querySelector('textarea')!.value).toBe('触屏草稿')
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
    // Reacquired control recovers the existing draft (coarse re-expands once)
    // and never automatically inserts it anywhere.
    Object.assign(f.states.get('a')!, { holder: own })
    await f.advance(2500)
    expect(f.keyboardPanel().hasAttribute('hidden')).toBe(false)
    expect(f.container.querySelector('textarea')!.value).toBe('触屏草稿')
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
  })

  it('keeps a quarantined draft and the user’s open panel through a channel loss without auto-inserting', async () => {
    const f = fixture = harness()
    await f.render()
    const own = f.requests.find(request => request.path === '/api/ego/control/status')!.clientKey!
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4, holder: own })
    await f.advance(2500)
    await f.click('键盘输入')
    await f.type('断网草稿')
    // Transport loss hides the whole keyboard (fail closed)…
    await f.emit(f.sources.at(-1)!, 'error', {})
    expect(f.draftBlock().hasAttribute('hidden')).toBe(true)
    expect(f.container.querySelector('textarea')!.disabled).toBe(true)
    expect(f.container.querySelector('textarea')!.value).toBe('断网草稿')
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
    // …and a fresh requester-bound status restores the holder, the user's
    // open panel and the draft — with nothing sent on its own.
    await f.advance(2500)
    expect(f.draftBlock().hasAttribute('hidden')).toBe(false)
    expect(f.keyboardPanel().hasAttribute('hidden')).toBe(false)
    expect(f.container.querySelector('textarea')!.value).toBe('断网草稿')
    expect(f.requests.filter(request => request.path === '/api/ego/input')).toHaveLength(0)
    await f.click('输入到网页')
    expect(f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.text))
      .toEqual(['断网草稿'])
  })

  it('moves the submit mode into collapsed more-options while keeping steer identifiable outside it', async () => {
    const f = fixture = harness()
    await f.render()
    const more = f.container.querySelector('details.dsh-ego-rc2-more') as HTMLDetailsElement | null
    if (more === null) throw new Error('missing more-options details')
    expect(more.open).toBe(false)
    expect(more.querySelector('select')!.value).toBe('queue')
    // The default queue mode adds no extra marker to the panel.
    expect(f.container.querySelector('.dsh-ego-rc2-mode-status')).toBeNull()
    // The non-default steer mode stays identifiable with the details closed.
    await f.selectMode('steer')
    const marker = f.container.querySelector('.dsh-ego-rc2-mode-status')!
    expect(marker.textContent).toContain('当前轮引导')
    expect(more.contains(marker)).toBe(false)
    // The hidden select still governs the real submission mode.
    await f.click('读取网页到主对话')
    expect(f.faces.get('a')!.prompt).toHaveBeenCalledTimes(1)
    expect(f.faces.get('a')!.prompt.mock.calls[0][1]).toBe('steer')
    // Switching back to the default queue removes the marker again.
    await f.selectMode('queue')
    expect(f.container.querySelector('.dsh-ego-rc2-mode-status')).toBeNull()
    await f.click('读取网页到主对话')
    expect(f.faces.get('a')!.prompt).toHaveBeenCalledTimes(2)
    expect(f.faces.get('a')!.prompt.mock.calls[1][1]).toBe('queue')
  })
})
