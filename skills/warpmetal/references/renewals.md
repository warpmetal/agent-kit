# WarpMetal renewal and refill workflow

## Contents

- Configure standing authority
- Schedule renewal checks
- Authorize and submit renewal
- Request a refill
- Stop and recovery states

## Configure standing authority

Create a durable backend policy and local Agent Wallet binding:

```sh
warpmetal renewal configure \
  --server <serverId> \
  --renew-before-days 3 \
  --maximum-payment-atomic <per-renewal-cap> \
  (--maximum-renewals <count> | --renew-through <UTC>) \
  [--maximum-total-spend-atomic <total-cap>] \
  --allowed-network <exact-CAIP-2-network> \
  --allowed-asset <exact-contract-or-mint> \
  --wallet <agent-wallet-name> \
  [--refill-target-atomic <target>] \
  [--email <human-address> | --without-email-notifications] \
  --json
```

Without an active notification recipient, configuration asks for one before
changing policy. `--email` immediately activates the address because the owner
or SSH-derived server credential authorizes the change. WarpMetal sends a
transactional advisory to the new address; it does not require verification.
Use `--without-email-notifications` only as an explicit opt-out; no signed
refill-email workflow is returned in that state. A refill target is a funding
target, not spend permission, and cannot exceed the per-renewal cap. The human
may transfer more than the displayed deficit. The agent may spend only the
exact renewal amount allowed by policy.

The WarpMetal CLI stores only the local wallet name. The backend stores
non-secret limits, counters, payment rail, time horizon, and an opaque
notification reference. WarpMetal never receives the wallet key.

## Schedule renewal checks

Use a recurring agent, scheduler, CI job, or cron to invoke:

```sh
warpmetal renewal due --all --json
warpmetal renewal run --server <serverId> --json
```

The CLI does not install a daemon. Treat actions as follows:

- `not_due`: stop successfully until the next scheduled check.
- `policy_required`: configure or deliberately revise policy.
- `approval_required`: stop; a ceiling or horizon prevents autonomous spend.
- `sign_payment`: follow the returned exact payment workflow.
- `refill_required`: follow the signed refill workflow and stop.
- `reconcile_pending`: preserve the artifact and reconcile; never authorize again.
- `manual_review`: stop all payment and mutation retries.
- `renewed` with `confirmed: true`: verify the new `termEndsAt` and stop
  payment submission successfully, even when `finalized` is false.

## Authorize and submit renewal

```sh
warpmetal renewal prepare --server <serverId> --json
```

The command validates server state and policy, preserves the exact body
`{"serverId":"..."}`, validates the sponsored x402 challenge, selects exactly
one policy-compatible rail, and returns:

```text
paymentWorkflow.authorize.argv
paymentWorkflow.submit.argv
paymentWorkflow.fundingWorkflow
refillNotification
refillWorkflow.environment (active recipient only)
refillWorkflow.argv (active recipient only)
```

Invoke the authorize argv once. It writes an owner-only artifact. Then invoke
the submit argv, equivalent to:

```sh
warpmetal renewal submit \
  --server <serverId> \
  --payment-artifact <owner-only-artifact-path> \
  --wait \
  --json
```

WarpMetal validates the artifact against the saved renewal body, challenge,
resource, policy network, policy asset, per-payment cap, sponsorship, and
buyer payment identifier before adding the private management credential.

## Request a refill

When Agent Wallet reports insufficient asset balance, do not authorize a
partial payment and do not create another wallet merely to bypass the policy.
Set the exact returned `X402API_NOTIFICATION_URL`, then invoke the returned:

```sh
x402api wallet notify-refill \
  --wallet <name> \
  --subscription-reference <opaque-reference> \
  --renew-by <UTC> \
  --target-balance-atomic <amount> \
  --reason renewal \
  --json
```

The wallet independently reads its live balance and signs a 15-minute
domain-separated intent. WarpMetal verifies the audience, time, nonce,
signature, wallet address, network, asset, policy, subscription, and
authoritative balance before queuing email. The intent cannot name a recipient
email, tenant, or product.

In a human conversation, also display the exact deficit, network, token symbol,
contract or mint, and payer wallet address. Render only that public address as
a QR code and repeat it as copyable text. Tell the human to fund the payer
wallet address—not the token contract/mint and not WarpMetal's merchant
recipient. Do not ask for ETH or SOL because supported network fees are
sponsored. A refill email repeats the address as text and includes a locally
generated QR encoding only that address.

## Stop and recovery states

- Insufficient balance: notify once, stop, and recheck later.
- Signed HTTP 402: preserve the safe rejection diagnostics. Re-run prepare and
  re-evaluate one replacement challenge only when `replacementAllowed` is true;
  stop when false or absent.
- Pending or timeout after authorization: reuse the same artifact; do not sign again.
- Price or payment rail outside policy: stop for deliberate policy revision.
- Exhausted count, horizon, or cumulative budget: stop for deliberate policy revision.
- Cancellation conflict or `manual_review`: payment may be final; stop all retries.
