import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, SCOPED_EGO_TOOL_NAMES } from '../src/index.ts'
import type { SpawnSpec, ToolExec } from '../src/types.ts'
vi.mock('../src/ffmpeg-installation.ts', () => ({ getSharedFfmpegInstallationManager: () => ({ check: async () => ({}), status: () => ({}) }) }))
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.unstubAllEnvs() })

function mount() {
  const home = mkdtempSync(join(tmpdir(), 'ego-tool-scopes-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home); vi.stubEnv('DSH_EGO_ISOLATED_RUNTIME', '1')
  const live = new Map(['A', 'B'].map(id => [id, { id }]))
  const tools = new Map<string, { execute(args: object, exec: ToolExec): Promise<unknown> }>()
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>()
  const events = new Map<string, (...args: unknown[]) => unknown>()
  const spawns: SpawnSpec[] = []
  let failNext = false
  const targetNames = (name: string) => ['a-' + name.slice(-12), 'b-' + name.slice(-12)]
  const ctx = {
    tools: { register: (tool: { name: string; execute(args: object, exec: ToolExec): Promise<unknown> }) => { tools.set(tool.name, tool); return () => {} } },
    sessions: { get: (id: string) => live.get(id) },
    get: (name: string) => name === 'sessions' ? ctx.sessions : name === 'webServer' ? {
      register: (o: { path: string; handler: (req: unknown, res: unknown) => unknown }) => { routes.set(o.path, o.handler); return () => {} },
    } : name === 'connection' ? { requestRejection: () => undefined } : undefined,
    inject: (_names: readonly string[], callback: (value: unknown) => void) => callback(ctx),
    on: (name: string, callback: (...args: unknown[]) => unknown) => { events.set(name, callback); return () => {} },
    effect: (fn: () => unknown) => { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(() => { /* do not execute browser teardown in a fixture */ }) },
    subprocess: { spawn: (spec: SpawnSpec) => {
      spawns.push(spec)
      if (failNext) {
        failNext = false
        return { done: Promise.resolve({ exitCode: 1, signal: null }), collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: 'target closed after dispatch', nextOffset: 28, lossy: false }) } } }
      }
      const name = JSON.parse(spec.stdio.stdin.data.match(/taskSpaces\.useOrCreate\(("[^"]*")\)/)![1]!) as string
      const targets = targetNames(name)
      const selected = spec.stdio.stdin.data.match(/await browser\.switchTab\("([^"]+)"\)/)?.[1] ?? targets[0]
      const value = spec.stdio.stdin.data.includes('const text = ')
        ? { ok: true, targetId: selected, url: 'https://fixture.example/read?code=private-code#state', title: 'Fixture', text: 'Owned page text' }
        : { ok: true, id: 1, name, page: { url: 'https://fixture.example' } }
      const stdout = '@@DSH_RESULT@@' + JSON.stringify(value) + '\n@@DSH_OWNERSHIP@@' + JSON.stringify({ name, id: 1, targets }) + '\n'
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } } }
    } },
  }
  apply(ctx as never, {})
  const exec = (sessionId: string) => ({ agent: { session: { id: sessionId } }, signal: new AbortController().signal }) as ToolExec
  const invoke = async (path: string, body: object) => {
    const req = { method: 'POST', url: path, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
    let status = 0, data = ''
    const res = { setHeader() {}, writeHead(code: number) { status = code }, end(value: string) { data = value } }
    await routes.get(path)!(req, res)
    return { status, data: JSON.parse(data) }
  }
  return { home, live, tools, exec, spawns, events, invoke, targetNames, loseNextReceipt: () => { failNext = true } }
}

describe('registered tools through actual rc.2 defineTool execution', () => {
  it('registers the scoped set and omits raw/global/login capabilities', () => {
    const h = mount()
    for (const name of ['ego_cli', 'ego_script', 'ego_js', 'ego_cdp', 'ego_login_import', 'ego_auth_flush', 'ego_status', 'ego_space_close']) expect(h.tools.has(name)).toBe(false)
    expect(h.tools.has('ego_navigate')).toBe(true)
    expect(h.tools.has('ego_http')).toBe(true)
    expect([...h.tools.keys()].sort()).toEqual([...SCOPED_EGO_TOOL_NAMES].sort())
    expect(h.tools.size).toBe(25)
    expect(h.spawns).toHaveLength(0)
  })
  it('requires the real exec session and rejects server fetch before any subprocess', async () => {
    const h = mount()
    await expect(h.tools.get('ego_page_info')!.execute({}, { signal: new AbortController().signal } as never)).rejects.toThrow('session-required')
    await expect(h.tools.get('ego_http')!.execute({ mode: 'server', url: 'https://example.org' }, h.exec('A'))).rejects.toThrow('unscoped-capability-disabled')
    await expect(h.tools.get('ego_download')!.execute({ triggerScript: '}); await browser.switchTab("foreign"); //' }, h.exec('A'))).rejects.toThrow('unscoped-capability-disabled')
    expect(h.spawns).toHaveLength(0)
  })
  it('does not replay an ambiguous failed CLI action and fences all subsequent Agent tools', async () => {
    const h = mount(); h.loseNextReceipt()
    await expect(h.tools.get('ego_navigate')!.execute({ url: 'https://fixture.example' }, h.exec('A'))).rejects.toThrow('target closed after dispatch')
    expect(h.spawns).toHaveLength(1)
    await expect(h.tools.get('ego_page_info')!.execute({}, h.exec('A'))).rejects.toThrow('agent-control-blocked')
    expect(h.spawns).toHaveLength(1)
  })
  it('reports only the actual scoped capability set in help and resets counts on real activity events', async () => {
    const h = mount()
    const help = await h.tools.get('ego_help')!.execute({ topic: 'tools' }, h.exec('A')) as { text: string }
    expect(help.text).toContain('ego_space_open')
    const mentioned = help.text.match(/\bego_[a-z_]+\b/g) ?? []
    for (const name of ['ego_js', 'ego_script', 'ego_cli', 'ego_login_import', 'ego_status']) expect(mentioned).not.toContain(name)
    h.events.get('agent/status')?.({ agent: { session: { id: 'A' } }, status: 'running' })
    expect(h.spawns).toHaveLength(0)
  })
  it('maps two real execution sessions to separate owned names and a dedicated runtime environment', async () => {
    const h = mount()
    await h.tools.get('ego_page_info')!.execute({}, h.exec('A'))
    await h.tools.get('ego_page_info')!.execute({}, h.exec('B'))
    const names = h.spawns.map(spec => JSON.parse(spec.stdio.stdin.data.match(/taskSpaces\.useOrCreate\(("[^"]*")\)/)![1]!))
    expect(names[0]).not.toBe(names[1])
    for (const spec of h.spawns) {
      expect(spec.env!.EGO_LINUX_PROFILE).toBe(join(h.home, 'plugins', 'ego-browser', 'runtime', 'profile'))
      expect(spec.env!.LOCALAPPDATA).toBe(join(h.home, 'plugins', 'ego-browser', 'runtime', 'local'))
      expect(spec.stdio.stdin.data).toContain('@@DSH_OWNERSHIP@@')
    }
  })
  it('rejects a foreign explicit space and a disposed execution session', async () => {
    const h = mount()
    await h.tools.get('ego_page_info')!.execute({}, h.exec('B'))
    const name = JSON.parse(h.spawns[0]!.stdio.stdin.data.match(/taskSpaces\.useOrCreate\(("[^"]*")\)/)![1]!)
    await expect(h.tools.get('ego_page_info')!.execute({ space: name }, h.exec('A'))).rejects.toThrow('space-not-owned')
    h.events.get('session/disposed')?.({ id: 'B' }); h.live.delete('B')
    await expect(h.tools.get('ego_page_info')!.execute({}, h.exec('B'))).rejects.toThrow('session-disposed')
    expect(h.spawns).toHaveLength(1)
  })
  it('reads and navigates the explicitly selected owned target without switching to the first tab', async () => {
    const h = mount()
    await h.tools.get('ego_page_info')!.execute({}, h.exec('A'))
    const name = JSON.parse(h.spawns[0]!.stdio.stdin.data.match(/taskSpaces\.useOrCreate\(("[^"]*")\)/)![1]!)
    const selected = h.targetNames(name)[1]
    const context = await h.invoke('/api/ego/context', { sessionId: 'A', requestId: 'read', targetId: selected, clientId: 'device-1' })
    expect(context.status).toBe(200)
    expect(context.data.context.targetId).toBe(selected)
    expect(context.data.context.url).toBe('https://fixture.example/read')
    expect(h.spawns.at(-1)!.stdio.stdin.data).toContain(`await browser.switchTab("${selected}")`)
    const navigate = await h.invoke('/api/ego/navigate', { sessionId: 'A', requestId: 'navigate', targetId: selected, url: 'https://fixture.example/next', clientId: 'device-1' })
    expect(navigate.status).toBe(200)
    expect(h.spawns.at(-1)!.stdio.stdin.data).toContain(`await browser.switchTab("${selected}")`)
  })
})
