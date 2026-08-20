# WarpMetal CLI reference

## Contents

- Discovery
- Purchase and provisioning
- Server management
- Agent Runtime and sandboxes
- Per-agent access
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
  [--runtime-file <runtime.json>] [--confirm TEMPORARY] \
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

warpmetal server reload \
  --server <serverId> --confirm ERASE --power-off-first \
  [--acknowledge-agent-runtime-reset] [--hostname <name>] \
  [--os <exact-live-os-name>] [--ssh-public-key-file <public-key-path>] \
  [--idempotency-key <key>] [--wait] [--timeout-seconds <n>] --json

warpmetal operation get \
  --operation <operationId> \
  [--server <serverId>] \
  [--wait] [--timeout-seconds <n>] \
  --json
```

Reload requires the recovery owner credential rather than a short-lived
SSH-derived token. `--power-off-first` authorizes shutdown and powered-off
verification inside the same operation. When Agent Runtime is enabled,
`--acknowledge-agent-runtime-reset` is required because workspaces are erased,
the supervisor must be reinstalled, and connection profiles must be refreshed.

Use `--token-file` only for recovery when local state is unavailable. Prefer
`WARPMETAL_OWNER_TOKEN` or `WARPMETAL_ACCESS_TOKEN` for a single command over a
shell argument, because command-line arguments can be recorded in history and
process listings.

## Agent Runtime and sandboxes

```sh
warpmetal runtime enable --server <serverId> [--idempotency-key <key>] --json
warpmetal runtime get --server <serverId> [--wait] [--timeout-seconds <n>] --json
warpmetal runtime install \
  --server <serverId> --identity <owner-key> --ssh-user <admin-user> \
  --confirm INSTALL [--wait] [--timeout-seconds <n>] --json

warpmetal sandbox create \
  --server <serverId> --name <name> --size <small|medium|large|xlarge> \
  [--lifetime temporary] [--expires-in-seconds <900-86400>] \
  [--confirm TEMPORARY] [--wait] [--timeout-seconds <n>] --json
warpmetal sandbox create --server <serverId> --file <batch.json> \
  [--confirm TEMPORARY] [--wait] [--timeout-seconds <n>] --json
warpmetal sandbox list --server <serverId> --json
warpmetal sandbox get --server <serverId> --sandbox <sandboxId> [--wait] --json
warpmetal sandbox action \
  --server <serverId> --sandbox <sandboxId> \
  --action <start|stop|restart|make_persistent> --confirm <same-action> \
  [--wait] --json
warpmetal sandbox delete \
  --server <serverId> --sandbox <sandboxId> --confirm DELETE [--wait] --json
```

See [runtime.md](runtime.md) for capacity, lifetime, cleanup, polling, and
installation safety. Exit 8 means accepted or pending, never applied.

## Per-agent access

```sh
warpmetal sandbox access keygen --output <private-key-path> --confirm GENERATE --json
warpmetal sandbox access grant \
  --server <serverId> --sandbox <sandboxId> --name <name> \
  --ssh-public-key-file <public-key-path> \
  [--connection-file <profile-path>] [--wait] --json
warpmetal sandbox access list --server <serverId> --sandbox <sandboxId> --json
warpmetal sandbox access get \
  --server <serverId> --sandbox <sandboxId> --grant <grantId> [--wait] --json
warpmetal sandbox access refresh \
  --server <serverId> --sandbox <sandboxId> --grant <grantId> \
  --connection-file <profile-path> --confirm REFRESH [--wait] --json
warpmetal sandbox access revoke \
  --server <serverId> --sandbox <sandboxId> --grant <grantId> \
  --confirm REVOKE [--wait] --json
warpmetal sandbox connect --connection-file <profile-path> \
  --identity <sandbox-private-key-path> [-- <remote-command> <arguments...>]
```

`sandbox connect` is the only runtime command that does not use `--json`; it
returns the OpenSSH or remote exit status. `--connection-file` on grant
creation requires `--wait`.
`sandbox access refresh` atomically replaces a stale token-free profile with
the currently applied grant and API-reported pinned host keys; use it after an
OS reload and supervisor reinstall.

## Skill installation and state

```sh
warpmetal agent install --target <codex|claude|all> [--scope user|project]
warpmetal state list --json
```

`state list` returns identifiers, public runtime metadata, and
credential-presence booleans only. Never
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
