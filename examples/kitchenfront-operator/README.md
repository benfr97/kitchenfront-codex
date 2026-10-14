# Kitchen Front Codex prototype

A separate experimental phone client for the open-source Codex App Server. The SDK Demo continues in its own chat, branch and preview. This client does not replace it.

The engine is pinned to the installed Codex CLI 0.160.0 protocol. The source fork base is recorded separately; no modified engine binary has yet been built or accepted.

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

Use Node 22 or later. `npm test` uses the built-in test runner; no dependency install or full Rust build is required for the client tests. `npm start` binds to loopback by default. No hosted or live inference result is claimed by those commands.

The public fork contains upstream open-source code and fictional example code only. Keep runtime state and secrets outside the repository. Preserve the root Apache-2.0 licence and notices.
