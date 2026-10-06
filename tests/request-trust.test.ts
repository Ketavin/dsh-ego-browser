import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { FRAME_RELAY_DISABLED, initCastServer } from '../src/cast-server.ts'
import { registerEgoBrowserGateway } from '../src/gateway.ts'
import { resolveConfig } from '../src/config.ts'
import { isTrustedDesktopRequest } from '../src/request-trust.ts'
import type { EgoContext, RegisterRouteOptions } from '../src/types.ts'

function response() {
  return {
    statusCode: 200, headers: {} as Record<string, unknown>, body: '',
    setHeader(key: string, value: unknown) { this.headers[key.toLowerCase()] = value },
    writeHead(code: number, headers: Record<string, unknown>) { this.statusCode = code; Object.assign(this.headers, headers) },
    end(body = '') { this.body += body },
  }
}

function mount(rejection: 403 | undefined) {
  const routes: RegisterRouteOptions[] = []
  const fence = vi.fn(() => rejection)
  const actions = { spawn: vi.fn(), raise: vi.fn(), login: vi.fn(), settings: vi.fn() }
  const ctx = {
    get: (name: string) => name === 'webServer' ? {
      register: (route: RegisterRouteOptions) => { routes.push(route); return () => {} },
    } : name === 'connection' ? { requestRejection: fence } : undefined,
    subprocess: { spawn: actions.spawn },
    effect: (fn: () => unknown) => fn(),
  } as unknown as EgoContext
  const bridge = { source: () => ({}), onChange: () => () => {} }
  initCastServer(ctx, resolveConfig({ disableFrameRelay: true }), bridge as never, null, actions.raise, actions.login)
  registerEgoBrowserGateway(ctx, bridge, null)
  return { routes, ctx, fence, actions }
}

describe('Host desktop request boundary', () => {
  it('fails closed without a Host fence, including a forged cookie name', () => {
    const req = { headers: { cookie: 'dsh-auth-invented=anything' } } as IncomingMessage
    expect(isTrustedDesktopRequest({}, req)).toBe(false)
    expect(isTrustedDesktopRequest({ get: () => ({}) }, req)).toBe(false)
    expect(isTrustedDesktopRequest({ get: () => { throw new Error('unmounted') } }, req)).toBe(false)
    expect(isTrustedDesktopRequest({ get: () => ({ requestRejection: () => { throw new Error('gone') } }) }, req)).toBe(false)
  })

  it('guards every exact cast route and settings prefix before side effects', async () => {
    const { routes, fence, actions } = mount(403)
    expect(routes).toHaveLength(26)
    for (const route of routes) {
      const req = { method: 'POST', headers: { cookie: 'dsh-auth-fake=1', 'content-type': 'application/json' } }
      const res = response()
      await route.handler(req, res)
      expect(res.statusCode, route.path).toBe(403)
      expect(fence).toHaveBeenLastCalledWith(req)
    }
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled()
  })

  it('requires the correct method and JSON media type before actions', async () => {
    const { routes, actions } = mount(undefined)
    const route = routes.find(route => route.path === '/api/ego/raise')!
    for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/json-malicious' }]) {
      const res = response()
      await route.handler({ method: 'POST', headers }, res)
      expect(res.statusCode).toBe(415)
    }
    const res = response()
    await route.handler({ method: 'GET', headers: {} }, res)
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe('POST')
    expect(actions.raise).not.toHaveBeenCalled()
  })

  it('passes the Host fence without a login cookie but requires the scoped host service', async () => {
    const { routes } = mount(undefined)
    const route = routes.find(route => route.path === '/api/ego/spaces')!
    const res = response()
    await route.handler({ method: 'GET', headers: {} }, res)
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).code).toBe('scope-service-unavailable')
  })
})
