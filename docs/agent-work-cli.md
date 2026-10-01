# Retained Work CLI

The Work commands use the existing server owner or short-lived owner SSH token.
They never fall back to the account session and never accept a bearer token on
the command line.

## Command grammar

Commands are positional:

```text
warpmetal work list SERVER BOX [--cursor CURSOR] [--limit N]
warpmetal work show SERVER BOX WORK
warpmetal work content SERVER BOX WORK [--revision N]
warpmetal work sources SERVER BOX [--cursor CURSOR] [--limit N]
warpmetal work policy SERVER BOX
warpmetal work create SERVER BOX --file REQUEST.json [--idempotency-key KEY]
warpmetal work update SERVER BOX WORK --file REQUEST.json [--idempotency-key KEY]
warpmetal work enable SERVER BOX WORK --file REQUEST.json [--idempotency-key KEY]
warpmetal work checkpoint SERVER BOX WORK --file REQUEST.json [--idempotency-key KEY]
warpmetal work continue SERVER BOX WORK --file REQUEST.json [--idempotency-key KEY]
warpmetal work restore SERVER BOX WORK --file REQUEST.json [--idempotency-key KEY]
warpmetal work handoff SERVER BOX WORK --file REQUEST.json [--idempotency-key KEY]
warpmetal work targets SERVER BOX WORK
warpmetal work status SERVER BOX WORK --kind checkpoint|continue|restore|handoff
  (--request REQUEST | --operation OPERATION)
warpmetal work open SERVER BOX WORK [--connection-file FILE] [--identity FILE]
```

The common `--base-url`, `--state-dir`, `--token-file`, `--json`, and `--help`
options retain their existing meanings. `open --json` fetches and prints a
fresh validated handoff descriptor without starting SSH. Non-JSON `open`
passes the same validated descriptor to the existing grant-bound session
bridge; it cannot choose a path, shell command, native project, or session.

## Closed input and output

Every mutation reads one explicit JSON object from `--file`. Create and update
permit at most 2 MiB of encoded JSON because those are the only deliberate
private Work-content writes. Other mutation inputs are limited to 64 KiB. The
canonical projectors reject unknown fields, invalid identifiers, stale or
missing revision fences, invalid task pairs, unsupported target modes, and
oversized content before a network request.

The idempotency key defaults to the request body's exact `requestId`. An
explicit `--idempotency-key` changes only the HTTP idempotency header. The
private mutation journal binds origin, fixed API path, request ID, and body
digest before the first POST. An ambiguous later invocation of the same intent
uses only the command's fixed GET reconciliation route. It never resubmits the
mutation or changes its body. A changed body under the same origin, fixed path,
and saved request ID is a local conflict. A distinct fixed path has its own
journal record.

Metadata commands never print objective, constraints, context, credentials,
host paths, native workspace directories, or raw Runtime evidence. `content`
is the deliberate private-text read and `create`/`update` are the deliberate
private-text writes. All server responses pass the reviewed closed Work,
continuation, handoff, or session-handoff projector before output.

## Operation outcomes

A pending, reported, or outcome-unknown operation exits 8. Failed or
superseded operations exit 5. A validated terminal `accepted` checkpoint exits
0 only with its checkpoint receipt; restore exits 0 only with its materialized
target; continuation and handoff exit 0 only with their admitted task/baseline
receipt. Human output says `checkpoint saved`, `workspace restored`,
`continuation admitted; task outcome pending`, or
`handoff admitted; task outcome pending`; admission never claims the task
finished.

`status` is GET-only and requires exactly one saved request ID or operation ID.
It cannot create or replay an operation.
