# Reviewed DSH rc.2 isolation candidate

Local version: `0.8.6-dsh-rc2.3`. Upstream v0.8.6 source base:
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
