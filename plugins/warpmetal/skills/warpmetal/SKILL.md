---
name: warpmetal
description: Safely purchase, renew, and manage WarpMetal VPS servers and Agent Runtime sandboxes with the official warpmetal CLI and x402api Agent Wallet. Use when a shell-capable agent needs live VPS discovery, hostname-based SSH identity creation, x402 payment or refill handling, bounded autonomous renewal, human lifecycle notifications, ordering, provisioning, server management, optional runtime installation, sandbox creation, per-agent SSH access, revocation, or deletion.
---

# WarpMetal

Use the `warpmetal` CLI as the executable interface. Do not reconstruct its
credential, idempotency, exact-body retry, SSH signing, or polling behavior
with ad hoc HTTP commands.

## Start safely

1. Run `warpmetal --version` and require version `0.7.4` or newer for this
   plugin. If it is missing or older, explain the compatibility requirement,
   ask before installing or upgrading software, and use only the official npm
   package from `https://www.npmjs.com/package/warpmetal`.
2. Use `--json` for every agent-driven command.
3. Read [references/safety.md](references/safety.md) before preparing an order,
   authorizing payment, using an SSH identity, or changing a server.
4. Read [references/cli-reference.md](references/cli-reference.md) when choosing
   a command or interpreting an exit code.
5. Read [references/payments.md](references/payments.md) before creating or
   funding a wallet, authorizing payment, or resolving an ambiguous attempt.
6. Read [references/runtime.md](references/runtime.md) before requesting,
   installing, accessing, expiring, or deleting Agent Runtime sandboxes.
7. Read [references/renewals.md](references/renewals.md) before configuring or
   executing an autonomous renewal or requesting a wallet refill.

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

Stop the current purchase if `purchasingReady` is false. In unattended
scheduling, recheck after 60 seconds, then double the delay after each failed
check up to 15 minutes and honor a longer `Retry-After`; never hot-loop. In an
interactive conversation, report the unavailable state and stop. Select
`planId` and the exact OS `name` from the live catalog. Do not reuse an OS name
or price from documentation or a previous session.

## Prepare an order

Confirm the intended plan, exact OS, and actual hostname. In a live human
conversation, ask before generating a new SSH key pair. In an unattended run,
generate a dedicated identity only when the automation policy permits creating
local credentials. Use the actual hostname as the readable key name; the CLI
adds `warpmetal-` and a short suffix only when a file already exists.

```sh
warpmetal order prepare \
  --plan <planId> \
  --hostname <hostname> \
  --os '<exact live OS name>' \
  --generate-ssh-key \
  --json
```

Use `--ssh-public-key-file <public-key-path>` instead only when a suitable key
was explicitly selected. Never run raw `ssh-keygen` for the VPS owner identity.
The CLI creates and binds `serverId -> key name -> fingerprint -> local paths`.
Inspect the safe mapping with `warpmetal server identity --server <serverId>
--json`; do not open the state file.

The CLI saves the generated recovery credential privately and does not print
it. Preserve the reported task and server IDs in the conversation, but do not
open the state file to retrieve the credential.

## Authorize payment

Run `warpmetal checkout challenge --task <taskId> --json`. The CLI validates
the live x402 terms, writes an owner-only credential-free request envelope, and
returns `paymentTerms` plus exact `paymentWorkflow.authorize.argv` and
`paymentWorkflow.submit.argv` arrays. Do not reconstruct those commands or
open either file.

Determine payment authority from the current execution context. In an
interactive conversation, show the human the exact amount, asset, network,
recipient, profile, and maximum authorization lifetime from `paymentTerms`,
then obtain confirmation immediately before signing and submission. In an
unattended autonomous run, do not wait for conversational approval: treat the
dedicated wallet's available token balance as standing spend authority, bounded
by its maximum-payment policy and any task or operator limits. Proceed only
when the exact live terms fit those limits.

Follow [references/payments.md](references/payments.md) to install the exact
`paymentWorkflow.signerPackage.spec`, verify the V1 machine contract, install
its matching `x402api-pay` skill, and invoke the returned wallet sequence:
`wallet setup`, `wallet list`, network-specific `wallet create` only if needed,
then the exact address, asset-balance, and funding commands. `wallet setup`
owns the managed unlock file; `X402API_WALLET_PASSWORD_FILE` is only an
optional x402api override and is never a WarpMetal input. Require
`agentWalletSupported: true`,
`sponsoredNetworkFee: true`, and `buyerNativeFeeRequired: false` on the chosen
live term. Never fall back to a historical buyer-funded or TRON profile.
Honor an explicit task or operator network and asset preference. Otherwise use
a compatible sufficiently funded wallet, then the first compatible term in the
live challenge's order. Never switch terms after authorization. Require the
wallet's `maximumPaymentAtomic` to cover the live amount without exceeding the
task or operator limit.

After interactive confirmation or autonomous policy validation, invoke the
returned authorize argv once. The separate
`x402api` executable owns the wallet, validates the envelope, and writes the
payment artifact. The returned `challengeHandle` is opaque merchant
reconciliation metadata; never copy it into the request envelope or treat it as
the buyer payment identifier. Then invoke the returned submit argv, equivalent to:

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
new CLI-produced workflow and re-evaluate payment authority. Ask again when a
human is chatting and the terms changed; in an unattended run, proceed only if
the replacement remains within standing authority. On `manual_review` or an
ambiguous attempt, stop and never create another payment.

## Renew autonomously within policy

Configure a bounded server policy before unattended renewal. Require a
per-payment ceiling and either a maximum renewal count or `renewThrough`; use a
cumulative ceiling when required by the operator. Bind a local Agent Wallet
whose network and asset exactly match the policy. See
[references/renewals.md](references/renewals.md) for commands and the complete
state machine.

In a live human conversation, disclose the exact renewal terms before signing.
In an unattended run, do not seek conversational approval when the policy,
wallet ceiling, exact live challenge, and balance all permit payment. Stop on a
price, asset, network, count, horizon, or total-budget mismatch.

Run `warpmetal renewal prepare --server <serverId> --json`, then invoke only
the returned `paymentWorkflow.authorize.argv` and
`paymentWorkflow.submit.argv`. If authorization reports insufficient balance,
use `paymentWorkflow.fundingWorkflow` to obtain the public address and balance,
then show the address as both a QR code and copyable text. Only when
`refillNotification.available` is true, set the returned
`refillWorkflow.environment`, invoke its exact argv once, and stop until
funding arrives. The signed refill intent resolves to a verified human contact;
never add an email address to it. Never make a partial payment.

After funding, prepare again, authorize exactly once, submit with WarpMetal,
and confirm the returned `termEndsAt`. On `reconcile_pending` or
`manual_review`, do not create another authorization.

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
warpmetal server login --server <serverId> --json
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
or another unsupported mutation.

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
