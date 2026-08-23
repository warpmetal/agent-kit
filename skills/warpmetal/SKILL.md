---
name: warpmetal
description: Safely purchase and manage WarpMetal VPS servers and Agent Runtime sandboxes with the official warpmetal CLI, including x402api Agent Wallet payment handoff. Use when a shell-capable agent needs live VPS discovery, x402 payment authorization, ordering, provisioning, server management, optional runtime installation, fixed-size sandbox creation, persistent or temporary lifetime, per-agent SSH access, sandbox connection, access revocation, or workspace deletion.
---

# WarpMetal

Use the `warpmetal` CLI as the executable interface. Do not reconstruct its
credential, idempotency, exact-body retry, SSH signing, or polling behavior
with ad hoc HTTP commands.

## Start safely

1. Run `warpmetal --version`.
2. If it is missing, ask before installing software, then install the official
   npm package only from `https://www.npmjs.com/package/warpmetal`.
3. Use `--json` for every agent-driven command.
4. Read [references/safety.md](references/safety.md) before preparing an order,
   authorizing payment, using an SSH identity, or changing a server.
5. Read [references/cli-reference.md](references/cli-reference.md) when choosing
   a command or interpreting an exit code.
6. Read [references/payments.md](references/payments.md) before creating or
   funding a wallet, authorizing payment, or resolving an ambiguous attempt.
7. Read [references/runtime.md](references/runtime.md) before requesting,
   installing, accessing, expiring, or deleting Agent Runtime sandboxes.

Never read, print, summarize, upload, or commit the WarpMetal state file,
x402api keystore, password file, payment request envelope, or payment artifact.
Never read an SSH private-key file. Pass private paths only to commands designed
to use them. Never request or handle a wallet seed phrase or private key.

WarpMetal provisions and reloads servers with key-only OpenSSH access. Password
and keyboard-interactive login are disabled, including for root. Never request,
store, invent, or expect a VPS login password; use the submitted public key and
its matching private-key path.

## Discover before acting

Run:

```sh
warpmetal health --json
warpmetal catalog --json
```

Stop if `purchasingReady` is false. Select `planId` and the exact OS `name`
from the live catalog. Do not reuse an OS name or price from documentation or
a previous session.

## Prepare an order

Confirm the intended plan, exact OS, hostname, and existing SSH public-key file
with the user. Ask before generating a new SSH key pair.

```sh
warpmetal order prepare \
  --plan <planId> \
  --hostname <hostname> \
  --os '<exact live OS name>' \
  --ssh-public-key-file <public-key-path> \
  --json
```

The CLI saves the generated recovery credential privately and does not print
it. Preserve the reported task and server IDs in the conversation, but do not
open the state file to retrieve the credential.

## Authorize payment

Run `warpmetal checkout challenge --task <taskId> --json`. The CLI validates
the live x402 terms, writes an owner-only credential-free request envelope, and
returns `paymentTerms` plus exact `paymentWorkflow.authorize.argv` and
`paymentWorkflow.submit.argv` arrays. Do not reconstruct those commands or
open either file.

Show the user the exact amount, asset, network, recipient, profile, and maximum
authorization lifetime from `paymentTerms`; obtain explicit approval before
signing or submission. Follow [references/payments.md](references/payments.md)
to install the exact `paymentWorkflow.signerPackage.spec`, verify the V1
machine contract, install its matching `x402api-pay` skill, and select or fund
a dedicated network-specific wallet. Require `agentWalletSupported: true`,
`sponsoredNetworkFee: true`, and `buyerNativeFeeRequired: false` on the chosen
live term. Never fall back to a historical buyer-funded or TRON profile.

After approval, invoke the returned authorize argv once. The separate
`x402api` executable owns the wallet, validates the envelope, and writes the
payment artifact. Then invoke the returned submit argv, equivalent to:

```sh
warpmetal checkout submit \
  --task <taskId> \
  --payment-artifact <owner-only-artifact-path> \
  --wait \
  --json
```

Do not use `x402api pay`, `x402api payment submit`, or `x402api payment
reconcile` for this checkout. Those commands submit credential-free requests,
but WarpMetal must add its private owner token locally.

WarpMetal verifies that the artifact matches the exact saved request and an
advertised sponsored requirement, gas reservation, resource, extensions, and
buyer payment identifier before sending its signature. The legacy
`--payment-signature-file` input remains available for another compatible
external signer. If a signed request returns a replacement challenge, use the
new CLI-produced workflow and request approval again when terms changed. On
`manual_review` or an ambiguous attempt, stop and never create another payment.

## Provision and manage

Poll a prepared or paid order with:

```sh
warpmetal order status --task <taskId> --wait --json
```

After initial provisioning and every OS reload, WarpMetal reapplies the same
key-only policy: `PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`, and
`AuthenticationMethods publickey`.

For routine management, prove possession of the installed SSH key without
reading it:

```sh
warpmetal server login --server <serverId> --identity <private-key-path> --json
warpmetal server get --server <serverId> --json
```

For power changes, state the intended effect and obtain explicit approval,
then pass the same action as the confirmation:

```sh
warpmetal server power \
  --server <serverId> \
  --action reboot \
  --confirm reboot \
  --wait \
  --json
```

For a destructive reload, explain that every server-disk file is erased and
obtain explicit approval. If Agent Runtime is enabled, also explain that every
sandbox workspace is lost, desired sandboxes return as empty workspaces after
reinstall, and pinned profiles must be refreshed. Then use only the guarded
command:

```sh
warpmetal server reload \
  --server <serverId> \
  --confirm ERASE \
  --power-off-first \
  [--acknowledge-agent-runtime-reset] \
  [--os '<exact-live-os-name>'] \
  --wait \
  --json
```

The CLI requires the recovery owner credential so it can keep polling after
reload revokes SSH-derived access tokens. On success, reinstall Agent Runtime
only after verifying the post-reload owner-facing SSH host-key fingerprint
through a trusted provider or console channel. The provider may rotate or
preserve the key; update `known_hosts` only when the verified key changed and
never bypass a mismatch. Then wait for grants to become applied and refresh
every connection profile with `sandbox access refresh --confirm REFRESH`
before connecting. Do not fall back to raw API calls for deletion, networking,
renewal, or another unsupported mutation.

## Use Agent Runtime

Agent Runtime is optional and shares one owner's VPS only among that owner's
agents. Discover live `agentRuntime` capacity and OS support before choosing
sizes. Use `--runtime-file` to include sandbox intent in an unpaid order, or
`warpmetal runtime enable` after the VPS is ready. Supervisor installation is
separate and requires approval plus `--confirm INSTALL`.

Omitted lifetime means persistent. A temporary sandbox requires
`--confirm TEMPORARY`, expires 15 minutes to 24 hours after first reaching
running, and permanently deletes its workspace at expiry. Never describe a
pending HTTP 202 response as applied; poll runtime, sandbox, and grant state.

Every agent must use a distinct sandbox-specific SSH key. Ask before key
generation, create one access grant for one sandbox, wait for `applied` plus
pinned host keys, then connect only through `warpmetal sandbox connect`.
Never give an agent the owner host key, owner token, SSH-derived management
token, runtime bootstrap, or node token.

If the installed CLI lacks a required runtime command, stop, explain the
version limitation, and ask before upgrading the official npm package. Do not
reconstruct runtime changes with raw HTTP, ad hoc SSH, Podman, Docker, or host
configuration commands.
