import { ScopeError } from './session-spaces.ts'

export type ControlState = 'idle' | 'agent' | 'requesting-human' | 'recovering' | 'human' | 'paused' | 'armed'
/** Global browser lease: all plugin tools, UI operations and human input share it. */
export class ControlLease {
  private state: ControlState = 'idle'
  private sessionId?: string
  private epoch = 0
  private expiresAt = 0
  private controller?: AbortController
  private inFlight?: Promise<unknown>
  private requests = new Map<string, { promise: Promise<unknown>; settled: boolean; expiresAt: number }>()
  private inputWatermark?: { sessionId: string; epoch: number; sequence: number }
  private humanChain: Promise<unknown> = Promise.resolve()
  private queuedHuman = 0
  private endingHuman = false
  private queuedInputs = 0
  private heldInputs = new Map<string, Record<string, unknown>>()
  private armAllowed = false
  private unsafePause = false
  private disposed = false
  /** Client device identity currently holding human control (same person may use several devices). */
  private holder?: string
  constructor(private readonly now = Date.now, private readonly ttlMs = 120_000) {}
  private expire(): void {
    if (this.state === 'human' && this.now() >= this.expiresAt) { this.state = 'paused'; this.armAllowed = false; this.holder = undefined; this.epoch++ }
  }
  status(sessionId: string) {
    this.expire()
    return { state: this.state, sessionId: this.sessionId === sessionId ? sessionId : null, leaseEpoch: this.epoch, owned: this.sessionId === sessionId, recoveryRequired: this.state === 'paused' && this.unsafePause, expiresAt: this.state === 'human' ? this.expiresAt : null }
  }
  /** Host-only owner check; the identity is never included in a foreign status reply. */
  ownerSession(): string | undefined { return this.sessionId }
  private owned(sessionId: string, epoch: unknown, holder?: string): void {
    if (this.disposed) throw new ScopeError('control-disposed')
    this.expire()
    if (this.sessionId !== sessionId || epoch !== this.epoch) throw new ScopeError('lease-not-owned')
    if (!this.holderMatches(holder)) throw new ScopeError('lease-holder-mismatch')
  }
  /**
   * Human control is bound to the one client device that took it over. A
   * request naming a DIFFERENT device is refused even though it presents the
   * same session and epoch; an absent identity stays tolerated so
   * host-internal operations (membership refresh, disposal) keep working.
   */
  holderMatches(holder: string | undefined): boolean {
    return this.holder === undefined || holder === undefined || holder === this.holder
  }
  /** Whether THIS client device holds the human lease — for status display only, never the value. */
  heldBy(sessionId: string, holder: string | undefined): boolean {
    return this.sessionId === sessionId && this.holder !== undefined && holder === this.holder
  }
  assertHuman(sessionId: string, epoch: unknown, holder?: string): void {
    this.owned(sessionId, epoch, holder)
    if (this.state !== 'human') throw new ScopeError('human-control-required')
  }
  async runAgent<T>(sessionId: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw new ScopeError('control-disposed')
    this.expire()
    if (signal?.aborted) throw new ScopeError('operation-aborted')
    if (this.state !== 'idle' && !(this.state === 'armed' && this.sessionId === sessionId)) throw new ScopeError('agent-control-blocked')
    this.sessionId = sessionId
    this.holder = undefined
    this.state = 'agent'
    this.armAllowed = false
    const epoch = ++this.epoch
    const controller = this.controller = new AbortController()
    const abort = () => { controller.abort(signal?.reason); if (this.epoch === epoch) { this.state = 'paused'; this.unsafePause = true; this.epoch++ } }
    signal?.addEventListener('abort', abort, { once: true })
    const flight = Promise.resolve().then(() => operation(controller.signal))
    this.inFlight = flight
    try { return await flight }
    catch (error) {
      if (this.epoch === epoch) { this.state = 'paused'; this.unsafePause = true; this.epoch++ }
      throw error
    }
    finally {
      signal?.removeEventListener('abort', abort)
      if (this.inFlight === flight) { this.inFlight = undefined; this.controller = undefined }
      if (this.epoch === epoch && this.state === 'agent') { this.state = 'idle'; this.sessionId = undefined }
    }
  }
  /** Reads, membership refreshes and input share one bounded human operation queue. */
  async runHuman<T>(sessionId: string, epoch: unknown, operation: () => Promise<T>, holder?: string): Promise<T> {
    this.assertHuman(sessionId, epoch, holder)
    if (this.endingHuman) throw new ScopeError('control-busy')
    return this.enqueueHuman(sessionId, epoch, operation, holder)
  }
  private async enqueueHuman<T>(sessionId: string, epoch: unknown, operation: () => Promise<T>, holder?: string): Promise<T> {
    if (this.queuedHuman >= 1024) throw new ScopeError('control-busy')
    this.queuedHuman++
    const queued = this.humanChain.then(async () => {
      // A lease can expire, be revoked or be disposed while this waits behind a refresh.
      this.assertHuman(sessionId, epoch, holder)
      if (this.inFlight) throw new ScopeError('control-busy')
      const flight = Promise.resolve().then(operation)
      this.inFlight = flight
      try { return await flight }
      catch (error) { this.humanOutcomeUnverified(sessionId); throw error }
      finally { if (this.inFlight === flight) this.inFlight = undefined }
    })
    this.humanChain = queued.then(() => undefined, () => undefined)
    try { return await queued }
    finally { this.queuedHuman-- }
  }
  runHumanInput<T>(sessionId: string, epoch: unknown, sequence: unknown, requestId: string, operation: () => Promise<T>, holder?: string): Promise<T> {
    this.assertHuman(sessionId, epoch, holder)
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) throw new ScopeError('input-sequence-required')
    const action = `input:${String(epoch)}:${sequence}`
    // Must match once()'s device-bound key exactly: a same-device retry of an
    // admitted input reuses its in-flight promise, another device never does.
    const key = JSON.stringify([sessionId, action, requestId, holder ?? null])
    const previous = this.requests.get(key)
    if (previous && previous.expiresAt > this.now()) return previous.promise as Promise<T>
    if (this.endingHuman) throw new ScopeError('control-busy')
    const watermark = this.inputWatermark
    if (watermark?.sessionId === sessionId && watermark.epoch === epoch && sequence <= watermark.sequence) throw new ScopeError('input-sequence-stale')
    this.inputWatermark = { sessionId, epoch: epoch as number, sequence }
    this.queuedInputs++
    try {
      return this.once(sessionId, requestId, action, () => {
        // This input was already admitted before an explicit drain fence.
        const flight = this.enqueueHuman(sessionId, epoch, operation, holder)
        return flight.finally(() => { this.queuedInputs-- })
      }, holder)
    } catch (error) { this.queuedInputs--; throw error }
  }
  /** Explicit release/continue blocks new producers, then waits for accepted work. */
  async withHumanDrain<T>(sessionId: string, epoch: unknown, operation: () => Promise<T>, timeoutMs = 5000, holder?: string): Promise<T> {
    this.owned(sessionId, epoch, holder)
    if (this.endingHuman) throw new ScopeError('control-busy')
    this.endingHuman = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // once() schedules an already-admitted input on a microtask. Let it join the queue.
      await Promise.resolve()
      await Promise.race([this.humanChain, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ScopeError('control-drain-timeout')), timeoutMs)
      })])
      this.owned(sessionId, epoch, holder)
      return await operation()
    } finally {
      if (timer) clearTimeout(timer)
      this.endingHuman = false
    }
  }
  noteInput(payload: Record<string, unknown>, completed: boolean): void {
    const type = payload.type
    const key = type === 'keyDown' || type === 'keyUp' ? `${String(payload.targetId)}:key:${String(payload.code ?? payload.key)}`
      : type === 'mousePressed' || type === 'mouseReleased' ? `${String(payload.targetId)}:button:${String(payload.button ?? 'left')}` : undefined
    if (!key) return
    if (type === 'keyDown' || type === 'mousePressed') {
      if (!this.heldInputs.has(key) && this.heldInputs.size >= 256) throw new ScopeError('human-input-ledger-full')
      this.heldInputs.set(key, payload)
    }
    else if (completed) this.heldInputs.delete(key)
  }
  humanOutcomeUnverified(sessionId: string): void {
    if (this.sessionId !== sessionId) return
    if (this.state === 'paused' && this.unsafePause) return
    this.state = 'paused'; this.unsafePause = true; this.armAllowed = false; this.holder = undefined; this.epoch++
  }
  /**
   * Explicit recovery is a transport reset, never a claim that an interrupted
   * webpage action did not happen. reset MUST prove the old browser is gone.
   * Only the Host may permit replacing a disposed session's global lease.
   */
  async recover(sessionId: string, epoch: unknown, holder: string, reset: () => Promise<void>, replaceDisposedOwner = false, timeoutMs = 5000) {
    if (this.disposed) throw new ScopeError('control-disposed')
    if (epoch !== this.epoch) throw new ScopeError('lease-epoch-stale')
    if (this.sessionId !== sessionId && !replaceDisposedOwner) throw new ScopeError('lease-not-owned')
    if (!this.holderMatches(holder)) throw new ScopeError('lease-holder-mismatch')
    if (this.state !== 'paused' || !this.unsafePause) throw new ScopeError('recovery-state-invalid')
    this.state = 'recovering'; this.armAllowed = false
    const recoveryEpoch = ++this.epoch
    this.controller?.abort(new Error('browser recovery requested'))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.allSettled([this.inFlight, this.humanChain]), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ScopeError('recovery-drain-timeout')), timeoutMs)
      })])
      if (timer) clearTimeout(timer)
      if (this.disposed || this.epoch !== recoveryEpoch) throw new ScopeError('recovery-obsolete')
      const flight = Promise.resolve().then(reset)
      this.inFlight = flight
      try { await flight }
      finally { if (this.inFlight === flight) this.inFlight = undefined }
      if (this.disposed || this.epoch !== recoveryEpoch) throw new ScopeError('recovery-obsolete')
      this.requests.clear(); this.heldInputs.clear(); this.inputWatermark = undefined
      this.unsafePause = false; this.sessionId = sessionId; this.holder = holder
      this.state = 'human'; this.expiresAt = this.now() + this.ttlMs; this.epoch++
      return this.status(sessionId)
    } catch (error) {
      if (this.epoch === recoveryEpoch) { this.state = 'paused'; this.unsafePause = true; this.holder = undefined; this.epoch++ }
      throw error
    } finally { if (timer) clearTimeout(timer) }
  }
  async takeOver(sessionId: string, timeoutMs = 5000, holder?: string) {
    if (this.disposed) throw new ScopeError('control-disposed')
    this.expire()
    if (this.state === 'recovering' || this.state === 'requesting-human') throw new ScopeError('control-busy')
    if (this.sessionId !== undefined && this.sessionId !== sessionId) throw new ScopeError('lease-not-owned')
    if (this.state === 'human') {
      // Another device of the same person/session may not grab or share the lease.
      if (!this.holderMatches(holder)) throw new ScopeError('lease-held-elsewhere')
      return this.status(sessionId)
    }
    if (this.state === 'paused' && this.unsafePause) throw new ScopeError('cancellation-unverified')
    const flight = this.inFlight
    this.sessionId = sessionId
    this.state = 'requesting-human'
    this.epoch++
    if (flight) {
      this.controller?.abort(new Error('human takeover requested'))
      this.unsafePause = true
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([flight.catch(() => undefined), new Promise((_, reject) => { timer = setTimeout(() => reject(new ScopeError('takeover-timeout')), timeoutMs) })])
      } finally {
        if (timer) clearTimeout(timer)
        this.state = 'paused'
      }
      // THIS request actually aborted a running browser operation. The distinct
      // code is an explicit receipt of that fresh interruption — never returned
      // for an already unsafe-paused lease, which the pre-check above refuses
      // with plain cancellation-unverified before touching anything.
      // Killing a CLI does not prove that Chrome has revoked a dispatched CDP action.
      throw new ScopeError('takeover-interrupted-run')
    }
    this.state = 'human'
    this.armAllowed = false
    this.holder = holder
    this.expiresAt = this.now() + this.ttlMs
    return this.status(sessionId)
  }
  release(sessionId: string, epoch: unknown, holder?: string) {
    this.owned(sessionId, epoch, holder)
    if (this.inFlight || this.queuedHuman || this.queuedInputs) throw new ScopeError('control-busy')
    if (this.heldInputs.size) throw new ScopeError('human-input-held')
    if (!['human', 'armed'].includes(this.state)) throw new ScopeError('release-state-invalid')
    // The holder identity survives the release so the SAME device alone can
    // run the two-phase continuation on this lease; a new takeover rebinds it.
    this.state = 'paused'; this.armAllowed = true; this.epoch++
    return this.status(sessionId)
  }
  assertContinuationReady(sessionId: string, epoch: unknown, holder?: string): void {
    this.owned(sessionId, epoch, holder)
    if (this.inFlight || this.queuedHuman || this.queuedInputs) throw new ScopeError('control-busy')
    if (this.heldInputs.size) throw new ScopeError('human-input-held')
    if (this.unsafePause || (this.state !== 'human' && !(this.state === 'paused' && this.armAllowed))) throw new ScopeError('continuation-state-invalid')
  }
  prepareContinuation(sessionId: string, epoch: unknown, holder?: string) {
    this.assertContinuationReady(sessionId, epoch, holder)
    if (this.state === 'human') return this.release(sessionId, epoch, holder)
    return this.status(sessionId)
  }
  abortContinuation(sessionId: string, epoch: unknown, holder?: string): void {
    // A foreign device's abort is simply ignored — never a state change.
    if (this.sessionId !== sessionId || this.epoch !== epoch || !this.holderMatches(holder)) return
    this.state = 'paused'; this.armAllowed = false; this.holder = undefined; this.epoch++
  }
  arm(sessionId: string, epoch: unknown, holder?: string) {
    this.owned(sessionId, epoch, holder)
    if (this.state !== 'paused' || this.inFlight || this.queuedHuman) throw new ScopeError('arm-state-invalid')
    if (!this.armAllowed) throw new ScopeError('cancellation-unverified')
    this.state = 'armed'; this.epoch++
    return this.status(sessionId)
  }
  revoke(sessionId: string): void {
    if (this.sessionId !== sessionId) return
    this.state = 'paused'; this.unsafePause = true; this.armAllowed = false; this.holder = undefined; this.epoch++
    this.controller?.abort(new Error('session disposed'))
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.state = 'paused'; this.armAllowed = false; this.holder = undefined; this.epoch++
    this.controller?.abort(new Error('plugin disposed'))
    await Promise.allSettled([this.inFlight, this.humanChain])
  }
  once<T>(sessionId: string, requestId: string, action: string, operation: () => Promise<T> | T, holder?: string): Promise<T> {
    if (!requestId || requestId.length > 128) throw new ScopeError('request-id-required')
    // The idempotent receipt belongs to the REQUESTING device: binding the
    // cache key to the client identity means a second device replaying the
    // same requestId can never be served the holder's cached takeover/page
    // text/release receipt — it misses the cache and runs the real checks.
    // A genuine same-device retry keeps its original receipt.
    const key = JSON.stringify([sessionId, action, requestId, holder ?? null])
    const existing = this.requests.get(key)
    if (existing && (!existing.settled || existing.expiresAt > this.now())) return existing.promise as Promise<T>
    for (const [key, entry] of this.requests) if (entry.settled && entry.expiresAt <= this.now()) this.requests.delete(key)
    if (this.requests.size >= 1024) {
      const settled = [...this.requests].find(([, entry]) => entry.settled)
      if (settled) this.requests.delete(settled[0])
      else throw new ScopeError('request-cache-busy')
    }
    const promise = Promise.resolve().then(operation)
    const entry = { promise, settled: false, expiresAt: this.now() + 300_000 }
    this.requests.set(key, entry)
    void promise.then(() => { entry.settled = true }, () => { entry.settled = true })
    return promise
  }
}
