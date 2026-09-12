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
the existing separate interactive-or-autonomous payment authority check.

For an existing ready server:

Use the WarpMetal owner account `root` for every supported host image; do not
substitute a distribution-default account such as `ubuntu`.

```sh
warpmetal runtime enable --server <serverId> --json
warpmetal runtime install \
  --server <serverId> \
  --identity <owner-private-key-path> \
  --ssh-user root \
  --confirm INSTALL \
  --wait \
  --json
warpmetal runtime get --server <serverId> --wait --json
```

Ask before installation. Pass the owner key path without reading the file.
CLI 0.8.8 first validates that the public half matches the server's ordering-key
fingerprint. When that server trust epoch has no pin, it runs only an owner-key-
authenticated `ssh true`, trusts the first observed Ed25519 host key, publishes
it atomically under the private WarpMetal state directory, and immediately
reconnects strictly. Only then does the CLI request the one-time bootstrap. It
holds that bootstrap only in memory, verifies the signed artifact, uploads it
through OpenSSH without a shell-enabled local spawn, and does not print or store
the bootstrap. Every later SSH/SCP operation uses the same strict pin; a
mismatch never overwrites it.

First-use trust provides continuity after the first observation but cannot
detect an active attacker on that connection. Provider-console pre-enrollment
is an optional higher-assurance alternative, not a requirement. Only a locally
recorded successful reload that reports an owner-host-key refresh creates one
new operation-bound trust epoch; failed or ambiguous reloads do not.

The signed installer is designed to preserve container workloads already
running on a supported host. It selects `crun` for WarpMetal's private rootless
Podman service, refuses APT removals and DNF erasures, protects installed
Docker/containerd/Podman and package-manager versions, and compares a minimal
root-only liveness snapshot after the guarded package action and immediately
before registration. The snapshot contains recognized runtime-process start
metadata and, when Docker is active, container IDs, init PIDs, and start
timestamps. Docker receives container-level checks; other recognized engines
receive process-level checks and need separate certification for broader
coexistence claims. The snapshot never collects names, images, environment,
mounts, or logs.

Treat these refusal codes as safety gates, not prompts to force or repair the
host automatically:

- `runtime_package_plan_unsafe`: the proposed package transaction was refused;
- `runtime_workload_state_unverifiable`: an active Docker workload could not be
  inspected safely;
- `runtime_workload_drift_detected`: a pre-existing runtime process or Docker
  container changed during the installation window;
- `runtime_package_postcondition_failed`: a protected container package changed
  unexpectedly; stop and review the host package logs;
- `runtime_legacy_migration_required`: preview Podman state needs a separate,
  explicitly reviewed migration and was not reset.
There is no force bypass. If `runtime_reboot_required` is returned, schedule
the reboot as a separate maintenance action and retry only after the host and
its existing workloads are healthy. The ordinary installer never installs a
kernel or runs `podman system reset`.

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

Refresh an existing sandbox to the current immutable production image only
after the owner approves the brief connection interruption:

```sh
warpmetal sandbox action \
  --server <serverId> \
  --sandbox <sandboxId> \
  --action refresh_image \
  --confirm refresh_image \
  --wait \
  --json
```

The supervisor must already support image refresh. The action pre-pulls and
replaces only the container root filesystem while retaining the external
workspace, sandbox lifetime, and original start time. `--wait` requires both
the observed digest and generation to match the accepted target. A change to
the global production image does not refresh existing sandboxes implicitly.

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

After a successful destructive OS reload, the signed Runtime bootstrap runs
automatically. Wait for Runtime readiness and for the retained active grant to
become `applied`, then replace its stale pinned profile:

```sh
warpmetal runtime get --server <serverId> --wait --json
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
pre-reload profile. Use manual Runtime installation only as an explicitly
approved repair when the backend reports that automatic setup failed.

### Install a concrete OpenSSH alias

CLI 0.8.10 or newer can install the reviewed profile as a standard local alias
without another API request:

```sh
warpmetal sandbox access install-ssh \
  --connection-file <profile-path> \
  --identity <sandbox-private-key-path> \
  --alias <alias> \
  --json
```

Use a separate keypair and grant for each sandbox. The identity must be the
private half of that sandbox grant, never the VPS owner management key. The
command validates the closed token-free profile and its fingerprints, then
prepends a managed include to `~/.ssh/config`. It writes a private alias
fragment and dedicated pinned known-hosts file. Exact reinstall is idempotent.

If an authenticated access refresh changes the profile, endpoint, host pin, or
identity, run the server-backed profile refresh first and then explicitly
replace the local alias:

```sh
warpmetal sandbox access refresh \
  --server <serverId> \
  --sandbox <sandboxId> \
  --grant <grantId> \
  --connection-file <profile-path> \
  --confirm REFRESH \
  --wait \
  --json
warpmetal sandbox access install-ssh \
  --connection-file <profile-path> \
  --identity <sandbox-private-key-path> \
  --alias <alias> \
  --confirm REFRESH \
  --json
```

Never replace a pin merely because an SSH connection reports a mismatch. The
alias installer consumes only the already-refreshed API profile and does not
scan or trust a network key. Remove one alias without changing unrelated SSH
configuration:

```sh
warpmetal sandbox access remove-ssh --alias <alias> --confirm REMOVE --json
```

The generated host block pins the exact host keys, selects only the sandbox
identity, disables password and keyboard-interactive authentication, retains
`ClearAllForwardings yes`, disables agent/X11 forwarding and local commands,
and contains neither `RemoteCommand` nor `RequestTTY`. The existing server-side
forced gateway still maps the key to exactly one sandbox. The alias cannot open
a host shell and never uses or exposes the owner management key.

After installing and authenticating each provider tool inside the sandbox, use
the alias for interactive or one-shot work:

```sh
ssh <alias>
ssh -t <alias> codex
ssh <alias> codex exec '<task>'
ssh -t <alias> claude
ssh <alias> claude -p '<task>'
ssh -t <alias> agent
ssh <alias> agent -p '<task>'
ssh -t <alias> gemini
ssh <alias> gemini -p '<task>'
```

Install and authenticate Codex, Claude Code, Cursor CLI, or Gemini CLI inside
the sandbox first. Provider authentication and credentials are sandbox-owned
and persist only in the sandbox home. WarpMetal does not install, authenticate,
configure, or receive credentials for those tools.

[Codex Desktop](https://learn.chatgpt.com/docs/remote-connections)
discovers a concrete alias through `~/.ssh/config`, requires ordinary
`ssh <alias>` connectivity, and launches the remote app server through the
login shell. Codex must therefore be installed inside the sandbox and on the
login-shell `PATH` before selecting the alias in Codex Desktop.

The tested Cursor Remote SSH path requests dynamic forwarding, which the
Runtime correctly denies, so Cursor IDE remote access is not supported by this
restricted alias. Do not relax forwarding controls. Use the official
[Cursor CLI](https://cursor.com/docs/cli/overview) interactively with
`ssh -t <alias> agent` or in
[headless mode](https://cursor.com/docs/cli/headless) with
`ssh <alias> agent -p '<task>'` instead.

Follow Gemini CLI's official [installation guide](https://geminicli.com/docs/get-started/installation/),
then use `ssh -t <alias> gemini` interactively or its documented
[headless mode](https://geminicli.com/docs/cli/headless/) with
`ssh <alias> gemini -p '<task>'`. Gemini's optional Docker or Podman sandbox is
normally unavailable inside the WarpMetal sandbox because no host
container-engine socket is exposed; run Gemini directly inside the existing
outer sandbox and choose its approvals yourself.

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
