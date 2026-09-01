# WarpMetal safety rules

## Contents

- Authority and freshness
- Credential boundaries
- Required confirmations
- Retry and terminal-state rules

## Authority and freshness

- Treat `https://warpmetal.com/llms.txt`, the live catalog, and the live HTTP
  402 challenge as authoritative in that order.
- Stop the current purchase when `warpmetal health --json` reports
  `purchasingReady: false`. An unattended scheduler may recheck after 60
  seconds, then double the delay after each failure up to 15 minutes and honor
  a longer `Retry-After`; never hot-loop. An interactive agent reports the
  unavailable state and stops.
- Select an exact OS name from the chosen plan's current
  `operatingSystems[]`. Never guess or hard-code an image version.

## Credential boundaries

- Treat the generated `ownerToken` as an offline recovery credential. Let the
  CLI store it; never inspect the state file or include it in output.
- Treat an SSH-derived access token as a short-lived bearer credential. Let
  the CLI store and refresh it.
- Never read or transmit an SSH private key. Pass only its filesystem path to
  `warpmetal server login`, `warpmetal runtime install`,
  `warpmetal sandbox connect`, or `ssh-keygen`.
- Generate a VPS owner identity through `warpmetal order prepare
  --generate-ssh-key` or `warpmetal identity generate`, not a raw shell
  command. The actual hostname is the readable key name. Never reuse or
  overwrite a generated owner key merely because another server has the same
  hostname; let the CLI add its collision suffix and bind the identity to
  `serverId`.
- WarpMetal disables VPS password and keyboard-interactive SSH login after
  initial provisioning and every OS reload. Never request, store, invent, or
  expect a VPS login password; use the submitted public key and matching
  private-key path.
- Never place the owner SSH key, owner token, management access token, runtime
  bootstrap, supervisor node token, or state file inside a sandbox.
- Give each agent a distinct sandbox-specific SSH key and grant. Never reuse
  the owner host key or one agent key across multiple sandboxes.
- Never request, read, transmit, or store a wallet seed phrase or private key.
- Install only the exact `@x402api/agent-wallet-cli` version and matching
  bundled `x402api-pay` skill reported by WarpMetal. Never substitute an
  unpinned repository checkout or similarly named wallet package.
- Let `x402api wallet setup` create and permission its managed unlock file.
  `X402API_WALLET_PASSWORD_FILE` belongs to x402api only as an optional
  externally managed override; WarpMetal must never create, read, or receive
  it. Stop if x402api rejects unsafe ownership or permissions.
- Never read or display an x402api password file, encrypted keystore, request
  envelope, payment artifact, or complete payment signature. Pass only their
  paths to the documented commands.
- Never put a token, payment signature, payment artifact, wallet password,
  private key, or state-file content in a prompt, URL, log, screenshot, source
  file, or shell argument.

## Interactive confirmations and autonomous payment authority

When a human is actively directing the current task in a conversation, obtain
explicit approval immediately before:

- installing the CLI or skill;
- installing or repairing the Agent Runtime supervisor;
- generating a new SSH key pair;
- creating a wallet or asking the human to transfer funds to it;
- signing or submitting an x402 payment authorization;
- booting, rebooting, or shutting down a server; and
- creating a temporary sandbox after explaining its irreversible expiry;
- revoking a sandbox access grant; and
- any destructive reload, sandbox deletion, or replacement-key operation.

In an unattended autonomous run, do not pause payment for conversational
approval. A pre-funded dedicated wallet provides standing spend authority,
bounded by its maximum-payment policy and any task or operator limits. Sign and
submit only when the exact live amount, asset, network, recipient, profile,
resource binding, and sponsorship fit those limits. Unattended mode does not
grant unlimited spend, permission to import a primary wallet, or permission to
use unsupported or buyer-funded payment rails. If the wallet is short and no
preconfigured refill or escalation mechanism exists, report
`funding_required` and stop.

For renewal, require an enabled server policy with a per-payment ceiling and a
bounded count or date horizon. Also enforce the exact network, asset, wallet
ceiling, and cumulative budget when configured. A refill target is not a spend
ceiling. Never pay outside policy, split a payment, or authorize twice to
resolve ambiguity. A signed refill request may contain only the opaque
subscription reference and wallet-produced fields; never add a recipient
email or untrusted product text.

A reload requires both `confirm: "ERASE"` and `powerOffFirst: true`. Treat
`powerOffFirst` as explicit authorization for WarpMetal to shut down the
server, wait until it is powered off, and then erase and reinstall it inside
one lifecycle operation. When Agent Runtime is enabled, also require
`acknowledgeAgentRuntimeReset`: all sandbox workspaces are permanently erased,
the supervisor identity is revoked, desired sandboxes are recreated empty
after reinstall, and all pinned profiles require refresh. Use only the guarded
CLI command and stop on `manual_review`. Reload invalidates the prior
owner-facing SSH host-key trust decision; the provider may rotate or preserve
the key. Verify the post-reload fingerprint through a trusted provider or
console channel, change `known_hosts` only when the verified key changed, and
never disable host-key checking.

An order preparation is unpaid but consumes a limited prepared-order slot.
Confirm the plan, hostname, OS, and public key before preparing it.

## Retry and terminal-state rules

- Reuse the same idempotency key only for the exact same logical request.
- If an unsigned gas-sponsorship reservation expires, run `warpmetal checkout
  challenge` again. WarpMetal retires the old merchant attempt, requests fresh
  instructions with a new payment-attempt ID and idempotency key, and the CLI
  replaces its saved challenge metadata. Re-evaluate the new terms before
  authorization; never sign or submit the expired challenge.
- For `payment_pending`, retry the exact checkout body and the exact same
  payment artifact. Preserve the returned `paymentId` as the durable x402api
  reconciliation key. Do not create a replacement payment.
- A signed HTTP 402 rejects that signature. A `paymentId` can be absent;
  preserve the safe `errorCode`, `requestId`, and `replacementAllowed` result.
  Request a new live challenge and create the one permitted replacement only
  when `replacementAllowed` is true and the new terms remain within current
  interactive or autonomous payment authority. When false or absent, stop.
- Treat `sponsorship_allowance_unavailable`,
  `sponsorship_payment_cap_exceeded`,
  `sponsorship_payment_allowance_exhausted`,
  `sponsorship_volume_allowance_exhausted`, and
  `sponsorship_gas_budget_exhausted` as terminal for the current authorization.
  Require the merchant tenant to restore or change its sponsorship allowance
  and issue a fresh challenge; never switch to buyer-funded gas.
- On timeout or restart after wallet authorization, reuse the saved x402api
  attempt and artifact through WarpMetal. Never authorize again merely because
  submission or fulfillment is uncertain, and never send the private owner
  token through `x402api pay`, `payment submit`, or `payment reconcile`.
- Treat `manual_review` as terminal for payments and mutations. Do not pay
  again and do not repeat the mutation. A later read-only status check may
  observe automatic reconciliation of `stale_payment_outcome`; only the exact
  `expired/payment_expired_unsettled` result with `paidAt: null` and
  `retrySafe: true` permits preparing a new order.
- Treat HTTP 202 as accepted or pending, never as proof of success. Poll the
  returned task or operation until a documented terminal state.
- Temporary sandbox expiry is a local hard deadline. Stop, restart, and
  control-plane outages do not pause it; expiry permanently deletes the
  workspace and revokes access.
- Stop when the installed CLI lacks a runtime command. Do not fall back to raw
  HTTP, raw Podman/Docker, or ad hoc SSH host mutation.
