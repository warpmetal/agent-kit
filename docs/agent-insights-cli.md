# Agent Insights CLI contract

Status: implemented in the reviewed CLI 0.9.1 candidate; publication and deployed qualification remain pending. Commands below use
the closed, versioned owner contracts in `src/contracts/`; historical
qualification evidence is retained separately from this source checkpoint.

Agent Insights uses the existing server-owner token from `warpmetal server
login`. It does not fall back to account login, create a sandbox grant, submit
a prompt, start a provider call, or change manager/takeover state while reading
or opening a session.

## Commands

All resource identifiers are positional. Mutations read a bounded, closed JSON
object from `--file`; `--idempotency-key` defaults to that object's `requestId`.

```text
warpmetal insights summary SERVER [--limit N] [--cursor BOX]
warpmetal insights status SERVER BOX
warpmetal insights enable SERVER BOX --file FILE [--idempotency-key KEY]
warpmetal insights disable SERVER BOX --file FILE [--idempotency-key KEY]
warpmetal insights list SERVER BOX [--limit N] [--cursor FINDING]
  [--state open|resolved] [--session SESSION] [--severity warning]
  [--attention unacknowledged|acknowledged|snoozed|dismissed]
  [--rule RULE] [--recent-hours 1|24|168|720]
warpmetal insights show SERVER BOX FINDING
warpmetal insights acknowledge SERVER BOX FINDING --file FILE [--idempotency-key KEY]
warpmetal insights snooze SERVER BOX FINDING --file FILE [--idempotency-key KEY]
warpmetal insights dismiss SERVER BOX FINDING --file FILE [--idempotency-key KEY]
warpmetal insights open SERVER BOX FINDING [--takeover OPERATION]
  [--connection-file FILE] [--identity PATH]

warpmetal insights manager settings SERVER BOX [--file FILE] [--idempotency-key KEY]
warpmetal insights manager activity SERVER BOX [--limit N] [--cursor RUN]
  [--finding FINDING]
warpmetal insights manager run SERVER BOX RUN
warpmetal insights manager target SERVER BOX FINDING
warpmetal insights manager recheck SERVER BOX FINDING --file FILE [--idempotency-key KEY]
warpmetal insights manager status SERVER BOX FINDING --request REQUEST

warpmetal insights takeover list SERVER BOX FINDING [--limit N] [--cursor OPERATION]
warpmetal insights takeover SERVER BOX FINDING --file FILE [--idempotency-key KEY]
warpmetal insights takeover status SERVER BOX FINDING --operation OPERATION
warpmetal insights takeover resume SERVER BOX FINDING --operation OPERATION
  --file FILE [--idempotency-key KEY]

warpmetal insights review SERVER BOX RUN [--connection-file FILE] [--identity PATH]
```

The settings `enable` and `disable` verbs require the canonical Insights
settings mutation and require `enabled` to match the verb. Finding action verbs
likewise require the canonical action to match the verb. Manager settings with
no file is a GET; with a file it is a PATCH. Manager status and takeover status
are GET-only recovery lookups using the explicit `--request` or `--operation`.

The `open --takeover OPERATION` option verifies an existing exact ready pause
operation. It never creates one. The finding, source, member, policy and hold
must still be current, and a superseding resume makes the proof stale. If the
owner API cannot establish those facts, the CLI refuses the handoff. Ordinary
`open` remains a read-only exact-session lookup.

With `--json`, `open` and `review` print only the freshly validated canonical
session-handoff descriptor and never claim that SSH or a native client opened.
Without `--json`, they pass that descriptor to the separately owned fixed
session-handoff launcher. Merely listing, showing, copying, opening or reviewing
never acknowledges a finding, starts a review, pauses a member, resumes a hold,
creates a session, or sends a prompt.

## Transport and replay

The handler exports:

```text
async handleInsights(positionals, options, services): number
```

`services` contains `client`, `store`, `context`, `requireServerToken`, `emit`,
`readInput`, `runMutation`, and `openSessionHandoff`. Authentication calls
`requireServerToken(store, serverId, options, context.env)`. HTTP uses
`client.request(method, path, {token, body, idempotencyKey})`.

Every mutation calls `runMutation` with the fixed exact API `path`, server and
sandbox scope, mutation kind, validated request ID/body, and submit/reconcile
callbacks. The journal is written before the first request. Repeating the same
intent performs recovery with GET only; a changed body conflicts locally.
Settings and finding actions reconcile through their read projections. Manager
Recheck uses the request lookup route. Takeover and Resume use the exact
operation lookup routes.

Mutable-resource reconciliation succeeds only when the current GET still
proves the saved request. Settings and attention require exactly the requested
revision plus one and the requested state. Manager policy additionally requires
the requested rules and limits; its public expiry and update timestamps must
still prove the requested authorization duration. Runtime policy acknowledgement
and manifest renewal can change those timestamps without changing the policy
revision, so a later GET may conservatively return an unknown outcome even when
the currently displayed policy is otherwise useful. `manager settings` without
`--file` remains the way to inspect that current state without claiming recovery
of an older mutation.

A snooze deadline is derived from the backend clock and its public finding does
not include the mutation timestamp. The initial POST receipt can prove the next
attention revision, snoozed state and presence of the server-derived deadline;
a GET-only retry cannot prove the originally requested duration and therefore
fails closed. The CLI never retries the POST. Recheck, Takeover and Resume bind
their public receipts to every request-carried revision, source, target and
budget field that the backend projects. Resume also reads and verifies the exact
predecessor policy and hold tuple before submission or recovery.

The handler consumes unchanged owner projection modules:

- `src/contracts/insights.js`: Insights query, mutation and response projectors;
- `src/contracts/manager.js`: manager query, mutation and response projectors;
- `src/contracts/session-handoff.js`: exact-session envelope projector.

Unknown options, surplus positionals, malformed files, action/verb mismatch and
invalid queries fail before any network request. Unknown or expanded server
responses fail closed and are never printed. Input files are capped at the
shared mutation limit and raw provider text, credentials, prompts and paths do
not appear in output.

Accepted/pending work exits 8. A terminal recommendation or `no_action` exits 0; `no_action` preserves its actual closed state and safe outcome instead of claiming a recommendation. Terminal failures exit 5. A completed review that requires owner attention retains `needs_owner`; opening its exact valid proposal-bearing session remains read-only. Authentication failures retain exit 4, request/transport/contract
failures retain the shared CLI codes, and syntax/input errors exit 2.
