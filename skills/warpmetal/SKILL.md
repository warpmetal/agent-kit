---
name: warpmetal
description: Safely purchase and manage WarpMetal VPS servers with the warpmetal CLI. Use when Codex, Claude Code, Cursor, Windsurf, or another shell-capable agent needs to inspect live VPS plans and operating systems, prepare or pay for an x402 order, poll provisioning, prove ownership with an SSH key, inspect a server, or run supported lifecycle operations.
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

Never read, print, summarize, upload, or commit the WarpMetal state file. Never
read an SSH private-key file. Pass its path only to a command designed to use
it. Never request or handle a wallet seed phrase or private key.

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

Run `warpmetal checkout challenge --task <taskId> --json` to obtain the live
x402 terms. Before any wallet creation, funding, or signature, show the user
the exact amount, asset, network, recipient, and expiration derived from the
live challenge and obtain explicit approval.

Use a compatible external wallet signer to produce one `PAYMENT-SIGNATURE`
header value in a file. Do not pass wallet secrets to WarpMetal or the CLI.
After approval, submit it with:

```sh
warpmetal checkout submit \
  --task <taskId> \
  --payment-signature-file <path> \
  --wait \
  --json
```

If the command reports a rejected signature, inspect the replacement live
challenge and request new approval where its terms changed. If it reports
`manual_review`, stop immediately and never create another payment.

## Provision and manage

Poll a prepared or paid order with:

```sh
warpmetal order status --task <taskId> --wait --json
```

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

Do not fall back to raw API calls for reload, deletion, networking, renewal,
or another unsupported mutation. Explain that the installed CLI version does
not yet expose that guarded operation.
