# WarpMetal Agent Kit

The official command-line client and portable Agent Skill for WarpMetal.

The CLI uses `https://api.warpmetal.com` as the API root; endpoints begin at
`/health`, `/catalog`, `/orders`, and so on, without a second `/api` prefix. It
stores generated WarpMetal credentials in a user-private state file and never
reads or stores wallet private keys or SSH private-key contents. Version 0.6
adopts this canonical root-path API. WarpMetal writes the exact credential-free
payment request, explains the next commands to an agent, validates the returned
payment artifact, and submits it without absorbing wallet custody.

## Distribution

- Source and releases: `https://github.com/warpmetal/agent-kit`
- CLI: the unscoped public npm package `warpmetal`, exposing the `warpmetal`
  executable
- Skill: `skills/warpmetal` in the GitHub repository and bundled inside the
  npm package
- Codex plugin: the skills-only package under `plugins/warpmetal`, exposed for
  repository testing by `.agents/plugins/marketplace.json`

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

npm install --global @x402api/agent-wallet-cli@0.2.7
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

## Codex plugin

The repository also contains a skills-only WarpMetal plugin for the public
Plugins Directory shared by Codex and ChatGPT. The plugin remains a separate
artifact from the npm CLI and requires `warpmetal` CLI version 0.7.7 or newer.

To test the repository marketplace after the plugin lands on `main`:

```sh
codex plugin marketplace add warpmetal/agent-kit --ref main
codex plugin add warpmetal@warpmetal
```

Run the plugin-specific repository checks with:

```sh
npm run plugin:check
```

Public submission materials, reviewer cases, and the owner checklist live in
`submission/openai`. Public publication happens through the OpenAI Platform;
the repo marketplace is only for development, testing, and direct distribution.

## First commands

```sh
warpmetal health
warpmetal catalog
warpmetal order prepare \
  --plan agent \
  --hostname codex-workspace \
  --os '<exact name from warpmetal catalog>' \
  --generate-ssh-key \
  --json
```

The generated key defaults to
`${WARPMETAL_HOME:-~/.config/warpmetal}/ssh/warpmetal-codex-workspace`. A
collision receives a random suffix; existing keys are never overwritten. Once
checkout returns `serverId`, the CLI binds that ID to the identity so
`warpmetal server login` and `warpmetal runtime install` can select it without
an `--identity` flag. Use `--ssh-public-key-file` instead when supplying a
user-managed public key.

Pass `--json` for structured, secret-redacted output. Use
`WARPMETAL_API_URL` for an alternate API origin and `WARPMETAL_HOME` for an
alternate state directory.

## Pay through the x402api Agent Wallet

After preparing an order, request its live payment challenge:

```sh
warpmetal checkout challenge --task <taskId> --json
```

On HTTP 402 the CLI returns exact `paymentTerms`, the opaque `challengeHandle`
that WarpMetal uses for merchant-side reconciliation, the pinned
`@x402api/agent-wallet-cli` package contract, and argv arrays under
`paymentWorkflow`. It also writes an owner-only request envelope that contains
the exact checkout URL and body but no WarpMetal credential or challenge
handle. The handle is not a buyer payment identifier and is never a wallet
signing input. The published launch wallet accepts sponsored Base USDC and
sponsored Solana USDC/USDT only;
the returned terms identify compatible alternatives and confirm that the buyer
does not need ETH or SOL. x402api pays the actual network fee from its platform
treasury; the merchant tenant's active allowance controls sponsorship
admission but is not charged actual gas. Payment authority depends on execution
context:

- When a human is actively chatting with the agent, show the exact live terms
  and ask for confirmation immediately before authorizing and submitting.
- In an unattended run, a pre-funded dedicated wallet is standing spend
  authority, bounded by its maximum-payment policy and any task or operator
  limits. When the live terms fit those limits, authorize and submit without
  waiting for conversational approval.

Follow the returned commands in order. `wallet setup` creates an owner-only,
managed unlock file inside the x402api home directory and is safe to repeat;
it never prints the generated passphrase. `X402API_WALLET_PASSWORD_FILE` is an
optional x402api override for an externally managed password file. It is not a
WarpMetal variable, and WarpMetal does not create, read, or receive that file.

```sh
x402api wallet setup --json
x402api wallet list --json
x402api wallet create --name <wallet-name> \
  --network <exact-challenge-network> \
  --maximum-payment-atomic <exact-live-amount> --json
x402api wallet address --wallet <wallet-name> --json
x402api wallet balance --wallet <wallet-name> \
  --asset <exact-challenge-asset> --json
x402api wallet funding --wallet <wallet-name> \
  --asset <exact-challenge-asset> \
  --target-balance-atomic <exact-live-amount> --json
```

Create a wallet only when no compatible dedicated wallet exists. The funding
command reports the public payer address, QR payload, current balance, target,
and exact deficit in atomic and normal six-decimal units. After the selected
wallet is sufficiently funded, invoke the returned authorization and WarpMetal
submission argv:

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

Require `maximumPaymentAtomic` to cover the live charge without exceeding the
task or operator limit. Among valid sponsored terms, honor an explicit network
or asset preference, otherwise prefer an already funded compatible wallet,
then the first compatible term in live challenge order. Never switch terms
after authorization.

If funding is short in an interactive conversation, tell the human the exact
top-up in normal and atomic units, the network, stablecoin and contract/mint,
and the payer wallet's public receiving address. The returned
`paymentWorkflow.fundingWorkflow` provides safe address and balance argv plus a
presentation contract: render that public address as both a QR code and
copyable text. The human sends the token to that wallet address, never to the
token contract/mint or WarpMetal's payment recipient, and never sends ETH or
SOL for a sponsored payment. In an unattended run, use a preconfigured refill
or escalation mechanism or stop with `funding_required`.

## Autonomous renewal and refill

Configure renewal only with explicit bounds. This example allows at most 12
renewals, enforces a 30 USDC per-payment ceiling and a 360 USDC cumulative
budget, and requests a verified notification recipient:

```sh
warpmetal renewal configure \
  --server <serverId> \
  --renew-before-days 3 \
  --maximum-payment-atomic 30000000 \
  --maximum-renewals 12 \
  --maximum-total-spend-atomic 360000000 \
  --allowed-network eip155:8453 \
  --allowed-asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --wallet <dedicated-wallet> \
  --email ops@example.com \
  --json
```

The recipient must follow the one-time verification link before lifecycle or
refill mail is sent. If no verified notification email exists, `renewal
configure` returns `email_required` before changing policy. Supply `--email`,
or deliberately continue with `--without-email-notifications`; the latter does
not enable signed refill-email workflows. A recurring unattended agent can then
run:

```sh
warpmetal renewal due --all --json
warpmetal renewal run --all-due --json
```

Inside policy, the CLI returns the exact Agent Wallet authorization and submit
argv. If balance is insufficient, `refillWorkflow` is returned only when the
server has an active verified notification subscription. Run its argv with the
returned `X402API_NOTIFICATION_URL` environment value. `x402api wallet
notify-refill` signs an opaque subscription reference and wallet-produced
balance fields; it cannot choose an email address. WarpMetal verifies the
wallet signature and current on-chain balance before emailing the verified
human the network, stablecoin, public wallet address, required minimum top-up,
and a locally generated QR encoding only that wallet address. The address is
also repeated as copyable text. The human may transfer more than that minimum;
the renewal policy—not the refill target—remains the spending authority.

The agent never sends a partial x402 payment. If no verified refill path
exists, it reports `funding_required`. If a previous payment is pending or
ambiguous, it reconciles the saved attempt and never signs a second payment.

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

The package is published at
`https://www.npmjs.com/package/warpmetal`. The source is publicly visible but
remains `UNLICENSED`; choose an explicit license before describing the project
as open source or inviting third-party reuse.
