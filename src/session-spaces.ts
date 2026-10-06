import { createHash, randomUUID } from 'node:crypto'
import type { ToolExec } from './types.ts'

export class ScopeError extends Error {
  constructor(readonly code: string, message = code) { super(message) }
}
export interface SessionSpace {
  sessionId: string
  generation: string
  name: string
  id?: string | number
  targets: Set<string>
}

/** Process-local ownership. A restart never adopts another host's old targets. */
export class SessionSpaceRegistry {
  private currentGeneration = randomUUID()
  get generation(): string { return this.currentGeneration }
  private bindings = new Map<string, SessionSpace>()
  private targetOwners = new Map<string, string>()
  private revoked = new Set<string>()
  bind(sessionId: unknown): SessionSpace {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) throw new ScopeError('session-required')
    if (this.revoked.has(sessionId)) throw new ScopeError('session-disposed')
    let binding = this.bindings.get(sessionId)
    if (!binding) {
      const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
      binding = { sessionId, generation: this.generation, name: `dsh-${this.generation}-${digest}`, targets: new Set() }
      this.bindings.set(sessionId, binding)
    }
    return binding
  }
  fromTool(exec: ToolExec | undefined): SessionSpace {
    const agent = exec?.agent as { session?: { id?: unknown } } | undefined
    return this.bind(agent?.session?.id)
  }
  require(sessionId: string): SessionSpace {
    const binding = this.bindings.get(sessionId)
    if (!binding || binding.generation !== this.generation) throw new ScopeError('scope-unbound')
    return binding
  }
  arguments(binding: SessionSpace, args: Record<string, unknown>, toolName: string): Record<string, unknown> {
    if (args.space !== undefined && args.space !== '' && String(args.space) !== binding.name && String(args.space) !== String(binding.id ?? '')) {
      throw new ScopeError('space-not-owned')
    }
    if (toolName === 'ego_space_close' && args.name !== undefined && String(args.name) !== binding.name && String(args.name) !== String(binding.id ?? '')) {
      throw new ScopeError('space-not-owned')
    }
    for (const key of ['targetId', 'target', 'tabId']) if (args[key] !== undefined) this.assertTarget(binding.sessionId, args[key])
    return { ...args, space: binding.name, ...(['ego_space_open', 'ego_space_close'].includes(toolName) ? { name: binding.name } : {}) }
  }
  record(sessionId: string, value: unknown): void {
    const binding = this.require(sessionId)
    const record = value as { name?: unknown; id?: unknown; targets?: unknown }
    if (!record || record.name !== binding.name || !Array.isArray(record.targets)) throw new ScopeError('ownership-unverified')
    const targets = record.targets.filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (targets.length !== record.targets.length) throw new ScopeError('ownership-unverified')
    for (const id of targets) {
      const owner = this.targetOwners.get(id)
      if (owner !== undefined && owner !== sessionId) throw new ScopeError('target-not-owned')
    }
    for (const id of binding.targets) this.targetOwners.delete(id)
    binding.targets = new Set(targets)
    if (typeof record.id === 'string' || typeof record.id === 'number') binding.id = record.id
    for (const id of targets) this.targetOwners.set(id, sessionId)
  }
  assertTarget(sessionId: string, targetId: unknown): string {
    if (typeof targetId !== 'string' || !targetId || !this.require(sessionId).targets.has(targetId)) throw new ScopeError('target-not-owned')
    return targetId
  }
  forgetTarget(sessionId: string, targetId: string): void {
    this.assertTarget(sessionId, targetId)
    this.require(sessionId).targets.delete(targetId)
    this.targetOwners.delete(targetId)
  }
  clear(sessionId: string): void {
    const binding = this.require(sessionId)
    for (const id of binding.targets) this.targetOwners.delete(id)
    binding.targets.clear()
    binding.id = undefined
  }
  /** Only after a proven browser stop: old targets and all old requests are invalid. */
  resetBrowser(): void {
    this.bindings.clear(); this.targetOwners.clear(); this.currentGeneration = randomUUID()
  }
  revoke(sessionId: string): void {
    if (this.bindings.has(sessionId)) this.clear(sessionId)
    this.bindings.delete(sessionId)
    this.revoked.add(sessionId)
  }
}
