import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error Vendored ES runtime intentionally has no TypeScript declaration.
import { adoptScopedPopups } from '../runtime/ego-linux/src/scoped-popups.mjs'
// @ts-expect-error Vendored ES runtime intentionally has no TypeScript declaration.
import { createTabsApi } from '../runtime/ego-linux/src/tabs.mjs'

describe('browser-proven scoped popup membership', () => {
  it('adopts nested opener descendants while preserving already-owned and unowned tabs', () => {
    const spaces = [{ targetIds: ['A'], browserContextId: null }, { targetIds: ['B'], browserContextId: null }]
    const targets = [{ targetId: 'nested', type: 'page', openerId: 'popup', url: 'https://callback.example' },
      { targetId: 'popup', type: 'page', openerId: 'A', url: 'https://auth.example' },
      { targetId: 'B', type: 'page', openerId: 'A', url: 'https://b.example' },
      { targetId: 'loose', type: 'page', url: 'https://unowned.example' }]
    expect(adoptScopedPopups(spaces, targets)).toBe(true)
    expect(spaces[0].targetIds).toEqual(['A', 'popup', 'nested'])
    expect(spaces[1].targetIds).toEqual(['B'])
    expect(adoptScopedPopups(spaces, targets)).toBe(false)
  })
  it('rejects wrong-context, conflicting opener, nonpage and absent-owner targets', () => {
    const spaces = [{ targetIds: ['ambiguous', 'A'], browserContextId: 'ctx-a' }, { targetIds: ['ambiguous'], browserContextId: 'ctx-b' }]
    const targets = [{ targetId: 'wrong', type: 'page', openerId: 'A', browserContextId: 'ctx-b' },
      { targetId: 'conflict', type: 'page', openerId: 'ambiguous', browserContextId: 'ctx-a' },
      { targetId: 'worker', type: 'worker', openerId: 'A', browserContextId: 'ctx-a' },
      { targetId: 'orphan', type: 'page', openerId: 'unknown', browserContextId: 'ctx-a' }]
    expect(adoptScopedPopups(spaces, targets)).toBe(false)
    expect(spaces[0].targetIds).toEqual(['ambiguous', 'A'])
  })
  it('uses Chrome default-context identity and retains a proven opener after its tab closes', () => {
    const spaces = [{ targetIds: ['A'], browserContextId: null }]
    expect(adoptScopedPopups(spaces, [{ targetId: 'A', type: 'page', browserContextId: 'default-opaque' }])).toBe(true)
    expect(adoptScopedPopups(spaces, [{ targetId: 'popup', type: 'page', openerId: 'A', browserContextId: 'default-opaque' },
      { targetId: 'wrong', type: 'page', openerId: 'A', browserContextId: 'other' }])).toBe(true)
    expect(spaces[0].targetIds).toEqual(['A', 'popup'])
  })
  it('never falls back to another session when a scoped task has no live tabs', async () => {
    vi.stubEnv('DSH_EGO_SCOPED_WORKER', '1')
    try {
      const api = createTabsApi({ call: async () => ({ targetInfos: [{ type: 'page', targetId: 'B', url: 'https://b.example', title: 'private B' }] }) },
        { port: undefined, getScope: async () => ({ browserContextId: null, targetIds: new Set(['closed-A']) }) })
      expect((await api.listTabs()).tabs).toEqual([])
    } finally { vi.unstubAllEnvs() }
  })
  it('requires proven target IDs even within an isolated browser context', async () => {
    vi.stubEnv('DSH_EGO_SCOPED_WORKER', '1')
    try {
      const api = createTabsApi({ call: async () => ({ targetInfos: [
        { type: 'page', targetId: 'A', browserContextId: 'ctx-a', url: 'https://a.example' },
        { type: 'page', targetId: 'unowned', browserContextId: 'ctx-a', url: 'https://private.example' },
      ] }) }, { port: undefined, getScope: async () => ({ browserContextId: 'ctx-a', targetIds: new Set(['A']) }) })
      expect((await api.listTabs()).tabs.map((tab: { targetId: string }) => tab.targetId)).toEqual(['A'])
    } finally { vi.unstubAllEnvs() }
  })
})
