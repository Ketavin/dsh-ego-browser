import { describe, expect, it } from 'vitest'
import { shouldProbePage, workerRequestRejection } from '../src/worker/request-fence.ts'
import type { IncomingMessage } from 'node:http'

const native = { method: 'POST', headers: { host: '127.0.0.1:42345', 'content-type': 'application/json' },
  socket: { remoteAddress: '127.0.0.1', localPort: 42345 } } as IncomingMessage
describe('private scoped worker HTTP fence', () => {
  it('accepts native Host JSON proxies without claiming user identity', () => {
    expect(workerRequestRejection(native, true)).toBeUndefined()
    expect(workerRequestRejection({ ...native, method: 'GET' } as IncomingMessage, true)).toBeUndefined()
  })
  it.each([{ origin: 'https://untrusted.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-origin' }, { host: 'untrusted.example:42345' }, { host: '127.0.0.1:42346' }])(
    'rejects browser and DNS rebinding headers %j before any worker action', headers => {
      expect(workerRequestRejection({ ...native, headers: { ...native.headers, ...headers } } as IncomingMessage, true)).toBe(403)
    })
  it('rejects simple browser media, unsupported methods and remote sockets', () => {
    expect(workerRequestRejection({ ...native, headers: { ...native.headers, 'content-type': 'text/plain' } } as IncomingMessage, true)).toBe(415)
    expect(workerRequestRejection({ ...native, method: 'PUT' } as IncomingMessage, true)).toBe(405)
    expect(workerRequestRejection({ ...native, socket: { remoteAddress: '192.0.2.1', localPort: 42345 } } as IncomingMessage, true)).toBe(403)
  })
  it('skips scoped global DOM probes while retaining the upstream standalone mode', () => {
    expect(shouldProbePage(true)).toBe(false)
    expect(shouldProbePage(false)).toBe(true)
    expect(workerRequestRejection({ ...native, headers: { origin: 'https://legacy.example' } } as IncomingMessage, false)).toBeUndefined()
  })
})
