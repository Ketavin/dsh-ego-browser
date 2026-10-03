/** Isolated rc.2 Sidebar UI. Each mounted tab owns one immutable Session scope. */
import {
  browserCoordinates, createConversationBridge, createInputDispatcher, createKeyboardInput, createScopedTransport,
  inputModifiers, releaseHumanOnDispose, requireScope, safePageUrl,
  type EgoScope, type JsonPayload, type Rc2Sessions,
} from './rc2-bridge.ts'
declare function require(id: string): any

interface Target { targetId: string; url: string; title: string; viewportW?: number; viewportH?: number }
interface Control { state: string; sessionId?: string; leaseEpoch: number; expiresAt?: number }
interface ClientContext {
  get?(name: string): any
  inject?(services: string[], callback: (ctx: ClientContext) => void): void
  effect(operation: () => (() => void) | void, label?: string): unknown
}

/** One metadata-only stream for public running rows, without opening histories. */
export function subscribeAutoOpen(sessions: any, sidebar: any,
  connect: (url: string) => Pick<EventSource, 'addEventListener' | 'close'> = url => new EventSource(url)): () => void {
  if (!sessions.list?.subscribe || !sessions.list?.getSnapshot) return () => {}
  const opened = new Set<string>()
  let source: ReturnType<typeof connect> | undefined
  let selected = ''
  let disposed = false
  const reconcile = () => {
    if (disposed) return
    const snapshot = sessions.list.getSnapshot()
    const ids = Object.keys(snapshot.byId ?? {}).filter(id => snapshot.byId[id]?.running === true).sort().slice(0, 256)
    const key = JSON.stringify(ids)
    if (key === selected) return
    selected = key; source?.close(); source = undefined
    for (const entry of opened) if (!ids.some(id => entry.endsWith(`:${id}`))) opened.delete(entry)
    if (ids.length === 0) return
    const current = connect(`/api/ego/tool-events?${new URLSearchParams({ sessionIds: key })}`)
    source = current
    current.addEventListener('tool-call', event => {
      if (disposed || source !== current) return
      try {
        const data = JSON.parse((event as MessageEvent).data)
        const identity = `${data.hostGeneration}:${data.sessionId}`
        if (typeof data.hostGeneration !== 'string' || !data.hostGeneration || !ids.includes(data.sessionId)
          || !Number.isSafeInteger(data.count) || data.count < 1 || opened.has(identity)
          || sessions.list.getSnapshot().byId[data.sessionId]?.running !== true
          || sidebar.isTabEnabled('ego-browser:watch') !== true) return
        sidebar.openTab({ type: 'ego-browser:watch' }, { sessionId: data.sessionId })
        opened.add(identity)
      } catch { /* malformed metadata never changes a Session selection */ }
    })
  }
  const off = sessions.list.subscribe(reconcile)
  reconcile()
  return () => { disposed = true; off(); source?.close(); source = undefined; opened.clear() }
}

export function validTargets(value: unknown): Target[] {
  return Array.isArray(value) ? value.filter((entry): entry is Target => entry !== null && typeof entry === 'object'
    && typeof entry.targetId === 'string' && entry.targetId !== '' && typeof entry.url === 'string'
    && typeof entry.title === 'string').slice(0, 30) : []
}

export function frameSource(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4_000_000) return
  const base64 = value.startsWith('data:image/jpeg;base64,') ? value.slice(23) : value
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length === 0) return
  return `data:image/jpeg;base64,${base64}`
}

export function applyRc2(ctx: ClientContext): void {
  const React = require('react')
  const sessions = ctx.get?.('sessions') as Rc2Sessions | undefined
  if (sessions === undefined || typeof sessions.binding !== 'function') return
  const h = React.createElement
  const bridges = new Map<string, ReturnType<typeof createConversationBridge>>()
  const transportFor = (scope: EgoScope) => createScopedTransport(requireScope(scope))
  const bridgeFor = (scope: EgoScope) => {
    const id = requireScope(scope).sessionId
    let bridge = bridges.get(id)
    if (bridge === undefined) { bridge = createConversationBridge(sessions, transportFor(scope)); bridges.set(id, bridge) }
    return bridge
  }

  function WatchTab(props: { scope: EgoScope; visible: boolean }) {
    const sessionId = requireScope(props.scope).sessionId
    const transport = React.useMemo(() => transportFor({ sessionId }), [sessionId])
    const [targets, setTargets] = React.useState([] as Target[])
    const [targetId, setTargetId] = React.useState('')
    const [generation, setGeneration] = React.useState('')
    const [control, setControl] = React.useState({ state: 'idle', leaseEpoch: 0 } as Control)
    const [frame, setFrame] = React.useState(undefined as string | undefined)
    const [size, setSize] = React.useState({ width: 0, height: 0 })
    const [url, setUrl] = React.useState('')
    const [message, setMessage] = React.useState('本会话 Agent 浏览器。')
    const [busy, setBusy] = React.useState(false)
    const [mode, setMode] = React.useState('queue' as 'queue' | 'steer')
    const keyboard = React.useRef(null as HTMLTextAreaElement | null)
    const image = React.useRef(null as HTMLImageElement | null)
    const mounted = React.useRef(true)
    const pending = React.useRef(false)
    const submissionIntents = React.useRef(new Map<string, string>())
    const refreshSequence = React.useRef(0)
    const lastPointer = React.useRef(undefined as { x: number; y: number } | undefined)
    const clicks = React.useRef({ time: 0, targetId: '', button: 0, x: 0, y: 0, count: 0 })
    const live = React.useRef({ visible: props.visible, targetId, control, generation })
    live.current = { visible: props.visible, targetId, control, generation }
    const human = props.visible && control.state === 'human' && control.sessionId === sessionId
    const notice = (value: string) => { if (mounted.current) setMessage(value) }
    const dispatcher = React.useRef(undefined as ReturnType<typeof createInputDispatcher> | undefined)
    dispatcher.current ??= createInputDispatcher(transport, captured => {
      const now = live.current
      // Visibility/busy stop producers, while already accepted input drains.
      return now.targetId === captured.targetId
        && now.control.state === 'human' && now.control.sessionId === sessionId
        && now.control.leaseEpoch === captured.leaseEpoch && now.generation === captured.hostGeneration
    }, () => notice('人工输入未送达；请确认接管状态。'))
    const flushInput = () => dispatcher.current!.flush()
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [sessionId])
    React.useEffect(() => {
      if (props.visible) return () => {
        const { control: current, generation: capturedGeneration, targetId: capturedTarget } = live.current
        if (current.state === 'human' && current.sessionId === sessionId) {
          void releaseHumanOnDispose(transport, { targetId: capturedTarget, leaseEpoch: current.leaseEpoch,
            hostGeneration: capturedGeneration }, flushInput).catch(() => notice('接管释放未确认；浏览器继续保持受限。'))
        }
      }
    }, [props.visible, transport])
    const refresh = async (signal?: AbortSignal) => {
      const revision = ++refreshSequence.current
      const [lease, spaces] = await Promise.allSettled([
        transport.get('/api/ego/control/status', signal), transport.get('/api/ego/spaces', signal),
      ])
      if (!mounted.current || signal?.aborted || revision !== refreshSequence.current) return
      if (lease.status !== 'fulfilled' || spaces.status !== 'fulfilled'
        || typeof lease.value.hostGeneration !== 'string' || !lease.value.hostGeneration
        || lease.value.hostGeneration !== spaces.value.hostGeneration) {
        setControl({ state: 'paused', leaseEpoch: 0 }); setTargets([]); setTargetId(''); setGeneration(''); return
      }
      const nextControl = lease.value.control
      if (!nextControl || typeof nextControl !== 'object' || !Number.isSafeInteger(nextControl.leaseEpoch)) {
        setControl({ state: 'paused', leaseEpoch: 0 }); return
      }
      // Neither an older polling result nor a delayed SSE may lower the lease.
      setControl((previous: Control) => live.current.generation === lease.value.hostGeneration
        && previous.leaseEpoch > nextControl.leaseEpoch ? previous : nextControl)
      setGeneration(lease.value.hostGeneration)
      const next = spaces.status === 'fulfilled' ? validTargets(spaces.value.spaces) : []
      setTargets(next)
      setTargetId((previous: string) => next.some(target => target.targetId === previous) ? previous : next[0]?.targetId ?? '')
    }
    React.useEffect(() => {
      if (!props.visible) return
      const abort = new AbortController()
      void refresh(abort.signal).catch(() => { if (!abort.signal.aborted) notice('浏览器通道尚未就绪；未启动共享浏览器。') })
      const timer = window.setInterval(() => { void refresh(abort.signal).catch(() => {}) }, 2500)
      return () => { abort.abort(); window.clearInterval(timer) }
    }, [props.visible, transport])

    React.useEffect(() => {
      setFrame(undefined)
      if (!props.visible || !targetId || !generation) return
      const abort = new AbortController()
      const clientId = `sidebar:${sessionId}:${crypto.randomUUID()}`
      let source: EventSource | undefined
      let renew: number | undefined
      const started = transport.post('/api/ego/watch/start', { clientId, targetId, hostGeneration: generation }, abort.signal)
      void started.then(() => {
        if (abort.signal.aborted) return
        source = new EventSource(transport.route('/api/ego/stream', { targetId, hostGeneration: generation }))
        source.addEventListener('frame', event => {
          if (abort.signal.aborted || live.current.generation !== generation) return
          try {
            const data = JSON.parse((event as MessageEvent).data) as JsonPayload
            if (data.sessionId !== sessionId || data.hostGeneration !== generation || data.targetId !== targetId) return
            const src = frameSource(data.data ?? data.frame)
            if (src === undefined) return
            setFrame(src)
            const width = Number(data.vw), height = Number(data.vh)
            if (width > 0 && height > 0) setSize({ width, height })
          } catch { /* malformed external frame ignored */ }
        })
        source.addEventListener('control', event => {
          if (abort.signal.aborted || live.current.generation !== generation) return
          try {
            const data = JSON.parse((event as MessageEvent).data)
            if (data.sessionId === sessionId && data.hostGeneration === generation && data.control
              && Number.isSafeInteger(data.control.leaseEpoch)) setControl((previous: Control) =>
                previous.leaseEpoch > data.control.leaseEpoch ? previous : data.control)
          } catch { /* no optimistic input permission */ }
        })
        renew = window.setInterval(() => { void transport.post('/api/ego/watch/start', { clientId, targetId, hostGeneration: generation }).catch(() => {}) }, 5000)
      }).catch(() => { if (!abort.signal.aborted) notice('本会话画面暂不可用，未切换到其他页面。') })
      return () => {
        abort.abort(); source?.close(); if (renew !== undefined) window.clearInterval(renew)
        void transport.post('/api/ego/watch/stop', { clientId, targetId, hostGeneration: generation }).catch(() => {})
      }
    }, [props.visible, targetId, generation, transport])

    const action = async (run: () => Promise<unknown>, success: string) => {
      if (pending.current) return
      pending.current = true; setBusy(true)
      try { await flushInput(); await run(); notice(success); await refresh() }
      catch (error) {
        const code = error instanceof Error ? error.message : 'browser-error'
        notice(code.startsWith('conversation-') && code.endsWith('-unconfirmed')
          ? '提交回执未确认；请先在主对话核实。相同页面再次点击会沿用本次请求，避免重送。'
          : `操作未完成：${code}`)
      }
      finally { pending.current = false; if (mounted.current) setBusy(false) }
    }
    const sendInput = (type: string, payload: JsonPayload) => {
      const current = live.current
      if (!mounted.current || pending.current || !current.visible || !current.targetId
        || current.control.state !== 'human' || current.control.sessionId !== sessionId) return
      const captured = { targetId: current.targetId, leaseEpoch: current.control.leaseEpoch, hostGeneration: current.generation }
      dispatcher.current!.enqueue(captured, type, payload)
    }
    const pointer = (event: any, type: string) => {
      if (!human || pending.current || image.current === null) return
      const xy = browserCoordinates(event, image.current.getBoundingClientRect(), size)
        ?? (type === 'mouseReleased' ? lastPointer.current : undefined)
      if (xy === undefined) return
      lastPointer.current = xy
      if (type === 'mousePressed') {
        const previous = clicks.current, time = Date.now()
        const repeat = previous.targetId === targetId && previous.button === event.button && time - previous.time < 500
          && Math.abs(previous.x - xy.x) < 5 && Math.abs(previous.y - xy.y) < 5
        clicks.current = { time, targetId, button: event.button, ...xy, count: repeat ? Math.min(previous.count + 1, 3) : 1 }
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        keyboard.current?.focus({ preventScroll: true })
      }
      if (type === 'mouseReleased') event.currentTarget.releasePointerCapture?.(event.pointerId)
      sendInput(type, { ...xy, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
        buttons: event.buttons, clickCount: clicks.current.count || 1, modifiers: inputModifiers(event) })
    }
    const keyInput = React.useRef(undefined as ReturnType<typeof createKeyboardInput> | undefined)
    keyInput.current ??= createKeyboardInput(sendInput)
    const submitPage = async (continueAfterHuman: boolean) => {
      const key = JSON.stringify([continueAfterHuman, targetId, generation])
      let intent = submissionIntents.current.get(key)
      if (!intent) { intent = crypto.randomUUID(); submissionIntents.current.set(key, intent) }
      try {
        const result = await bridgeFor({ sessionId }).submit(intent, mode,
          continueAfterHuman ? { leaseEpoch: control.leaseEpoch, hostGeneration: generation } : undefined,
          { targetId, hostGeneration: generation, ...(human ? { leaseEpoch: control.leaseEpoch } : {}) },
          () => mounted.current && live.current.visible)
        submissionIntents.current.delete(key)
        return result
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith('-unconfirmed')) submissionIntents.current.delete(key)
        throw error
      }
    }
    const takeOver = async () => {
      const result = await bridgeFor({ sessionId }).takeOver(crypto.randomUUID(), generation, control.leaseEpoch)
      if (!mounted.current || !live.current.visible) {
        const granted = result.control as Control | undefined
        if (granted?.state === 'human' && granted.sessionId === sessionId
          && Number.isSafeInteger(granted.leaseEpoch) && typeof result.hostGeneration === 'string') {
          await releaseHumanOnDispose(transport, { targetId, leaseEpoch: granted.leaseEpoch,
            hostGeneration: result.hostGeneration }, flushInput)
        }
        throw new Error('takeover-view-closed')
      }
      return result
    }
    const button = (label: string, run: () => Promise<unknown>, success: string, disabled = false) => h('button', {
      type: 'button', disabled: busy || disabled, onClick: () => { void action(run, success) },
    }, label)
    return h('div', { className: 'dsh-ego-rc2', 'data-ego-session': sessionId },
      h('form', { onSubmit: (event: any) => {
        event.preventDefault()
        void action(() => transport.post('/api/ego/navigate', { url, requestId: crypto.randomUUID(),
          ...(generation ? { hostGeneration: generation } : {}), ...(targetId ? { targetId } : {}),
          ...(human ? { leaseEpoch: control.leaseEpoch } : {}) }), '本会话页面已打开。')
      } }, h('input', { type: 'url', 'aria-label': 'Agent 网页地址', required: true, value: url,
        onChange: (event: any) => setUrl(event.target.value), placeholder: 'https://…', disabled: busy }),
      h('button', { type: 'submit', disabled: busy }, '打开')),
      h('div', { className: 'dsh-ego-rc2-controls' },
        button('停止本次运行并接管', takeOver, '接管状态已更新。', human || !generation),
        button('读取网页到主对话', () => submitPage(false), '已提交网页上下文；等候主对话处理。', !targetId),
        button('完成并提交继续', () => submitPage(true),
          '继续请求已提交；接收回执不代表 Agent 已读取或恢复同一轮。', !human),
        h('select', { value: mode, 'aria-label': '主对话提交方式', disabled: busy, onChange: (event: any) => setMode(event.target.value) },
          h('option', { value: 'queue' }, '排队提交'), h('option', { value: 'steer' }, '当前轮引导'))),
      h('div', { role: 'status' }, `${message} 控制状态：${control.state}`),
      h('div', { className: 'dsh-ego-rc2-targets' }, targets.map((target: Target) => h('button', {
        key: target.targetId, type: 'button', 'aria-pressed': targetId === target.targetId,
        title: safePageUrl(target.url), disabled: busy, onClick: () => {
          void action(async () => setTargetId(target.targetId), '已切换本会话页面。')
        },
      }, target.title || safePageUrl(target.url) || '空白页面'))),
      h('div', { className: 'dsh-ego-rc2-view' }, frame === undefined ? h('p', null, '暂无本会话画面。') : h('img', {
        ref: image, src: frame, alt: '本会话 Agent 浏览器画面', draggable: false,
        onPointerDown: (event: any) => pointer(event, 'mousePressed'), onPointerUp: (event: any) => pointer(event, 'mouseReleased'),
        onPointerCancel: (event: any) => pointer(event, 'mouseReleased'),
        onPointerMove: (event: any) => { if (event.buttons) pointer(event, 'mouseMoved') },
        onContextMenu: (event: any) => event.preventDefault(),
        onWheel: (event: any) => {
          if (!human || image.current === null) return
          const xy = browserCoordinates(event, image.current.getBoundingClientRect(), size)
          if (xy) sendInput('mouseWheel', { ...xy, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: inputModifiers(event) })
        },
      })),
      h('textarea', { ref: keyboard, className: 'dsh-ego-rc2-keyboard', 'aria-label': '接管后的网页键盘输入', disabled: !human || busy,
        onCompositionStart: keyInput.current.compositionStart, onCompositionEnd: keyInput.current.compositionEnd,
        onChange: keyInput.current.change, onKeyDown: keyInput.current.keyDown, onKeyUp: keyInput.current.keyUp,
        onBlur: () => { void flushInput().catch(() => notice('键盘释放未确认；请重新确认接管状态。')) },
      }),
      h('small', null, '专用 Agent 浏览器。任务空间区分页签，不等于账号隔离。画面仅供观察；读取与继续需明确提交。弹窗只接受本会话 opener 归属；真实账号 OAuth 尚未验收，系统浏览器登录导入与原生弹出仍关闭。'))
  }

  const mount = (sidebarCtx: ClientContext) => {
    const sidebar = sidebarCtx.get?.('betterSidebar')
    if (!sidebar || !sidebar.features?.includes('browserUrl')) return
    sidebarCtx.effect(() => {
      const style = document.createElement('style')
      style.textContent = `
        .dsh-ego-rc2{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box;overflow:auto;font:var(--dsw-font-s-14,14px/22px system-ui);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
        .dsh-ego-rc2 form,.dsh-ego-rc2-controls,.dsh-ego-rc2-targets{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex-shrink:0;min-width:0;max-width:100%}
        .dsh-ego-rc2 button,.dsh-ego-rc2 input,.dsh-ego-rc2 select,.dsh-ego-rc2 textarea{box-sizing:border-box;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:5px 9px;min-width:0;max-width:100%}
        .dsh-ego-rc2 button{cursor:pointer;white-space:normal;overflow-wrap:anywhere;text-align:start}
        .dsh-ego-rc2 button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
        .dsh-ego-rc2 button:not(:disabled):active,.dsh-ego-rc2 button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-state-business-primary)}
        .dsh-ego-rc2 :is(button,input,select,textarea):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
        .dsh-ego-rc2 :is(button,input,select,textarea):disabled{cursor:not-allowed;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform)}
        .dsh-ego-rc2 input::placeholder,.dsh-ego-rc2 textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
        .dsh-ego-rc2 form input{flex:1 1 200px}
        .dsh-ego-rc2 [role=status]{flex-shrink:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
        .dsh-ego-rc2-view{flex:1;min-height:80px;min-width:0;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-module-platform);border-radius:8px}
        .dsh-ego-rc2-view img{width:100%;height:100%;object-fit:contain;touch-action:none}
        .dsh-ego-rc2-keyboard{min-height:36px;flex-shrink:0;resize:none;width:100%}
        .dsh-ego-rc2 small{flex-shrink:0;font:var(--dsw-font-s-12,12px/18px system-ui);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
      `
      document.head.appendChild(style)
      const dispose = sidebar.registerTab({
        id: 'ego-browser:watch', title: 'Agent Browser', order: 70, single: true,
        available: (_ctx: unknown, scope: EgoScope) => sessions.binding(scope.sessionId) !== undefined,
        component: (props: { scope: EgoScope; visible: boolean }) => h(WatchTab, { ...props, key: props.scope.sessionId }),
        onOpenUrl: async (request: { url: string; requestId: string; scope: EgoScope }) => {
          await transportFor(request.scope).post('/api/ego/navigate', { url: request.url, requestId: request.requestId })
        },
      })
      const autoOpen = subscribeAutoOpen(sessions, sidebar)
      return () => { autoOpen(); dispose(); style.remove(); bridges.clear() }
    }, 'ego-browser: scoped rc.2 sidebar')
  }
  if (ctx.get?.('betterSidebar')) mount(ctx)
  else ctx.inject?.(['betterSidebar'], mount)
}
