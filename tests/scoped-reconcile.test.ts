import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

async function apiFor(spaces: unknown[], targets: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'ego-scoped-reconcile-'))
  vi.stubEnv('LOCALAPPDATA', root); vi.stubEnv('XDG_STATE_HOME', root)
  vi.stubEnv('DSH_EGO_SCOPED_WORKER', '1')
  vi.resetModules()
  // @ts-expect-error Vendored runtime intentionally has no TypeScript declarations.
  const { TASK_SPACE_FILE } = await import('../runtime/ego-linux/src/paths.mjs')
  await mkdir(dirname(TASK_SPACE_FILE), { recursive: true })
  await writeFile(TASK_SPACE_FILE, JSON.stringify({ spaces, selectedId: 1, nextId: 3, closedSpaces: [] }))
  // @ts-expect-error Vendored runtime intentionally has no TypeScript declarations.
  const { createTaskSpacesApi } = await import('../runtime/ego-linux/src/task-spaces.mjs')
  const call = vi.fn(async (method: string) => {
    if (method === 'Target.getTargets') return { targetInfos: targets }
    throw new Error(`unexpected mutation ${method}`)
  })
  return { api: createTaskSpacesApi({ call }), call }
}

describe('scoped reconciliation cannot infer ownership or sweep other spaces', () => {
  it('never re-adopts an unrelated same-URL target after all owned pages close', async () => {
    const { api, call } = await apiFor([{ id: 1, name: 'A', targetIds: ['closed-A'], urls: ['https://same.example'], browserContextId: null }],
      [{ targetId: 'unowned', type: 'page', url: 'https://same.example', browserContextId: 'elsewhere' }])
    expect(await api.listTaskSpaces()).toEqual({ taskSpaces: [] })
    expect(call.mock.calls.every(([method]: [string]) => method === 'Target.getTargets')).toBe(true)
  })
  it('preserves another session idle/blank targets without legacy global close', async () => {
    const before = Date.now() - 4 * 60 * 60 * 1000
    const { api, call } = await apiFor([
      { id: 1, name: 'A', targetIds: ['A'], browserContextId: null, touchedAt: before, createdAt: before },
      { id: 2, name: 'B', targetIds: ['B'], browserContextId: null, touchedAt: before, createdAt: before },
    ], [{ targetId: 'A', type: 'page', url: 'https://a.example' }, { targetId: 'B', type: 'page', url: 'about:blank' }])
    expect((await api.listTaskSpaces()).taskSpaces.map((space: { name: string }) => space.name)).toEqual(['A', 'B'])
    expect(call.mock.calls.every(([method]: [string]) => method === 'Target.getTargets')).toBe(true)
  })
  it('never disposes another session context when its tracked parent closes', async () => {
    const { api, call } = await apiFor([
      { id: 1, name: 'A', targetIds: ['A'], browserContextId: null },
      { id: 2, name: 'B', targetIds: ['closed-B'], browserContextId: 'ctx-b' },
    ], [{ targetId: 'A', type: 'page', url: 'https://a.example' },
      { targetId: 'unowned-C', type: 'page', url: 'https://c.example', browserContextId: 'ctx-b' }])
    expect((await api.listTaskSpaces()).taskSpaces.map((space: { name: string }) => space.name)).toEqual(['A'])
    expect(call.mock.calls.every(([method]: [string]) => method === 'Target.getTargets')).toBe(true)
  })
  it('keeps a proven popup when the cached-context parent disappears in the next snapshot', async () => {
    const targets = [{ targetId: 'A', type: 'page', url: 'https://a.example', browserContextId: 'opaque-default', openerId: '' }]
    const { api } = await apiFor([{ id: 1, name: 'A', targetIds: ['A'], browserContextId: null }], targets)
    expect((await api.listTaskSpaces()).taskSpaces[0].scopedContextId).toBe('opaque-default')
    targets.splice(0, 1, { targetId: 'popup', type: 'page', url: 'https://callback.example', browserContextId: 'opaque-default', openerId: 'A' })
    expect((await api.listTaskSpaces()).taskSpaces[0].targetIds).toEqual(['popup'])
  })
})
