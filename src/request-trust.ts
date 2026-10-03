/** Reuse the deployed DSH desktop-request boundary; this is not a user identity API. */
import type { IncomingMessage } from 'node:http'
import type { EgoContext } from './types.ts'

/**
 * Fail closed without the Host's public fence. On the rc.2 deployment this
 * permits only loopback, trusted Host and same-origin browser requests. A
 * cookie name (or cookie value) does not grant access to this plugin.
 */
export function isTrustedDesktopRequest(ctx: Pick<EgoContext, 'get'>, req: IncomingMessage): boolean {
  try {
    const connection = ctx.get?.('connection') as {
      requestRejection?: (request: IncomingMessage) => 403 | undefined
    } | undefined
    return typeof connection?.requestRejection === 'function'
      && connection.requestRejection(req) === undefined
  } catch {
    return false
  }
}
