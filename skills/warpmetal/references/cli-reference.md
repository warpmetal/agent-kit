# WarpMetal CLI reference

## Contents

- Discovery
- Account authentication
- Purchase and provisioning
- SSH identities
- Renewal and notifications
- Server management
- Agent Runtime and sandboxes
- Per-agent access
- Retained Work and Insights (source candidate)
- Skill installation and state
- Exit codes

## Discovery

```sh
warpmetal health --json
warpmetal catalog [--plan <planId>] --json
warpmetal models [--provider <id>] [--auth-mode <api_key|chatgpt_subscription>] [--json]
```

## Public model catalog

`warpmetal models` performs a read-only `GET /agent-team-model-catalog` request.
It preserves the published snapshot metadata, source provenance, freshness state
and authentication modes. `--provider` and `--auth-mode` filter entries and
remove recommendations whose published entry is no longer present. The command
does not infer eligibility or contact a model provider. `catalog` remains the
VPS plan catalog.

`health` exits with code 3 when the service responds but purchasing is paused.
The catalog remains useful for read-only discovery.

## Account authentication

```sh
warpmetal login [--no-browser] [--read-only] --json
warpmetal auth status --json
warpmetal logout --json
```

`login` uses the public `warpmetal-customer-cli` device client. It requests
`cli:read cli:write` by default or only `cli:read` with `--read-only`, prints the
bounded verification page and user code to stderr, and opens that page unless
`--no-browser` is present. Polling follows the server interval and treats
pending, slow-down, denial, expiry and cancellation as distinct outcomes. JSON
stdout contains only safe account identity and scope fields; access, refresh
and device credentials are never output.

The rotating CLI refresh family is independent of browser sessions, legacy
owner tokens and SSH credentials. It is stored in an owner-only, atomic session
file under the private WarpMetal state directory. Concurrent commands serialize
refresh. If refresh completion is ambiguous, the saved session is cleared and a
new login is required rather than replaying the old credential.

Sessions are bound to the exact Identity and account origins. Defaults are
`https://identity.warpmetal.com` and `https://warpmetal.com`; explicit
`--identity-url` and `--account-url` values must be HTTPS origins (localhost may
use HTTP). Redirects are refused, and credentials for one origin pair are never
sent to another. `logout` attempts remote family revocation and always clears
the matching local session, reporting whether revocation was confirmed.

Account login does not grant server SSH access. `warpmetal server login` remains
the separate, server-specific SSH challenge command.

## Account orders and devices

```sh
warpmetal account orders [--task <taskId>] --json
warpmetal account devices [--server <serverId>] --json
warpmetal order prepare --account --without-agent-boxes \
  --plan <planId> --hostname <name> --os '<exact catalog OS>' \
  --generate-ssh-key [--idempotency-key <key>] --json
```

Reads require `cli:read`; unpaid preparation requires `cli:write`. Only these
allowlisted operations are granted. Account scope never authorizes a payment,
renewal, server deletion, credential change or runtime execution. Collections
return the server's bounded page and `nextCursor`; order history is distinct from
active devices and can include released or cancelled orders.

Account mode signs in before checking order fields. It derives contact and
ownership from the signed-in principal, rejects `--email`, uses the private
account gateway, and records `ownershipMode: account` plus principal/origin in
private local state without an owner token. Use the same idempotency key and
unchanged payload to retry an ambiguous preparation. Do not retry a charge.
Existing owner-token checkout commands do not become account payment commands.

Boxes/team are selected by default for new account preparation: provide
`--runtime-file` with your chosen team, `--without-team` for one persistent small
`main` box, or `--without-agent-boxes` for no runtime. Explicit runtime files keep
their box/team choices, and older scripts without `--account` retain their
defaults. Server model/runtime readiness gates remain binding.

The optional `teams` sibling of `sandboxes` uses the deployed team-v1 schema:

```json
{
  "sandboxes": [{"name":"manager","size":"small"},{"name":"builder","size":"small"}],
  "teams": {"version":1,"teams":[{
    "name":"Build team",
    "members":[
      {"sandboxName":"manager","role":"manager","providerId":"openai"},
      {"sandboxName":"builder","role":"worker","providerId":"anthropic"}
    ],
    "links":[{"from":"manager","to":"builder","capability":"task.delegate"}],
    "startPolicy":"manual"
  }]}
}
```

Provider names in this example are preferences, not qualification proof. Optional
`modelId` and `authMode` must reflect the selected published entry; omitted values
mean choose later, never automatic credentials. A team has one manager and 2–8
distinct declared boxes. Credentials, unknown fields, automatic start and
cross-team links are rejected. Team/setup files are for order preparation;
`sandbox create --file` accepts a sandbox batch only.

## Purchase and provisioning

```sh
warpmetal order prepare \
  --plan <live planId> \
  --hostname <dns-label> \
  --os '<exact live OS name>' \
  (--generate-ssh-key [--ssh-key-name <name>] | --ssh-public-key-file <path>) \
  [--runtime-file <runtime.json>] [--confirm TEMPORARY] \
  [--email <address>] \
  [--idempotency-key <key>] \
  --json

warpmetal checkout challenge \
  --task <taskId> \
  [--request-envelope-out <path>] \
  --json

warpmetal checkout submit \
  --task <taskId> \
  (--payment-artifact <path> | --payment-signature-file <path>) \
  [--wait] [--timeout-seconds <n>] \
  --json

warpmetal order status \
  --task <taskId> \
  [--wait] [--timeout-seconds <n>] \
  --json
```

On HTTP 402, `checkout challenge` validates and displays exact payment terms,
writes the opaque x402api `challengeHandle` to private WarpMetal state for
merchant reconciliation, and writes a credential-free x402api V1 request envelope with owner-only
permissions, and returns the exact pinned wallet package, V1 contract probe,
matching wallet-skill install, setup, list, network-specific create,
address/balance/funding, authorization, and WarpMetal submission argv arrays.
The returned top-level `paymentWorkflow.sequence` fixes their order. Funding
options remain paired by exact live network and asset. The default envelope and
suggested artifact paths live under the
private WarpMetal state directory. An explicit output path must not already
contain different content. `challengeHandle` is intentionally absent from the
wallet envelope: it is neither a buyer payment identifier nor signing input.
`paymentChallengeDigest` is the distinct authoritative signing input forwarded
from x402api; the CLI fails closed instead of deriving it from
`PAYMENT-REQUIRED`.
If a previously issued unsigned sponsorship reservation expired, WarpMetal may
retire that attempt and return a new `paymentAttemptId`. The CLI replaces the
saved challenge and stale wallet-attempt metadata; use only the newly returned
workflow.

For interactive initial purchases, the response may additionally include
`humanCheckout.url`, the identical `qrPayload`, `expiresAt`, and an exact
`afterPayment.argv` command. The URL is a short-lived bearer capability for the
same charge, not a recipient address. Present the URL as a clickable x402api
handoff. An optional QR contains that exact web link for another-device
acquisition; scanning it does not authorize payment, and x402api owns any
wallet-specific choices inside the hosted page. If the buyer pays there, do not
submit an agent-wallet artifact; run the returned status command and,
after ready, follow `ask_human_for_notification_email` to offer lifecycle
notices. The CLI does not persist the hosted URL. Renewal commands never expose
or use this interactive option.

The current integration targets `@x402api/agent-wallet-cli@0.2.9`. A compatible
live term is marked `agentWalletSupported: true` and must use the sponsored
Base USDC or Solana USDC/USDT launch profile with buyer native fees disabled.
For the current declaration, x402api pays actual gas from its platform treasury
while the merchant tenant's allowance controls sponsorship admission. WarpMetal
retains the matched legacy tenant-credit declaration during rollout and rejects
mixed policy pairs. WarpMetal rejects a challenge with no compatible sponsored
term. Because the checkout is authenticated, do not substitute `x402api pay`,
`payment submit`, or `payment reconcile` for the returned WarpMetal submission
command.

`warpmetal checkout submit` and `warpmetal renewal submit` surface
`paymentId`, `confirmed`, and `finalized` from WarpMetal and persist those safe
lifecycle fields in private CLI state. `confirmed: true` is terminal for
payment submission and starts the business operation; `finalized: false` only
means signed-receipt reconciliation continues asynchronously.

`--payment-artifact` accepts the owner-only JSON artifact produced by a
compatible pinned x402api Agent Wallet release. WarpMetal validates its request
and payment-requirement digests, resource, extensions, buyer payment identifier,
signature, sponsorship expiry, file type, and permissions before submission.
It reports only safe attempt metadata. The compatibility
`--payment-signature-file` input must contain one HTTP header value. WarpMetal
never creates, imports, reads, or stores wallet keys and does not sign x402
challenges itself. See [payments.md](payments.md).

## SSH identities

```sh
warpmetal identity generate --hostname <dns-label> [--ssh-key-name <name>] --json
warpmetal identity list --json
warpmetal server identity --server <serverId> --json
warpmetal server identity attach \
  --server <serverId> --identity <private-key-path> \
  [--ssh-key-name <name>] --json
```

Generated identities live under the private WarpMetal state directory. The
default name is `warpmetal-<actual-hostname>`. Existing files are never
overwritten; a collision adds a short suffix. Order completion binds the local
identity to `serverId`, and later SSH-backed commands select it automatically.

## Renewal and notifications

```sh
warpmetal renewal configure \
  --server <serverId> --renew-before-days <n> \
  --maximum-payment-atomic <amount> \
  (--maximum-renewals <n> | --renew-through <UTC>) \
  [--maximum-total-spend-atomic <amount>] \
  --allowed-network <network> --allowed-asset <asset> \
  --wallet <name> [--refill-target-atomic <amount>] \
  [--email <address> | --without-email-notifications] --json
warpmetal renewal status --server <serverId> --json
warpmetal renewal due (--server <serverId> | --all) --json
warpmetal renewal prepare --server <serverId> --json
warpmetal renewal submit --server <serverId> \
  --payment-artifact <path> [--wait] --json
warpmetal renewal run (--server <serverId> | --all-due) --json
warpmetal notifications add --server <serverId> --email <address> \
  [--events <comma-separated-events>] --json
warpmetal notifications list --server <serverId> --json
warpmetal notifications remove --server <serverId> --recipient <recipientId> --json
warpmetal notifications events --server <serverId> \
  --events <comma-separated-events> --json
warpmetal notifications disable --server <serverId> --json
```

After a server becomes ready, `order status` returns
`nextAction.action: ask_human_for_notification_email` when setup has not been
completed or dismissed. Ask the human for an optional address, then use
`notifications add`; the server credential authorizes immediate activation, so
there is no verification step. A branded advisory identifies the server and
provides recipient-scoped removal. Up to five active recipients are supported.
Renewal configuration asks for an email before mutating policy unless
`--without-email-notifications` explicitly opts out. `renewal prepare` always
returns safe funding address/balance argv and returns signed refill-email argv
only when at least one active recipient exists.
`renewal run` is an agent-facing state machine, not a wallet-signing daemon.
See [renewals.md](renewals.md).

## Server management

```sh
warpmetal server login \
  --server <serverId> \
  [--identity <private-key-path>] \
  --json

warpmetal server get --server <serverId> --json

warpmetal server power \
  --server <serverId> \
  --action <boot|reboot|shutdown> \
  --confirm <same-action> \
  [--idempotency-key <key>] \
  [--wait] [--timeout-seconds <n>] \
  --json

warpmetal server reload \
  --server <serverId> --confirm ERASE --power-off-first \
  [--acknowledge-agent-runtime-reset] [--hostname <name>] \
  [--os <exact-live-os-name>] \
  [--generate-ssh-key [--ssh-key-name <name>] | --ssh-public-key-file <path>] \
  [--idempotency-key <key>] [--wait] [--timeout-seconds <n>] --json

warpmetal operation get \
  --operation <operationId> \
  [--server <serverId>] \
  [--wait] [--timeout-seconds <n>] \
  --json
```

Reload requires the recovery owner credential rather than a short-lived
SSH-derived token. `--power-off-first` authorizes shutdown and powered-off
verification inside the same operation. When Agent Runtime is enabled,
`--acknowledge-agent-runtime-reset` is required because workspaces are erased,
the Runtime identity is replaced, empty sandboxes are reconciled automatically,
and connection profiles must be refreshed. After a successful reload, wait for
automatic setup before refreshing profiles:

```sh
warpmetal runtime get --server <serverId> --wait --json
```

The successful operation records a new owner SSH trust epoch. Verify the
replacement host key before owner SSH. Manual Runtime installation remains an
explicit repair path when automatic setup fails; it is not part of a
successful reload.

Use `--token-file` only for recovery when local state is unavailable. Prefer
`WARPMETAL_OWNER_TOKEN` or `WARPMETAL_ACCESS_TOKEN` for a single command over a
shell argument, because command-line arguments can be recorded in history and
process listings.

## Agent Runtime and sandboxes

Agent-enabled first boot and Runtime-enabled reload automatically carry the
closed nested-sandbox opt-in inside verified provider cloud-init. The signed
Runtime bundle installs the exact-path policy for the image's immutable
Bubblewrap helper without a later customer SSH key. This is not a public order
field or CLI flag; VPS-only cloud-init remains unchanged, and existing enrolled
hosts use reload/reprovision. There is no silent in-place policy repair.

```sh
warpmetal runtime enable --server <serverId> [--idempotency-key <key>] --json
warpmetal runtime get --server <serverId> [--wait] [--timeout-seconds <n>] --json
warpmetal runtime install \
  --server <serverId> [--identity <owner-key>] --ssh-user root \
  --confirm INSTALL \
  [--wait] [--timeout-seconds <n>] --json

warpmetal sandbox create \
  --server <serverId> --name <name> --size <small|medium|large|xlarge> \
  [--lifetime temporary] [--expires-in-seconds <900-86400>] \
  [--confirm TEMPORARY] [--wait] [--timeout-seconds <n>] --json
warpmetal sandbox create --server <serverId> --file <batch.json> \
  [--confirm TEMPORARY] [--wait] [--timeout-seconds <n>] --json
warpmetal sandbox list --server <serverId> --json
warpmetal sandbox get --server <serverId> --sandbox <sandboxId> [--wait] --json
warpmetal sandbox action \
  --server <serverId> --sandbox <sandboxId> \
  --action <start|stop|restart|make_persistent|refresh_image|patch_image> --confirm <same-action> \
  [--image-digest <image@sha256:digest>] [--wait] --json
warpmetal sandbox delete \
  --server <serverId> --sandbox <sandboxId> --confirm DELETE [--wait] --json

warpmetal tools list --server <serverId> --json
warpmetal tools install --server <serverId> --sandbox <sandboxId> --profile <profileId> \
  [--idempotency-key <key>] [--wait] [--timeout-seconds <n>] --json
warpmetal tools status --server <serverId> [--wait] [--timeout-seconds <n>] --json
```

CLI 0.8.8 manages owner-facing VPS host trust during `runtime install`. With no
pin for the exact server trust epoch, the confirmed install performs one
harmless owner-key-authenticated SSH connection, trusts the first observed
Ed25519 host key, atomically pins it, and immediately reconnects strictly before
requesting bootstrap. JSON reports `hostKeyTrust.state` as
`trusted_first_use` or `matched` plus the safe fingerprint. Every later SSH and
SCP operation is strict; changed keys, malformed pins, and failed or ambiguous
reloads never replace trust. This TOFU step cannot detect an active attacker on
the first connection. Provider-console pre-enrollment is optional and stronger.

See [runtime.md](runtime.md) for capacity, lifetime, cleanup, polling, and
installation safety. Exit 8 is reserved for an actual bounded `--wait`
deadline timeout; a successful non-wait inspection exits 0 while reporting an
accepted, pending, applying, ready, or empty current state.

The `tools` commands use only the owner token already stored for the named
server. They do not accept token argv or `--token-file`. `tools list` returns
the registered immutable profiles. `tools install` sends only `{profileId}`
with an idempotency key; callers cannot supply download URLs, shell commands,
argv, environment variables, or artifacts. With `--wait`, `ready` exits 0,
`failed` or `cancelled` exits 5, and a bounded timeout exits 8. JSON contains
only the public profile/setup-operation fields returned by WarpMetal.

Codex is a released automatic tool profile when the public
`/agent-tool-profiles` endpoint advertises it as `available`. WarpMetal installs
the exact registered artifacts when selected at order time or through
`tools install`. Claude Code uses the released `claude-code` automatic tool
profile under the same public availability gate. Claude Managed Agents are separate:
`claude-managed-ant` is an install-only CLI profile. Installing `ant` does not
authenticate a worker and does not activate Managed Agents. Cursor CLI remains
manual and unavailable as an automatic profile until separately qualified later.
Gemini CLI remains manual.

For order-time setup, the runtime JSON file may contain the exact optional
shape below in addition to `sandboxes`:

```json
{
  "sandboxes": [
    { "name": "codex-worker", "size": "small" },
    { "name": "claude-worker", "size": "small" },
    { "name": "managed-worker", "size": "small" }
  ],
  "setup": {
    "version": 1,
    "sandboxProfiles": [
      { "sandboxName": "codex-worker", "profileId": "codex" },
      { "sandboxName": "claude-worker", "profileId": "claude-code" },
      { "sandboxName": "managed-worker", "profileId": "claude-managed-ant" }
    ]
  }
}
```

Every selection must reference a sandbox name in the same file. Unknown fields,
including URL, shell, command, argv, environment, or artifact overrides, are
rejected before an API request.

## Retained Work and Insights (source candidate)

Discover command availability with `warpmetal --help`; these routes require
the corresponding candidate control plane, Runtime and Sandbox.

```sh
warpmetal work list|sources|policy SERVER BOX --json
warpmetal work show|content|targets SERVER BOX WORK --json
warpmetal work create SERVER BOX --file request.json --json
warpmetal work update|enable|checkpoint|continue|restore|handoff SERVER BOX WORK --file request.json --json
warpmetal work status SERVER BOX WORK --kind checkpoint|continue|restore|handoff \
  (--request REQUEST | --operation OPERATION) --json
warpmetal work open SERVER BOX WORK --json
warpmetal insights summary SERVER --json
warpmetal insights status|list SERVER BOX --json
warpmetal insights enable|disable SERVER BOX --file request.json --json
warpmetal insights show SERVER BOX FINDING --json
warpmetal insights acknowledge|snooze|dismiss SERVER BOX FINDING --file request.json --json
warpmetal insights open SERVER BOX FINDING [--takeover OPERATION] --json
warpmetal insights manager settings SERVER BOX [--file request.json] --json
warpmetal insights manager activity SERVER BOX [--finding FINDING] --json
warpmetal insights manager run SERVER BOX RUN --json
warpmetal insights manager target SERVER BOX FINDING --json
warpmetal insights manager recheck SERVER BOX FINDING --file request.json --json
warpmetal insights manager status SERVER BOX FINDING --request REQUEST --json
warpmetal insights takeover list SERVER BOX FINDING --json
warpmetal insights takeover SERVER BOX FINDING --file request.json --json
warpmetal insights takeover status SERVER BOX FINDING --operation OPERATION --json
warpmetal insights takeover resume SERVER BOX FINDING --operation OPERATION --file request.json --json
warpmetal insights review SERVER BOX RUN --json
```

Use the server's existing scoped owner/SSH credential. The account session is
not a fallback. `--file` mutations validate a closed request with an explicit
request ID and revision fences before HTTP. Saved same-intent retries are
GET-only. Preserve the original request after a lost reply; never generate a
new request to bypass an uncertain outcome. Pending operations exit 8, terminal
failures/conflicts exit 5. Accepted Continue/handoff means task admission, not
completion. Check task state separately.

Only `work content` deliberately prints private content. Metadata and receipts
are closed projections. Do not log private request files or content output.

`open`/`review --json` returns a fresh descriptor without SSH. For deliberate
human interactive access, omit `--json` and supply absolute
`--connection-file` and `--identity` paths for the exact sandbox grant. Local
OpenCode 2.0.14 connects through the fixed pinned bridge to the exact existing
session. The command creates no session and sends no initial prompt. Manager
review cannot mutate the worker. Takeover checks the current protected hold;
Resume requires its saved operation, predecessor and revision tuple.

## Per-agent access

```sh
warpmetal sandbox access keygen --output <private-key-path> --confirm GENERATE --json
warpmetal sandbox access grant \
  --server <serverId> --sandbox <sandboxId> --name <name> \
  --ssh-public-key-file <public-key-path> \
  [--connection-file <profile-path>] [--wait] --json
warpmetal sandbox access list --server <serverId> --sandbox <sandboxId> --json
warpmetal sandbox access get \
  --server <serverId> --sandbox <sandboxId> --grant <grantId> [--wait] --json
warpmetal sandbox access refresh \
  --server <serverId> --sandbox <sandboxId> --grant <grantId> \
  --connection-file <profile-path> --confirm REFRESH [--wait] --json
warpmetal sandbox access install-ssh \
  --connection-file <profile-path> --identity <sandbox-private-key-path> \
  --alias <alias> [--confirm REFRESH] --json
warpmetal sandbox access remove-ssh --alias <alias> --confirm REMOVE --json
warpmetal sandbox access revoke \
  --server <serverId> --sandbox <sandboxId> --grant <grantId> \
  --confirm REVOKE [--wait] --json
warpmetal sandbox connect --connection-file <profile-path> \
  --identity <sandbox-private-key-path> [-- <remote-command> <arguments...>]
```

`sandbox connect` is the only runtime command that does not use `--json`; it
returns the OpenSSH or remote exit status. `--connection-file` on grant
creation requires `--wait`.
`sandbox access refresh` atomically replaces a stale token-free profile with
the currently applied grant and API-reported pinned host keys; use it after an
OS reload once automatic Runtime reconciliation is ready.

`sandbox access install-ssh` is local-only and requires CLI 0.8.10 or newer.
It turns the reviewed profile and sandbox-private identity into a concrete
alias in `~/.ssh/config`. Exact replay is unchanged. If the profile, endpoint,
pin, or identity changes, first run the authenticated `sandbox access refresh`
command above, then repeat `sandbox access install-ssh ... --confirm REFRESH`.
Removal requires exact `--confirm REMOVE` and preserves unrelated SSH config.

Use a separate keypair and grant for each sandbox. The alias never uses or
exposes the VPS owner management key; the forced gateway cannot open a host
shell, and forwarding remains disabled with `ClearAllForwardings yes`.
Authentication for user-installed tools happens inside the sandbox. Common
interactive and one-shot entry points are:

```sh
ssh <alias>
ssh -t <alias> codex
ssh <alias> codex exec '<task>'
ssh -t <alias> claude
ssh <alias> claude -p '<task>'
ssh -t <alias> agent
ssh <alias> agent -p '<task>'
ssh -t <alias> gemini
ssh <alias> gemini -p '<task>'
```

Authenticate each selected provider tool inside the sandbox after setup is
ready. The public `/agent-tool-profiles` response is authoritative for
availability and checkout selection. Claude Code uses the `claude-code`
automatic tool profile. Claude Managed Agents are
separate: `claude-managed-ant` is an install-only CLI profile. Installing `ant`
does not authenticate a worker and does not activate Managed Agents. Cursor CLI
remains manual and unavailable as an automatic profile until separately
qualified later. Install and authenticate Cursor CLI or Gemini CLI inside the
sandbox. WarpMetal does not perform provider login or receive provider
credentials.

[Codex Desktop](https://learn.chatgpt.com/docs/remote-connections) reads
the concrete alias from `~/.ssh/config` and starts Codex through the sandbox
login shell, so Codex must be installed and on that login-shell `PATH`. The
tested Cursor Remote SSH route requests prohibited dynamic forwarding and is
not compatible with this boundary. Keep forwarding denied and use the
[Cursor CLI](https://cursor.com/docs/cli/overview) interactive or
[headless](https://cursor.com/docs/cli/headless) commands shown above.

Install Gemini CLI from its official [installation guide](https://geminicli.com/docs/get-started/installation/)
and use its documented [headless mode](https://geminicli.com/docs/cli/headless/)
for `gemini -p`. Gemini's optional Docker or Podman sandbox is normally
unavailable inside the WarpMetal sandbox because no host container-engine
socket is exposed; run Gemini directly inside the existing outer sandbox and
choose its approvals yourself.

## Skill installation and state

```sh
warpmetal agent install --target <codex|claude|all> [--scope user|project]
warpmetal state list --json
```

`warpmetal agent install` installs only the bundled WarpMetal skill; it does
not install sandbox tools or select a sandbox tool profile.

`state list` returns identifiers, public runtime metadata, and
credential-presence booleans only. Never
open the underlying state file from an agent session.

## Exit codes

- `0`: command completed or reached its requested safe stopping point.
- `1`: unexpected local or API failure.
- `2`: invalid command, option, input, or local state.
- `3`: purchasing unavailable, rate limited, or API temporarily unavailable.
- `4`: missing or rejected credential or SSH proof.
- `5`: API conflict, including an idempotency conflict.
- `6`: manual review; stop and do not retry the consequential action.
- `7`: payment authorization rejected or required; inspect the live challenge.
- `8`: operation still pending or wait timeout reached.
