// Remote-access authorization keys must stay outside every browser-writable
// surface: the settings schema, the resolved config, and the /ego/api gateway.
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { registerEgoBrowserGateway } from '../src/gateway.ts'
import { Config as ConfigSchema, resolveConfig } from '../src/config.ts'
import type { EgoContext, RegisterRouteOptions } from '../src/types.ts'

const REMOTE_KEYS = ['remoteAccess', 'origin', 'issuer', 'audience', 'ownerSubject']

function mountGateway() {
  const routes: RegisterRouteOptions[] = []
  const update = vi.fn(async () => {})
  const ctx = {
    get: (name: string) => name === 'webServer' ? {
      register: (route: RegisterRouteOptions) => { routes.push(route); return () => {} },
    } : name === 'connection' ? { requestRejection: () => undefined } : undefined,
    inject: (_services: readonly string[], fn: (sctx: unknown) => void) => fn({ settings: { update } }),
    effect: (fn: () => unknown) => fn(),
    settings: { update },
  } as unknown as EgoContext
  const bridge = {
    source: () => ({ chromePath: '' }),
    onChange: () => () => {},
  }
  registerEgoBrowserGateway(ctx, bridge, null)
  const gateway = routes[0]!
  const call = async (body: unknown) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = { method: 'POST', headers: { 'content-type': 'application/json' }, url: '/ego/api/set', [Symbol.asyncIterator]: () => ({ next: async () => chunks.length ? { value: chunks.shift(), done: false } : { value: undefined, done: true } }) }
    const res = { statusCode: 0, body: '' as string, writeHead(status: number) { res.statusCode = status }, end(payload = '') { res.body += payload } }
    await gateway.handler(req as unknown as IncomingMessage, res)
    return { status: res.statusCode, body: res.body === '' ? '' : JSON.parse(res.body) }
  }
  return { update, call }
}

describe('remote access configuration is not browser-writable', () => {
  it('rejects gateway set attempts for every remote authorization key', async () => {
    const { update, call } = mountGateway()
    for (const key of REMOTE_KEYS) {
      const result = await call({ patch: { [key]: 'attacker-value' } })
      expect(result.status, key).toBe(403)
      expect(result.body.error.code, key).toBe('remote-access-immutable')
    }
    const nested = await call({ patch: { remoteAccess: { origin: 'https://evil.example', issuer: 'https://evil.cloudflareaccess.com', audience: 'x', ownerSubject: 'y' } } })
    expect(nested.status).toBe(403)
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps the keys out of the settings schema and the resolved config', () => {
    // The SettingsConfig schema (schemastery) carries its key map in .dict: no
    // remote authorization key may appear in it.
    const schemaKeys = Object.keys((ConfigSchema as unknown as { dict: Record<string, unknown> }).dict ?? {})
    for (const key of REMOTE_KEYS) expect(schemaKeys, key).not.toContain(key)
    const resolved = resolveConfig({ remoteAccess: { origin: 'https://x', issuer: 'https://y.cloudflareaccess.com', audience: 'a', ownerSubject: 'o' } } as never)
    expect(Object.keys(resolved)).not.toContain('remoteAccess')
    for (const key of REMOTE_KEYS) expect(Object.keys(resolved)).not.toContain(key)
    expect(JSON.stringify(resolved)).not.toContain('cloudflareaccess')
  })

  it('still accepts ordinary preference writes after the rejection path', async () => {
    const { update, call } = mountGateway()
    const ok = await call({ patch: { chromePath: 'C:/chrome/chrome.exe' } })
    expect(ok.status).toBe(200)
    expect(update).toHaveBeenCalledWith('ego-browser', { chromePath: 'C:/chrome/chrome.exe' })
  })
})
