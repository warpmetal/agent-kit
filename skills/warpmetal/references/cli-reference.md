# WarpMetal CLI reference

## Contents

- Discovery
- Purchase and provisioning
- Server management
- Skill installation and state
- Exit codes

## Discovery

```sh
warpmetal health --json
warpmetal catalog [--plan <planId>] --json
```

`health` exits with code 3 when the service responds but purchasing is paused.
The catalog remains useful for read-only discovery.

## Purchase and provisioning

```sh
warpmetal order prepare \
  --plan <live planId> \
  --hostname <dns-label> \
  --os '<exact live OS name>' \
  --ssh-public-key-file <path> \
  [--email <address>] \
  [--idempotency-key <key>] \
  --json

warpmetal checkout challenge --task <taskId> --json

warpmetal checkout submit \
  --task <taskId> \
  --payment-signature-file <path> \
  [--wait] [--timeout-seconds <n>] \
  --json

warpmetal order status \
  --task <taskId> \
  [--wait] [--timeout-seconds <n>] \
  --json
```

The payment signature file must contain one HTTP header value. The CLI does
not create or store wallet keys and does not sign x402 challenges.

## Server management

```sh
warpmetal server login \
  --server <serverId> \
  --identity <private-key-path> \
  --json

warpmetal server get --server <serverId> --json

warpmetal server power \
  --server <serverId> \
  --action <boot|reboot|shutdown> \
  --confirm <same-action> \
  [--idempotency-key <key>] \
  [--wait] [--timeout-seconds <n>] \
  --json

warpmetal operation get \
  --operation <operationId> \
  [--server <serverId>] \
  [--wait] [--timeout-seconds <n>] \
  --json
```

Use `--token-file` only for recovery when local state is unavailable. Prefer
`WARPMETAL_OWNER_TOKEN` or `WARPMETAL_ACCESS_TOKEN` for a single command over a
shell argument, because command-line arguments can be recorded in history and
process listings.

## Skill installation and state

```sh
warpmetal agent install --target <codex|claude|all> [--scope user|project]
warpmetal state list --json
```

`state list` returns identifiers and credential-presence booleans only. Never
open the underlying state file from an agent session.

## Exit codes

- `0`: command completed or reached its requested safe stopping point.
- `1`: unexpected local or API failure.
- `2`: invalid command, option, input, or local state.
- `3`: purchasing unavailable, rate limited, or API temporarily unavailable.
- `4`: missing or rejected credential or SSH proof.
- `5`: API conflict, including an idempotency conflict.
- `6`: manual review; stop and do not retry the consequential action.
- `7`: payment authorization rejected or required; inspect the live challenge.
- `8`: operation still pending or wait timeout reached.
