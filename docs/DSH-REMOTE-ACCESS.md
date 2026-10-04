# DSH remote Agent Browser access contract (S3 candidate)

Local candidate version `0.8.6-dsh-remote.2` on the reviewed rc2.5 source
line (base `22a229245ec336fb4a132e88e312221575b5d5b8` plus the reviewed
S1/S2 diffs); the `0.8.6-dsh-remote.1` package and commit are preserved as
historical evidence. This document is the packaging contract for the remote
access path; `DSH-RC2-ADAPTATION.md` remains the adaptation note for the
local candidate. Neither document is a release acceptance.

## Configuration (mount-time, not Settings)

Remote access is enabled only by a host composition entry `remoteAccess`
with four exact fields: `origin` (one HTTPS origin, no path/query), `issuer`
(an `https://<team>.cloudflareaccess.com` root), `audience` (one Access
application audience) and `ownerSubject` (the single allowed owner subject —
never inferred; the operator supplies it). Absent, partial or malformed
configuration leaves remote access disabled (`remote-access-unconfigured` /
`remote-access-invalid`), and the block is outside SettingsConfig, the
settings schema, the gateway ALLOWED_KEYS and the live settings bridge: no
browser Settings or gateway preference write can create or move it. The JWKS
URL is derived from the issuer; a request can never supply its own.

## Authorization chain (per request, every request)

Local desktop requests keep the unchanged Core `connection.requestRejection`
fence. Remote callers are answered only through the plugin-owned path that
runs strictly AFTER that fence refused: a `Cf-Access-Jwt-Assertion` header
(the Access edge injects it from the user's `CF_Authorization` session)
verified with RS256 against the issuer JWKS — signature, issuer, audience,
expiry (and `nbf`), and the pinned single owner subject. Tokens are never
accepted from a URL (token-shaped query names are refused), never written to
responses, persistence or logs, and duplicated authorization headers
(Host/Origin/Sec-Fetch-Site/assertion) on the wire are refused before
verification. Host, Origin and Sec-Fetch-Site must pin to the configured
origin. A verified grant changes nothing about the guard chain that follows:
method/body shape, session scope, owned target, host generation, request
identity and human-lease checks apply identically to remote callers.
Refusals carry codes only — never a cookie, JWT, owner subject, audience or
command-line token.

## Boundaries and budgets

- **Single owner, many devices.** The verified owner may open the same chat
  from several devices. Passive watching (spaces, SSE frame stream, watch
  status) is open to every device of the session; human control is bound to
  exactly one client device identity per lease epoch (`lease-held-elsewhere`
  / `lease-holder-mismatch` for others), and a viewer's draft and remote keys
  stay disabled.
- **Control is not the picture.** Watching frames grants nothing; takeover is
  an explicit stop-and-take-over action. Losing the picture never revokes or
  releases a lease, and a lease loss never keeps input authority.
- **Remote SSE budget.** At most **4 concurrent remote Ego SSE streams**
  (`REMOTE_MAX_STREAMS`), each bounded by BOTH the verified JWT expiry and a
  10-minute maximum window, whichever ends first — a reconnect always
  re-presents a fresh assertion to the full chain. The 4-stream budget is
  shared by frame streams AND the running-session `tool-events` metadata
  stream: it is a plugin-wide stream budget, **not** a promise that 4 devices
  can watch in every combination. An over-capacity stream route answers
  `429 { ok: false, code: "remote-stream-capacity" }` before any SSE headers;
  because an EventSource connect failure exposes no HTTP status or body, the
  panel makes one read-only `watch/status` probe (`remoteStreamFull`) to
  report 已达上限 precisely instead of a generic disconnect. The probe grants
  and reserves nothing; enforcement stays at the stream routes; local streams
  never consume remote slots. Slots are released on disconnect, close,
  deadline, expiry or plugin unload.
- **Expiry, revocation and re-auth.** Token expiry — or an application-level
  token revocation performed through the Cloudflare Zero Trust admin, after
  which the protected Access edge stops admitting that application's
  sessions (the origin verifies each freshly presented assertion and keeps
  no revocation list of its own) — ends streams and fails closed: frames
  clear, control and draft input are disabled locally, and the host lease
  itself is untouched. Passive recovery is bounded, never silent: the picture
  channel retries at most three consecutive times before parking until the
  status channel recovers, and it reconnects only once a request actually
  passes authorization again; no draft, queued input, main Conversation or
  Agent execution is ever replayed or resumed implicitly. Authentication
  alone never grants control: authority returns only through a fresh
  requester-bound receipt (a status poll or takeover answer naming this
  device with `held: true` for the current host generation and lease epoch).
  A human lease that is still valid and still this same client's may be
  re-proved by such a receipt without a new takeover; if the lease is
  absent, expired or held by another device, an explicit takeover is
  required. The accepted R12 recovery evidence observed the first device
  passive after re-authentication — it did not test, and does not promise,
  a blanket always-passive behavior for a still-live same-client human
  lease.
- **No replay of human work.** A disconnect, expiry, refusal or host
  generation change never replays queued input, re-sends a draft or resumes
  the main Conversation; the explicit draft-send semantics (composition guard,
  one bounded ordered insertText, outcome-preserving failure handling) are
  unchanged and documented in `DSH-RC2-ADAPTATION.md`.

## DSH Access login vs target-website OAuth

Cloudflare Access login authenticates the OWNER to the plugin routes. It is
not, and does not imply, login to any target website: real provider OAuth
(provider selection, popup/callback, device boundaries, dedicated-Profile
persistence) is **NOT RUN / unaccepted**, and the system-browser login import
and native popups remain closed. Only the plugin's own opener-bound
popup/redirect behavior under the dedicated profile is covered by existing
controlled evidence.

## Packaging notes

Runtime auth dependency: `jose@6.2.3` (pinned exact), used by the Host bundle
for JWKS verification. The tarball ships the actual Host entry, the cast
worker and the client bundle plus this contract; `jose` installs from the
registry at assembly time as a declared dependency (it is not vendored).
Interfaces relied on as stable, without a Core upgrade: the rc.2
`0.1.1-rc.2` host (webServer route registration, `connection.requestRejection`,
Session/Agent registry, scope/generation/target services, control lease) and
the Better Sidebar `browserUrl` tab contract.
