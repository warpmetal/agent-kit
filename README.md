# WarpMetal Agent Kit

The official command-line client and portable Agent Skill for WarpMetal.

The CLI uses the public API at `https://api.warpmetal.com`, stores generated
WarpMetal credentials in a user-private state file, and never reads or stores
wallet private keys or SSH private-key contents. Version 0.4 adds a guarded
x402api Agent Wallet handoff: WarpMetal writes the exact credential-free payment
request, explains the next commands to an agent, validates the returned payment
artifact, and submits it without absorbing wallet custody.

## Distribution

- Source and releases: `https://github.com/warpmetal/agent-kit`
- CLI: the unscoped public npm package `warpmetal`, exposing the `warpmetal`
  executable
- Skill: `skills/warpmetal` in the GitHub repository and bundled inside the
  npm package

Keeping the skill beside the CLI gives Codex, Claude, and other Agent
Skills-compatible tools one canonical set of safety instructions while the CLI
remains the stable executable API.

## Install

WarpMetal supports Node.js 20 and 22. The separate x402api Agent Wallet
requires Node.js 22; it is not a WarpMetal package dependency. Install the
published wallet CLI with the exact version WarpMetal reports:

```sh
npm install --global warpmetal
warpmetal --help

npm install --global @x402api/agent-wallet-cli@0.2.1
x402api help --json
```

Install the bundled skill for supported coding agents:

```sh
warpmetal agent install --target codex
warpmetal agent install --target claude
warpmetal agent install --target all
```

Use `--scope project` to install into the current repository instead of the
user-level agent directory.

The bundled `skills/warpmetal` directory follows the portable Agent Skills
layout. Agents that support that layout but use another installation path can
consume that directory directly; they do not need a different WarpMetal API
integration.

## First commands

```sh
warpmetal health
warpmetal catalog
warpmetal order prepare \
  --plan agent \
  --hostname codex-workspace \
  --os '<exact name from warpmetal catalog>' \
  --ssh-public-key-file ~/.ssh/id_ed25519.pub
```

Pass `--json` for structured, secret-redacted output. Use
`WARPMETAL_API_URL` for an alternate API origin and `WARPMETAL_HOME` for an
alternate state directory.

## Pay through the x402api Agent Wallet

After preparing an order, request its live payment challenge:

```sh
warpmetal checkout challenge --task <taskId> --json
```

On HTTP 402 the CLI returns exact `paymentTerms`, the pinned
`@x402api/agent-wallet-cli` package contract, and argv arrays under
`paymentWorkflow`. It also writes an owner-only request envelope that contains
the exact checkout URL and body but no WarpMetal credential. The published
launch wallet accepts sponsored Base USDC and sponsored Solana USDC/USDT only;
the returned terms identify compatible alternatives and confirm that the buyer
does not need ETH or SOL. Payment authority depends on execution context:

- When a human is actively chatting with the agent, show the exact live terms
  and ask for confirmation immediately before authorizing and submitting.
- In an unattended run, a pre-funded dedicated wallet is standing spend
  authority, bounded by its maximum-payment policy and any task or operator
  limits. When the live terms fit those limits, authorize and submit without
  waiting for conversational approval.

Then invoke the returned authorization argv with a dedicated wallet name:

```sh
x402api payment authorize \
  --wallet <wallet-name> \
  --request-envelope <path-returned-by-warpmetal> \
  --artifact-out <path-returned-by-warpmetal> \
  --json

warpmetal checkout submit \
  --task <taskId> \
  --payment-artifact <owner-only-artifact-path> \
  --wait \
  --json
```

Check the payer wallet address and balance with:

```sh
x402api wallet address --wallet <wallet-name> --json
x402api wallet balance --wallet <wallet-name> --json
```

If funding is short in an interactive conversation, tell the human the exact
top-up in normal and atomic units, the network, stablecoin and contract/mint,
and the payer wallet's public receiving address. The human sends the token to
that wallet address, never to the token contract/mint or WarpMetal's payment
recipient, and never sends ETH or SOL for a sponsored payment. In an unattended
run, use a preconfigured refill or escalation mechanism or stop with
`funding_required`.

The x402api Agent Wallet is a separate, merchant-neutral executable. Install
its matching `x402api-pay` skill with `x402api skill install --output <agent-skill-directory>/x402api-pay --json`.
Do not use `x402api pay`, `payment submit`, or `payment reconcile` for WarpMetal:
checkout requires the private WarpMetal owner token, so x402api authorizes and
WarpMetal submits. WarpMetal keeps `--payment-signature-file` for another
compatible external signer.

## Security boundary

- Order and access tokens are never printed; they are written to
  `${WARPMETAL_HOME:-~/.config/warpmetal}/state.json` with user-only
  permissions where the platform supports POSIX modes.
- The CLI passes an SSH private-key path directly to `ssh-keygen`; it never
  reads the private key.
- WarpMetal applies key-only OpenSSH configuration on initial provisioning and
  every OS reload. Password and keyboard-interactive login are disabled; never
  request, store, or expect a VPS login password.
- The CLI writes x402api-compatible request envelopes and accepts validated
  x402api payment artifacts or a compatible external `PAYMENT-SIGNATURE` file.
  Wallet key management and signing remain outside this package.
- Destructive or state-changing commands require explicit confirmations and
  generate idempotency keys by default.
- Runtime bootstrap credentials remain memory-only. Signed supervisor bundles
  are checksum- and signature-verified before OpenSSH uploads them.
- Each agent gets a distinct SSH key forced into exactly one sandbox. Token-free
  connection profiles pin the VPS host key and contain no owner credential or
  private-key material.
- Sandboxes use the fixed runtime image and fixed sizes. Persistent is the
  default; temporary sandboxes require explicit confirmation and permanently
  delete their workspace after 15 minutes to 24 hours.
- Guarded reload powers the server off first. Runtime-enabled reload requires a
  second acknowledgment, after which the CLI guides supervisor reinstall and
  pinned connection-profile refresh. Post-reload owner SSH host keys must be
  independently verified because the provider may rotate or preserve them;
  update `known_hosts` only when the verified key changed. Erased workspaces
  are never described as recoverable.

## Agent Runtime example

```sh
warpmetal runtime enable --server <serverId> --json
warpmetal runtime install \
  --server <serverId> \
  --identity ~/.ssh/warpmetal-owner \
  --ssh-user ubuntu \
  --confirm INSTALL \
  --wait \
  --json
warpmetal sandbox create \
  --server <serverId> \
  --name planner \
  --size small \
  --wait \
  --json
warpmetal sandbox access keygen \
  --output ~/.ssh/warpmetal-planner \
  --confirm GENERATE \
  --json
```

See `skills/warpmetal/references/runtime.md` for the complete lifecycle,
cleanup, access-grant, and strict host-key connection workflow.

## Release status

The initial development release is published at
`https://www.npmjs.com/package/warpmetal`. The source is publicly visible but
remains `UNLICENSED`; choose an explicit license before describing the project
as open source or inviting third-party reuse.
