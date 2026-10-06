import { describe, expect, it, vi } from 'vitest'
import { ControlLease } from '../src/control-lease.ts'

describe('shared browser control lease', () => {
  it('recovers only after old work settles and the transport reset is proven, with new device/epoch fences', async () => {
    const lease = new ControlLease(), abort = new AbortController()
    let finish!: () => void, stopped!: () => void
    const work = lease.runAgent('A', abort.signal, () => new Promise<void>(resolve => { finish = resolve }))
    await Promise.resolve(); abort.abort()
    const old = lease.status('A').leaseEpoch
    const reset = vi.fn(() => new Promise<void>(resolve => { stopped = resolve }))
    await expect(lease.recover('B', old, 'b', reset)).rejects.toThrow('lease-not-owned')
    await expect(lease.recover('A', old - 1, 'a', reset)).rejects.toThrow('lease-epoch-stale')
    const recovery = lease.recover('A', old, 'a', reset)
    expect(lease.status('A').state).toBe('recovering')
    expect(reset).not.toHaveBeenCalled()
    await expect(lease.takeOver('A')).rejects.toThrow('control-busy')
    finish(); await work
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce())
    expect(() => lease.assertHuman('A', old, 'a')).toThrow('lease-not-owned')
    await expect(lease.runAgent('A', undefined, async () => {})).rejects.toThrow('agent-control-blocked')
    stopped(); const human = await recovery
    expect(human.state).toBe('human'); expect(human.recoveryRequired).toBe(false)
    expect(lease.heldBy('A', 'a')).toBe(true)
    expect(() => lease.assertHuman('A', human.leaseEpoch, 'b')).toThrow('lease-holder-mismatch')
    lease.assertHuman('A', human.leaseEpoch, 'a')
    const paused = lease.release('A', human.leaseEpoch, 'a')
    lease.arm('A', paused.leaseEpoch, 'a')
    await lease.runAgent('A', undefined, async () => {})
  })
  it('keeps the fuse after a failed reset or unfinished old work and allows an explicit retry', async () => {
    const lease = new ControlLease()
    await expect(lease.runAgent('A', undefined, async () => { throw Error('unknown') })).rejects.toThrow('unknown')
    const reset = vi.fn(async () => { throw Error('stop not proven') })
    await expect(lease.recover('A', lease.status('A').leaseEpoch, 'a', reset)).rejects.toThrow('stop not proven')
    expect(lease.status('A')).toMatchObject({ state: 'paused', recoveryRequired: true })
    expect(() => lease.arm('A', lease.status('A').leaseEpoch)).toThrow('cancellation-unverified')
    await lease.recover('A', lease.status('A').leaseEpoch, 'a', async () => {})
    expect(lease.status('A').state).toBe('human')
    const blocked = new ControlLease(), abort = new AbortController()
    let finish!: () => void
    const work = blocked.runAgent('A', abort.signal, () => new Promise<void>(resolve => { finish = resolve }))
    await Promise.resolve(); abort.abort()
    const untouched = vi.fn(async () => {})
    await expect(blocked.recover('A', blocked.status('A').leaseEpoch, 'a', untouched, false, 5)).rejects.toThrow('recovery-drain-timeout')
    expect(untouched).not.toHaveBeenCalled()
    finish(); await work
    expect(blocked.status('A').recoveryRequired).toBe(true)
  })
  it('never grants an obsolete recovery after session revocation or plugin disposal', async () => {
    const lease = new ControlLease()
    lease.revoke('unused')
    await expect(lease.runAgent('A', undefined, async () => { throw Error('unknown') })).rejects.toThrow()
    let finish!: () => void
    const recovery = lease.recover('A', lease.status('A').leaseEpoch, 'a', () => new Promise<void>(resolve => { finish = resolve }))
    const refused = expect(recovery).rejects.toThrow('recovery-obsolete')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const disposal = lease.dispose()
    finish(); await refused; await disposal
    expect(lease.status('A').state).toBe('paused')
    await expect(lease.takeOver('A')).rejects.toThrow('control-disposed')
  })
  it('holds human control across asynchronous input and rejects agent/foreign/old epoch actions', async () => {
    const lease = new ControlLease()
    const human = await lease.takeOver('A')
    let finish!: () => void
    const input = lease.runHuman('A', human.leaseEpoch, () => new Promise<void>(resolve => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(lease.runAgent('A', undefined, async () => {})).rejects.toThrow('agent-control-blocked')
    expect(() => lease.assertHuman('B', human.leaseEpoch)).toThrow('lease-not-owned')
    expect(() => lease.release('A', human.leaseEpoch)).toThrow('control-busy')
    finish(); await input
    const paused = lease.release('A', human.leaseEpoch)
    expect(paused.state).toBe('paused')
    await expect(lease.runAgent('A', undefined, async () => {})).rejects.toThrow('agent-control-blocked')
    const armed = lease.arm('A', paused.leaseEpoch)
    await expect(lease.runAgent('B', undefined, async () => {})).rejects.toThrow('agent-control-blocked')
    await lease.runAgent('A', undefined, async () => {})
    expect(lease.status('A').state).toBe('idle')
    expect(armed.leaseEpoch).toBeGreaterThan(human.leaseEpoch)
  })
  it('aborts then waits for the actual operation completion without claiming CDP revocation', async () => {
    const lease = new ControlLease()
    let finish!: () => void, signal!: AbortSignal
    const action = lease.runAgent('A', undefined, async s => { signal = s; await new Promise<void>(resolve => { finish = resolve }) })
    await Promise.resolve()
    const takeover = lease.takeOver('A')
    const rejected = expect(takeover).rejects.toThrow('takeover-interrupted-run')
    expect(signal.aborted).toBe(true)
    expect(lease.status('A').state).toBe('requesting-human')
    expect(() => lease.assertHuman('A', lease.status('A').leaseEpoch)).toThrow('human-control-required')
    finish(); await action; await rejected
    expect(lease.status('A').state).toBe('paused')
    expect(() => lease.arm('A', lease.status('A').leaseEpoch)).toThrow('cancellation-unverified')
  })
  it('distinguishes a fresh interrupted operation from a denial on an already unsafe-paused lease', async () => {
    const lease = new ControlLease()
    let finish!: () => void, aborted = 0
    const action = lease.runAgent('A', undefined, async signal => {
      signal.addEventListener('abort', () => { aborted++ })
      await new Promise<void>(resolve => { finish = resolve })
    })
    await Promise.resolve()
    // Fresh interruption: THIS takeover aborts a live browser operation and
    // fails closed with the explicit interrupted-run receipt.
    const fresh = expect(lease.takeOver('A')).rejects.toThrow('takeover-interrupted-run')
    await vi.waitFor(() => expect(aborted).toBe(1))
    finish(); await action; await fresh
    expect(lease.status('A').state).toBe('paused')
    const epochAfterInterruption = lease.status('A').leaseEpoch
    // A later takeover attempt on the already unsafe-paused lease is refused
    // BEFORE any new interruption: same fail-closed pause, but the plain
    // cancellation-unverified denial claims no fresh interruption.
    await expect(lease.takeOver('A', 5)).rejects.toThrow('cancellation-unverified')
    expect(aborted, 'no browser operation existed to abort').toBe(1)
    expect(lease.status('A').leaseEpoch).toBe(epochAfterInterruption)
    expect(lease.status('A').state).toBe('paused')
  })
  it('keeps the fence after a cancellation timeout or external agent abort', async () => {
    const lease = new ControlLease()
    let finish!: () => void
    const action = lease.runAgent('A', undefined, () => new Promise<void>(resolve => { finish = resolve }))
    await Promise.resolve()
    await expect(lease.takeOver('A', 5)).rejects.toThrow('takeover-timeout')
    expect(lease.status('A').state).toBe('paused')
    finish(); await action
    expect(lease.status('A').state).toBe('paused')
    const other = new ControlLease(), abort = new AbortController()
    await other.runAgent('A', abort.signal, async () => { abort.abort() })
    expect(other.status('A').state).toBe('paused')
  })
  it('expires human input without automatically resuming or arming an Agent', async () => {
    let now = 1
    const lease = new ControlLease(() => now, 10)
    const human = await lease.takeOver('A')
    now = 20
    expect(() => lease.assertHuman('A', human.leaseEpoch)).toThrow('lease-not-owned')
    expect(lease.status('A').state).toBe('paused')
    await expect(lease.runAgent('A', undefined, async () => {})).rejects.toThrow('agent-control-blocked')
    expect((await lease.takeOver('A')).state).toBe('human')
  })
  it('deduplicates an in-flight intent without retrying it', async () => {
    const lease = new ControlLease()
    let calls = 0
    const first = lease.once('A', 'same-intent', 'navigate', async () => ++calls)
    expect(lease.once('A', 'same-intent', 'navigate', async () => ++calls)).toBe(first)
    expect(await first).toBe(1)
    expect(calls).toBe(1)
  })
  it('binds idempotent receipts to the requesting device and never serves another device', async () => {
    const lease = new ControlLease(), human = await lease.takeOver('A', 5000, 'device-A')
    let reads = 0
    // Mirror the route shape: the cached operation itself re-asserts the lease.
    const read = (holder: string) => lease.once('A', 'same-request', `context:${human.leaseEpoch}`, () =>
      lease.runHuman('A', human.leaseEpoch, async () => ({ ok: true, text: `page-${++reads}` }), holder), holder)
    const first = read('device-A')
    expect(read('device-A'), 'same-device retry keeps its receipt').toBe(first)
    // A second device replaying the SAME requestId misses the cache and faces
    // the holder fence inside the operation instead of the cached page text.
    await expect(read('device-B')).rejects.toThrow('lease-holder-mismatch')
    expect(await first).toEqual({ ok: true, text: 'page-1' })
    expect(reads).toBe(1)
  })
  it('accepts more than 1024 settled inputs while rejecting evicted sequences and old epochs', async () => {
    const lease = new ControlLease(() => 1)
    const human = await lease.takeOver('A')
    let dispatched = 0
    for (let sequence = 1; sequence <= 1200; sequence++) {
      await lease.runHumanInput('A', human.leaseEpoch, sequence, `input-${sequence}`, async () => ++dispatched)
    }
    expect(dispatched).toBe(1200)
    expect(await lease.runHumanInput('A', human.leaseEpoch, 1200, 'input-1200', async () => ++dispatched)).toBe(1200)
    expect(dispatched).toBe(1200)
    expect(() => lease.runHumanInput('A', human.leaseEpoch, 1, 'input-1', async () => ++dispatched)).toThrow('input-sequence-stale')
    lease.release('A', human.leaseEpoch)
    expect(() => lease.runHumanInput('A', human.leaseEpoch, 1201, 'old-epoch', async () => ++dispatched)).toThrow('lease-not-owned')
  })
  it('never evicts an in-flight promise and releases cache capacity after settling', async () => {
    const lease = new ControlLease()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const flights = Array.from({ length: 1024 }, (_, i) => lease.once('A', String(i), 'fixture', () => pending))
    expect(lease.once('A', '0', 'fixture', async () => {})).toBe(flights[0])
    expect(() => lease.once('A', 'new', 'fixture', async () => {})).toThrow('request-cache-busy')
    finish(); await Promise.all(flights)
    await expect(lease.once('A', 'new', 'fixture', async () => 'accepted')).resolves.toBe('accepted')
  })
  it('requires successful releases on the same target and keeps uncertain human input paused', async () => {
    const lease = new ControlLease(), human = await lease.takeOver('A')
    lease.noteInput({ targetId: 'one', type: 'keyDown', key: 'Shift', code: 'ShiftLeft' }, false)
    lease.noteInput({ targetId: 'two', type: 'keyUp', key: 'Shift', code: 'ShiftLeft' }, true)
    expect(() => lease.release('A', human.leaseEpoch)).toThrow('human-input-held')
    expect(() => lease.prepareContinuation('A', human.leaseEpoch)).toThrow('human-input-held')
    lease.noteInput({ targetId: 'one', type: 'keyUp', key: 'Shift', code: 'ShiftLeft' }, false)
    expect(() => lease.release('A', human.leaseEpoch)).toThrow('human-input-held')
    lease.noteInput({ targetId: 'one', type: 'keyUp', key: 'Shift', code: 'ShiftLeft' }, true)
    expect(lease.release('A', human.leaseEpoch).state).toBe('paused')
    const uncertain = new ControlLease(), control = await uncertain.takeOver('A')
    await expect(uncertain.runHumanInput('A', control.leaseEpoch, 1, 'uncertain', async () => { throw new Error('receipt lost') })).rejects.toThrow('receipt lost')
    expect(uncertain.status('A').state).toBe('paused')
    await expect(uncertain.takeOver('A')).rejects.toThrow('cancellation-unverified')
    expect(() => uncertain.arm('A', uncertain.status('A').leaseEpoch)).toThrow('cancellation-unverified')
  })
  it('drains pending work on disposal and rejects a queued action before dispatch', async () => {
    const lease = new ControlLease(), human = await lease.takeOver('A')
    let finish!: () => void, nextCalls = 0
    const first = lease.runHumanInput('A', human.leaseEpoch, 1, 'first', () => new Promise<void>(resolve => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const next = lease.runHumanInput('A', human.leaseEpoch, 4, 'next-with-gap', async () => { nextCalls++ })
    const nextRejected = expect(next).rejects.toThrow('control-disposed')
    let drained = false
    const dispose = lease.dispose().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    finish(); await first; await nextRejected; await dispose
    expect(nextCalls).toBe(0); expect(drained).toBe(true)
    await expect(lease.runAgent('A', undefined, async () => {})).rejects.toThrow('control-disposed')
  })
  it('waits for human membership refresh before exactly-once ordered down/up/text input', async () => {
    const lease = new ControlLease(), human = await lease.takeOver('A')
    const events: string[] = []
    let finish!: () => void
    const refresh = lease.runHuman('A', human.leaseEpoch, () => new Promise<void>(resolve => {
      events.push('refresh'); finish = resolve
    }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const down = lease.runHumanInput('A', human.leaseEpoch, 1, 'down', async () => { events.push('down'); lease.noteInput({ targetId: 'one', type: 'mousePressed' }, true) })
    expect(lease.runHumanInput('A', human.leaseEpoch, 1, 'down', async () => { events.push('duplicate') })).toBe(down)
    const up = lease.runHumanInput('A', human.leaseEpoch, 2, 'up', async () => { events.push('up'); lease.noteInput({ targetId: 'one', type: 'mouseReleased' }, true) })
    const text = lease.runHumanInput('A', human.leaseEpoch, 3, 'text', async () => { events.push('text') })
    const context = lease.runHuman('A', human.leaseEpoch, async () => { events.push('context') })
    expect(() => lease.release('A', human.leaseEpoch)).toThrow('control-busy')
    expect(() => lease.prepareContinuation('A', human.leaseEpoch)).toThrow('control-busy')
    expect(events).toEqual(['refresh'])
    finish(); await Promise.all([refresh, down, up, text, context])
    // once() admits input on a microtask, but all input remains ordered and reads never overlap it.
    expect(events[0]).toBe('refresh'); expect(events.filter(event => ['down', 'up', 'text'].includes(event))).toEqual(['down', 'up', 'text'])
    expect(events).not.toContain('duplicate')
    expect(lease.release('A', human.leaseEpoch).state).toBe('paused')
  })
  it('rechecks the exact lease after a refresh, refusing revoked queued input without dispatch', async () => {
    const lease = new ControlLease(), human = await lease.takeOver('A')
    let finish!: () => void, dispatched = 0
    const refresh = lease.runHuman('A', human.leaseEpoch, () => new Promise<void>(resolve => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const input = lease.runHumanInput('A', human.leaseEpoch, 1, 'queued-before-revoke', async () => { dispatched++ })
    const refused = expect(input).rejects.toThrow('lease-not-owned')
    lease.revoke('A'); finish(); await refresh; await refused
    expect(dispatched).toBe(0); expect(lease.status('A').state).toBe('paused')
  })
  it('bounds queued human refreshes and drains them without dispatch after disposal', async () => {
    const lease = new ControlLease(), human = await lease.takeOver('A')
    let finish!: () => void, dispatched = 0
    const first = lease.runHuman('A', human.leaseEpoch, () => new Promise<void>(resolve => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const queue = Array.from({ length: 1023 }, () => lease.runHuman('A', human.leaseEpoch, async () => { dispatched++ }))
    const settled = Promise.allSettled(queue)
    await expect(lease.runHuman('A', human.leaseEpoch, async () => {})).rejects.toThrow('control-busy')
    const disposal = lease.dispose(); finish(); await first; await disposal
    expect((await settled).every(result => result.status === 'rejected')).toBe(true)
    expect(dispatched).toBe(0)
  })
  it('fences new producers while release drains refresh and already-admitted input exactly once', async () => {
    const lease = new ControlLease(), human = await lease.takeOver('A')
    let finish!: () => void, dispatched = 0
    const refresh = lease.runHuman('A', human.leaseEpoch, () => new Promise<void>(resolve => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const input = lease.runHumanInput('A', human.leaseEpoch, 1, 'admitted', async () => { dispatched++ })
    const release = lease.withHumanDrain('A', human.leaseEpoch, async () => lease.release('A', human.leaseEpoch))
    expect(lease.runHumanInput('A', human.leaseEpoch, 1, 'admitted', async () => { dispatched++ })).toBe(input)
    expect(() => lease.runHumanInput('A', human.leaseEpoch, 2, 'new-input', async () => { dispatched++ })).toThrow('control-busy')
    await expect(lease.runHuman('A', human.leaseEpoch, async () => {})).rejects.toThrow('control-busy')
    finish(); await refresh; await input
    expect((await release).state).toBe('paused'); expect(dispatched).toBe(1)
  })
  it('rechecks revoked leases and held inputs after an explicit drain before release', async () => {
    const lease = new ControlLease(), human = await lease.takeOver('A')
    let finish!: () => void, transitions = 0
    const refresh = lease.runHuman('A', human.leaseEpoch, () => new Promise<void>(resolve => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const drain = lease.withHumanDrain('A', human.leaseEpoch, async () => { transitions++ })
    const refused = expect(drain).rejects.toThrow('lease-not-owned')
    lease.revoke('A'); finish(); await refresh; await refused; expect(transitions).toBe(0)
    const other = new ControlLease(), control = await other.takeOver('A')
    other.noteInput({ targetId: 'one', type: 'keyDown', key: 'Shift' }, true)
    await expect(other.withHumanDrain('A', control.leaseEpoch, async () => other.release('A', control.leaseEpoch))).rejects.toThrow('human-input-held')
    expect(other.status('A').state).toBe('human')
  })
  it('times out an explicit drain without dispatching the transition or removing the queue fence', async () => {
    const lease = new ControlLease(), human = await lease.takeOver('A')
    let finish!: () => void, transitions = 0
    const refresh = lease.runHuman('A', human.leaseEpoch, () => new Promise<void>(resolve => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(lease.withHumanDrain('A', human.leaseEpoch, async () => { transitions++ }, 5)).rejects.toThrow('control-drain-timeout')
    expect(transitions).toBe(0); expect(() => lease.release('A', human.leaseEpoch)).toThrow('control-busy')
    finish(); await refresh; expect(lease.release('A', human.leaseEpoch).state).toBe('paused')
  })
})

describe('client device ownership of the human lease', () => {
  it('binds human control to the taking device and refuses a second device of the same session', async () => {
    const lease = new ControlLease()
    const a = await lease.takeOver('A', 5000, 'device-A')
    expect(lease.heldBy('A', 'device-A')).toBe(true)
    expect(lease.heldBy('A', 'device-B')).toBe(false)
    expect(lease.heldBy('B', 'device-A')).toBe(false)
    // The same device retakes idempotently; the other device can neither grab nor share.
    expect((await lease.takeOver('A', 5000, 'device-A')).leaseEpoch).toBe(a.leaseEpoch)
    await expect(lease.takeOver('A', 5000, 'device-B')).rejects.toThrow('lease-held-elsewhere')
    // Every human-lease operation refuses the second device...
    expect(() => lease.assertHuman('A', a.leaseEpoch, 'device-B')).toThrow('lease-holder-mismatch')
    await expect(lease.runHuman('A', a.leaseEpoch, async () => 'x', 'device-B')).rejects.toThrow('lease-holder-mismatch')
    expect(() => lease.runHumanInput('A', a.leaseEpoch, 1, 'b-input', async () => {}, 'device-B')).toThrow('lease-holder-mismatch')
    await expect(lease.withHumanDrain('A', a.leaseEpoch, async () => {}, 5, 'device-B')).rejects.toThrow('lease-holder-mismatch')
    expect(() => lease.release('A', a.leaseEpoch, 'device-B')).toThrow('lease-holder-mismatch')
    // ...while the holding device and host-internal calls (no identity) proceed.
    expect(await lease.runHuman('A', a.leaseEpoch, async () => 'ok', 'device-A')).toBe('ok')
    expect(await lease.runHuman('A', a.leaseEpoch, async () => 'host')).toBe('host')
    expect(() => lease.runHumanInput('A', a.leaseEpoch, 1, 'a-input', async () => {}, 'device-A')).toBeTypeOf('function')
  })
  it('keeps the holder across release so only that device can prepare, arm, or abort the continuation', async () => {
    const lease = new ControlLease(), a = await lease.takeOver('A', 5000, 'device-A')
    const paused = lease.release('A', a.leaseEpoch, 'device-A')
    expect(paused.state).toBe('paused')
    // Two-phase continuation belongs to the releasing device alone.
    expect(() => lease.assertContinuationReady('A', paused.leaseEpoch, 'device-B')).toThrow('lease-holder-mismatch')
    const prepared = lease.prepareContinuation('A', paused.leaseEpoch, 'device-A')
    expect(prepared.state).toBe('paused')
    expect(() => lease.arm('A', prepared.leaseEpoch, 'device-B')).toThrow('lease-holder-mismatch')
    expect(lease.arm('A', prepared.leaseEpoch, 'device-A').state).toBe('armed')
    // A foreign abort of a human lease is a silent no-op, never a state change.
    const again = await lease.takeOver('A', 5000, 'device-A')
    lease.abortContinuation('A', again.leaseEpoch, 'device-B')
    expect(lease.status('A').state).toBe('human')
    lease.abortContinuation('A', again.leaseEpoch, 'device-A')
    expect(lease.status('A').state).toBe('paused')
  })
  it('rebinds the holder after release, expiry, revoke or an agent run — old identities never survive', async () => {
    let now = 1
    const lease = new ControlLease(() => now, 10)
    const a = await lease.takeOver('A', 5000, 'device-A')
    lease.release('A', a.leaseEpoch, 'device-A')
    // After an explicit release another device may TAKE OVER (contention → release → reacquire);
    // the previous holder's operations are then the refused ones.
    const b = await lease.takeOver('A', 5000, 'device-B')
    expect(lease.heldBy('A', 'device-B')).toBe(true)
    expect(() => lease.assertHuman('A', b.leaseEpoch, 'device-A')).toThrow('lease-holder-mismatch')
    // TTL expiry drops the holder with the lease; either device may retake.
    now = 1000
    expect(lease.status('A').state).toBe('paused')
    expect(lease.heldBy('A', 'device-B')).toBe(false)
    const c = await lease.takeOver('A', 5000, 'device-A')
    expect(lease.heldBy('A', 'device-A')).toBe(true)
    // Session revocation clears the holder identity (a revoked lease stays
    // fail-closed for takeover, so nothing here may act on the stale identity).
    lease.revoke('A')
    expect(lease.heldBy('A', 'device-A')).toBe(false)
    expect(() => lease.assertHuman('A', c.leaseEpoch, 'device-A')).toThrow()
    // An armed continuation resumed by an agent run clears the holder too.
    const second = new ControlLease()
    const held = await second.takeOver('S', 5000, 'device-A')
    second.release('S', held.leaseEpoch, 'device-A')
    expect(second.arm('S', second.status('S').leaseEpoch, 'device-A').state).toBe('armed')
    await second.runAgent('S', undefined, async () => {})
    expect(second.heldBy('S', 'device-A')).toBe(false)
  })
})
