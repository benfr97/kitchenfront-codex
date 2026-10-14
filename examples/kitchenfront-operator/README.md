# Kitchen Front Codex prototype

An experimental phone client for the open-source Codex App Server. Under Ben’s latest direction, Codex fork is the continuing consolidated product owner. Demo is finishing the guarded shared-account setup and transferring its accepted design and behaviour before pausing. That handoff is pending; this example is not yet the completed hosted product, and no second agent engine is being imported.

The engine uses this fork’s App Server protocol and opt-in dynamic-only router. Record the exact source revision and executable hash for each build. A separately recorded macOS development build has passed isolated initialisation; this is not a genuine AI or hosted acceptance result.

Only fictional customers, correspondence and appointments belong in this experiment. No real email, calendar, customer record, credential or desktop Codex configuration is imported. Inference is disabled until a reviewed isolation boundary and a separately approved bounded test are recorded. An offline replay is explicitly labelled and is not an AI result.

## Browser/server contract

- `GET /api/session` returns `{csrfToken, engine, liveEnabled, messages, proposals, activity}` for an isolated HTTP-only-cookie session. `engine` includes `name`, `version` and factual `status`.
- `POST /api/turns` accepts `{requestId, question}` with `X-CSRF-Token`. It streams newline-delimited JSON events over the response. `requestId` is a UUID generated once per submission. Reusing it must never run a second inference.
- Events are `{type, ...data}`. Types: `turn.started` (`turnId`), `tool.started` (`itemId`, `name`, `label`), `tool.completed` (`itemId`, `name`, `label`, `success`), `message.delta` (`text`), `turn.completed` (`turnId`, `answer`, `proposals`, `usage`, `mode`), `turn.failed` (`code`, `message`, `status`), and `turn.interrupted` (`turnId`, `status`). Render tool activity from received events, not invented timers.
- `POST /api/stop` accepts `{requestId}` plus CSRF. It requests interruption; it is not a billing cancellation claim. Preserve the pending request identity until reconciled.
- `POST /api/proposals/:id/decision` accepts `{decision:"approve"|"reject", revision}` plus CSRF. It returns `{proposal,replayed}`; `proposal.result` describes the exact fictional result. No actual email or calendar write.
- `POST /api/reset` creates a new fictional state generation after explicit user action. It does not erase budget history or authorise a new paid request.
- `POST /api/replay` accepts `{scenario:"quotation"|"reply"|"consultation",requestId}` plus CSRF. It streams the same event shape from deterministic fixtures, always with `mode:"offline_replay"`. It is a developer comparison aid, never evidence of live AI success. Reusing a recorded ID returns a conflict and requires saved-session readback, never another execution.

Proposals contain `id`, `revision`, `kind` (`reply` or `consultation`), `title`, `recipient`, `body`, optional `subject`, optional `start`, `end`, `timeZone`, `calendar`, `status` (`pending`, `approved`, `rejected`, `conflict`) and optional `result`. All originate from server validation against the current fictional session.

The phone UI must say that all effects are simulated, distinguish replay from a genuine AI answer, show failures without a fabricated answer, preserve saved messages/results on reload, and keep Stop/review controls reachable on short and landscape screens.

## Development

Use Node 22 or later. `npm test` uses the built-in test runner; no dependency install or full Rust build is required for the client tests. `npm start` requires `KITCHENFRONT_TWO_YEAR_PACKET_DIR` pointing to the separately supplied, sealed same-host fictional packet, and binds to loopback only. The full packet is not included in this public fork. No hosted or live inference result is claimed by those commands.

The local tests include four macOS containment checks: strict temporary-directory admission, outside-file read/write denial, default network denial and exact loopback fixture-port isolation. Those four are explicitly skipped on other operating systems; a Linux CI pass does not establish macOS containment. The optional sealed-packet test needs the configured same-host path; its skip is not a packet acceptance result. Saved sessions use one exclusive directory owner and expire after eight hours. A stale owner lock is preserved for verified recovery; do not delete it merely to start another server.

For a trusted locally built engine, `npm run smoke -- /absolute/path/to/codex-app-server RECORDED_SHA256 app-server` checks initialization in the outer no-network macOS sandbox, then terminates its own child. Use `cli` as the final argument only for the full Codex CLI entrypoint. The hash must come from a separate source/build receipt; a caller-supplied hash alone is not provenance. This smoke never creates a thread or starts a model turn. Its result does not prove live AI quality or permit inference.

The opt-in Rust change uses `KITCHENFRONT_CODEX_DYNAMIC_ONLY=1` to construct the model tool router from direct dynamic tools alone, without default, deferred, MCP, shell or other tool executors. The flag is scoped to this isolated child. It does not remove separate App Server command APIs, which is why the bridge also has a fixed RPC allowlist. Do not expose raw App Server WebSocket or stdio routes to a browser. A future live build still requires reviewed network/credential handling, per-session engine ownership and spending/cancellation reconciliation before the HTTP `liveEnabled` flag can change.

The public fork contains upstream open-source code and fictional example code only. Keep runtime state and secrets outside the repository. Preserve the root Apache-2.0 licence and notices.

## Fictional date and source contract

At startup the operator configures the external packet directory. Its exact 21-file aggregate and showroom source hash are verified before use. New sessions and explicit resets pin a trusted server clock in Europe/London; HTTP and model inputs cannot set that clock, session or packet. Reload and approval retain the existing snapshot. The UI displays the pinned date, quotation age, enquiry time and consultation request time. The three core cases are separate session-specific fictional overlays, not provider messages. They expose no real mailbox, customer or calendar access.

The presentation snapshot bounds fixed mail to five past messages and calendar to thirty events in the source’s fourteen-local-day window. Casey’s alternatives are separately checked against the entire sealed diary and synthetic review conflict. Proposals can use only those exact candidates; approval also checks any new session booking. The dataset horizon fails closed without historical fallback. The historical 13 October fixture remains only for explicit protocol tests and injected unit-test stores.

For model-free actual-engine plumbing, `node scripts/fixture-engine-check.mjs /absolute/path/to/codex-app-server RECORDED_SHA256` uses a single owned loopback Responses fixture. Every result is labelled `PROTOCOL_FIXTURE_ONLY`; fake fixture token usage must never enter a live budget ledger or a product conversation. It verifies the tool protocol, not model reasoning. Neither that fixture nor an offline UI replay enables `/api/turns`.

Inherited upstream blocking, postmerge and V8 workflows are guarded to the upstream repository. The focused prototype check uses standard Ubuntu only, with no artifact/cache uploads. Do not enable inherited large-runner workflows in this fork.

## Shared seeded-account consumer (not activated)

The separate `SEEDED-READER-CONTRACT.md` describes a proposed server-only port for reading Demo’s same provider records. It requires independently pinned accepted receipt bytes and an exact trusted principal/session/account/grant/resource/source binding. It admits only a bounded approved view, not the full seed ledger. It validates original dates, exact returned IDs, versions, content hashes and resource membership; provider failure cannot use a fictional fallback. There is no OAuth, import, provider transport or credential in this module.

`POST /api/seeded-records` accepts only `{}` with the existing session cookie, same origin and CSRF token. It returns `503 SHARED_CONNECTION_NOT_ADMITTED` by default. Only reviewed server configuration can supply the two exact readers through `seededReadersForSession`; the CLI does not configure or enable that factory. The application caches admitted readers per session generation, holds its activity guard until both accounts settle, rejects a changed session/account result, and returns neither account on partial failure. Reset invalidates the old reader generation. This prepared HTTP path is not actual account connection or provider parity proof.
