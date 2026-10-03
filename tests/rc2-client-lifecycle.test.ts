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
type RequestRecord = { path: string; method: string; sessionId: string; body: Payload }
type Tab = { component(props: { scope: { sessionId: string }; visible: boolean }): import('react').ReactNode }
type HostState = { generation: string; state: string; epoch: number; targetId: string }

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
  const control = (sessionId: string) => {
    const state = states.get(sessionId)!
    return { state: state.state, leaseEpoch: state.epoch, sessionId: state.state === 'human' ? sessionId : null }
  }
  const receipt = (sessionId: string) => ({ ok: true, sessionId, hostGeneration: states.get(sessionId)!.generation, control: control(sessionId) })
  const grants = new Map<string, { gate: ReturnType<typeof deferred<Response>>; epoch: number }>()
  let inputGate: { sessionId: string; gate: ReturnType<typeof deferred<Response>> } | undefined
  const fetchMock = vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://fixture.local')
    const body = options.body ? JSON.parse(String(options.body)) as Payload : {}
    const sessionId = String(body.sessionId ?? url.searchParams.get('sessionId') ?? '')
    const state = states.get(sessionId)
    if (!state) throw new Error(`unexpected fixture scope: ${sessionId}`)
    requests.push({ path: url.pathname, method: options.method ?? 'GET', sessionId, body })
    if (url.pathname === '/api/ego/control/status') return json(receipt(sessionId))
    if (url.pathname === '/api/ego/spaces') return json({ ...receipt(sessionId), spaces: [
      { targetId: state.targetId, title: `Page ${sessionId}`, url: `https://example.test/${sessionId}` },
    ] })
    if (url.pathname === '/api/ego/control/takeover') {
      const grant = grants.get(sessionId)
      if (!grant) throw new Error('takeover must be deliberately deferred by the test')
      return grant.gate.promise
    }
    if (url.pathname === '/api/ego/input') {
      if (body.type === 'keyDown' && inputGate?.sessionId === sessionId) return inputGate.gate.promise
      return json({ ok: true, sessionId, hostGeneration: state.generation })
    }
    if (url.pathname === '/api/ego/control/release') {
      if (body.hostGeneration !== state.generation || body.leaseEpoch !== state.epoch) {
        return json({ ok: false, code: 'lease-not-owned' }, 409)
      }
      state.state = 'paused'; state.epoch++
      return json(receipt(sessionId))
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
    sessionId, prompt: vi.fn(async () => ({ ok: true })), cancel: vi.fn(async () => ({ ok: true })),
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
    async grant(sessionId: string) {
      const grant = grants.get(sessionId)!
      const state = states.get(sessionId)!
      state.state = 'human'; state.epoch = grant.epoch
      await act(async () => { grant.gate.resolve(json(receipt(sessionId))); await Promise.resolve() })
      await flush()
    },
    deferKeyDown(sessionId: string) { inputGate = { sessionId, gate: deferred<Response>() } },
    async keyDown() {
      const keyboard = container.querySelector('textarea')!
      expect(keyboard.disabled).toBe(false)
      await act(async () => {
        keyboard.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true, bubbles: true }))
        await Promise.resolve()
      })
      await flush()
    },
    async finishKeyDown() {
      await act(async () => { inputGate!.gate.resolve(json(receipt(inputGate!.sessionId))); await Promise.resolve() })
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
          const state = states.get(sessionId)!; state.state = 'human'; state.epoch = grant.epoch
          grant.gate.resolve(json(receipt(sessionId)))
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
    expect(f.faces.get('a')!.cancel).toHaveBeenCalledTimes(1)
    if (close === 'hidden') await f.render('a', false)
    else await f.unmount()
    expect(f.requests.filter(request => request.path.endsWith('/release'))).toHaveLength(0)
    await f.grant('a')
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

  it('waits for an in-flight DOM keyDown, sends the captured keyUp, then releases on unmount', async () => {
    const f = fixture = harness()
    Object.assign(f.states.get('a')!, { state: 'human', epoch: 4 })
    f.deferKeyDown('a')
    await f.render(); await f.keyDown(); await f.unmount()
    expect(f.requests.filter(request => request.path === '/api/ego/input').map(request => request.body.type)).toEqual(['keyDown'])
    expect(f.requests.filter(request => request.path.endsWith('/release'))).toHaveLength(0)
    await f.finishKeyDown()
    const inputAndRelease = f.requests.filter(request => request.path === '/api/ego/input' || request.path.endsWith('/release'))
    expect(inputAndRelease.map(request => request.body.type ?? 'release')).toEqual(['keyDown', 'keyUp', 'release'])
    expect(inputAndRelease[1].body).toMatchObject({ sessionId: 'a', targetId: 'owned-a', leaseEpoch: 4, hostGeneration: 'host-1', inputSeq: 2, code: 'ControlLeft', modifiers: 0 })
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
})
