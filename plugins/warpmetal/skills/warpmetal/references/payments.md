# WarpMetal payment workflow

## Contents

- Trust boundary
- Wallet setup and funding
- Exact purchase workflow
- Exact renewal and refill workflow
- Retries and recovery

## Trust boundary

WarpMetal is the merchant tool. It owns product selection, the private owner
credential, exact checkout bytes, submission, provisioning, and fulfillment.
The separate x402api Agent Wallet owns encrypted network keys, balance checks,
payment authorization, and durable payment attempts. Never merge their state
files or pass a WarpMetal credential to `x402api`.

The CLI includes the matching `@x402api/agent-wallet-core` SDK. That SDK is the
authoritative buyer-side parser and signer contract. WarpMetal retains its own
merchant-side validation because the backend is Python and additionally binds
the challenge to WarpMetal's exact resource, amount, recipient, and receipt
contract.

WarpMetal runs on Node.js 20 or 22. The x402api Agent Wallet currently requires
Node.js 22. Use the exact published package reported by
`paymentWorkflow.signerPackage.spec`; the current contract is
`@x402api/agent-wallet-cli@0.2.9`. Do not add it as a WarpMetal dependency,
install executable wallet code from an unpinned repository URL, or substitute
a similarly named package.

The wallet package ships its own version-matched `x402api-pay` skill. Install
that skill into the directory used by Codex, Claude Code, or another portable
Agent Skills runtime with the returned `paymentWorkflow.walletSkill.install.argv`.
The command refuses to overwrite an existing directory; do not delete an old
skill automatically.

## Wallet setup and funding

1. Install the exact `paymentWorkflow.signerPackage.install.argv` under Node
   22. Run `command -v x402api` and the returned
   `paymentWorkflow.signerContract.probe.argv`. Require contract version 1 and
   every entry in `paymentWorkflow.signerContract.requiredCommands` to appear
   in the probe's `commands` array.
2. Run the exact `paymentWorkflow.walletWorkflow.setup.argv`. The idempotent
   `x402api wallet setup --json` command creates an owner-only managed unlock
   file inside the x402api home directory and never prints its generated
   passphrase. `X402API_WALLET_PASSWORD_FILE` is an optional x402api override
   for an externally managed password file; it is not a WarpMetal setting.
   Never create it on WarpMetal's behalf, read it, or pass it to WarpMetal. A
   supervised operator may instead use `--password-stdin` where supported.
3. Run the exact `paymentWorkflow.walletWorkflow.list.argv` and reuse a
   dedicated persistent wallet for
   the exact challenge network.
4. In an interactive conversation, create a wallet only with explicit
   approval. In an unattended run, create one only when the automation policy
   already permits it and a secure password source is configured; otherwise
   reuse a preconfigured wallet or stop. Keep Base and Solana wallets separate;
   never import the owner's primary seed or key. TRON wallet management exists,
   but the published launch payer cannot authorize TRON. Configure the local
   per-payment ceiling at creation and inspect it before reuse:

   ```sh
   x402api wallet create --name <name> \
     --network <exact-challenge-network> \
     --maximum-payment-atomic <per-payment-policy-cap> --json
   x402api wallet show --wallet <name> --json
   ```

   Require `maximumPaymentAtomic` to be at least the exact live amount and no
   higher than the task or operator limit. If an existing wallet has no ceiling
   or an unsuitable one, do not treat its full balance as bounded authority;
   use a suitably capped dedicated wallet or stop.
5. Use the returned public address, exact asset-balance, and funding commands:

   ```sh
   x402api wallet address --wallet <name> --json
   x402api wallet balance --wallet <name> \
     --asset <exact-challenge-asset> --json
   x402api wallet funding --wallet <name> \
     --asset <exact-challenge-asset> \
     --target-balance-atomic <required-or-policy-target> --json
   ```

   Use only the selected term's returned argv; do not combine one network with
   another term's asset. The funding result provides the current balance,
   target, exact deficit, payer address, and QR payload without moving funds.
6. If funding is short in an interactive conversation, show the exact deficit
   in normal token units and atomic units, the exact network, token symbol and
   contract/mint, and the payer wallet's public receiving address. Render only
   that public address as a QR code and repeat the full address as copyable
   text. Tell the human to transfer the token to the payer wallet address,
   never to the token contract/mint or `paymentTerms.recipient`. Sponsored
   launch payments never ask the buyer to fund ETH or SOL. Recheck the balance
   after the transfer.
7. If funding is short in an unattended run, use only a preconfigured refill
   mechanism returned by WarpMetal. For a configured renewal, set the returned
   `refillWorkflow.environment`, invoke `refillWorkflow.argv` once, and stop
   until funding arrives. Otherwise report `funding_required` and stop; do not
   invent a human approval step or funding source.

Treat the dedicated wallet's funded balance as spend authority available to
the agent, bounded by any wallet-local maximum payment policy and task or
operator limits. When a human is actively chatting, disclose the exact live
terms and obtain confirmation immediately before payment. In an unattended
run, do not wait for conversational approval; authorize and submit
autonomously when the terms fit the standing authority.

Use this structure when asking a human to fund the wallet:

> Transfer exactly `<amount> <USDC-or-USDT>` on `<Base-or-Solana>` to the agent
> wallet `<payer-wallet-address>`. Token contract/mint: `<asset-identifier>`.
> Send the token to the payer wallet address, not to the token contract/mint and
> not to WarpMetal's payment recipient. Do not send ETH or SOL; the network fee
> is paid by x402api from its platform treasury.

## Exact purchase workflow

```sh
warpmetal checkout challenge --task <taskId> --json
```

Read only the returned safe JSON. Confirm `paymentTerms`, then use the exact
argv arrays returned under `paymentWorkflow`:

```text
paymentWorkflow.authorize.argv
  x402api payment authorize --wallet <wallet-name>
    --request-envelope <owner-only-request-path>
    --artifact-out <owner-only-artifact-path> --json

paymentWorkflow.submit.argv
  warpmetal checkout submit --task <taskId>
    --payment-artifact <owner-only-artifact-path> --wait --json
```

Replace only `<wallet-name>` after selecting the wallet for the advertised
network. Do not parse, rewrite, copy, or display the request envelope or payment
artifact. The envelope excludes the WarpMetal owner token; the artifact holds
the complete payment signature and remains owner-only. The safe challenge JSON
also contains `challengeHandle`, an opaque value retained by WarpMetal for
merchant reconciliation. It is deliberately excluded from the x402api V1
request envelope and must not be confused with the wallet-created buyer payment
identifier.
The wallet nonce is bound to the authoritative `paymentChallengeDigest` that
WarpMetal forwards from x402api's charge response. Never derive or replace that
digest with a hash of `PAYMENT-REQUIRED`.

Choose only a term marked `agentWalletSupported: true`,
`sponsoredNetworkFee: true`, and `buyerNativeFeeRequired: false`. The supported
launch profiles are sponsored Base USDC and sponsored Solana USDC/USDT, bound
by the strict `com.x402api.gas-sponsorship` extension. Stop on an expired gas
reservation or any buyer-funded, unsupported, or unbound alternative.

x402api pays actual gas from its platform treasury. The merchant tenant's
active sponsorship allowance controls admission, but actual gas is not a
tenant debit. During the coordinated rollout, accept only the exact 0.2.9
platform-treasury declaration or the matched legacy tenant-credit declaration;
never accept a mixed billing and final-charge policy.

Among valid sponsored terms, honor an explicit task or operator network and
asset preference. Otherwise prefer a compatible wallet that is already
sufficiently funded. If several terms remain, choose the first compatible term
in the live challenge's advertised order. Do not switch terms after
authorization.

Do not replace the two-stage workflow with `x402api pay`, `payment submit`, or
`payment reconcile`. Those wallet commands can submit an exact credential-free
endpoint; WarpMetal checkout requires a private owner token that must never
enter the wallet envelope. Use x402api only for authorization and WarpMetal for
submission and merchant reconciliation.

WarpMetal rejects an artifact whose request digest, selected payment
requirement, resource, extension set, buyer payment identifier, signature,
expiry, sponsorship lifetime, file type, or permissions do not match the saved
challenge. Keep `--payment-signature-file` only as a compatibility path for
another external signer.

## Exact renewal and refill workflow

Renewal uses the same signer boundary and exact artifact checks as purchase,
but the merchant body is `{"serverId":"..."}` and submission returns through
`warpmetal renewal submit`. Read [renewals.md](renewals.md) for policy limits,
scheduling, signed refill notification, and recovery states.

Never use an initial-purchase artifact for renewal or a renewal artifact for a
later term. The resource URL, body, challenge digest, gas reservation, and
current `termEndsAt` generation are different.

## Retries and recovery

- Expired unsigned gas sponsorship: run the WarpMetal challenge flow again.
  WarpMetal retires the expired merchant attempt and requests fresh instructions
  under a new payment-attempt ID and idempotency key. The CLI replaces stale
  wallet-attempt metadata when it saves the new challenge. Inspect the new
  terms and authorize only the new workflow; never reuse an expired envelope or
  artifact.
- `payment_pending`, or legacy `payment_finalizing`, without
  `confirmed: true`: keep the same checkout bytes and artifact. Preserve the
  returned durable `paymentId`; `--wait` records it in private WarpMetal state
  and performs bounded retries with that exact authorization.
- `confirmed: true`: stop payment submission immediately, including when
  `finalized` is false or a legacy pending-like status is present. WarpMetal
  has admitted provisioning or renewal exactly once and will reconcile payment
  detail plus the signed final receipt asynchronously. Never authorize a
  replacement because receipt finality is pending.
- Timeout or process restart after authorization: use the saved x402api attempt
  ID and artifact. Reconcile with WarpMetal and reuse its submit argv. Never
  authorize again merely because submission is unknown.
- Signed HTTP 402: the artifact was definitively rejected. A `paymentId` may be
  absent because settlement never began; preserve the safe `errorCode`,
  `requestId`, and `replacementAllowed` result instead. Only when
  `replacementAllowed` is true may you run the unsigned WarpMetal challenge
  flow again, inspect the replacement terms, and authorize the one permitted
  replacement artifact. When false or absent, stop without signing again.
- `sponsorship_allowance_unavailable`, `sponsorship_payment_cap_exceeded`,
  `sponsorship_payment_allowance_exhausted`,
  `sponsorship_volume_allowance_exhausted`, or
  `sponsorship_gas_budget_exhausted`: the wallet treats the authorization as
  terminal. The merchant tenant must restore or change its allowance and issue
  a fresh challenge; never retry the artifact or fall back to buyer-funded gas.
- `manual_review`: payment or fulfillment may be final. Stop all payment and
  mutation retries. WarpMetal may continue read-only backend reconciliation for
  `stale_payment_outcome`; check status on a later autonomous cycle without
  submitting a payment. Only `expired` plus
  `failure.code: payment_expired_unsettled`, `paidAt: null`, and
  `retrySafe: true` proves the old charge expired unpaid and permits preparing
  a new order under current standing authority. Never reuse the old signature.
- Expired or corrupt signed artifact, changed request digest, unexpected recipient,
  unsupported network, asset, profile, sponsorship error, or request-binding
  mismatch: stop instead of falling back or asking the buyer to fund ETH/SOL.
