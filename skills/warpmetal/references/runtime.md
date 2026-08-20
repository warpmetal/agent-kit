# WarpMetal Agent Runtime

## Product boundary

Agent Runtime is optional. One VPS owner uses it to divide that owner's VPS
among that owner's agents; it is not a multi-customer hosting or billing
system. VPS price, term, renewal, power, and payment remain unchanged.

All V1 sandboxes use one WarpMetal-pinned image. Callers choose a published
size, not an arbitrary image, template, command, mount, environment, CPU,
memory, or disk value.

## Discover capacity and OS support

Run `warpmetal catalog --json`. Use only the selected product's live:

- `agentRuntime.supported`;
- `agentRuntime.capacity`;
- `agentRuntime.sizes[]`; and
- `operatingSystems[].agentRuntimeSupported`.

The API checks admission again and the installed supervisor may reject work
when actual host capacity is lower. Never assume every size fits every VPS.

## Order-time versus after provisioning

For order-time intent, write a JSON file containing only `sandboxes` and the
fields `name`, `size`, optional `lifetime`, and optional `expiresInSeconds`:

```json
{
  "sandboxes": [
    { "name": "planner", "size": "small" },
    { "name": "builder", "size": "medium" },
    {
      "name": "reviewer",
      "size": "small",
      "lifetime": "temporary",
      "expiresInSeconds": 14400
    }
  ]
}
```

Pass it to `warpmetal order prepare --runtime-file <path>`. If it contains a
temporary sandbox, pass `--confirm TEMPORARY`. Preparing remains unpaid; keep
the existing separate payment approval.

For an existing ready server:

```sh
warpmetal runtime enable --server <serverId> --json
warpmetal runtime install \
  --server <serverId> \
  --identity <owner-private-key-path> \
  --ssh-user <os-admin-user> \
  --confirm INSTALL \
  --wait \
  --json
warpmetal runtime get --server <serverId> --wait --json
```

Ask before installation. Pass the owner key path without reading the file.
The CLI holds the one-time bootstrap only in memory, verifies the signed
artifact, uploads it through OpenSSH without a shell-enabled local spawn, and
does not print or store the bootstrap.

## Sizes and lifetime

Use `small`, `medium`, `large`, or `xlarge` exactly as the live catalog
publishes them. Create one sandbox or an atomic JSON batch:

```sh
warpmetal sandbox create \
  --server <serverId> \
  --name <name> \
  --size <size> \
  [--lifetime temporary] \
  [--expires-in-seconds <900-86400>] \
  [--confirm TEMPORARY] \
  --wait \
  --json

warpmetal sandbox create \
  --server <serverId> \
  --file <batch.json> \
  [--confirm TEMPORARY] \
  --wait \
  --json
```

Lifetime rules:

- Omitted lifetime is persistent and has no automatic deletion.
- Temporary defaults to 86,400 seconds, with a 900-second minimum and
  86,400-second maximum.
- The clock begins on first `running`; restart and stop do not reset or pause
  it.
- `expiresAt` is authoritative after first running.
- Expiry revokes access, terminates sessions, removes the container, and
  permanently deletes the workspace even during a control-plane outage.
- Before `expiring`, `make_persistent` removes automatic expiry. V1 cannot
  extend a temporary duration.

Use `sandbox list`, `sandbox get --wait`, and guarded `sandbox action` commands
to observe and change desired state. HTTP 202 and CLI exit 8 mean accepted or
pending, not complete.

Manual deletion is irreversible:

```sh
warpmetal sandbox delete \
  --server <serverId> \
  --sandbox <sandboxId> \
  --confirm DELETE \
  --wait \
  --json
```

State the workspace-loss consequence and get approval before running it.

## One key and grant per agent sandbox

The owner host key is never an agent sandbox credential. For each agent and
sandbox, ask before generating a distinct Ed25519 keypair:

```sh
warpmetal sandbox access keygen \
  --output <sandbox-private-key-path> \
  --confirm GENERATE \
  --json

warpmetal sandbox access grant \
  --server <serverId> \
  --sandbox <sandboxId> \
  --name <grant-name> \
  --ssh-public-key-file <sandbox-public-key-path> \
  --connection-file <profile-path> \
  --wait \
  --json
```

Only the public key goes to WarpMetal. The private key stays with the agent.
The token-free profile is written only after the grant is `applied` and the
API supplies verified VPS host keys. Do not print or open that profile in an
agent conversation.

After a destructive OS reload, reinstall the supervisor and wait for the
retained active grant to become `applied`, then replace its stale pinned
profile:

```sh
warpmetal sandbox access refresh \
  --server <serverId> \
  --sandbox <sandboxId> \
  --grant <grantId> \
  --connection-file <profile-path> \
  --confirm REFRESH \
  --wait \
  --json
```

The sandbox record is retained, but its old workspace is not; reconciliation
creates a new empty workspace. Never bypass a host-key mismatch or reuse the
pre-reload profile.

Connect without an owner management credential:

```sh
warpmetal sandbox connect \
  --connection-file <profile-path> \
  --identity <sandbox-private-key-path>

warpmetal sandbox connect \
  --connection-file <profile-path> \
  --identity <sandbox-private-key-path> \
  -- <remote-command> <arguments...>
```

`sandbox connect` is direct SSH transport and does not use `--json`. It pins
the API-provided host key, disables forwarding, never reads the private key,
and returns the remote exit status. The forced gateway maps the key to exactly
one sandbox and cannot start a host shell.

Revoke access with explicit approval:

```sh
warpmetal sandbox access revoke \
  --server <serverId> \
  --sandbox <sandboxId> \
  --grant <grantId> \
  --confirm REVOKE \
  --wait \
  --json
```

Revocation removes new access and terminates tracked active sessions while
leaving the sandbox itself intact.

## Stop conditions

Stop rather than improvise when:

- the CLI lacks a required runtime command;
- the live catalog does not support the plan, size, or OS;
- runtime is `degraded`, `offline`, or `needs_reinstall` and the documented
  repair is not approved;
- a sandbox or grant reaches `failed`;
- pinned host keys are missing or differ;
- deletion, temporary expiry, key generation, installation, or revocation has
  not received the required approval; or
- any command would require raw API, raw Podman/Docker, ad hoc SSH host
  mutation, the owner key inside a sandbox, or exposure of a credential.
