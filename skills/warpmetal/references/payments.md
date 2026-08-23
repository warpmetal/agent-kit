# WarpMetal payment workflow

## Contents

- Trust boundary
- Wallet setup and funding
- Exact purchase workflow
- Retries and recovery

## Trust boundary

WarpMetal is the merchant tool. It owns product selection, the private owner
credential, exact checkout bytes, submission, provisioning, and fulfillment.
The separate x402api Agent Wallet owns encrypted network keys, balance checks,
payment authorization, and durable payment attempts. Never merge their state
files or pass a WarpMetal credential to `x402api`.

WarpMetal runs on Node.js 20 or 22. The x402api Agent Wallet currently requires
Node.js 22. Use the exact published package reported by
`paymentWorkflow.signerPackage.spec`; the current contract is
`@x402api/agent-wallet-cli@0.2.1`. Do not add it as a WarpMetal dependency,
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
   `paymentWorkflow.signerContract.probe.argv`. Require contract version 1.
2. Ensure an operator configured `X402API_WALLET_PASSWORD_FILE` as an owner-only
   file, or is supervising `--password-stdin`. Never read either value.
3. Use `x402api wallet list --json` and reuse a dedicated persistent wallet for
   the exact challenge network.
4. Create a wallet only with explicit approval. Keep Base and Solana wallets
   separate; never import the owner's primary seed or key. TRON wallet
   management exists, but the published launch payer cannot authorize TRON.
5. Use `x402api wallet balance --wallet <name> --json`. If funding is short,
   show the public address, exact network, token, and atomic deficit. The owner
   funds the token address from a wallet they control. Sponsored launch
   payments never ask the buyer to fund ETH or SOL.

Treat the dedicated wallet's funded balance as spend authority available to
the agent, bounded by any wallet-local maximum payment policy. WarpMetal still
requires explicit approval immediately before its payment authorization and
submission workflow.

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
the complete payment signature and remains owner-only.

Choose only a term marked `agentWalletSupported: true`,
`sponsoredNetworkFee: true`, and `buyerNativeFeeRequired: false`. The supported
launch profiles are sponsored Base USDC and sponsored Solana USDC/USDT, bound
by the strict `com.x402api.gas-sponsorship` extension. Stop on an expired gas
reservation or any buyer-funded, unsupported, or unbound alternative.

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

## Retries and recovery

- `payment_pending` or `payment_finalizing`: keep the same checkout bytes and
  artifact. `--wait` performs bounded retries with that exact authorization.
- Timeout or process restart after authorization: use the saved x402api attempt
  ID and artifact. Reconcile with WarpMetal and reuse its submit argv. Never
  authorize again merely because submission is unknown.
- Signed HTTP 402: the artifact was definitively rejected. Run the WarpMetal
  challenge flow again, inspect the replacement terms, and authorize one new
  artifact only when the protocol and approval allow it.
- `manual_review`: payment or fulfillment may be final. Stop all payment and
  mutation retries.
- Expired or corrupt artifact, changed request digest, unexpected recipient,
  unsupported network, asset, profile, sponsorship error, or request-binding
  mismatch: stop instead of falling back or asking the buyer to fund ETH/SOL.
