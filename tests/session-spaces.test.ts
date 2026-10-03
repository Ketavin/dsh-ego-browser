import { describe, expect, it } from 'vitest'
import { SessionSpaceRegistry } from '../src/session-spaces.ts'

describe('actual session space ownership', () => {
  it('requires the execution agent session and never accepts a body scope in its place', () => {
    const scopes = new SessionSpaceRegistry()
    expect(() => scopes.fromTool({ arguments: { sessionId: 'A' } } as never)).toThrow('session-required')
    expect(scopes.fromTool({ agent: { session: { id: 'A' } } } as never).sessionId).toBe('A')
  })
  it('uses separate runtime names across sessions and host generations', () => {
    const scopes = new SessionSpaceRegistry()
    expect(scopes.bind('A').name).not.toBe(scopes.bind('B').name)
    expect(new SessionSpaceRegistry().bind('A').name).not.toBe(scopes.bind('A').name)
  })
  it('rejects arbitrary and foreign spaces before script execution', () => {
    const scopes = new SessionSpaceRegistry(), a = scopes.bind('A'), b = scopes.bind('B')
    expect(() => scopes.arguments(a, { space: b.name }, 'ego_click')).toThrow('space-not-owned')
    expect(() => scopes.arguments(a, { space: 'default' }, 'ego_snapshot')).toThrow('space-not-owned')
    expect(scopes.arguments(a, {}, 'ego_click').space).toBe(a.name)
  })
  it('does not adopt target IDs from a different runtime space or session', () => {
    const scopes = new SessionSpaceRegistry(), a = scopes.bind('A'), b = scopes.bind('B')
    expect(() => scopes.record('A', { name: b.name, targets: ['B-target'] })).toThrow('ownership-unverified')
    scopes.record('B', { name: b.name, id: 2, targets: ['B-target'] })
    expect(() => scopes.record('A', { name: a.name, targets: ['B-target'] })).toThrow('target-not-owned')
    expect(() => scopes.arguments(a, { targetId: 'B-target' }, 'ego_click')).toThrow('target-not-owned')
  })
  it('revokes removed targets and does not infer a popup from its URL', () => {
    const scopes = new SessionSpaceRegistry(), a = scopes.bind('A')
    scopes.record('A', { name: a.name, targets: ['old'] })
    scopes.record('A', { name: a.name, targets: ['new'] })
    expect(() => scopes.assertTarget('A', 'old')).toThrow('target-not-owned')
    expect(() => scopes.assertTarget('A', 'popup-same-url')).toThrow('target-not-owned')
    expect(scopes.assertTarget('A', 'new')).toBe('new')
  })
})
