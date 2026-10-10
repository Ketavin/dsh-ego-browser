import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error Vendored runtime stays JavaScript, as with the other runtime tests.
import { createBrowserStateStore } from '../runtime/ego-linux/src/browser-state.mjs'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture(scoped = true) {
  const dir = await mkdtemp(join(tmpdir(), 'ego-owner-record-')); dirs.push(dir)
  const stateFile = join(dir, 'local', 'browser.json'), ownerFile = join(dir, 'profile', '.dsh-browser-owner.json')
  const store = createBrowserStateStore({ stateFile, ownerFile, scoped })
  const state = { pid: 1234, port: 12345, profileDir: join(dir, 'profile'), binary: 'fixture-chrome', wsUrl: 'ws://127.0.0.1:12345/devtools/browser/fixture' }
  return { store, stateFile, ownerFile, state }
}
describe('durable scoped browser identity', () => {
  it('survives deletion or corruption of disposable browser.json', async () => {
    const f = await fixture(); await f.store.write(f.state)
    await rm(f.stateFile)
    expect(await f.store.read()).toEqual(f.state)
    await writeFile(f.stateFile, '{torn')
    expect(await f.store.read()).toEqual(f.state)
    await f.store.forget()
    expect(await f.store.read()).toBeNull()
    await expect(readFile(f.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('uses the new durable owner after a crash before its mirror was updated', async () => {
    const f = await fixture(); await f.store.write(f.state)
    const next = { ...f.state, pid: 5678, port: 23456 }
    await writeFile(f.ownerFile, JSON.stringify({ version: 1, state: next }))
    expect(await f.store.read()).toEqual(next)
  })
  it('refuses a corrupted or future-version durable owner instead of falling back to a stale PID', async () => {
    const f = await fixture(); await f.store.write(f.state)
    for (const text of ['{torn', JSON.stringify({ version: 2, state: f.state }), JSON.stringify({ version: 1, state: [] })]) {
      await writeFile(f.ownerFile, text)
      await expect(f.store.read()).rejects.toThrow('runtime-owner-record-unverified')
    }
    expect(JSON.parse(await readFile(f.stateFile, 'utf8'))).toEqual(f.state)
  })
  it('reads a legacy owner until the next verified reuse backfills the record', async () => {
    const f = await fixture(false); await f.store.write(f.state)
    const scoped = createBrowserStateStore({ stateFile: f.stateFile, ownerFile: f.ownerFile, scoped: true })
    expect(await scoped.read()).toEqual(f.state)
    await expect(readFile(f.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await scoped.write(f.state)
    expect(JSON.parse(await readFile(f.ownerFile, 'utf8'))).toEqual({ version: 1, state: f.state })
  })
})
