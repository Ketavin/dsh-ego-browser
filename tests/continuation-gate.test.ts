import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContinuationGate, type ContinuationAgent } from '../src/continuation-gate.ts'
import { ControlLease } from '../src/control-lease.ts'
import { SessionSpaceRegistry } from '../src/session-spaces.ts'

type Message = ContinuationAgent['inbox']['nextTurn'][number]
function agentFixture() {
  const nextTurn: Message[] = [], nextStep: Message[] = []
  const cancel = new AbortController()
  let busy = false, settled = false
  const agent: ContinuationAgent = { session: { id: 'A' }, inbox: { nextTurn, nextStep }, whenIdle: async () => {},
    runMaintenance(job) {
      if (busy) throw new Error('real phase busy despite public idle status')
      busy = true
      return job(cancel.signal).finally(() => { busy = false; settled = true })
    } }
  return { agent, nextTurn, nextStep, cancel, busy: () => busy, settled: () => settled, occupy: () => { busy = true } }
}
async function harness(ttl = 30_000) {
  const scopes = new SessionSpaceRegistry(); scopes.bind('A')
  const control = new ControlLease(), human = await control.takeOver('A')
  const fixture = agentFixture()
  let current: ContinuationAgent | undefined = fixture.agent
  const gate = new ContinuationGate(scopes, control, () => current, ttl)
  return { scopes, control, human, fixture, gate, replace: () => { current = agentFixture().agent } }
}
const message = (id: string, text: string): Message => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
afterEach(() => vi.useRealTimers())

describe('continuation admission at the public rc.2 maintenance seam (fixtures)', () => {
  it('blocks all browser tools until an actual new marked user message exists, then arms before releasing maintenance', async () => {
    const h = await harness()
    h.fixture.nextTurn.push(message('old', 'Previously queued work'))
    const receipt = await h.gate.prepare('A', h.human.leaseEpoch)
    expect(h.fixture.busy()).toBe(true)
    expect(h.control.status('A').state).toBe('paused')
    await expect(h.control.runAgent('A', undefined, async () => {})).rejects.toThrow('agent-control-blocked')
    expect(() => h.gate.commit('A', receipt.continuationId, receipt.leaseEpoch)).toThrow('continuation-admission-unverified')
    h.fixture.nextStep.push(message('new', receipt.marker))
    expect(h.gate.commit('A', receipt.continuationId, receipt.leaseEpoch).admitted).toBe(true)
    expect(h.control.status('A').state).toBe('armed')
    await Promise.resolve(); await Promise.resolve()
    expect(h.fixture.settled()).toBe(true)
    expect(h.fixture.nextTurn[0]!.id).toBe('old')
    await h.control.runAgent('A', undefined, async () => {})
  })
  it('does not accept a baseline identity, substring, non-user source or client claimed acceptance', async () => {
    const h = await harness()
    h.fixture.nextTurn.push(message('old', 'old'))
    const receipt = await h.gate.prepare('A', h.human.leaseEpoch)
    h.fixture.nextTurn[0] = message('old', receipt.marker)
    h.fixture.nextStep.push(message('substring', receipt.marker + ' extra'), { ...message('tool', receipt.marker), source: { kind: 'tool' } })
    expect(() => h.gate.commit('A', receipt.continuationId, receipt.leaseEpoch)).toThrow('continuation-admission-unverified')
    h.gate.dispose()
  })
  it('aborts after durable admission without deleting any message or granting browser control', async () => {
    const h = await harness(), receipt = await h.gate.prepare('A', h.human.leaseEpoch)
    h.fixture.nextTurn.push(message('new', receipt.marker))
    h.gate.abort('A', receipt.continuationId, receipt.leaseEpoch)
    expect(h.fixture.nextTurn).toHaveLength(1)
    expect(h.control.status('A').state).toBe('paused')
    expect(() => h.gate.commit('A', receipt.continuationId, receipt.leaseEpoch)).toThrow('continuation-not-owned')
    await expect(h.control.runAgent('A', undefined, async () => {})).rejects.toThrow('agent-control-blocked')
  })
  it('uses runMaintenance to detect another maintenance job even when whenIdle/status looks idle', async () => {
    const h = await harness(); h.fixture.occupy()
    await expect(h.gate.prepare('A', h.human.leaseEpoch)).rejects.toThrow('continuation-agent-busy')
    expect(h.control.status('A').state).toBe('human')
  })
  it('settles maintenance on cancel and timeout while retaining newly admitted messages', async () => {
    const h = await harness(), receipt = await h.gate.prepare('A', h.human.leaseEpoch)
    h.fixture.nextTurn.push(message('new', receipt.marker)); h.fixture.cancel.abort()
    await Promise.resolve(); await Promise.resolve()
    expect(h.fixture.settled()).toBe(true); expect(h.fixture.nextTurn).toHaveLength(1)
    expect(h.control.status('A').state).toBe('paused')
    const timed = await harness(5), timedReceipt = await timed.gate.prepare('A', timed.human.leaseEpoch)
    timed.fixture.nextTurn.push(message('new', timedReceipt.marker))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(timed.fixture.settled()).toBe(true); expect(timed.control.status('A').state).toBe('paused')
    expect(timed.fixture.nextTurn).toHaveLength(1)
  })
  it('refuses replacement Agent, foreign intent/epoch and disposed ownership', async () => {
    const h = await harness(), receipt = await h.gate.prepare('A', h.human.leaseEpoch)
    expect(() => h.gate.commit('A', 'other', receipt.leaseEpoch)).toThrow('continuation-not-owned')
    expect(() => h.gate.commit('A', receipt.continuationId, receipt.leaseEpoch - 1)).toThrow('continuation-not-owned')
    h.replace()
    expect(() => h.gate.commit('A', receipt.continuationId, receipt.leaseEpoch)).toThrow('continuation-stale')
    expect(h.control.status('A').state).toBe('paused')
    const disposed = await harness(), pending = await disposed.gate.prepare('A', disposed.human.leaseEpoch)
    disposed.gate.revoke('A'); disposed.scopes.revoke('A'); disposed.control.revoke('A')
    expect(() => disposed.gate.commit('A', pending.continuationId, pending.leaseEpoch)).toThrow('continuation-not-owned')
  })
})
