import { describe, expect, it } from 'vitest'
import { ACTION_FAILURE_SENTINEL, verifiedPreDispatchFailure } from '../src/action-outcome.ts'

describe('owned runtime pre-dispatch receipt', () => {
  const receipt = (requestId = 'current', phase = 'input-not-dispatched', version = 1) =>
    ACTION_FAILURE_SENTINEL + JSON.stringify({ requestId, phase, version })
  it('requires one complete versioned receipt for this exact call', () => {
    expect(verifiedPreDispatchFailure(receipt() + '\nElementResolutionError: matched 2 elements', 'current')).toBe(true)
    for (const text of [receipt('old'), receipt('current', 'unknown'), receipt('current', undefined, 2),
      receipt() + '\n' + receipt(), 'log prefix ' + receipt(), 'ElementResolutionError: matched 2 elements', ACTION_FAILURE_SENTINEL + '{']) {
      expect(verifiedPreDispatchFailure(text, 'current')).toBe(false)
    }
  })
})
