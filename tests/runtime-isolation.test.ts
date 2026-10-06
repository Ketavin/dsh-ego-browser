import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedRuntimeEnv } from '../src/runtime-isolation.ts'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe('dedicated host and worker runtime paths', () => {
  it('refuses an absent, relative, missing or unapproved home', () => {
    expect(isolatedRuntimeEnv({})).toBeUndefined()
    expect(isolatedRuntimeEnv({ DSH_EGO_ISOLATED_RUNTIME: '1', DSH_HOME: 'relative' })).toBeUndefined()
    expect(isolatedRuntimeEnv({ DSH_HOME: process.cwd() })).toBeUndefined()
  })
  it('overrides shared profile/state/cache values with runtime-recognized paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'ego-isolation-')); dirs.push(home)
    const env = isolatedRuntimeEnv({ DSH_EGO_ISOLATED_RUNTIME: '1', DSH_HOME: home, LOCALAPPDATA: 'shared', EGO_LINUX_PROFILE: 'shared-profile', EGO_LINUX_CDP_URL: 'ws://shared.example', EGO_LINUX_EXTRA_ARGS: '--user-data-dir=shared' })!
    const root = join(home, 'plugins', 'ego-browser', 'runtime')
    expect(env.LOCALAPPDATA).toBe(join(root, 'local'))
    expect(env.XDG_STATE_HOME).toBe(env.LOCALAPPDATA)
    expect(env.EGO_LINUX_STATE_DIR).toBe(join(root, 'local', 'ego-lite-linux'))
    expect(env.EGO_LINUX_PROFILE).toBe(join(root, 'profile'))
    expect(env.XDG_CACHE_HOME).toBe(join(root, 'cache'))
    expect(env.EGO_LINUX_CDP_URL).toBeUndefined()
    expect(env.EGO_LINUX_EXTRA_ARGS).toBe('')
  })
  it('guards the scoped worker startup against the global sibling process sweep', () => {
    const source = readFileSync(new URL('../src/worker/ego-cast-worker.ts', import.meta.url), 'utf8')
    expect(source).toContain("if (process.env.DSH_EGO_SCOPED_WORKER !== '1') stopSiblingWorkers()")
  })
  it('does not explicitly reintroduce credential-shaped env or unrelated harness identity after Core scrubbing', () => {
    const home = mkdtempSync(join(tmpdir(), 'ego-isolation-')); dirs.push(home)
    const env = isolatedRuntimeEnv({ DSH_EGO_ISOLATED_RUNTIME: '1', DSH_HOME: home, fixture_token: 'fixture', FIXTURE_API_KEY: 'fixture',
      DSH_SESSION_ID: 'unrelated', DSH_SHELL_ID: 'unrelated', PATH: 'platform-path', LANG: 'fixture-locale' })!
    expect(env.fixture_token).toBeUndefined(); expect(env.FIXTURE_API_KEY).toBeUndefined()
    expect(env.DSH_SESSION_ID).toBeUndefined(); expect(env.DSH_SHELL_ID).toBeUndefined()
    expect(env.PATH).toBe('platform-path'); expect(env.LANG).toBe('fixture-locale')
    expect(env.DSH_HOME).toBe(home); expect(env.DSH_EGO_SCOPED_WORKER).toBe('1')
  })
})
