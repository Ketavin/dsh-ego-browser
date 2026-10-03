# DSH rc.2 adaptation candidate

This is an isolated source candidate based on upstream v0.8.6,
`dfde57221443bdade5e0cbee7c773a6839ffe560`. It is not enabled in the formal
Profile and is not yet a compatible release. Do not lower the package engine
range or enable the plugin before the remaining integration gates pass.

The first change reuses `connection.requestRejection` on every cast route and
the settings prefix. On the deployed Core (`8de453b`, with the P1/P2 candidate
layered on it), this means loopback socket plus Host/Origin/browser trust.
It is **not** an authenticated user identity interface. Remote callers are
denied; forged `dsh-auth-*` cookies have no effect. Missing/unmounted Host
fences fail closed. Actions also require POST and JSON; reads require GET.
The client still needs its bodyless POST calls reviewed against this contract.

The entry schema uses plain fields because rc.2 has no `.volatile()` API.
Its existing registered settings scope/watch path is retained. This fixes a
real load-time exception found while exercising the source with Core's actual
Schemastery. It does not certify every settings UI path.

Development links for tools/settings point to the sibling isolated P2 Core
checkout. Automatic peer installation is disabled in pnpm-workspace.yaml to
prevent `pnpm exec` from silently adding a different DSH generation. The
lockfile pins this development assembly; final release dependency metadata
will be established after the rc.2 client and runtime gates.

Validated on 2026-10-03:

- Host/client TypeScript check passed.
- Config/settings/trust/cast regression: 6 files, 41 tests passed.
- Separate fixture using the actual Core HostConnectionService and real
  loopback HTTP: 64 checks passed across all 15 registered routes, remote
  socket rejection, and Host-approved requests without cookies. No browser,
  worker, ffmpeg download or external provider was started.

Still required: rc.2 client runtime bridge; per-session task-space ownership
and popup/target checks; shared human/tool control lease and cancellation;
explicit main-chat context/continue bridge; independent Chrome data path;
Windows runtime, OAuth and persistence validation; real combined Sidebar
Profile and actual loaded-bundle checks. The existing global default space,
unrestricted low-level script tools and login-import controls must not be
mistaken for an accepted scoped integration.

P1–P6 are to ship together only after individual and combined acceptance,
under a new exact production release approval. This source commit grants no
production promotion or account-login permission.
