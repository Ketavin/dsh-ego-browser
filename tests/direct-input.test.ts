import { describe, it, expect, vi } from 'vitest'
import { createDirectInputBridge } from '../src/client/direct-input.ts'

function fixture() {
  const state = { active: true, identity: 'host:page:epoch' }, send = vi.fn(), flush = vi.fn()
  const bridge = createDirectInputBridge(() => state, send, flush)
  const field = { value: '' } as HTMLInputElement
  const event = (extra: object = {}) => ({ currentTarget: field, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra })
  return { state, send, flush, bridge, field, event }
}
describe('direct native page input', () => {
  it('inserts ordinary characters and repeated identical characters once each', () => {
    const f = fixture()
    for (let i = 0; i < 2; i++) {
      const key = f.event({ key: 'a', code: 'KeyA', keyCode: 65 })
      f.bridge.onKeyDown(key); expect(key.preventDefault).not.toHaveBeenCalled()
      f.field.value = 'a'; f.bridge.onInput(f.event())
      f.bridge.onKeyUp(key)
    }
    expect(f.send.mock.calls).toEqual([['insertText', { text: 'a' }], ['insertText', { text: 'a' }]])
    expect(f.field.value).toBe('')
  })
  it('commits IME once without forwarding candidates or the committing Enter', () => {
    const f = fixture()
    f.bridge.onCompositionStart(); f.field.value = 'zhong'
    f.bridge.onInput(f.event({ nativeEvent: { isComposing: true } }))
    f.bridge.onKeyDown(f.event({ key: 'Enter', code: 'Enter', keyCode: 229 }))
    expect(f.send).not.toHaveBeenCalled()
    f.field.value = '中文'; f.bridge.onCompositionEnd(f.event({ data: '中文' }))
    f.field.value = '中文'; f.bridge.onInput(f.event({ nativeEvent: { inputType: 'insertFromComposition' } }))
    f.bridge.onKeyUp(f.event({ key: 'Enter', code: 'Enter', keyCode: 13 }))
    expect(f.send.mock.calls).toEqual([['insertText', { text: '中文' }]])
    f.bridge.onKeyDown(f.event({ key: '文', code: 'KeyA' })); f.field.value = '文'; f.bridge.onInput(f.event())
    expect(f.send.mock.calls.at(-1)).toEqual(['insertText', { text: '文' }])
  })
  it('drops composition from an obsolete page, revoked lease or blur', () => {
    for (const invalidation of ['page', 'lease', 'blur']) {
      const f = fixture(); f.bridge.onCompositionStart(); f.field.value = '旧输入'
      if (invalidation === 'page') f.state.identity = 'new-page'
      if (invalidation === 'lease') f.state.active = false
      if (invalidation === 'blur') f.bridge.onBlur(f.event())
      f.bridge.onCompositionEnd(f.event({ data: '旧输入' }))
      f.field.value = '旧输入'; f.bridge.onInput(f.event())
      expect(f.send).not.toHaveBeenCalled()
    }
  })
  it('pastes plain multiline text once, preserving shortcut key pairs and releasing on blur', () => {
    const f = fixture(), ctrlV = f.event({ key: 'v', ctrlKey: true, code: 'KeyV' })
    f.bridge.onKeyDown(ctrlV); expect(ctrlV.preventDefault).not.toHaveBeenCalled()
    f.bridge.onPaste(f.event({ clipboardData: { getData: (type: string) => type === 'text/plain' ? '中文\nABC' : '<b>bad</b>' } }))
    const ctrlA = f.event({ key: 'a', ctrlKey: true, code: 'KeyA', keyCode: 65 })
    f.bridge.onKeyDown(ctrlA); f.bridge.onKeyUp(ctrlA); f.bridge.onBlur(f.event())
    expect(f.send.mock.calls).toEqual([['insertText', { text: '中文\nABC' }],
      ['keyDown', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, autoRepeat: false }],
      ['keyUp', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }]])
    expect(f.flush).toHaveBeenCalledOnce()
  })
})
