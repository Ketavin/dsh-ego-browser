# Opt-in control reliability acceptance

These checks use a dedicated local Chrome profile and local HTTP fixtures. They
do not call a production DSH Host, access account cookies or contact a model
provider. They are separate from the fast Vitest suite.

- `control-reliability-e2e.mjs`: 12 Chrome checks for ambiguous input, no implicit
  replay, unknown outcomes, durable browser identity, explicit recovery and
  refusal to stop a foreign process.
- `main-conversation-handoff-e2e.mjs`: 12 integration checks using the real rc.2
  Core Agent, the plugin HTTP routes, the client Conversation bridge and Chrome.
  A scripted local model holds a real turn open, then requests a real browser
  click after the explicit handoff. The checks cover busy refusal, retained human
  control, a fresh explicit retry, one admitted continuation, one click, request
  deduplication and strict fixture cleanup.

The handoff check needs Node 24 (for direct TypeScript loading), Chrome and a
module lookup directory whose `node_modules` contains the compatible built
rc.2 Core packages, including `@deepseek-ai/dsh-agent-loop`. Set
`DSH_EGO_CORE_MODULE_ROOT` to that lookup directory if it is not the parent of
this repository. Optional environment variables:

- `DSH_EGO_VERIFY_PACKAGE`: the package directory to test; defaults to this repo.
  An installed package can be tested without modifying it.
- `DSH_EGO_VERIFY_EVIDENCE`: output directory for the isolated profile and JSON
  receipt; defaults to `../../evidence` relative to this repo.
- `DSH_EGO_VERIFY_CHROME`: the Chrome executable; defaults to the usual Windows
  system installation.

Run `node verification-own/main-conversation-handoff-e2e.mjs`. The successful
receipt is `main-conversation-handoff-acceptance.json` in the evidence directory.
No test grants control on a production Host. The real Core session admission
uses a local Session-face adapter. Passing these checks does not claim a native
browser panel or a production Conversation was visually operated.
