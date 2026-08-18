# WarpMetal safety rules

## Contents

- Authority and freshness
- Credential boundaries
- Required confirmations
- Retry and terminal-state rules

## Authority and freshness

- Treat `https://warpmetal.com/llms.txt`, the live catalog, and the live HTTP
  402 challenge as authoritative in that order.
- Stop new purchases when `warpmetal health --json` reports
  `purchasingReady: false`.
- Select an exact OS name from the chosen plan's current
  `operatingSystems[]`. Never guess or hard-code an image version.

## Credential boundaries

- Treat the generated `ownerToken` as an offline recovery credential. Let the
  CLI store it; never inspect the state file or include it in output.
- Treat an SSH-derived access token as a short-lived bearer credential. Let
  the CLI store and refresh it.
- Never read or transmit an SSH private key. Pass only its filesystem path to
  `warpmetal server login` or `ssh-keygen`.
- Never request, read, transmit, or store a wallet seed phrase or private key.
- Never put a token, payment signature, private key, or state-file content in
  a prompt, URL, log, screenshot, source file, or shell argument.

## Required confirmations

Obtain explicit user approval immediately before:

- installing the CLI or skill;
- generating a new SSH key pair;
- creating or funding a wallet;
- signing or submitting an x402 payment authorization;
- booting, rebooting, or shutting down a server; and
- any destructive reload, deletion, or replacement-key operation.

An order preparation is unpaid but consumes a limited prepared-order slot.
Confirm the plan, hostname, OS, and public key before preparing it.

## Retry and terminal-state rules

- Reuse the same idempotency key only for the exact same logical request.
- For `payment_pending`, retry the exact checkout body and the exact same
  payment signature. Do not create a replacement payment.
- A signed HTTP 402 rejects that signature. Use the new live challenge for one
  replacement authorization.
- Treat `manual_review` as terminal. Do not pay again and do not repeat the
  mutation.
- Treat HTTP 202 as accepted or pending, never as proof of success. Poll the
  returned task or operation until a documented terminal state.
