# Reviewed DSH rc.2 isolation candidate

Local version: `0.8.6-dsh-remote.6` (the auto-reveal correction on the
reviewed rc2.5 line; the S2 reviewed snapshot and the earlier
`dsh-remote.1`–`.4` commits and packages stay recorded separately as
historical evidence). Upstream v0.8.6 source base:
`dfde57221443bdade5e0cbee7c773a6839ffe560`. This is a code adaptation of that
source, not a declaration that upstream v0.8.6 supports rc.2. The reviewed Core
is the local `0.1.1-rc.2` fork at `8de453b65df4f65e2b7857479eec538c8ccc6ee0`,
with the isolated P1/P2 changes. Exact candidate commits and package hashes are
recorded outside this repository in the P3 verification receipt.

The client requires the Better Sidebar `browserUrl` feature. The frozen P3
Sidebar is `28f386159610f093ede57da81fa7f158cd674aa2`, based on the actual formal
0.17.8 source. It exposes one Browser entry with Preview and Agent modes while
preserving both tab lifecycles. Ego registers only `ego-browser:watch`; there is
no floating ball or second Browser rail icon. The old upstream README, ARCH.md
and legacy JavaScript describe a different runtime. Current TypeScript and
this adaptation note are authoritative for the local candidate.

Automatic tool opens require `betterSidebar.getSnapshot().prefs.agentOpenTools`
to be true. Live Ego metadata opens `ego-browser:watch` with `reveal: true`;
Better Sidebar 0.17.9 reveals only the active session's actual hosting panel
and keeps inactive-session opens collapsed. No history is loaded for this
notification, and no human control or navigation is acquired by revealing it.

## Runtime and request boundary

`DSH_EGO_ISOLATED_RUNTIME=1` and an existing absolute `DSH_HOME` are mandatory.
Without both, actions fail closed as `isolated-runtime-unconfigured`. Data,
state, cache, worker and Chrome profile paths stay under
`DSH_HOME/plugins/ego-browser/runtime`; existing links are resolved and checked
against that home. Inherited external CDP and extra Chrome arguments are
cleared. No daily Chrome, ResearchHub runtime or existing account is imported.
Only CDP JPEG capture is enabled in this candidate.
Explicit subprocess environment removes credential-shaped names
(`KEY|PASSWORD|SECRET|TOKEN`, case-insensitive) and unrelated `DSH_*` entries
before reintroducing the narrow isolation controls. This name heuristic is the
reviewed Core policy, not proof that every possible credential-bearing value
can be identified. Stored PID liveness alone is insufficient: browser reuse,
status and termination check the actual process executable/profile and stored
WebSocket identity; workers match the exact boot ID/PID/profile health receipt.

Every public cast route and gateway settings prefix uses the actual Core
`connection.requestRejection`. This checks local socket, Host, Origin and
browser request trust. It is **not authenticated user identity**. A forged
cookie supplies no authority. Required fences missing or unmounted, remote
callers, wrong method and non-JSON mutation requests are denied. The private
worker also rejects browser-origin/fetch-site requests before input dispatch;
scoped mode disables its global video and auth-flush surfaces.

Session/Agent ownership is a separate boundary: actual live Session registry,
new host generation, per-session task name, proven CLI ownership record and
owned target set. Reads, frame streams, navigation and input require matching
session/generation/target. Arbitrary global spaces and raw target IDs are
rejected. Disposal tombstones the scope and closes its streams. An empty task
never falls back to global browser tabs.

Popups are adopted only from a browser-reported opener chain rooted in a
previously owned target, within its proven browser context. Existing owners
are never reassigned; ambiguous and unowned openers are rejected. Chrome's
default context can have an opaque ID, which is learned from owned live
targets. Reconciliation occurs during scoped CLI access and human membership
polling under the same control lease. Task ownership does not imply account
cookie isolation: default-context spaces share the dedicated Agent cookie jar.
URL restart recovery, global abandoned/idle sweeps and empty-context disposal
are disabled in scoped reconciliation; another Session's CLI cannot use those
heuristics to adopt or close a target. A late popup without a previously proven
parent/context is rejected and may pause the lease, rather than guessed by URL.

## Remote access (plugin-owned Cloudflare Access path)

Remote callers reach the same public `/api/ego/*` routes only through an
explicit plugin-owned authorization path that runs strictly after the Core
fence above refuses a request. The fence itself is never loosened, patched or
fed a fabricated Origin/cookie; the remote path neither re-runs nor overrides
it. Authorization is a real cryptographic check of the
`Cf-Access-Jwt-Assertion` header injected by the Cloudflare Access edge
(RS256 only, verified with `jose` 6.2.3 against the JWKS derived from the
pinned issuer at `<issuer>/cdn-cgi/access/certs`): signature, issuer,
application audience, expiry, not-before and the exact human owner subject.
Forwarded headers alone confer nothing, and a request can never supply its own
JWKS URL. The request must also carry the pinned HTTPS origin in Host, a
matching Origin when present (required on non-GET/HEAD), and `same-origin`
when Sec-Fetch-Site is present, so both fetch and native EventSource calls are
covered. The Host header is parsed as exactly one legal authority (name,
name:port, bracketed IPv6 with optional port); malformed values such as
multiple colons, non-numeric or oversized ports and unbracketed IPv6 are
rejected rather than treated as absent, while an explicit default `:443`
equals the portless pin. Duplicate wire fields for Host, Origin,
Sec-Fetch-Site or the assertion are refused before verification using the raw
header representation — Node's parsed view silently drops a second Host field,
so the wire form is what is counted; a duplicate is refused outright, never
"first wins" or treated as absent. Credentials in URLs are rejected before any
verification. Pre-verification refusals (malformed request/URL, duplicate or
mismatched Host/Origin/Sec-Fetch-Site, missing or malformed assertion) make no
JWKS request and change no state; the verification step itself may fetch the
JWKS even when the signature or claims ultimately fail. Tokens are never
written to responses, persistence or logs, and only rejection codes leave the
module.

Configuration is an immutable mount-time snapshot of the composition entry's
`remoteAccess` block: exact HTTPS origin, exact
`https://<team>.cloudflareaccess.com` issuer, application audience and the one
allowed owner subject (operator-supplied, never inferred). Absent, partial or
malformed configuration disables remote access entirely; changing it requires
editing the host composition and restarting. The block is not part of the
settings schema, the settings bridge or the gateway allow-list, and browser
gateway writes targeting these fields are rejected outright as
`remote-access-immutable` (403) before any settings update, not silently
dropped.

Authorization grants nothing else, and it does not outlive its JWT: after an
asynchronous wait (a trickling request body, worker health discovery) the
grant is re-checked before any NEW control or worker operation, and an expired
request is refused with a safe auth code before any side effect. This is the
JWT's own lifetime and is independent of the control lease TTL; already
started operations are not cancelled. Every downstream guard still applies to
a remote caller: bound method and media type, live session, session/target
ownership, host generation, namespaced request/client identifiers, takeover
epoch and the human control lease. A verified JWT cannot reach a different
conversation or a stale target. The grant is per person, not per device: the
client-device ownership of human control (below) applies identically, so two
remote devices presenting the same owner assertion still cannot act on one
lease simultaneously. The public route set is unchanged.

Remote SSE streams are bounded on top of the existing relay: one connection
lives at most until the earlier of the verified JWT expiry and a ten-minute
maximum window (reconnect must re-authorize through the full chain), at most
four concurrent remote streams, per-frame byte cap, sliding-window frame
frequency and a violation budget that terminates a runaway stream. A stream
slot is owned from the moment it is reserved: during worker health discovery a
client disconnect, the grant deadline or plugin unload returns the slot
immediately, and no worker stream is opened for a closed, expired or unloaded
downstream afterwards. One idempotent teardown owns the whole stream: every
close path — expiry, upstream end/error, downstream disconnect, limits,
explicit stop, relay refusal, plugin unload — actively destroys the worker
request and response, clears the deadline timer, returns the stream slot,
drops the SSE registration and detaches the stream's own backpressure-drain
and close listeners, each exactly once; a blocked downstream that never
flushes still closes the upstream, and the per-plugin stream registration —
its Set entry together with its own route-layer close listener — is removed
without depending on the downstream closing (other components'
listeners on the same response are never touched). Expiry only closes the
picture; it never arms or resumes the Agent. Local desktop streams keep their
exact previous behavior, and browser frames never enter the shared
tool-events channel. Fixture evidence uses purpose-owned generated RSA keys
against loopback JWKS servers; passing it is not a claim about real Cloudflare
Access issuance, tunnel behavior or WAN acceptance, which remain unverified,
as does any real third-party OAuth login.

## Control and public main-conversation bridge

Exactly 25 tools are registered, listed by `SCOPED_EGO_TOOL_NAMES` and
`ego_help`. Low-level `ego_cli`, `ego_script`, `ego_js`, `ego_cdp`,
`ego_login_import`, `ego_auth_flush`, global `ego_status` and
`ego_space_close` are not registered. Server-mode HTTP and download trigger
scripts are refused. Native window raise and system login import are disabled.

One host lease serializes agent work and explicit human takeover. Input carries
an ordered sequence and exact lease epoch; possible held keys/buttons must be
released before control/continuation handoff. Unconfirmed cancellation or input
completion pauses fail closed instead of granting another actor permission.
Hidden/unmounted clients flush input, release the exact lease, and release any
late grant. Old generations, stale streams and callbacks cannot restore access.

Human control is additionally bound to one client device: the same person may
open the same chat from several devices, and sessionId+epoch alone cannot tell
them apart. Every control-affecting request (takeover, navigate, input, close,
release, explicit page context, prepare/commit/abort continuation) must name
the requesting device (`clientId`); takeover binds that identity to the lease,
and a different device of the same session is refused (`lease-held-elsewhere`
on grab, `lease-holder-mismatch` on act) even with the correct session and
epoch. Ordered input, idempotency, held-key flushing, fail-closed cancellation
and the two-phase continuation are unchanged; the holder identity survives an
explicit release so only the releasing device can continue, and expiry,
revocation, disposal or a new agent run discard it without replay. Host-side
membership refreshes carry no device identity and remain trusted internal
operations. Passive same-session reads (spaces, SSE watch, watch status) stay
open to every device of the session; the status answer says only whether the
asking device holds (`held`), never the holder value. This is plugin-internal
binding of a client-generated identifier, not a cryptographic device
credential — a device that somehow learned another's identifier could still
name it.

Idempotent HTTP receipts are bound to the requesting device as well: the
request cache key includes the client identity, so a second device replaying
the first device's requestId (takeover, navigate, explicit context, close,
input, release, prepare/commit/abort) never receives the holder's cached
receipt — it misses the cache and runs the real holder checks — while a
genuine same-device retry, including release after the state change, keeps
its original receipt. The Sidebar's openBrowser/browserUrl callback names the
same stable per-session device identity as the mounted watch tab (it exists
even when no tab is mounted, and a repeated open intent keeps both its
identity and its requestId); it only navigates under the normal
session/generation fences and never takes over or releases control. On the
client, the conversation cancellation of a takeover is issued only after the
Host allowed it, or after the Host's explicit `takeover-interrupted-run`
receipt saying THIS request actually aborted a running browser operation and
failed closed (a bounded takeover timeout of a live operation qualifies
equally); a bare `cancellation-unverified` answer — an already unsafe-paused
lease refused before any new interruption — is an unproven denial that never
cancels or otherwise disturbs the main conversation. Local
input authority is granted only by a requester-bound receipt — a status poll
or takeover answer naming this device with `held: true` for one exact host
generation and lease epoch; an identity-less SSE control payload can never
mint or extend that proof, and any epoch change requires a fresh proof. The
watch poll runs the control status and the passive spaces/membership read as
separate channels with separate freshness: they are issued together but settle
independently, so a spaces reply slower than the poll interval can never
obsolete a healthy requester-bound control answer or a valid target update,
and a refused control answer fails closed immediately without waiting for
spaces. Spaces are single-flight — one outstanding membership pull satisfies
every tick — and a spaces answer commits only against the host generation the
status channel last committed for this tab, so an obsolete completion after a
host-generation or scope change can never restore old targets or authority.
On an
authorization refusal, connection loss or stream error the client clears the
stale frame and its local permission, shows the auth/capacity/channel reason,
reconnects the picture at most three times before parking until the status
channel recovers, and never replays queued input or continuation or resumes
the Agent; a worker/spaces partial failure is reported separately and does
not revoke a proven lease.

The client uses the actual rc.2 public `sessions.binding`, `SessionFace.prompt`
and `SessionFace.cancel`, without reopening the active global runtime. Page
context is bounded, treated as untrusted external text, redacts obvious secret
fields and omits URL credentials/query/fragment. Reading and continuing require
explicit submission; a prompt receipt does not mean the Agent has read it or
resumed the same turn.

Continue is two-phase: the host claims actual public `Agent.runMaintenance`,
returns a marker receipt, then commits only after a new durable user inbox
message on the same live Agent contains that marker. Abort, TTL, cancellation,
disposal, stale generation/epoch or missing marker leave the browser paused.
Ambiguous prompt/commit responses retain an idempotent intent; admission cannot
be described as withdrawn merely because a client closes afterward.

## Evidence and remaining acceptance

The final verification receipt records full unit/typecheck/build counts and
the exact built entry and package hashes. Isolated evidence includes:

- Real Core HostConnectionService over loopback HTTP: 64 trust checks.
- Actual compiled rc.2 Session/Agent/Loop and public maintenance: four checks.
- Actual Host ApiProxy JSON carrier and source client SessionFace: five checks
  for creation, public prompt marker admission, commit, cancel and precise
  single-session disposal while another Session remains live.
- Actual Windows dedicated headless Chrome, built host and worker: eight checks
  for A/B space ownership, real CDP frames, private worker browser-origin
  rejection, human input/lease release, local opener/302 callback/owned popup
  close and verified owned process cleanup.
- Actual compiled Core LocalSubprocessRuntime with untouched native internals:
  seven checks for public Session identities, real CLI/tool/worker handles,
  child environment scrub, navigation/frame/input fences and final owned process disposal.
- Dedicated runtime cold restart and stale state: five checks for unrelated
  live-PID and foreign endpoint refusal, fresh targets/no URL adoption, local
  fixture cookie/storage persistence and exact captured process cleanup.
- Real React source lifecycle fixtures exercise A/B remount, late takeover
  release, held-input drain and host-generation replacement.

The original browser probe uses a native adapter; a separate final probe loads
the actual compiled Core subprocess service. The RPC probe uses the in-process JSON carrier,
not the complete SessionRuntime projection or web socket transport. No external
LLM, actual login or production service is touched.

Still required before joint release: loaded final bundles in the combined
Sidebar/Profile and P1–P6 joint regression. Real account login persistence,
crash recovery and arbitrary stale-state recovery are not certified. Provider OAuth and account
login are not accepted: only a local OAuth-style popup/opener/redirect fixture
has passed. Platform variants, shared daily-browser runtime, FFmpeg and native
window handoff are not certified capabilities of this candidate.

Development links for settings/tools point to the isolated P2 Core. Automatic
peer installation is disabled; the frozen lockfile is required. The package
pins the reviewed rc.2 peers and does not authorize an overall Core upgrade.
P1–P6 ship together only after individual and combined acceptance. This source
candidate does not itself authorize production promotion or account login.

The rc2.3 follow-up fixes a real combined-UI failure in rc2.2: human input could
receive `control-busy` while the background membership refresh held the browser
lease. Human refresh, page reads and input now share one queue bounded at 1024
operations. Every queued operation rechecks the exact Session/lease before
dispatch; input sequence, deduplication and held-input release rules remain in
force. Release, continuation, arm and disposal account for the whole queue.
The initial watch status uses neutral text so tool auto-open does not incorrectly
report that no page has opened. The final installed combined UI must be rerun
against rc2.3; rc2.2 failure screenshots and receipts are retained.

The rc2.4 follow-up makes the explicit release/continue boundary wait for that
queue. It rejects new human producers while draining previously accepted work,
with a five-second bound, then repeats exact ownership/epoch and the original
ready/held-input/state checks. Duplicate accepted input retains its original
receipt; a refused new input does not advance the sequence watermark. The
continuation gate wraps its original synchronous public maintenance claim
after the drain, preserving durable marker admission before arming. rc2.3 UI
proved two clicks and Chinese inputs, but its continue could still collide with
an ongoing refresh. The final installed UI must now be rerun against rc2.4.

The rc2.5 follow-up only styles the rc.2 watch view using the actual DSW font,
label/background/border/interaction tokens. Controls use 14px type, themed
hover/focus/disabled states and wrapping layout; status and the scoped-browser
notice remain readable in dark and narrow panels. Frame coordinates, control,
transport and host bytes are unchanged. Final installed light/dark and narrow
UI checks are recorded separately from the retained rc2.4 functional pass.

The rc2.5 mobile-input follow-up replaces immediate mirror typing with a
persistent local draft. The old keyboard surface dispatched keystroke-by-
keystroke and cleared `event.target.value` unconditionally — including on a
no-op early return and before the asynchronous reply — which erased composing
Chinese text on iPhone. The draft is now a plain native textarea: IME
composition, selection, paste and local Enter/Backspace editing only edit the
local value, are never dispatched piecewise, and never clear anything by
themselves; a synthetic final `input` after `compositionend` cannot duplicate
text because the draft is value-driven, not append-driven. One explicit
`输入到网页` button commits the whole draft (bounded at 4000 characters) as a
single ordered `insertText` under the captured session/target/host generation
and lease epoch. Its outcome is explicit: `sent` (the HTTP reply proves CDP
delivery, not page acceptance — the user is told to check the webpage),
`refused` (a definitive host dash-code), `unconfirmed` (a transport failure or
a host code that itself reports an unverified/unconfirmed outcome — the draft
is kept and the user is asked to inspect the page), or `stale` (the lease/page
changed before dispatch). Only the `sent` outcome may clear the draft, and
only when it was not edited while in flight — clearing is decided by a draft
revision counter, so a re-edit back to the same value is still preserved.
Failed, refused, stale and unconfirmed sends keep the draft with their reason
and are never retried or replayed automatically; a duplicate click while a
send is pending is refused. Remote special keys (回车/退格/Tab/Esc) are explicit
buttons sending one ordered down/up pair each, so editing the draft can never
intercept Enter/Backspace/Tab/Escape as remote shortcuts; desktop pointer
behavior is unchanged. A touch tap on the frame no longer focuses the draft
textarea — the virtual keyboard would shift the layout between pointer down
and up and move the tapped coordinates — while mouse pointers keep the focus
convenience; letterbox coordinate mapping, down/up ordering and generation
binding are unchanged. Drafts are scoped to the mounted session/page: a real
target, host-generation or Session change clears the draft, a fail-closed
channel wipe (authorization refusal, stream loss) instead quarantines it
intact until the page and authority return, and a draft can never be sent to
a page other than the one it was written for. Viewer devices stay read-only.
These are controlled jsdom/React regressions and exported-function checks;
actual iPhone/iOS Safari IME verification has NOT been run and remains
pending physical Codex/human acceptance.

The rc2.5 mobile follow-up review (R7) closed three behavioral gaps. First,
native IME composition is now tracked: while a composition is active the send
button disables and the send handler refuses (no half-finished candidate
string is ever transmitted, no remote Enter, no duplicate final input);
commit and cancel both end at compositionend with the native value final,
blur resets the flag so it can never stick, and a real page/Host change
clears it with the draft. Draft selection, Ctrl+A, paste, Backspace and
Enter stay entirely local, and the draft declares a 16px font so focusing it
cannot trigger the mobile input zoom (no Safari/version sniffing); an R8
follow-up corrected that declaration's cascade — the shared
`.dsh-ego-rc2 textarea{font:inherit}` rule was out-ranking the single-class
selector in the loaded UI (computed 14px), so the draft rule now qualifies
the element (`.dsh-ego-rc2 textarea.dsh-ego-rc2-keyboard`) to win without
`!important` or any theme change. Actual computed font in the real loaded
browser remains Codex's verification, and native iPhone acceptance is still
NOT PASSED. Second, desktop page keyboard shortcuts are restored through a focusable page
keyboard region — the frame image itself: a mouse click on the frame focuses
that region (not the draft editor), and Ctrl+A/arrows/Enter there reach the
page as one ordered down/up pair each with their modifiers; Tab keeps its
focus-moving default and its released down is covered by the blur flush.
Draft-focused keys are never remote. Reserved browser/OS shortcuts cannot
all be guaranteed, and no clipboard sync is claimed — pasted text is local
draft text sent only explicitly. Third, the draft scope tracker now keeps
the LAST VALID target/generation identity: a transient auth/transport wipe
sets the state fields empty but no longer overwrites that identity, so
same-context recovery preserves the quarantined text (never auto-sent),
while a genuinely different proven Host generation/target/session clears the
old draft and composition with a concise notice; the revision-counter
protection still ignores old pending completions, and no old Host operation
or text replays onto the new Host. Status wording corrected: the original
public Canary candidate IS approved and active (old installed bytes) with
physical frame/same-chat takeover/mutual-exclusion evidence — the
user-reported failure is specifically iPhone Chinese input, so Chinese
acceptance remains NOT PASSED; the new mobile code in this candidate has
NOT been publicly activated or physically validated; the old source
clearing mechanism is confirmed, but no native iPhone event/focus trace was
captured, so the complete physical cause is not established; real provider
OAuth remains NOT RUN.

The dsh-remote.1 follow-up (S3) ships the reviewed S1/S2 sources unchanged and
adds one read-only error-classification aid: the existing watch/status route
reports `remoteStreamFull`, and on an unclassified EventSource failure the
panel probes it once to report 远程画面连接已达上限 (close other devices)
instead of a generic 画面连接中断. The flag grants nothing and reserves
nothing — capacity stays enforced only at the two SSE routes, and local
streams (which never consume remote slots) always read false. The full remote
access, stream-budget and boundary contract is documented separately in
`docs/DSH-REMOTE-ACCESS.md`. The dsh-remote.2 follow-up corrects that
document's lifecycle wording only — bounded passive picture retry, a fresh
requester-bound receipt re-proving a still-valid same-client lease, explicit
takeover only when the lease is absent/expired/held elsewhere, and
application revocation described through the protected Access edge — with no
runtime, control or authorization source change; the remote.1 commit and
package are preserved unchanged. The dsh-remote.3 follow-up fixes one client
notice defect observed on the real R13 Canary: after a capacity or
channel-loss stream failure, a later VALID current-session/target/generation
frame now replaces the obsolete 远程画面连接已达上限/画面连接中断 notice
with 画面连接已恢复 — and only then, because the replacement is gated on the
notice still being the message on screen. A newer input, composition,
submission, lease or authorization message is never erased, malformed/stale/
unrelated frames never trigger it, frames still grant no control authority
(requester-bound held receipts are unchanged), retry bounds and no-replay
semantics are untouched, and a stream recovery can never mask an
independently failed authorization/control channel (the auth refusal and
control-channel notices are not stream notices).

The dsh-remote.5 follow-up (P3 S1) makes the watch panel disclose its input
surface progressively instead of showing a placeholder keyboard. The whole
remote-keyboard block renders only for the visible tab that itself holds
proven human control (the same requester-bound receipt rule as before): idle,
Agent-running, other-device and disconnected states show no keyboard chrome.
For a proven holder the block collapses to a small 键盘输入 toggle with
`aria-expanded`/`aria-controls` wiring — a desktop pointer starts collapsed,
while a coarse-pointer (touch) acquisition expands it once per proof (a
guarded `matchMedia('(pointer: coarse)')` layout hint only, never a device
identity or authority fact). The textarea, its 16px declaration and every
IME/authority fence stay mounted in every state: a collapse, expand, lost
takeover or channel pause never touches the draft value, its revision counter
or its page identity, so reacquired control recovers the draft without ever
re-inserting it, and collapsing during an active composition sends nothing
(the existing blur/compositionend fences remain authoritative). The
submit-mode select moved into a default-collapsed 更多选项 details with a
one-line queue/steer explanation; queue stays the default, and while the
non-default 当前轮引导 mode is selected a small always-visible marker outside
the details names it, so closing the details can never obscure a changed
submission behavior. Button labels and reading/takeover/continuation
semantics, the two-phase continuation, IME ordering, draft explicit-send and
no-replay rules are unchanged, and no dependency or Core version moved.
