# Proposed seeded-read consumer port

`lib/seeded-reader.mjs` defines a server-only consumer boundary for a future Kitchen Front Demo shared-connection broker. It is a proposal, not an accepted live broker contract: Demo's accepted broker contract and returned-provider-ID ledger are still missing. Keep the HTTP path disabled until those artifacts are independently admitted. The expected business accounts are `hello@kitchenfront.co.uk` for Google and `kitchenfront@outlook.com` for Microsoft; provider IDs remain receipt supplied and are never hardcoded here.

## Server construction

The server may construct a reader with:

```js
createSeededReader({
  binding,                            // trusted actor/org/session/provider/account/grant/resource/source/revision binding
  acceptedReceiptBytes,               // already-read receipt bytes, never a caller-selected path
  expectedReceiptSha256,               // independently pinned hash of those exact bytes
  admissionEvidenceBytes,              // already-read scoped resource/capability evidence bytes
  expectedAdmissionEvidenceSha256,      // separately configured hash, not a value trusted from the evidence
  capabilities,                       // separately reviewed, read-only capability declaration
  broker,                              // trusted injected callback; no HTTP transport is implemented here
  clock,                               // trusted server clock; tests inject a deterministic clock
})
```

All construction values must come from server-owned connection/session state. Do not accept actor, organisation, provider, account, grant, resource, receipt, record IDs, time window or clock from request JSON or the model. Construct a reader for the current real session generation and discard it when that generation changes. `pinnedAt` comes from the trusted server clock at reader construction and is distinct from any fictional local snapshot clock. The reader is frozen and privately branded; `isSeededReader(value)` rejects method-shaped substitutes. Its immutable flat `admissionScope` carries the complete binding, capabilities and independently checked evidence/receipt hashes for server readback checks.

The public HTTP adapter should require authentication, CSRF and the exact `{}` request shape. Its default remains `503 SHARED_CONNECTION_NOT_ADMITTED` when the accepted broker contract and returned-ID ledger are absent. The adapter is the only caller of `readAcceptedSeeds({signal})`; its optional abort signal is an internal server deadline/disconnect control, never a user selector. The broker receives the same signal as its second callback argument. A callback that ignores abort is still considered active until it actually settles.

## Admission and bounded reads

Before the first broker callback, the reader verifies exact accepted receipt bytes against the separately pinned SHA-256, exact trusted binding, accepted status and validity interval, source aggregate `505aa0aebccc5476a5eed8a1e5dfad464c06dc8e12220a1ef5239c2e45bad611`, resource identity/revision, reviewed read capabilities, read-only guards and the scoped broker declaration. Resource admission also requires separately pinned evidence bytes and an independently configured expected SHA-256. That evidence must bind the exact provider, account, subject, client, grant and revision, dedicated resource IDs and revisions, resource kinds, `isDefault:false`, and resource/guard/capability review references and digests. Google calendar access additionally requires cross-client broker review matching the exact client, grant and secondary calendar. The reader requires the exact evidence status `accepted_independent_resource_admission` and rejects `configuration_proposal`. Demo's accepted resource evidence is still missing; a status string inside a local receipt cannot establish external acceptance or a provider read.

Default aliases and primary resources are rejected before broker access. Mail resources must be a dedicated Google label or Microsoft folder; known system folders, account-address aliases and defaults are invalid. Calendar resources must be a separately created `app_created_secondary` resource with `isDefault:false`; `primary`, `default`, `me`, or the account address is invalid. The expected Google/Microsoft business account address is independently fixed by this consumer contract.

The accepted seed view is limited to at most 5 past mail records and 30 calendar records. Each mail seed pins its `receivedAt`; each calendar seed pins `start` and `end`. The reader rejects future mail and calendar events outside the pinned 14-day Europe/London window before invoking the broker. Current events are allowed when `end > pinnedAt && start < windowEnd`; returned timestamps must exactly match seed metadata. The callback receives one exact-ID request per source with trusted scope, receipt hash, exact dedicated resource, source time window, response byte caps, count limit and no-wide-query/no-fallback guards. Google mail must still carry the dedicated label ID on each returned message; Microsoft mail must carry the exact dedicated folder ID; calendar records must carry the exact dedicated calendar ID.

The callback must return `{status:'ok', scope, coverage, records}`. Scope echoes the binding, receipt hash and capabilities. Coverage identifies the source, `exact_approved_ids` mode, requested and returned counts, and `hasMore` with a cursor when applicable. The reader requires a complete response for the accepted view, exact returned IDs, unique records, exact versions and content digests, matching resource membership and valid bounded timestamps. Any error, malformed response, partial batch, expiry or provider failure rejects the whole method; it never returns a successful source as partial output and never falls back to fixtures. Abort is checked before each source, after each awaited broker callback and before returning. The reader makes no retry.

`readAcceptedSeeds()` returns `status: 'provider_seed_readback'`, `coverageBasis: 'bounded_accepted_seed_view'`, `overallSourceCoverage: 'UNKNOWN'`, the same frozen `admissionScope` as `sessionScope`, the pinned London time, source aggregate and receipt hash, plus `mail` and `calendar` records and their coverage/cursor details. It reports only the accepted bounded view. A future broker must choose and attest a bounded view (at most 5 mail and 30 calendar records) and map those records to its returned-ID ledger; this consumer does not choose among a larger collection or paginate it. It does not claim to enumerate the full mailbox, calendar, or larger fixture collection. `nextCursor` is exposed as coverage evidence and is never followed automatically.

## Interruption and cleanup

The HTTP adapter has a bounded response deadline. It can return `503 SEED_READ_INTERRUPTED_UNKNOWN` after aborting the internal signal, but this is not evidence that an underlying broker or reader stopped. While any owned callback remains unresolved, the session is `blocked_unknown`; reset and replay return `409 READ_CLEANUP_UNKNOWN`. The hold clears only when the factory and all reads actually settle. Session expiry during an in-flight operation returns `401 SESSION_EXPIRED_DURING_READ` without releasing partial records. Server shutdown aborts owned operations and retains the session-store owner lock until their completion; startup of a successor is not admitted while that lock remains held.

## Verification boundary

`test/seeded-reader.test.mjs` uses fictional IDs, fictional `example.test` contacts, a local in-memory callback and an ephemeral loopback HTTP server. Its structurally valid accepted-status evidence is synthetic test input, not an accepted Demo receipt. It covers the exact scope and resource admission, alias/default rejection, no callback before admission, pre-callback future-mail rejection, session/grant/source/resource changes, removed labels, duplicates, wrong versions/digests, invalid windows, byte/count limits, all-or-nothing provider failures, principal/session scoping, unbranded readers, abort acknowledgement, ignored-abort holds, factory deadlines, session expiry, cache eviction and shutdown ownership. These tests establish consumer-port behavior only. They do not prove Demo acceptance, OAuth, a provider read, live record provenance, UI integration, or an actual model-assisted demo. The visible app must not present these fixture tests or any synthetic callback result as a live provider result.
