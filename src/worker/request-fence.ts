import type { IncomingMessage } from 'node:http'

/** Private scoped worker accepts native Host proxies, never browser requests. */
export function workerRequestRejection(req: Pick<IncomingMessage, 'method' | 'headers' | 'socket'>,
  scoped = process.env.DSH_EGO_SCOPED_WORKER === '1'): number | undefined {
  if (!scoped) return
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return 403
  const port = req.socket.localPort
  const host = req.headers.host
  if (!port || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host ?? '')) return 403
  // Browser pages call only the guarded DSH host. Random ports are no fence.
  if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return 403
  if (req.method !== 'GET' && req.method !== 'POST') return 405
  if (req.method === 'POST' && !(typeof req.headers['content-type'] === 'string'
    && /^application\/json(?:\s*;|$)/i.test(req.headers['content-type']))) return 415
}

export function shouldProbePage(scoped: boolean): boolean { return !scoped }
