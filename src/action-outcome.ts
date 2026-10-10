/** Only the owned runtime may certify that an input never reached dispatch. */
export class PreDispatchError extends Error {
  constructor(message: string) { super(message); this.name = 'PreDispatchError' }
}

export const ACTION_FAILURE_SENTINEL = '@@DSH_ACTION_FAILURE@@'
export const PREFLIGHT_TOOLS = new Set(['ego_click', 'ego_fill', 'ego_hover'])

export function verifiedPreDispatchFailure(stderr: string, requestId: string): boolean {
  const receipts = stderr.split('\n').filter(line => line.startsWith(ACTION_FAILURE_SENTINEL))
  if (receipts.length !== 1) return false
  try {
    const value = JSON.parse(receipts[0]!.slice(ACTION_FAILURE_SENTINEL.length))
    return value?.version === 1 && value.requestId === requestId && value.phase === 'input-not-dispatched'
  } catch { return false }
}
