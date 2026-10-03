import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { ScopeError } from './session-spaces.ts'

/** Explicit isolated bootstrap only; never falls back to the user's Ego profile. */
export function isolatedRuntimeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  if (base.DSH_EGO_ISOLATED_RUNTIME !== '1' || !base.DSH_HOME || !isAbsolute(base.DSH_HOME) || !existsSync(base.DSH_HOME)) return undefined
  if (!statSync(base.DSH_HOME).isDirectory()) return undefined
  const home = realpathSync(base.DSH_HOME)
  const root = join(home, 'plugins', 'ego-browser', 'runtime')
  for (const path of [join(home, 'plugins'), join(home, 'plugins', 'ego-browser'), root, join(root, 'local'), join(root, 'data'), join(root, 'cache'), join(root, 'profile')]) {
    if (existsSync(path)) {
      const rel = relative(home, realpathSync(path))
      if (rel.startsWith('..') || isAbsolute(rel)) throw new ScopeError('runtime-path-outside-home')
    }
  }
  return {
    ...base,
    LOCALAPPDATA: join(root, 'local'),
    XDG_STATE_HOME: join(root, 'local'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    EGO_LINUX_STATE_DIR: join(root, 'local', 'ego-lite-linux'),
    EGO_LINUX_PROFILE: join(root, 'profile'),
    EGO_LINUX_CDP_URL: undefined,
    EGO_LINUX_EXTRA_ARGS: '',
    DSH_EGO_SCOPED_WORKER: '1',
  }
}
