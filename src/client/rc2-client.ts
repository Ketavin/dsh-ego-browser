/** Isolated rc.2 Sidebar UI. Each mounted tab owns one immutable Session scope. */
import {
  browserCoordinates, createConversationBridge, createInputDispatcher, createScopedTransport,
  DRAFT_TEXT_LIMIT, inputModifiers, releaseHumanOnDispose, requireScope, safePageUrl,
  type EgoScope, type JsonPayload, type Rc2Sessions,
} from './rc2-bridge.ts'
declare function require(id: string): any

interface Target { targetId: string; url: string; title: string; viewportW?: number; viewportH?: number }
interface Control { state: string; sessionId?: string; leaseEpoch: number; expiresAt?: number; held?: boolean }
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

/** Authorization refusals are distinct from worker/transport channel failures. */
function authRefusalCode(code: string): boolean {
  return code.startsWith('remote-') || code === 'browser-request-401' || code === 'browser-request-403'
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
  const transportFor = (scope: EgoScope, clientId?: string) => createScopedTransport(requireScope(scope), fetch, clientId !== undefined ? { clientId } : {})
  // One stable device identity per Session for the whole plugin mount: the
  // mounted watch tab and the Sidebar's openBrowser/browserUrl callback are
  // the SAME device of that session — even when the callback fires with no
  // tab mounted — and a repeated open intent keeps its identity. The callback
  // only navigates under the normal session/generation fences; it never takes
  // over or releases human control on its own.
  const sessionClientId = new Map<string, string>()
  const clientIdFor = (sessionId: string): string => {
    let clientId = sessionClientId.get(sessionId)
    if (clientId === undefined) {
      clientId = `sidebar:${sessionId}:${crypto.randomUUID()}`
      sessionClientId.set(sessionId, clientId)
    }
    return clientId
  }
  const bridgeFor = (scope: EgoScope, clientId: string) => {
    // One bridge per session AND client device: a second device of the same
    // session never acts under this tab's lease identity.
    const key = JSON.stringify([requireScope(scope).sessionId, clientId])
    let bridge = bridges.get(key)
    if (bridge === undefined) { bridge = createConversationBridge(sessions, transportFor(scope, clientId)); bridges.set(key, bridge) }
    return bridge
  }

  function WatchTab(props: { scope: EgoScope; visible: boolean }) {
    const sessionId = requireScope(props.scope).sessionId
    // The session's stable device identity (shared with the openBrowser
    // callback): it binds the human lease to exactly one device when taking
    // over, and every control mutation carries it.
    const clientKey = clientIdFor(sessionId)
    const transport = React.useMemo(() => transportFor({ sessionId }, clientKey), [sessionId, clientKey])
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
    // Each channel carries its own freshness counter: a slow passive spaces
    // answer must never obsolete a healthy requester-bound control reply, and
    // one refused control answer must never wait out a spaces pull. Spaces are
    // additionally single-flight — at most one outstanding membership pull —
    // so a slow backend cannot pile up expensive queries on every interval.
    const statusSequence = React.useRef(0)
    const spacesSequence = React.useRef(0)
    const spacesInFlight = React.useRef(false)
    const announceRecovery = React.useRef(false)
    // The generation this tab's status channel last committed — read at spaces
    // commit time, not render time, so a spaces answer settles against what
    // was actually proven and never against a not-yet-rendered state.
    const committedGeneration = React.useRef('')
    // Channel health: a refused/failed status poll, and how many times in a
    // row the picture stream has dropped without a healthy frame between.
    const pollDown = React.useRef(false)
    const streamFailures = React.useRef(0)
    const [streamRetry, setStreamRetry] = React.useState(0)
    const lastPointer = React.useRef(undefined as { x: number; y: number } | undefined)
    const clicks = React.useRef({ time: 0, targetId: '', button: 0, x: 0, y: 0, count: 0 })
    // Human-control authority for THIS device is proven only by a
    // requester-bound receipt — a status poll or takeover answer that names
    // this clientKey — saying held === true for one exact host generation and
    // lease epoch. An identity-less SSE control payload can never mint or
    // extend that proof, and a new epoch needs a fresh proof: until then the
    // tab stays a read-only watcher of the session.
    const heldVerified = React.useRef({ generation: '', epoch: -1 })
    const held = control.state === 'human' && control.sessionId === sessionId
      && heldVerified.current.generation === generation && heldVerified.current.epoch === control.leaseEpoch
    const live = React.useRef({ visible: props.visible, targetId, control, generation, held })
    live.current = { visible: props.visible, targetId, control, generation, held }
    const human = props.visible && held
    // The persistent local draft: native IME, selection, paste and editing only
    // — nothing is dispatched piecewise and nothing is cleared automatically.
    // One explicit 输入到网页 send commits the whole draft as a single bounded
    // ordered insertText; refused, stale and unconfirmed sends keep the draft.
    // A send clears the draft only when it was not edited while in flight
    // (a same-value re-edit is still an edit) and only the draft's own page
    // — identified by a revision counter and the origin captured at edit time
    // — is ever cleared or sent.
    const [draft, setDraft] = React.useState('')
    const draftRef = React.useRef('')
    const draftRevision = React.useRef(0)
    const draftOrigin = React.useRef({ targetId: '', generation: '' })
    const [sending, setSending] = React.useState(false)
    const pendingSend = React.useRef(false)
    // Native IME composition is tracked so a half-finished candidate string is
    // never sent: the send button disables and the click handler refuses while
    // a composition is active. Commit and cancel both end with compositionend
    // (the native value is final then); blur and a real page/Host change reset
    // the flag so it can never stick or carry text to another page.
    const composingRef = React.useRef(false)
    const [composing, setComposing] = React.useState(false)
    const setComposingFlag = (value: boolean) => { composingRef.current = value; setComposing(value) }
    const editDraft = (value: string) => {
      draftRef.current = value; draftRevision.current += 1
      // Keep the LAST VALID page identity for the draft: an empty target or
      // generation (a transient fail-closed wipe) never rewrites it, so text
      // written for a page keeps that page's identity through a pause.
      draftOrigin.current = { targetId: targetId || draftOrigin.current.targetId,
        generation: generation || draftOrigin.current.generation }
      setDraft(value)
    }
    // The latest notice text (a mirror of the state for event-handler reads)
    // plus the exact capacity/channel-loss notice currently on screen, if
    // any. A recovered picture may replace ONLY that stream notice — a newer
    // input, composition, submission, lease or authorization message, or a
    // control-channel failure reported by the status poll, is never erased.
    const messageRef = React.useRef('本会话 Agent 浏览器。')
    const streamNoticeRef = React.useRef(undefined as string | undefined)
    const notice = (value: string) => { messageRef.current = value; if (mounted.current) setMessage(value) }
    const dispatcher = React.useRef(undefined as ReturnType<typeof createInputDispatcher> | undefined)
    dispatcher.current ??= createInputDispatcher(transport, captured => {
      const now = live.current
      // Visibility/busy stop producers, while already accepted input drains.
      return now.targetId === captured.targetId
        && now.control.state === 'human' && now.control.sessionId === sessionId && now.held
        && now.control.leaseEpoch === captured.leaseEpoch && now.generation === captured.hostGeneration
    }, () => notice('人工输入未送达；请确认接管状态。'))
    const flushInput = () => dispatcher.current!.flush()
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [sessionId])
    React.useEffect(() => {
      if (props.visible) return () => {
        const { control: current, generation: capturedGeneration, targetId: capturedTarget, held: capturedHeld } = live.current
        // Only THIS device's lease is released on disposal: a watching device
        // closing its tab must never release the lease another device holds.
        if (current.state === 'human' && current.sessionId === sessionId && capturedHeld) {
          void releaseHumanOnDispose(transport, { targetId: capturedTarget, leaseEpoch: current.leaseEpoch,
            hostGeneration: capturedGeneration }, flushInput).catch(() => notice('接管释放未确认；浏览器继续保持受限。'))
        }
      }
    }, [props.visible, transport])
    // A draft belongs to this exact mounted session/page: a real target, host
    // or Session change can never carry text into another page. A transient
    // fail-closed wipe only empties the target/generation STATE — the last
    // VALID identity is kept, so same-context recovery preserves the draft
    // intact while a genuinely different proven context clears it, and any
    // stale composition flag with it.
    const draftScope = React.useRef({ sessionId, targetId: '', generation: '' })
    React.useEffect(() => {
      const previous = draftScope.current
      const next = { sessionId, targetId: targetId || previous.targetId,
        generation: generation || previous.generation }
      draftScope.current = next
      if (previous.sessionId !== sessionId
        || (previous.targetId !== '' && previous.targetId !== next.targetId)
        || (previous.generation !== '' && previous.generation !== next.generation)) {
        const hadText = draftRef.current !== ''
        editDraft(''); setComposingFlag(false)
        if (hadText) notice('页面或主机已变化；原草稿已清空。')
      }
    }, [sessionId, targetId, generation])
    const refresh = async (signal?: AbortSignal) => {
      // The control status and the passive spaces/membership read are separate
      // channels: they are issued together but settle independently, and
      // neither may discard the other's reply — a slow spaces answer can never
      // obsolete a healthy requester-bound control answer, and a refused
      // control answer fails closed immediately without waiting for spaces.
      const statusRevision = ++statusSequence.current
      const statusRequest = transport.get('/api/ego/control/status', signal, { clientId: clientKey })
        .then((value: JsonPayload) => ({ ok: true as const, value }), (reason: unknown) => ({ ok: false as const, reason }))
      // Spaces are additionally single-flight, decided synchronously at tick
      // start: one outstanding membership pull satisfies this tick, so a slow
      // backend cannot pile up expensive queries on every interval.
      const spacesRevision = spacesInFlight.current ? 0 : ++spacesSequence.current
      const spacesRequest = spacesRevision === 0 ? undefined
        : transport.get('/api/ego/spaces', signal)
          .then((value: JsonPayload) => ({ ok: true as const, value }), (reason: unknown) => ({ ok: false as const, reason }))
      if (spacesRequest !== undefined) spacesInFlight.current = true
      const spacesSettled = spacesRequest?.then((result: { ok: boolean; value?: JsonPayload; reason?: unknown }) => { spacesInFlight.current = false; return result })

      const lease = await statusRequest
      if (!mounted.current || signal?.aborted || statusRevision !== statusSequence.current) return
      if (!lease.ok) {
        // The control channel refused or dropped: fail closed locally and say
        // why. An authorization refusal and a transport failure get distinct
        // messages; neither replays queued work nor resumes anything, and the
        // Host lease itself is untouched by a client-side refusal. The already
        // issued spaces pull of this tick is discarded by the cleared
        // generation when it settles.
        const code = lease.reason instanceof Error ? lease.reason.message : ''
        heldVerified.current = { generation: '', epoch: -1 }
        committedGeneration.current = ''
        setControl({ state: 'paused', leaseEpoch: 0 }); setTargets([]); setTargetId(''); setGeneration('')
        notice(authRefusalCode(code) ? '远程认证未通过或已过期；请重新认证后再操作。' : '浏览器控制通道暂不可用；已暂停本地图面与控制。')
        pollDown.current = true
        return
      }
      if (typeof lease.value.hostGeneration !== 'string' || !lease.value.hostGeneration) {
        heldVerified.current = { generation: '', epoch: -1 }
        committedGeneration.current = ''
        setControl({ state: 'paused', leaseEpoch: 0 }); return
      }
      const nextControl = lease.value.control
      if (!nextControl || typeof nextControl !== 'object' || !Number.isSafeInteger(nextControl.leaseEpoch)) {
        committedGeneration.current = ''
        setControl({ state: 'paused', leaseEpoch: 0 }); return
      }
      // Requester-bound answer: only held === true for THIS device proves
      // human authority, and only for this exact generation and epoch. Any
      // other answer revokes the local proof until a new receipt says so.
      heldVerified.current = nextControl.state === 'human' && nextControl.sessionId === sessionId && nextControl.held === true
        ? { generation: lease.value.hostGeneration, epoch: nextControl.leaseEpoch }
        : { generation: '', epoch: -1 }
      // Neither an older polling result nor a delayed SSE may lower the lease.
      setControl((previous: Control) => live.current.generation === lease.value.hostGeneration
        && previous.leaseEpoch > nextControl.leaseEpoch ? previous : nextControl)
      setGeneration(lease.value.hostGeneration)
      committedGeneration.current = lease.value.hostGeneration
      // Reconnect the picture only when the channel actually recovered: a
      // failed poll followed by this successful one — never a blind loop.
      if (pollDown.current) {
        pollDown.current = false
        announceRecovery.current = true
        if (streamFailures.current > 0) { streamFailures.current = 0; setStreamRetry((value: number) => value + 1) }
      }
      if (spacesSettled === undefined) return
      const spaces = await spacesSettled
      if (!mounted.current || signal?.aborted || spacesRevision !== spacesSequence.current) return
      if (!spaces.ok) {
        // A worker/spaces failure is NOT an authorization refusal — keep the
        // control answer and the watched target, and surface the partial
        // failure instead of wiping state.
        const code = spaces.reason instanceof Error ? spaces.reason.message : ''
        notice(authRefusalCode(code) ? '远程认证未通过或已过期；请重新认证后再操作。' : '本会话页面列表暂时不可用；控制状态仍以主机回答为准。')
        return
      }
      // A spaces answer commits only against the generation this tab's status
      // channel last committed: an obsolete completion after a generation or
      // scope change can never restore old targets or authority.
      if (spaces.value.hostGeneration !== committedGeneration.current) return
      const next = validTargets(spaces.value.spaces)
      setTargets(next)
      setTargetId((previous: string) => next.some(target => target.targetId === previous) ? previous : next[0]?.targetId ?? '')
      if (announceRecovery.current) { announceRecovery.current = false; notice('浏览器通道已恢复。') }
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
      let retryTimer: number | undefined
      // Fail closed on stream loss: close (no native auto-reconnect loop),
      // drop the stale frame and the locally proven permission, and say why.
      // Reconnection is bounded — at most three consecutive attempts, then the
      // stream stays parked until the status channel recovers or the watched
      // target/generation changes; nothing is replayed and nothing resumes.
      const failStream = (error?: unknown) => {
        if (abort.signal.aborted) return
        source?.close(); source = undefined
        if (renew !== undefined) { window.clearInterval(renew); renew = undefined }
        setFrame(undefined)
        heldVerified.current = { generation: '', epoch: -1 }
        const code = error instanceof Error ? error.message : ''
        const conclude = (kind: 'capacity' | 'auth' | 'channel') => {
          if (abort.signal.aborted) return
          const text = kind === 'capacity' ? '远程画面连接已达上限；请先关闭其他设备的画面。'
            : kind === 'auth' ? '远程认证未通过或已过期；请重新认证后再操作。'
            : '画面连接中断；已清空本地图面并暂停控制，恢复后将重连。'
          notice(text)
          // Only the capacity/channel notices are picture-recovery messages;
          // an authorization refusal is an authorization fact that a recovered
          // picture must not mask.
          if (kind !== 'auth') streamNoticeRef.current = text
          streamFailures.current += 1
          if (streamFailures.current <= 3) {
            retryTimer = window.setTimeout(() => { if (!abort.signal.aborted) setStreamRetry((value: number) => value + 1) }, 1000 * streamFailures.current)
          }
        }
        if (code === "remote-stream-capacity") return conclude("capacity")
        if (authRefusalCode(code)) return conclude('auth')
        if (code !== '') return conclude('channel')
        // An EventSource connect failure carries no HTTP status or body, so a
        // 429 remote-stream-capacity refusal of the stream route is otherwise
        // indistinguishable from a channel loss. One read-only watch/status
        // probe classifies it; the probe changes nothing and never retries.
        void transport.get('/api/ego/watch/status', abort.signal)
          .then((value: JsonPayload) => conclude(value.remoteStreamFull === true ? 'capacity' : 'channel'),
            () => conclude('channel'))
      }
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
            // Healthy frames reset the reconnect budget.
            streamFailures.current = 0
            // A valid current-session/target/generation frame proves the
            // picture recovered: replace the obsolete capacity/channel-loss
            // notice — but only while it is still the message on screen, so a
            // newer action or authorization message always survives.
            if (streamNoticeRef.current !== undefined && messageRef.current === streamNoticeRef.current) {
              streamNoticeRef.current = undefined
              notice('画面连接已恢复。')
            }
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
              && Number.isSafeInteger(data.control.leaseEpoch)) {
              // An SSE control payload carries NO per-device proof: never let
              // it carry or mint a held value — state/epoch only. Authority
              // stays bound to the last requester-bound receipt's epoch.
              const incoming = { ...(data.control as Control) }
              delete incoming.held
              setControl((previous: Control) => previous.leaseEpoch > incoming.leaseEpoch ? previous : incoming)
            }
          } catch { /* no optimistic input permission */ }
        })
        source.addEventListener('error', () => failStream())
        renew = window.setInterval(() => { void transport.post('/api/ego/watch/start', { clientId, targetId, hostGeneration: generation }).catch(() => {}) }, 5000)
      }).catch((error: unknown) => failStream(error))
      return () => {
        abort.abort()
        if (retryTimer !== undefined) window.clearTimeout(retryTimer)
        source?.close(); if (renew !== undefined) window.clearInterval(renew)
        void transport.post('/api/ego/watch/stop', { clientId, targetId, hostGeneration: generation }).catch(() => {})
      }
    }, [props.visible, targetId, generation, transport, streamRetry])

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
        || current.control.state !== 'human' || current.control.sessionId !== sessionId
        || !current.held) return
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
        // A touch tap must not raise any local editor — the virtual keyboard
        // would shift the layout between down and up and move the tapped
        // coordinates. A desktop click instead focuses the page keyboard
        // region itself, so Ctrl+A/arrows act on the page, never the draft.
        if (event.pointerType === 'mouse') (event.currentTarget as HTMLElement).focus?.({ preventScroll: true })
      }
      if (type === 'mouseReleased') event.currentTarget.releasePointerCapture?.(event.pointerId)
      sendInput(type, { ...xy, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
        buttons: event.buttons, clickCount: clicks.current.count || 1, modifiers: inputModifiers(event) })
    }
    // The focused page keyboard region owns REMOTE keys for desktop users:
    // after a mouse click on the frame, Control+A/arrows/Enter reach the page
    // as ordered down/up pairs with their modifiers, while the draft editor
    // keeps every native key (Ctrl+A, Backspace, Enter, paste) local. Tab
    // keeps its focus-moving default; its released-down is covered by the
    // blur flush. Reserved browser/OS shortcuts cannot all be guaranteed, and
    // no clipboard sync is claimed — pasted text is local draft text only.
    const pageKey = (event: any, type: string) => {
      if (!human || pending.current) return
      if (type === 'keyDown' && event.key !== 'Tab') event.preventDefault()
      sendInput(type, { key: String(event.key ?? ''), code: String(event.code ?? ''),
        windowsVirtualKeyCode: Number(event.keyCode) || 0, modifiers: inputModifiers(event) })
    }
    const sendDraft = async () => {
      if (pendingSend.current) return
      const text = draftRef.current
      if (text === '' || text.length > DRAFT_TEXT_LIMIT) {
        notice(text === '' ? '请先输入要发送的文字。' : `文字过长（最多 ${DRAFT_TEXT_LIMIT} 字）；请缩短后再发送。`)
        return
      }
      // Admission guard: a half-finished IME candidate is never transmitted,
      // not even through a queued/stale click on an enabled-looking button.
      if (composingRef.current) { notice('输入法组合尚未完成；请先确认候选词后再发送。'); return }
      const now = live.current
      if (!now.held || now.control.state !== 'human' || now.control.sessionId !== sessionId) {
        notice('请先接管控制后再发送文字。'); return
      }
      if (!now.targetId) { notice('请先选择本会话页面。'); return }
      // The draft never travels to a page other than the one it was written
      // for — not even after a channel pause recovered onto a different page.
      if (draftOrigin.current.targetId !== now.targetId || draftOrigin.current.generation !== now.generation) {
        notice('目标页面已变化；草稿保留。请确认当前页面后重新发送。'); return
      }
      const revision = draftRevision.current
      pendingSend.current = true; setSending(true)
      try {
        const outcome = await dispatcher.current!.submitText({ targetId: now.targetId,
          leaseEpoch: now.control.leaseEpoch, hostGeneration: now.generation }, text)
        if (!mounted.current) return
        if (outcome.state === 'sent') {
          // A positive reply proves CDP delivery, not that the page accepted
          // the text: say sent and ask the user to check the webpage. Clear
          // the draft only if it was not edited while this send was in flight
          // — a re-edit back to the same value is still an edit.
          if (draftRevision.current === revision) { editDraft(''); notice('文字已发送；请到网页中确认输入结果。') }
          else notice('文字已发送；发送期间的修改保留在草稿中。请到网页中确认输入结果。')
        } else if (outcome.state === 'stale') notice('未发送：控制或页面状态已变化；草稿保留。')
        else if (outcome.state === 'refused') notice(`网页输入被拒绝（${outcome.code}）；草稿保留。`)
        else notice('发送结果未确认；草稿保留。请到网页中检查文字是否已输入。')
      } finally { pendingSend.current = false; if (mounted.current) setSending(false) }
    }
    // Remote special keys stay explicit controls: editing the local draft must
    // never intercept Enter/Backspace/Tab/Escape as remote shortcuts. Each
    // control sends one ordered down/up pair through the shared dispatcher.
    const specialKey = (label: string, key: string, code: string, keyCode: number) => h('button', {
      type: 'button', disabled: busy || !human, 'aria-label': `远程${label}键`,
      onClick: () => {
        sendInput('keyDown', { key, code, windowsVirtualKeyCode: keyCode, modifiers: 0 })
        sendInput('keyUp', { key, code, windowsVirtualKeyCode: keyCode, modifiers: 0 })
      },
    }, label)
    const submitPage = async (continueAfterHuman: boolean) => {
      const key = JSON.stringify([continueAfterHuman, targetId, generation])
      let intent = submissionIntents.current.get(key)
      if (!intent) { intent = crypto.randomUUID(); submissionIntents.current.set(key, intent) }
      try {
        const result = await bridgeFor({ sessionId }, clientKey).submit(intent, mode,
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
      const result = await bridgeFor({ sessionId }, clientKey).takeOver(crypto.randomUUID(), generation, control.leaseEpoch)
      const granted = result.control as Control | undefined
      // The takeover answer is requester-bound: together with the status poll
      // it is the only receipt allowed to prove THIS device holds control.
      const proved = granted?.state === 'human' && granted.sessionId === sessionId && granted.held === true
        && Number.isSafeInteger(granted.leaseEpoch) && typeof result.hostGeneration === 'string'
      if (proved) heldVerified.current = { generation: result.hostGeneration as string, epoch: granted!.leaseEpoch }
      if (!mounted.current || !live.current.visible) {
        // Disposal release also requires the explicit requester-held receipt.
        if (proved) {
          await releaseHumanOnDispose(transport, { targetId, leaseEpoch: granted!.leaseEpoch,
            hostGeneration: result.hostGeneration as string }, flushInput)
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
      h('div', { role: 'status' }, `${message} 控制状态：${control.state}${control.state === 'human' && !held ? '（另一设备持有控制）' : ''}`),
      h('div', { className: 'dsh-ego-rc2-targets' }, targets.map((target: Target) => h('button', {
        key: target.targetId, type: 'button', 'aria-pressed': targetId === target.targetId,
        title: safePageUrl(target.url), disabled: busy, onClick: () => {
          void action(async () => setTargetId(target.targetId), '已切换本会话页面。')
        },
      }, target.title || safePageUrl(target.url) || '空白页面'))),
      h('div', { className: 'dsh-ego-rc2-view' }, frame === undefined ? h('p', null, '暂无本会话画面。') : h('img', {
        ref: image, src: frame, alt: '本会话 Agent 浏览器画面', draggable: false, tabIndex: 0,
        'aria-label': '本会话网页键盘区',
        onPointerDown: (event: any) => pointer(event, 'mousePressed'), onPointerUp: (event: any) => pointer(event, 'mouseReleased'),
        onPointerCancel: (event: any) => pointer(event, 'mouseReleased'),
        onPointerMove: (event: any) => { if (event.buttons) pointer(event, 'mouseMoved') },
        onContextMenu: (event: any) => event.preventDefault(),
        onKeyDown: (event: any) => pageKey(event, 'keyDown'),
        onKeyUp: (event: any) => pageKey(event, 'keyUp'),
        onBlur: () => { void flushInput().catch(() => notice('键盘释放未确认；请重新确认接管状态。')) },
        onWheel: (event: any) => {
          if (!human || image.current === null) return
          const xy = browserCoordinates(event, image.current.getBoundingClientRect(), size)
          if (xy) sendInput('mouseWheel', { ...xy, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: inputModifiers(event) })
        },
      })),
      h('div', { className: 'dsh-ego-rc2-draft' },
        h('textarea', { ref: keyboard, className: 'dsh-ego-rc2-keyboard', 'aria-label': '网页输入草稿', disabled: !human,
          value: draft, maxLength: DRAFT_TEXT_LIMIT,
          onChange: (event: any) => editDraft(String(event.target.value).slice(0, DRAFT_TEXT_LIMIT)),
          onCompositionStart: () => setComposingFlag(true),
          onCompositionEnd: () => setComposingFlag(false),
          placeholder: '先点网页中的目标输入框，再在此输入文字（支持中文），然后点“输入到网页”。',
          onBlur: () => { setComposingFlag(false); void flushInput().catch(() => notice('键盘释放未确认；请重新确认接管状态。')) },
        }),
        h('div', { className: 'dsh-ego-rc2-draft-actions' },
          h('button', { type: 'button', disabled: busy || sending || !human || draft === '' || composing,
            onClick: () => { void sendDraft() } }, sending ? '发送中…' : '输入到网页'),
          specialKey('回车', 'Enter', 'Enter', 13), specialKey('退格', 'Backspace', 'Backspace', 8),
          specialKey('Tab', 'Tab', 'Tab', 9), specialKey('Esc', 'Escape', 'Escape', 27))),
      h('small', null, '专用 Agent 浏览器。任务空间区分页签，不等于账号隔离。画面仅供观察；先点网页中的目标输入框，再用草稿和“输入到网页”或特殊键按钮操作；桌面端点击画面后，Ctrl+A、方向键等会直接作用于网页。读取与继续需明确提交。弹窗只接受本会话 opener 归属；真实账号 OAuth 尚未验收，系统浏览器登录导入与原生弹出仍关闭。'))
  }

  const mount = (sidebarCtx: ClientContext) => {
    const sidebar = sidebarCtx.get?.('betterSidebar')
    if (!sidebar || !sidebar.features?.includes('browserUrl')) return
    sidebarCtx.effect(() => {
      const style = document.createElement('style')
      style.textContent = `
        .dsh-ego-rc2{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box;overflow:auto;font:var(--dsw-font-s-14,14px/22px system-ui);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
        .dsh-ego-rc2 form,.dsh-ego-rc2-controls,.dsh-ego-rc2-targets,.dsh-ego-rc2-draft-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex-shrink:0;min-width:0;max-width:100%}
        .dsh-ego-rc2-draft{display:flex;flex-direction:column;gap:6px;flex-shrink:0;min-width:0}
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
        .dsh-ego-rc2-view img:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
        /* At least 16px so focusing the draft never triggers the mobile input
         * zoom. The element qualifier out-cascades the shared
         * .dsh-ego-rc2 textarea font:inherit rule without touching it. */
        .dsh-ego-rc2 textarea.dsh-ego-rc2-keyboard{min-height:36px;flex-shrink:0;resize:none;width:100%;font-size:16px}
        .dsh-ego-rc2 small{flex-shrink:0;font:var(--dsw-font-s-12,12px/18px system-ui);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
      `
      document.head.appendChild(style)
      const dispose = sidebar.registerTab({
        id: 'ego-browser:watch', title: 'Agent Browser', order: 70, single: true,
        available: (_ctx: unknown, scope: EgoScope) => sessions.binding(scope.sessionId) !== undefined,
        component: (props: { scope: EgoScope; visible: boolean }) => h(WatchTab, { ...props, key: props.scope.sessionId }),
        onOpenUrl: async (request: { url: string; requestId: string; scope: EgoScope }) => {
          // Same stable device identity as the mounted tab (or alone when no
          // tab is mounted yet); navigation only — never a takeover/release.
          await transportFor(request.scope, clientIdFor(requireScope(request.scope).sessionId))
            .post('/api/ego/navigate', { url: request.url, requestId: request.requestId })
        },
      })
      const autoOpen = subscribeAutoOpen(sessions, sidebar)
      return () => { autoOpen(); dispose(); style.remove(); bridges.clear(); sessionClientId.clear() }
    }, 'ego-browser: scoped rc.2 sidebar')
  }
  if (ctx.get?.('betterSidebar')) mount(ctx)
  else ctx.inject?.(['betterSidebar'], mount)
}
