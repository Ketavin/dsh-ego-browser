import { randomUUID } from 'node:crypto'
import { ControlLease } from './control-lease.ts'
import { ScopeError, SessionSpaceRegistry } from './session-spaces.ts'

/** Public rc.2 Agent seam only; this module neither admits nor removes messages. */
export interface ContinuationAgent {
  readonly session: { readonly id: string }
  readonly inbox: { readonly nextTurn: readonly PendingMessage[]; readonly nextStep: readonly PendingMessage[] }
  whenIdle(): Promise<void>
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>
}
interface PendingMessage { readonly id: string; readonly source?: { readonly kind?: string }; readonly content: readonly { type: string; text?: string }[] }
interface Entry {
  sessionId: string; generation: string; id: string; marker: string; epoch: number; expiresAt: number
  agent: ContinuationAgent; baseline: Set<string>; signal: AbortSignal; finish: () => void
  timer: ReturnType<typeof setTimeout>; abortListener: () => void
}
export class ContinuationGate {
  private active?: Entry
  constructor(private readonly scopes: SessionSpaceRegistry, private readonly control: ControlLease,
    private readonly getAgent: (sessionId: string) => ContinuationAgent | undefined, private readonly ttlMs = 30_000) {}
  private agent(sessionId: string): ContinuationAgent {
    const agent = this.getAgent(sessionId)
    if (!agent || agent.session.id !== sessionId || typeof agent.whenIdle !== 'function' || typeof agent.runMaintenance !== 'function') throw new ScopeError('continuation-agent-unavailable')
    return agent
  }
  private receipt(entry: Entry) {
    return { continuationId: entry.id, leaseEpoch: entry.epoch, hostGeneration: entry.generation, marker: entry.marker, expiresAt: entry.expiresAt }
  }
  async prepare(sessionId: string, epoch: unknown, holder?: string) {
    return this.control.withHumanDrain(sessionId, epoch, () => this.prepareDrained(sessionId, epoch, holder), 5000, holder)
  }
  private async prepareDrained(sessionId: string, epoch: unknown, holder?: string) {
    this.scopes.require(sessionId)
    this.control.assertContinuationReady(sessionId, epoch, holder)
    if (this.active) throw new ScopeError('continuation-busy')
    const agent = this.agent(sessionId)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([agent.whenIdle(), new Promise((_, reject) => { idleTimer = setTimeout(() => reject(new ScopeError('continuation-agent-busy')), 250) })])
    } finally { if (idleTimer) clearTimeout(idleTimer) }
    if (this.agent(sessionId) !== agent) throw new ScopeError('continuation-agent-replaced')
    if (this.active) throw new ScopeError('continuation-busy')
    let entry: Entry | undefined, failure: unknown
    let maintenance: Promise<unknown>
    try {
      maintenance = agent.runMaintenance(signal => {
        try {
          this.scopes.require(sessionId)
          const status = this.control.prepareContinuation(sessionId, epoch, holder)
          if (signal.aborted) throw new ScopeError('continuation-cancelled')
          let finish!: () => void
          const hold = new Promise<void>(resolve => { finish = resolve })
          const id = randomUUID()
          entry = { sessionId, generation: this.scopes.generation, id, marker: `[[dsh-ego-continue:${id}]]`, epoch: status.leaseEpoch,
            agent, baseline: new Set([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(message => message.id)), signal, finish,
            expiresAt: Date.now() + this.ttlMs, timer: undefined as unknown as ReturnType<typeof setTimeout>, abortListener: () => {} }
          const captured = entry
          captured.abortListener = () => this.end(captured, false)
          captured.timer = setTimeout(() => this.end(captured, false), this.ttlMs)
          signal.addEventListener('abort', captured.abortListener, { once: true })
          this.active = captured
          return hold
        } catch (error) { failure = error; return Promise.resolve() }
      })
    } catch { throw new ScopeError('continuation-agent-busy') }
    if (!entry) { await maintenance; throw failure ?? new ScopeError('continuation-maintenance-unavailable') }
    const captured = entry
    void maintenance.catch(() => this.end(captured, false))
    return this.receipt(captured)
  }
  private require(sessionId: string, id: unknown, epoch: unknown): Entry {
    const entry = this.active
    if (!entry || entry.sessionId !== sessionId || entry.id !== id || entry.epoch !== epoch) throw new ScopeError('continuation-not-owned')
    let agent: ContinuationAgent | undefined
    try { agent = this.agent(sessionId) } catch { /* fail closed and settle the old maintenance claim */ }
    if (entry.generation !== this.scopes.generation || agent !== entry.agent || entry.signal.aborted || Date.now() >= entry.expiresAt) {
      this.end(entry, false); throw new ScopeError('continuation-stale')
    }
    this.scopes.require(sessionId)
    return entry
  }
  commit(sessionId: string, id: unknown, epoch: unknown, holder?: string) {
    const entry = this.require(sessionId, id, epoch)
    const admitted = [...entry.agent.inbox.nextTurn, ...entry.agent.inbox.nextStep].some(message =>
      !entry.baseline.has(message.id) && message.source?.kind === 'user' && message.content.some(block => block.type === 'text' && block.text === entry.marker))
    if (!admitted) throw new ScopeError('continuation-admission-unverified')
    this.control.arm(sessionId, epoch, holder)
    this.end(entry, true)
    return { continuationId: entry.id, admitted: true }
  }
  abort(sessionId: string, id: unknown, epoch: unknown, holder?: string) {
    const entry = this.require(sessionId, id, epoch)
    // Only the lease-holding device may abort its own prepared continuation.
    if (!this.control.holderMatches(holder)) throw new ScopeError('lease-holder-mismatch')
    this.end(entry, false, holder)
    return { continuationId: entry.id, admitted: false }
  }
  private end(entry: Entry, committed: boolean, holder?: string): void {
    if (this.active !== entry) return
    this.active = undefined
    clearTimeout(entry.timer); entry.signal.removeEventListener('abort', entry.abortListener)
    if (!committed) this.control.abortContinuation(entry.sessionId, entry.epoch, holder)
    entry.finish()
  }
  revoke(sessionId: string): void { if (this.active?.sessionId === sessionId) this.end(this.active, false) }
  dispose(): void { if (this.active) this.end(this.active, false) }
}
