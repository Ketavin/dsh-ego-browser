import { describe, expect, it } from 'vitest'
import { ControlLease } from '../src/control-lease.ts'

describe('shared browser control lease', () => {
  it('holds human control across asynchronous input and rejects agent/foreign/old epoch actions', async () => {
    const lease = new ControlLease()
    const human = await lease.takeOver('A')
    let finish!: () => void
    const input = lease.runHuman('A', human.leaseEpoch, () => new Promise<void>(resolve => { finish = resolve }))
    await Promise.resolve()
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
    const rejected = expect(takeover).rejects.toThrow('cancellation-unverified')
    expect(signal.aborted).toBe(true)
    expect(lease.status('A').state).toBe('requesting-human')
    expect(() => lease.assertHuman('A', lease.status('A').leaseEpoch)).toThrow('human-control-required')
    finish(); await action; await rejected
    expect(lease.status('A').state).toBe('paused')
    expect(() => lease.arm('A', lease.status('A').leaseEpoch)).toThrow('cancellation-unverified')
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
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const next = lease.runHumanInput('A', human.leaseEpoch, 4, 'next-with-gap', async () => { nextCalls++ })
    const nextRejected = expect(next).rejects.toThrow('control-disposed')
    let drained = false
    const dispose = lease.dispose().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    finish(); await first; await nextRejected; await dispose
    expect(nextCalls).toBe(0); expect(drained).toBe(true)
    await expect(lease.runAgent('A', undefined, async () => {})).rejects.toThrow('control-disposed')
  })
})
