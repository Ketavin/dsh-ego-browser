import { DRAFT_TEXT_LIMIT, inputModifiers, type JsonPayload } from './rc2-bridge.ts'

/** Native editing surface for the remote page; no draft or clipboard is retained. */
export function createDirectInputBridge(current: () => { active: boolean; identity: string },
  send: (type: string, payload: JsonPayload) => void, flush: () => void) {
  let composition: string | undefined
  let compositionTail: string | undefined
  const downs = new Set<string>()
  const insert = (field: HTMLInputElement, text = field.value) => {
    field.value = ''
    if (current().active && text && text.length <= DRAFT_TEXT_LIMIT) send('insertText', { text })
  }
  return {
    reset(field: HTMLInputElement | null) {
      composition = undefined; compositionTail = undefined; downs.clear()
      if (field) field.value = ''
    },
    onCompositionStart() { composition = current().active ? current().identity : undefined; compositionTail = undefined },
    onCompositionEnd(event: any) {
      const field = event.currentTarget as HTMLInputElement
      const text = field.value || String(event.data ?? event.nativeEvent?.data ?? '')
      const origin = composition
      composition = undefined; compositionTail = text
      if (origin === current().identity && current().active) insert(field, text)
      else field.value = ''
    },
    onInput(event: any) {
      if (composition !== undefined || event.nativeEvent?.isComposing) return
      const field = event.currentTarget as HTMLInputElement
      // Some engines emit a final input after compositionend. It belongs to
      // the same native commit; a subsequent physical key/paste clears this
      // receipt, so typing the same character twice remains two insertions.
      if (compositionTail !== undefined && field.value === compositionTail) {
        field.value = ''; compositionTail = undefined; return
      }
      compositionTail = undefined; insert(field)
    },
    onPaste(event: any) {
      event.preventDefault(); event.stopPropagation()
      compositionTail = undefined
      if (composition !== undefined) return
      insert(event.currentTarget, String(event.clipboardData?.getData('text/plain') ?? ''))
    },
    onKeyDown(event: any) {
      event.stopPropagation()
      if (!current().active || composition !== undefined || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return
      compositionTail = undefined
      const altGraph = event.getModifierState?.('AltGraph') === true
      const shortcut = (event.ctrlKey || event.metaKey || event.altKey) && !altGraph
      if ((event.key?.length === 1 && !shortcut) || ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'v')) return
      event.preventDefault()
      downs.add(String(event.code || event.key))
      send('keyDown', { key: String(event.key), code: String(event.code ?? ''), windowsVirtualKeyCode: Number(event.keyCode) || 0,
        modifiers: inputModifiers(event), autoRepeat: !!event.repeat })
    },
    onKeyUp(event: any) {
      event.stopPropagation()
      if (!downs.delete(String(event.code || event.key)) || !current().active) return
      event.preventDefault()
      send('keyUp', { key: String(event.key), code: String(event.code ?? ''), windowsVirtualKeyCode: Number(event.keyCode) || 0, modifiers: inputModifiers(event) })
    },
    onBlur(event: any) {
      composition = undefined; compositionTail = undefined; downs.clear()
      event.currentTarget.value = ''; flush()
    },
  }
}
