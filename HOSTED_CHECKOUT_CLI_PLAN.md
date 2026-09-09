# Hosted Checkout CLI Plan

Status: P4 release active; P1-P3 complete
Owner: WarpMetal CLI and WarpMetal public API
Last updated: 2026-09-08

## Outcome

Give an interactive buyer an optional, short-lived x402api hosted-checkout URL
for the exact WarpMetal programmatic charge while preserving the existing
agent-wallet authorization and submission path. The CLI must be safe to publish
before the WarpMetal API projection is deployed: older API responses simply omit
the optional direct-checkout object.

## Facts and assumptions

| ID | Type | Statement | Evidence / verification | Status |
| --- | --- | --- | --- | --- |
| F1 | fact | x402api production returns optional paired `human_checkout_url` and `qr_payload` on eligible programmatic charges; `expires_at` is their authority. | production OpenAPI source SHA `7387674e566a3de2f1e8519956fe55b79c78b648` | verified |
| F2 | fact | WarpMetal currently creates the exact charge but does not project the hosted-checkout fields into its HTTP 402 body. | `backend/warpmetal/payments.py` and `backend/warpmetal/routes.py` on `origin/main` | verified |
| F3 | fact | `warpmetal checkout challenge` already returns an agent-wallet workflow and does not render a QR itself. | `src/cli.js`, `src/payment.js`, CLI reference | verified |
| F4 | fact | The public CLI is `warpmetal@0.8.5`; tag pushes run check, tests, pack, and trusted npm publication. | npm registry and `.github/workflows/publish.yml` | verified |
| A1 | assumption | Direct checkout is an interactive initial-purchase option, not an unattended renewal action. | user flow and prior approved design | accepted |
| A2 | assumption | A clickable URL plus an identical `qrPayload` in JSON is the appropriate CLI boundary; the calling UI/agent renders the QR. | existing CLI presentation contract avoids runtime QR dependencies | accepted |
| A3 | assumption | The configured hosted-checkout origin is `https://pay.x402api.com`. | deployed x402api public origin | verified |
| F5 | fact | `warpmetal order status --wait` already returns `ask_human_for_notification_email` after a server becomes ready when notification setup is incomplete. | CLI implementation and regression test | verified |

## Invariants

- The hosted-checkout URL and QR payload must be present together, byte-for-byte
  identical, canonical credential-free HTTPS URLs on the configured x402api
  checkout origin, and unexpired.
- The URL is a bearer capability. Do not log it, add it to the x402 request
  envelope, or persist it in WarpMetal CLI state.
- A missing optional object means the current agent-wallet workflow continues
  unchanged.
- The direct path uses the same charge, amount, merchant binding, gas
  sponsorship, confirmation, webhook, and provisioning flow. It must never be a
  recipient-address QR.
- Human checkout is exposed for initial purchase challenges only. Renewal policy
  execution remains agent-wallet based.
- Direct-checkout output must include the exact bounded `order status --wait`
  continuation. Once provisioning is ready, the existing status result remains
  authoritative and the agent asks the owner for the optional lifecycle-email
  address before invoking `notifications add`.
- Confirmation/finality semantics do not change: provisioning may start on
  confirmed payment while finality reconciliation continues asynchronously.

## Interfaces

WarpMetal HTTP 402 gains one optional additive body property:

```json
{
  "humanCheckout": {
    "url": "https://pay.x402api.com/c/chk_<32-character-handle>",
    "qrPayload": "https://pay.x402api.com/c/chk_<32-character-handle>",
    "expiresAt": "<RFC 3339 timestamp>"
  }
}
```

`warpmetal checkout challenge --json` validates the object and adds a safe
`afterPayment.argv` continuation for `warpmetal order status --task <taskId>
--wait --json`, plus `notificationNextAction:
ask_human_for_notification_email`. Human-readable output prints the clickable
URL, expiry, and continuation before the existing agent-wallet instructions. No
command or exit code changes.

## Error handling and logging

| Condition | Behavior | Verification |
| --- | --- | --- |
| fields absent | agent-wallet-only response | compatibility test |
| one field absent, URL mismatch, wrong origin/scheme, credentials, fragment, query, malformed or expired timestamp | fail closed; return payment instructions unavailable from the API adapter, or a CLI contract error | backend and CLI negative tests |
| API/charge timeout or ambiguous result | preserve the existing attempt; do not mint a replacement solely for hosted checkout | regression tests |
| hosted checkout succeeds | existing webhook/reconciliation provisions the bound order; CLI need not submit a second signature | existing settlement architecture plus docs |

The bearer URL may appear only in the authenticated response and explicit CLI
output requested by the owner. Application logs and execution annotations must
continue to record identifiers and safe error codes only.

## Phases and gates

### P1 — Baseline and contract freeze

Entry gate:

- [x] CLI is based on `warpmetal/agent-kit` `origin/main` at `156f854`.
- [x] API integration is based on `warpmetal_frontend` `origin/main` at `c049f63`.
- [x] `npm ci && npm run check && npm test`: 59/59 tests passed.
- [x] `python3 -m ruff check warpmetal tests/test_payment_contract.py`: passed.
- [x] `python3 -m pytest -q tests/test_payment_contract.py`: 58/58 passed.

Exit gate: this plan and the additive contract are committed with no unresolved
assumption that changes signing, settlement, or renewal behavior.

### P2 — API projection

- Validate x402api's optional fields at the adapter boundary.
- Add `humanCheckout` only to unsigned initial-purchase HTTP 402 bodies.
- Add positive, absent, and malformed-contract tests.
- Update the WarpMetal API guide and backend x402api boundary documentation.

Gate: targeted payment/route tests, Ruff, and the relevant PostgreSQL checkout
tests pass.

Result: complete. Hosted capability validation/projection, initial-purchase-only
route behavior, malformed-metadata isolation for renewals, and renewal omission
are covered. Bearer non-persistence is asserted against both payment-attempt and
execution-event records. Full backend gate: 1,753
passed, 1 skipped; coverage gate passed at 87.13% statements and 73.52%
branches after merging current `origin/main`.

### P3 — CLI consumption

- Validate the optional object before presentation.
- Return it in JSON and show the URL/expiry in human-readable output.
- Include and test the exact post-payment status command and notification-email
  prompt continuation.
- Keep it out of request envelopes and saved private state.
- Update both authoritative and packaged skill copies plus README/reference docs.

Gate: CLI check, complete Node test suite, plugin consistency test, audit, and
pack dry-run pass.

Result: complete. CLI gate: 60/60 tests passed; syntax and plugin checks passed;
`npm audit --audit-level=high` reported zero vulnerabilities; the `0.8.6`
package dry-run succeeded. The post-payment continuation preserves the effective
API and state-directory overrides, and its execution reaches the post-provision
`ask_human_for_notification_email` action. The notification flow is covered in
both hosted-checkout and ready-status tests.

### P4 — CLI-first release

- Open API and CLI pull requests and require CI.
- Merge and tag the CLI first as the next patch release.
- Wait for trusted publication, verify npm metadata, install the exact version
  into an isolated directory, and smoke-test `--version` and help.
- Only after the CLI is proven, merge/deploy the WarpMetal API projection and
  verify the production challenge response when an eligible test order is
  available. Do not create a paid order solely for the smoke test.

Gate: exact npm artifact is publicly installable and the production WarpMetal
health gate remains green.

### P5 — SDK continuation

Resume the already-open x402api SDK pull requests only after P4. SDK source
merges and registry releases retain their independent CI and credential gates.

## Recovery

- Before API deployment, the new CLI sees no `humanCheckout` field and behaves
  exactly like `0.8.5`.
- If API rollout must be reversed, omit the optional field; no CLI rollback is
  required.
- If the CLI package is defective before API deployment, publish a corrected
  patch and keep the API projection undeployed.
- Never revoke or rotate x402api hosted capabilities as a rollback substitute;
  their normal charge expiry remains authoritative.

## Post-release hosted-wallet compatibility amendment

x402api production deployment
`d3b6dc42c2efe5842ad30804741ec48cbcc4575e` keeps the existing
`human_checkout_url` and identical `qr_payload` wire contract. The canonical
URL is an acquisition handoff to `pay.x402api.com`, not a recipient address,
token-transfer request, signature, or authorization. Human-readable CLI and
skill guidance therefore presents the clickable URL first and describes an
optional QR only as another-device navigation. x402api owns qualified wallet
selection, mobile wallet-browser opening, desktop wallet-specific QR
presentation, explicit buyer authorization, and submission. The CLI does not
add a wallet connector, synthesize wallet links, persist the capability, or
change autonomous Agent Wallet behavior. This amendment authorizes tests and a
pull request only; it does not authorize an npm publication.
