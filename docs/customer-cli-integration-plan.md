# Customer CLI integration

Outcome: `CLI-ACCOUNT-20260927`. Revision 5, contracts frozen; P1 resumed with explicit owner authorization. Production edits require manager-inspected RED per packet.

## Project details

The owner authorized planning and executing the CLI update after confirming
token-based browser/device login. The update must let a person authenticate
before supplying an SSH key or order configuration, keep a revocable CLI
session, show the already published model catalog, and support Agent Boxes/team
configuration consistently with the website. The existing unattended SSH and
owner-token workflows remain supported.

This is a new implementation packet. The previous deployment-check heartbeat
was explicitly cancelled and remains deleted. This work does not reopen the
completed branding, browser-login, or model-visibility qualification. Real
provider consent, production backup restore, and Google app verification remain
unverified in the previous deployment plan.

### Baseline and ownership

| Repository | Exact baseline | Isolated worktree / branch |
|---|---|---|
| CLI | `43240a6d1df3e10d6d8edd4157dd3f7ec2ad94e6`, published npm 0.8.13 | `/Users/jokubo/.codex/worktrees/cli-account-session/agent-kit`, `codex/cli-account-session` |
| Identity | `4958071855d58d489e230715ee4e961b979a5e8c` | `/Users/jokubo/.codex/worktrees/cli-account-session/warpmetal-identity`, `codex/customer-cli-session` |
| Frontend/commerce | `63e4ad94c8f8436f947ea40f5639fefaf9460701` | `/Users/jokubo/.codex/worktrees/cli-account-session/warpmetal_frontend`, `codex/cli-account-gateway` |

Root manages this canonical plan, interface decisions and integration. Auth and
ownership specialists inspect the two service boundaries. Implementation packets
receive disjoint files after contract freeze. A fresh reviewer will perform one
integrated review after automated gates pass. Managed-plan-execution authorizes
this bounded delegation; no persistent agent configuration is changed.

Non-goals: new VPS, payment, charge, provider inference/qualification, fabricated
catalog rows, raw Dex credentials as commerce authority, Fleet/Mission Control
enablement, automatic ownership transfer of legacy servers, or broad payment
rewrites. Machine service credentials are a separate future grant unless the
existing narrowly scoped server-token path suffices; customer login must not
silently issue unattended administrative authority.

## Requirements and acceptance

| ID | Requirement | Observable acceptance | Evidence |
|---|---|---|---|
| C1 | Account-first CLI login | Packaged CLI starts login with no SSH/plan/OS/hostname; Google/GitHub signup or returning login completes using verified provider contact | real CLI + browser + Identity/Dex/Postgres E2E; external upstream fixture explicit |
| C2 | Headless approval | CLI prints a bounded URL/code, polls at server interval, respects pending/slow-down/deny/expiry/cancel; one-use approval and redemption | real protocol/process/DB E2E |
| C3 | Durable token session | Short access lifetime, rotating refresh, independent CLI family, restart, refresh concurrency, logout/revoke and reuse detection; no secrets in stdout/errors | real CLI processes + persistent server DB |
| C4 | Account authorization | Token resolves stable principal/account; account order prepare and inventory isolate owners; raw Dex/Fleet/legacy owner credentials cannot impersonate customer session | real commerce/Postgres/private transport E2E |
| C5 | Model visibility | CLI renders current public snapshot, provenance/auth modes/staleness; no inference or invented eligibility | real CLI against catalog API and one read-only published check |
| C6 | Team configuration | CLI supports deployed team schema/defaults with explicit opt-outs and restored explicit configuration; server readiness gates remain binding | CLI to real commerce validation E2E |
| C7 | Compatibility | Legacy owner/SSH tokens, existing saved state, payment challenge bytes, server management and explicit runtime-file behavior preserved | affected existing tests + real CLI legacy regression |
| C8 | Delivery truth | OpenAPI/reference/skill/docs/package agree with exact tested code; serial deployment only after qualified candidate; live proof separate from fixtures | static/contracts/packaged smoke/CI/live where available |

## Architecture and entry assumptions

Observed: CLI `src/api.js` calls the existing public commerce API. `server login`
means an SSH challenge, not customer account login. State schema 4 stores
per-order owner tokens. `src/runtime.js` currently accepts only `sandboxes` and
`setup`, not team configuration. The current package and npm tag both identify
the exact baseline above.

Observed: Dex is an upstream broker for WarpMetal Identity. Customer browser
tokens are minted by Identity and retained in the BFF. Commerce requires a
verified BFF mTLS envelope plus an Identity customer JWT; account ownership is
resolved from its stable subject. Existing Fleet device grants are
organization-scoped and disabled by the customer production profile. They must
not be enabled wholesale to implement this feature.

The planned boundary is a dedicated customer CLI session established by explicit
browser approval, then a narrowly scoped API/gateway mapping that session to
existing customer ownership. The exact issuance and gateway contract is under
inspection. Reusing an existing browser refresh token, exposing BFF private
credentials, accepting arbitrary redirect URIs, or trusting account IDs from the
CLI are rejected options.

### Authentication and authorization

Human login uses the existing branded provider/browser account boundary. CLI
approval must identify the requesting client and granted capabilities, with
explicit allow/deny and same-origin/CSRF controls. Tokens need exact issuer,
audience, client/purpose, scopes and expiry. Server-side state must support
one-use device redemption and independent session revocation. Local session
storage must be private and origin-bound, and serialize refresh across processes.
Existing owner/SSH credentials retain their existing resource authority; they
do not become account principals. All identity and resource checks fail closed.

### Error handling and logging

Protocol errors are stable codes: pending, slow_down, denied, expired,
invalid_grant, invalid_token, insufficient_scope, unavailable. Polling has a
deadline and bounded backoff; writes retain existing idempotency semantics.
Transport ambiguity never retries payment or resource creation blindly. Safe
logs contain event, route, status, correlation ID and opaque reference only.
Never log tokens, passwords, device secrets, authorization URLs with sensitive
queries, client secrets, or unnecessary contact data. Account status may show
the user's own safe identity fields but not stored authority.

### Threat and failure model

| Boundary | Risk | Required control |
|---|---|---|
| CLI → login | Code theft, phishing, replay | high-entropy secret, short user code rate-limited separately, explicit requested client/scope approval, one-use DB transition |
| Browser → approval | CSRF or wrong account | session authentication, exact origin, CSRF, explicit confirmation, no caller-supplied principal |
| Token → commerce | Audience confusion, cross-owner access | exact customer CLI grant, gateway scope allowlist, private transport, server-side subject ownership |
| Refresh → durable state | Concurrent rotation/replay or crash | serialized rotation, atomic private local persistence, server family revocation, explicit re-login on ambiguous loss |
| Existing orders | Silent ownership rewrite | legacy credentials unchanged, explicit mode selection, no account linking by email |
| Team/model setup | Invented support or paid execution | use published IDs/auth modes and server qualification gate; no provider calls |

## Documentation and API contracts

CLI owns this plan, its command/auth/runtime references, canonical JSON/OpenAPI
description of public CLI calls, README examples, packaged skill and plugin copy.
Identity owns new customer grant contracts/lifecycle/deployment documentation if
that boundary changes. Frontend/commerce owns the browser approval, gateway and
account-route contract. Examples must distinguish new commands from legacy SSH
login and clearly state scope, lifetime, revocation, errors, idempotency,
pagination, origin binding, local storage and compatibility.

## Phase map

| Phase | Outcome | Exit criterion | Status |
|---|---|---|---|
| P0 | Freeze smallest safe cross-repository contract | Boundary evidence, assumptions, exact test manifest and active packet approved | complete |
| P1 | Packaged CLI account/model/team journey | Test-first vertical auth path, account ownership, catalog/team integration, required static/regression gates, one final review/remediation | in_progress |
| P2 | Deliver qualified releases and truthful acceptance | exact PR/CI artifacts, serial rollout/package release where authorized, read-only live check; provider consent limitation explicit | pending |

## Active phase P0

Implementation authorized: **no production edits until interfaces and expected
RED tests are frozen**. User execution authority is already granted; this is an
internal engineering checkpoint, not a request for renewed user permission.

| Assumption | Evidence / resolution | Status |
|---|---|---|
| Latest CLI has no customer auth | exact main and npm 0.8.13 inspected | verified |
| Web tokens can be used directly by a public CLI | private mTLS/customer authorization required; cannot expose BFF credentials | false |
| Fleet device switch supplies customer login | Fleet organization/audience boundary and production profile differ | false |
| Account commerce routes already exist | `/orders` account mode, durable account bindings, mTLS subject verification exist | verified |
| Dedicated customer grant can reuse identity primitives | independent customer device table and durable family client binding; existing signing/rotation reused | verified |
| Representative integration environment exists | retained real joint fixture and Docker available; current image metadata is historical, not a candidate proof | verified with rebuild required |

Baseline `npm run check` and `npm run plugin:check` pass on Node 22.23.2/npm
10.9.8 (4 plugin cases). No broad behavior suite repeated yet. Existing local
fixture/resources remain untouched. No production or provider call was made.

### Primary journey and planned boundary evidence

Packaged `warpmetal login` → customer authorization/device request → branded
browser signup/login → explicit approval → one-use device exchange → private
local CLI session → authenticated gateway → real account-owned commerce result.
Identity, PostgreSQL, Dex, BFF and CLI processes remain real. Only upstream
Google/GitHub and unavailable hardware/payment effects may be fixtures, and no
claim of actual provider consent/payment/provisioning may follow from them.
Thin login/status/logout E2E must run before broad order/team implementation.

### Attempt and resource ledger

Manager-set cumulative budget (no user-imposed hard stop): four focused
correction iterations per frozen subpart; initial integrated gate plus at most
two consolidated correction/rerun batches; one evidenced transient retry; one
final code review and one remediation set within those bounds. First elapsed
review checkpoint at 60 minutes. Live attempts require a frozen procedure before
execution. Expected RED failures do not count as unexpected gate failures.
No integrated or live attempt consumed yet.

Created resources: the three exact worktrees above; retained, not cleanup targets
while implementation/evidence depend on them. User-dirty canonical worktrees,
Vite config and existing Docker resources are outside write/cleanup ownership.
Disposable resources created later must be recorded individually; no pruning.

## Verification log

P0: source, config, published-version and environment inspection only. Behavioral
claims remain unverified until the frozen E2E gates run. Provider consent and
deployment require separate truthful acceptance.

### Independent C5 catalog test packet

The catalog adapter has no dependency on the unresolved auth grant decision.
Tests only are authorized now; production changes still require root inspection
of RED evidence. Command contract: `warpmetal models [--provider ID]
[--auth-mode api_key|chatgpt_subscription] [--json]` reads the existing public
`GET /agent-team-model-catalog`. JSON preserves snapshot/provenance/freshness and
auth-mode metadata, while filtering only entries and recommendation IDs that
remain present. Human output makes stale/suppressed/empty states explicit and
does not invent scores or capabilities. Unknown flags/auth modes fail before
network calls. Existing `catalog` remains the VPS catalog.

Extend the package's E2E evidence with a real `node bin/warpmetal.js` subprocess
and real loopback HTTP transport carrying frozen public catalog documents. This
proves the CLI adapter only; it does not claim a new backend/DB or provider
qualification. The existing backend is unchanged. A final packaged read-only
request to the already accepted production catalog proves actual interoperability
without inference, publishing, orders or any model requalification.

Oracle includes fresh/stale/suppressed/empty responses, provider/auth filtering,
HTTP errors, no fabricated recommendation and no mutation methods. Expected RED:
unknown `models` command before implementation. Owner `cli_model_contract` writes
only `test/models-e2e.test.js` and evidence under `artifacts/cli-account-20260927`.
Proposed later implementation ownership is `src/models.js`, `src/api.js`,
`src/cli.js` command dispatch/help and relevant README/skill references; no
concurrent CLI writers until this packet completes. Green commands: the focused
subprocess test, `npm run check`, `npm run plugin:check`, then final package test
gate after auth integration. No new unit tests.

## Active phase P1: frozen cross-repository contract

P0 inspection is complete. The user authorized implementation; test owners may
write/run the tests below now. Root records each expected RED before authorizing
its corresponding production edits. Auth/ownership implementers use Sol because
the boundary is security-sensitive; bounded catalog adapter work uses Terra.
Root owns CLI auth, contract integration and final evidence. Only upstream
provider interactions are fixture-backed in the integrated customer journey.

### Identity device client

The public client is `warpmetal-customer-cli`. Use an independent default-off
`IDENTITY_CUSTOMER_CLI_DEVICE_ENABLED` switch; existing Fleet device/human/agent
switches stay off. Verification URI is `https://warpmetal.com/account/cli`.
`POST /oauth/device_authorization` accepts closed form fields `client_id,scope`.
Scopes are exactly `cli:read` or `cli:read cli:write`; write alone, web/Fleet
scopes, extra fields, duplicate fields and client secrets fail closed. Return RFC
device_code/user_code/verification_uri/verification_uri_complete/expires_in/
interval, with no-store. Public `/oauth/token` accepts exact device-code grant
or refresh-token form for this client, and `/oauth/revoke` accepts its refresh
token. Poll pending/slow_down/deny/expiry is RFC-compatible. Metadata advertises
only enabled grants. No BFF public token proxy is needed.

Use a dedicated hash-only customer CLI device table, row locking and one-use
approval/redemption. Add nullable `HumanSessionFamily.client_id`; migrated web
families remain NULL and new issuance records actual client. CLI family is
durably client-bound with distinct `wmclr_` refresh prefix. Public refresh/revoke
can never accept/revoke browser families. Session lifetimes remain customer
5-minute access, 7-day idle and 30-day maximum. Refresh reuse revokes the CLI
family. Logout-all/password reset continue to revoke all customer families.

Customer access JWT retains the exact existing closed claim schema and
`warpmetal-vps` audience, adding no cnf/client field. Inspection corrected a
design assumption: cnf belongs to the BFF service token, not the customer JWT.
Private BFF transport and its service token retain certificate binding.

Private mTLS/service-token endpoints use narrow `customer:cli` service scope:

- `/internal/customer/cli/device-authorizations:begin`: JSON userCode,
  principalId,browserRefreshToken; validates current browser family, returns
  approvalHandle,userCode,client{id,name},scopes[{id,label}],expiresAt.
- `/internal/customer/cli/device-authorizations:approve`: JSON approvalHandle,
  principalId,browserRefreshToken,decision (approve|deny); revalidates same
  principal/family/current browser token, consumes handle once, returns status
  and expiresAt. No CLI tokens go to browser/BFF approval response.
- `/internal/customer/cli/authorize`: JSON requiredScope (cli:read|cli:write);
  customer bearer in `X-Warpmetal-Customer-Authorization`, separate from service
  Authorization. Verifies signature/issuer/audience/time, active durable CLI
  family/client/principal and scope. Returns only principalId,email,emailVerified,
  scopes,sessionFamilyId,expiresAt. No raw tokens returned/logged.

### BFF, browser and commerce

`/account/cli` is the browser approval document. API POST
`/account/cli/authorization` uses existing cookie/session, exact Origin and CSRF;
action begin accepts userCode, action approve/deny accepts approvalHandle.
Identity derives trusted principal/family from BFF session. UI renders explicit
client/scopes and Approve/Deny. Signed-out visitors may login or create an
account via `/account/signup` using existing account-purpose registration and a
validated same-origin return path. No SSH/order fields precede authentication.
Use existing WarpMetal components/palette under uncodixfy, not a new theme.

Exact bearer-only gateway allowlist, no cookies as CLI auth or arbitrary proxy:
GET `/account/cli/whoami`, `/account/cli/devices`, `/account/cli/devices/:id`,
`/account/cli/orders`, `/account/cli/orders/:id` require cli:read;
POST `/account/cli/orders` requires cli:write. Every call consults private
Identity authorize and uses the same customer JWT over existing Commerce mTLS.
Commerce keeps exact token validation and subject-based ownership. Direct
public customer-account Commerce access stays denied. These scopes authorize
only this route set, never payment/renewal/billing/delete/credential changes,
runtime execution, Fleet or Mission Control.

Add private GET `/account/orders`, subject-scoped AccountOrder/PurchaseTask
history separate from active server inventory. Account prepare aggregates the
existing registration-intent and account-mode /orders calls with stable child
idempotency keys; derives identity from bearer, never caller account/email.
No checkout cookie, ownerToken or registration intent leaks to CLI. Existing
public owner-token order path remains unchanged. No new account payment path.

### CLI contract and ownership

Root owns new CLI auth/session/gateway files and subsequent dispatch integration.
Catalog agent temporarily owns src/api.js/src/cli.js only after its RED approval;
root will not edit those files until catalog handoff. CLI auth stores origin-bound
private0700/0600 atomic session files, not browser tokens; a cross-process lock
serializes refresh with bounded stale-lock recovery. Ambiguous refresh loss
requires re-login rather than token reuse. API and account/issuer origin overrides
are explicit and validated; never transmit credentials after redirects.

Commands: login (browser URL by default, `--no-browser` headless, optional
`--read-only`), auth status, logout, account orders/devices plus individual IDs;
existing prepare-order gains explicit account-mode support and a saved account
credential discriminator, retaining owner-token default compatibility. Team
JSON extends existing runtime-file schema exactly; explicit existing files and
legacy requests keep their meaning. New interactive account preparation defaults
Agent Boxes/team on, with explicit opt-outs and server readiness still binding.

### Frozen test packets and integration order

1. Identity owner cli_identity_design: real ASGI/Postgres existing customer E2E
   extension for feature-disabled/invalid input, start/pending/slowdown, browser
   approval and deny, wrong-family/CSRF responsibility, one-use redemption,
   CLI/browser separation, scopes/refresh/reuse/revoke, migration old-row
   preservation, logout-all. RED expected new route/feature absent. Own Identity
   worktree only, including schema/contracts/docs; preserve Fleet behavior.
2. Commerce owner cli_commerce_design: extend existing real account local-stack
   harness tests for strict gateway+signup return+CSRF, account order aggregation,
   history/isolation and legacy owner-token path. RED expected absent gateway or
   account collection; do not mistake unavailable future Identity for RED.
   Own frontend worktree only, including worker/UI/backend/contracts/docs.
3. Root: real packaged CLI subprocess HTTP/session evidence before auth client
   production; then thin integrated CLI login/status/logout on real Identity,
   BFF and Postgres as soon as producers are ready. After thin green, extend
   account prepare/model/team and legacy regression using real commerce DB.
4. Complete required static/build/contracts and package tests once components
   integrate, then one fresh final auth/ownership/persistence review, one
   consolidated remediation set and appropriate rerun. No second review.

No production deployment, paid action or new provider inference is authorized
by a fixture test. Existing user rollout authority permits later serial releases
after exact qualification; P2 freezes their order, commands and live procedure.

### Checkpoint: C5 expected RED accepted

Root inspected the real subprocess/HTTP oracle and its captured unknown-command
output in `artifacts/cli-account-20260927/models-red/README.md`. Six valid
invocations fail because `models` is absent; no product file changed. C5
production implementation is now authorized for catalog agent's assigned files.
Model IDs and capabilities in this test are synthetic public-document fixtures,
not new production qualification. No unexpected failure budget consumed.

### Checkpoint: C5 local GREEN and CLI session RED

C5 implementer reports focused subprocess E2E, syntax and 4 plugin checks green;
root has its file-level handoff. Production model readback remains pending.
Catalog agent's mutable CLI file ownership ends at this handoff.

Root wrote and ran `node --test test/customer-auth-e2e.test.js`: both real
subprocess/loopback protocol scenarios fail with `Unknown command: login`, exit2.
This is the expected absence, not a transport/harness failure. Test covers
independent private persistence, concurrent-process single refresh, origin
binding, logout, pending/deny/expiry, redirect denial and secret-free output.
It qualifies the CLI client adapter only; real Identity/BFF/DB integration is
still mandatory. CLI auth production now authorized to Sol owner; root owns
runtime/team files/tests separately. No unexpected failure budget consumed.

### Checkpoint: explicit team-file RED accepted

Root ran `node --test test/team-prepare-e2e.test.js` against the packaged command
and loopback HTTP API: expected exit2 `unsupported field: teams`. Existing
box-only file remains the compatibility oracle; malformed/credential-bearing
members must fail before transport and real server readiness rejection must
remain visible. This adapter fixture does not certify production commerce or
runtime execution. Root may now extend runtime parsing to the existing frozen
team-v1 contract; no dispatch overlap with the auth owner.

### Checkpoint: team parser GREEN; account CLI RED

Explicit team-file subprocess E2E plus 13 existing runtime tests passed. Unknown
fields/credential-shaped data, cross-sandbox refs, duplicate managers, automatic
start and invalid auth/link combinations are rejected before network; server
gate rejection stays authoritative. Existing box-only files remain unchanged.

Root's `test/account-orders-e2e.test.js` executes the packaged CLI and expected
RED is `Unknown option: --account`, exit2, before any login/order call. Account
commands are frozen as `account orders [--task ID]`, `account devices [--server
ID]` and `order prepare --account`. Root may implement these after auth owner's
src/cli.js handoff. Account mode authenticates before validating order fields,
uses only the scoped gateway and saves explicit account ownership (principal and
origin, no ownerToken). Account default Boxes/team requires an explicit team
runtime-file; it never invents a provider/model. `--without-agent-boxes` opts out
entirely; `--without-team` without a file requests a single persistent small
`main` box. Existing explicit files retain their intent and legacy defaults are
unchanged. This deterministic CLI behavior replaces the earlier tentative
interactive prompt assumption. No payment endpoint or account purchase added.

### Checkpoint: Identity RED accepted with two oracle corrections

Root inspected the new actual ASGI/Postgres device and populated Alembic tests.
Expected missing route404, disabled metadata advertisement and absent nullable
client_id are valid RED. Before implementation, align two oracle details to
the already frozen contract: public OAuth errors use RFC top-level `error`, not
the private application's detail.code; newly issued browser families record
the web client_id, while only migrated old rows retain NULL. This is a contract
correction, not weakened acceptance. Production Identity implementation is
authorized after those test corrections; no new user permission needed.

Harness history retained: two CursorResult-to-dict test-harness corrections
preceded the final schema RED. Task-owned Postgres `identity-cli-red-p1-pg`,
port51814, its anonymous volume and databases identity/identity_cli_migration_red
are retained; no shared resource changed. Focused production correction budget
remains four; these pre-implementation harness failures are recorded separately.

### CLI integration checkpoint

Account subprocess gate is GREEN after one integration correction: login rejected
the documented global --base-url flag; auth accepts it without using it as the
issuer/account origin. The explicit auth origin flags remain authoritative.
This consumed 1/4 focused account integration corrections, leaving three.

Root extended the same team subprocess journey to the shared sandbox-create
file parser: expected regression RED is TypeError `sandboxes.some is not a
function` when passed order-only team data. The parser must give a usage error
before network instead. Manager authorizes this narrow boundary fix; no new
runtime capability is introduced.

### Checkpoint: frontend/Commerce RED accepted

Root inspected four BFF contract tests and the real Flask/Postgres order history
test. Missing routes404 are expected product RED; the BFF layer uses explicit
private-Identity doubles and does not certify integrated auth. Existing real DB
inventory/account-prepare/replay controls passed3 cases. Frontend implementation
is authorized for the frozen gateway, approval/signup UI, private order history,
aggregate prepare and contracts/docs. Owned DB warpmetal_cli_gateway_red_20260927
on existing p2a-postgres is retained; shared databases/containers are untouched.
Root owns the new real built-browser+packaged-CLI joint oracle in Identity.

### CLI packaged checkpoint

All 159 CLI tests passed (log `artifacts/cli-account-20260927/cli-package-tests.log`).
After a metadata/docs-only candidate version bump to CLI0.9.0/plugin0.1.8, syntax
and plugin checks passed. A local unpublished npm pack contains28 expected
files; unpacked package-candidate-1 executes against the actual public catalog
successfully, evidence model-public-readback.json. No provider/model inference,
catalog write, order or payment occurred. Package-candidate-1.json records the
ciphertext-independent tarball SHA256. This read-only interoperability proves
model visibility only, not production CLI auth (new services not deployed).

The joint CLI/browser harness is written and syntax/lint clean. Its first lint
pass found unused import, formatting and subprocess audit markers; these test
harness findings were corrected without product behavior changes. No joint run
has occurred. Candidate networks10.254.240.0/24 through10.254.246.0/24 were
read-only checked unused; creation is deferred until producer images are ready.

### Joint integration entry checkpoint

Identity reports real device cases7, populated migration1 and adjacent customer
cases83 green. Commerce reports focused gateway cases4, real order-history DB
case1, build and lint green (15 pre-existing warnings). Root's candidate images
are built from the three working trees; image IDs and source hashes are recorded
by the new fixture. First build-shell invocation failed before Docker because
its evidence directory was absent; creating the directory resolved it. No
application test or source correction was involved.

Frozen thin-joint procedure: new isolated TLS fixture, public customer flag on
only in that fixture, original default Fleet/runtime flags unchanged. Execute
unpacked npm candidate1 as actual child processes in a retained browser runner.
For each Google/GitHub synthetic upstream identity: start without order fields,
sign up in the built account-only page, return to explicit CLI approval, redeem
once, read status/orders/devices, deny a separate request, log out the browser
while CLI remains valid, then revoke CLI and verify anonymous status. Other
services, transport, database, signer, broker and browser are real. No order,
payment, model inference, VPS or production provider consent is in this first
oracle. First initial integrated attempt is now authorized; preserve failure
stage and exact candidate before any consolidated correction.

CI now extends the existing required customer job with an exact CLI consumer
source pin, packaged CLI build/test and the real CLI/browser oracle. Existing
seven required jobs and all pre-existing steps remain. The qualification scope
adds only this requested consumer; Fleet/Mission Control stay deferred. Existing
scope verifier controls updated to the two-consumer contract and all30 passed.
The new CLI pin is temporarily the baseline and MUST be replaced with the exact
reviewed CLI commit before push; it is not qualification of this candidate.
Private CLI state/logs are excluded from hosted artifact upload, which retains
only bounded JSON evidence. No CI or production release has been dispatched.

### Thin joint initial run: harness corrections and first service failure

All task-owned services started successfully in `identity-customer-joint-39187`,
with metadata artifacts/customer-integration-20260925/joint-fixture.json in the
new Identity worktree. Seven new explicit network ranges240–246 are retained.
The runner container/state are retained, with private paths excluded from CI.
First harness stopped before auth because Playwright's Node request client did
not inherit the fixture CA; NODE_EXTRA_CA_CERTS fixes trust without disabling TLS.
Second run reached the signed-out page but network-idle waiting timed out after
200 HTML/session responses and normal attempted RSC prefetches. The oracle now
waits for DOM load and the actual visible controls instead of network silence.
Failure logs remain joint-initial.log/joint-harness-ca.log. The failure JSON is
now persisted before the optional fixture reset so cleanup cannot erase it.

Frontend's final signup session re-read was rebuilt into immutable local image
sha256: recorded in joint-final-fixture.json and replaced only the two owned
frontend fixture containers. Third run (`joint-navigation`) proved actual Google
signup, explicit approval, one-use CLI exchange and authenticated CLI status,
then failed account inventory with exit3. This is the first real product-boundary
failure, under diagnosis before a consolidated correction. No production/paid
operation occurred. Initial integrated gate remains RED; no full-path success
claim. The independent CA/navigation harness corrections do not count as product
fix iterations but remain in the cumulative ledger.

### Infrastructure stop and recovery decision (2026-09-27 04:46 UTC)

Consolidated integration correction1 is the private Commerce proxy allowlist:
actual same CLI session read devices200 while orders mapped proxy404/non-JSON
into BFF503. The real deployment HAProxy test reproduced missing GET /account/orders
404, then passed both slots with narrowly allowed GET catalog/orders/task detail
and POST orders. Wrong methods/deeper cancel/network remain denied. This packet
is locally GREEN but the full joint retry has not run: host disk exhaustion
blocked fixture proxy recreation. Root interrupted its own pending Docker call;
the in-memory retry procedure did not start the browser. The copied proxy file
is updated but loaded container state must be reconciled after Docker recovery.
One consolidated integration correction of two is consumed; one remains.

First full Identity qualification preserved448 passed/1 skipped, customer
coverage1261/1352=93.2692%, branches422/486=86.8313%. The no-skip migration setup
and meaningful malformed-token/session-state branches were consolidated into
the existing real ASGI/Postgres journey. Focused revised module coverage is
218/225=96.8889% statements and69/76=90.7895% branches, with7 CLI cases passed;
populated migration1, preflight33 and complete fast gate passed. Aggregate full
qualification remains unverified. Its rerun failed before tests with BuildKit
metadata database I/O errors, not a product assertion. Old skipped/coverage
failure and subsequent infra failure remain preserved. No floors changed.

Host Data filesystem was read-only verified100% full,51–54MiB free. Docker's
77GiB sparse data file and shared15GiB caches were inventoried without deletion.
No prune, volume removal, production mutation or new provider call occurred.
The task's966MiB worktree/dependencies and all evidence remain. Pending disk
recovery request is exactly ~/Library/Caches/Homebrew (~2GiB), Yarn (~2.3GiB),
and go-build (~1.6GiB), regenerable shared caches; user may authorize these exact
deletions as an infrastructure-recovery exception or free space themselves.
Execution-skill cleanup consent remains required; no reply is not authorization.

Current verified user-visible boundary: packaged models reads real public
catalog;159 package tests pass; real Google signup, explicit CLI approval,
one-use exchange and CLI status pass. Inventory correction is locally proven
but joint integration remains RED/unverified. No final review, commits, PRs,
CI dispatch, deployment or npm publication occurred. P1 stays in progress with
an infrastructure blocker; P2 has not begun. Cancelled old heartbeat stays
cancelled. After space recovery: reconcile Docker health/owned proxy, run the
expanded thin journey (both providers/returning/read-only/concurrent refresh),
then deterministic unpaid Commerce prepare/ownership fixture, final gates and
one independent integrated review. Do not bypass gates or manufacture live proof.

### Ledger correction at infrastructure checkpoint

The earlier separation of harness corrections from the integrated failed-run
allowance was too permissive. Under execution-protocol section7, harness/fixture
failures consume the same failed-run budget. Preserve the actual cumulative
sequence: attempt1 CA trust failure; attempt2 browser navigation wait timeout;
attempt3 inventory/private proxy failure; attempt4 proxy-reload preparation
interrupted on disk/Docker failure before browser execution. There were three
completed unexpected failed integrated executions plus one interrupted setup,
not merely one product failure. Product correction1 (private proxy) is locally
verified; this does not reset the aggregate ledger or establish joint success.
The original manager-set initial-plus-two-rerun allowance is exhausted. No
further integrated retry is authorized by the previous “one remains” statement.

After disk recovery, root must freeze a revised bounded integration packet that
addresses the newly evidenced fixture boundary gaps together: verified CA for
all native clients, document/control readiness instead of network silence,
loaded exact private proxy routes, real Commerce catalog/readiness fixture for
unpaid preparation, exact current images and migration schema. Any extension
must record its evidence and retain all four attempts, not rename/reset them.
No user-set test ceiling has been exceeded; this is an internal manager budget
and requires a grounded replan, not renewed permission for the implementation.
No such rerun or final review is started while the environment is unavailable.

### Explicit cache recovery authorization and result (2026-09-27 12:06 UTC)

User replied “Yes delete it” to the exact three-cache request. Root deleted only
/Users/jokubo/Library/Caches/Homebrew, /Users/jokubo/Library/Caches/Yarn and
/Users/jokubo/Library/Caches/go-build. Initial Homebrew removal hit normal Go
module read-only directory permissions; root restored owner directory write
permissions only within those approved cache trees and completed deletion.
All three paths were verified absent; Data free space is now7.0GiB. No source,
worktree, evidence, Docker image/volume or VPS data was deleted. Receipt is
artifacts/cli-account-20260927/cache-cleanup-20260927.json.

Docker did not recover automatically: read-only server version and owned
container inventory each timed out after15 seconds. Root is investigating the
stalled local daemon before any integration retry or build. No acceptance gate
has been promoted and the cumulative ledger remains unchanged.

### Recovery replan revision4 (2026-09-27 12:20 UTC)

Cache cleanup and supported Docker recovery restored server27.4.0. All three
candidate application image IDs match joint-final-fixture.json. Persistent
Identity and Commerce databases retained cli1_customer_cli_sessions and
0071_team_action_response respectively. OpenBao retained initialized Raft state;
root unsealed only the owned fixture using its retained private key. Its expired
one-hour adapter authority was replaced under the same fixture-only policy and
period, stored privately, with no production authority touched. Docker data and
all failed evidence are retained. The CLI Desktop start briefly ran then exited
for an unproven reason; LaunchServices open persisted. No reset/prune occurred.
Receipt: artifacts/cli-account-20260927/docker-recovery-20260927.json.

The original fixture was specified for authentication/read-only inventory and
could not satisfy the newly inspected unpaid-order discovery boundary: catalog
was absent and purchasingReady false. This is a fixture contract gap across the
remaining journey, not permission to bypass a product gate. Revision4 freezes
all uncovered boundaries together before another joint execution:

1. Trust the fixture CA in the browser, Python and native Node/Playwright request
   clients; native TLS verification stays on. Use document load plus required
   controls as browser readiness, not unrelated RSC network silence.
2. Reconcile every running image to the sealed candidate; inspect database
   revisions and actual loaded HAProxy exact method/path routes. No test may
   silently substitute the backend for the public bearer gateway.
3. Preserve the restarted signing key and reestablish fixture-only authority;
   probe readiness and discovery before user/device mutations. Expected restart
   recovery is environment setup, not successful authentication evidence.
4. Freeze a guarded Commerce DB readiness fixture from the existing backend
   provider/pricing helpers and exact nonsecret x402 contract. It supplies only
   cached inventory/worker/dependency observations, makes no provider/payment
   calls, and explicitly does not prove live provider/worker/payment readiness.
   Its bounded refresh process may run for at most15 minutes to cover real
   browser login; only this project's commerce-db is permitted. Runtime flags
   remain off. Use the actual catalog, pricing, SSH validation, unpaid prepare,
   ownership, idempotency and persisted task/account tables behind real mTLS.
5. Expanded oracle uses the unpacked candidate CLI: both providers, explicit
   grant/deny, returning read-only session, parallel refresh, browser-vs-CLI
   revocation, inventory; unpaid account prepare/replay/cross-owner refusal,
   legacy mode separation, and valid team input denied by actual readiness.
   No payment, provision, runtime start or external inference is allowed.

Manager decision: the changed fixture contract and verified environment recovery
justify exactly TWO additional integrated executions (first revised journey,
then at most one consolidated correction or review-remediation rerun). Preserve
three previous completed failures and one interrupted setup: maximum cumulative
completed joint executions is now5, interrupted setups remain separately1.
Harness/product failures both consume the two new executions; no uncounted
transient retries remain. One integrated final review only after green; its
remediation consumes the same allowance. If exhausted or a new uncovered
boundary invalidates this plan, stop and report; do not relabel and continue.
Full Identity qualification may run once on current code after environment
preflight and at most once more for a concrete consolidated correction/review
finding; previous skipped/coverage and BuildKit failures stay preserved. Other
unaffected broad green suites are reused. No user-set ceiling is changed.
Next time checkpoint is60 minutes after this revision. No production/CI/live
mutation is authorized by this local retry budget. P1 remains in_progress and
P2 pending; no review, commit or publication is claimed.

### Revision4 readiness admission result

Native runtime inspection found the backend image intentionally excludes tests,
so the readiness-only service mounts the exact consumer backend/tests directory
read-only; no product image changed. Source dependencies are runtime libraries.
The actual guarded readiness preflight then failed before seed writes or new
customer authentication: the real migration creates the default provider account
without credentials. The helper incorrectly classified that supported initial
state as a partial configuration. Read-only SQL confirmed exactly that account
and zero config versions. Evidence commerce-readiness-preflight.log and retained
customer-cli-readiness-preflight-39187 container in the Identity worktree.

This fixture admission failure consumes revision4 execution1. Cumulative failed
executions now4 plus interrupted setup1; exactly ONE combined corrected
admission/joint execution remains. The specialist is correcting only fixture
configuration creation for the existing migrated account, preserving its row,
and inspecting adjacent readiness assumptions before execution. No auth/order
attempt or product code change occurred. A further failed combined execution
must stop; it is not permission for another symptom-by-symptom replan.

### Final revision4 combined execution admitted

At 2026-09-27T12:28:09.012610+00:00, source/runtime, TLS, restored schemas, loaded exact proxy, fixture contract and bounded readiness refresh have been inspected together. Fast gate now passes207 formatted files, Ruff,28-file typing, contracts, architecture and two-consumer scope. Preserved preceding static failures: missing uv on non-login PATH, and one helper import blank-line order; corrected without behavior change. The real readiness fixture correction is included. Starting cumulative execution5 (revision4 execution2), the last permitted combined fixture admission/browser/CLI journey. No further integrated retry remains under this packet. Exact inputs: Identity artifacts/cli-account-20260927/joint-recovery-fixture.json.

### Revision4 standalone Identity qualification

First resumed full run preserved450 passed/1 failed: invoking Alembic inside the
new real migration test disabled the audit logger through default fileConfig,
so the later real structured audit assertion received no event. The focused
migration-then-audit sequence reproduced RED1passed/1failed; the narrow migration
environment correction preserves existing loggers with
fileConfig(..., disable_existing_loggers=False), and focused GREEN2/2 passed.
The single allowed correction/full rerun passed451 tests, zero skips/failures,
backup/restore, populated upgrade/downgrade/re-upgrade and no Alembic drift.
Core96.2617% statements/89.7196% branches; customer95.2663%/90.1235% with unchanged
floors. No full qualification rerun allowance remains. Both directories are
retained: Identity artifacts/identity-r4-qualification-20260927 and
identity-r4-qualification-correction-20260927. Root inspected qualification.json
and resource-manifest.json; source snapshot and exact retained image are in them.
The stale standalone tmpfs database was recreated only in its existing isolated
project, without a new image/network or touching joint fixture39187.

This migration logging-only correction does not change API runtime or schema;
the retained joint application images still exactly match all src modules.
The current migration environment is proven by the separate mounted-source
qualification above. Future CI must rebuild and qualify the complete exact
commits before any release. Full fast gate is now green after root finalized
harness inputs; the specialist's concurrent format failure is retained.

### Revision4 final combined result — blocked

The corrected Commerce readiness fixture successfully seeded/validated all four
catalog plans and its synthetic cached observations without any provider or
payment request. The combined browser runner then exited before customer login
or order preparation: new cli_orders.py imports psycopg, but the sealed historical
browser image installs only Playwright and lacks that database driver. This is
a missed test-image dependency, not a product auth failure or a passing journey.
Evidence: Identity artifacts/cli-account-20260927/joint-recovery-combined.log and
joint-recovery-combined/{runner.json,readiness.log,blocked.json}. Both owned
runner/readiness containers are stopped and retained. No new customer account,
prepared order, payment or VPS was created in this execution.

Cumulative joint usage is FIVE failed executions plus ONE interrupted setup;
revision4 allowance is exhausted. Root stops retries and leaves P1 blocked/P2
pending, with no final review, commits, PRs, CI dispatch or publication. No
heartbeat was recreated. The exact next correction is adding psycopg[binary]
3.3.4 (the existing uv.lock version) to the test browser Dockerfile, validating
its full import/native-tool dependency closure and rebuilding the sealed test
image before the same frozen oracle. That correction/retry is NOT performed
under an exhausted packet, and no additional budget is invented here. The
separate451-test Identity and159-test CLI package results remain valid within
their stated scope; they do not establish integrated CLI production readiness.

### Revision5 owner-authorized completion and publication

2026-09-27T13:40:14.574430+00:00: owner explicitly requested “finish the test and fix and publish”. This resumes the previously stopped packet and explicitly authorizes qualified repository releases and npm publication. Historical five failed integrated executions plus one interrupted setup remain retained; no counter is reset. The missing browser psycopg dependency is confirmed by actual image capability inventory; ssh-keygen, CA tooling, Playwright and bundled Node are present. Only psycopg[binary]==3.3.4 (matching uv.lock) is newly required by cli_orders; unused cryptography/httpx are not added.

Implementation authorized: yes. Root owns image dependency correction, joint integration and serial release. Manager-set additional allowance under renewed owner authority: first corrected integrated execution plus two consolidated recovery executions and one reserved review-remediation execution (four additional, cumulative maximum9 completed joint executions plus retained setup1). Any genuine code fix requires focused E2E RED before mutation. A new missing boundary must be investigated together with adjacent boundaries before any retry; no gate weakening. Existing full Identity451-test and CLI159-test proofs are reused unless changed code invalidates them. One fresh integrated final review after green; at most one remediation set, no second review. Hosted required gates remain mandatory for exact committed heads; allow at most two evidenced correction batches for genuine CI failures. No duplicate release dispatch or overlapping VPS rollout. Read-only live acceptance gets an initial execution per new release and at most one evidenced correction/recheck; actual provider consent requires available real login and is never fabricated.

Time checkpoint60 minutes from resumption. Previous deployment-check heartbeat stays deleted. No card charge, paid order, VPS, inference, runtime enablement or unrelated cleanup. Release order: qualified Identity with customer CLI switch disabled, frontend gateway/approval release and live checks, controlled customer CLI activation and live protocol/browser acceptance, then CLI npm publication; exact sequence/automation mechanics will be verified against current workflows. Models use existing public catalog without requalification. Plan/API/docs and tests must agree before commits and PRs. Source pins are replaced with exact owned source commits before push. A read-only release logistics worker may inspect workflows/current remotes while root performs the local joint gate; it may not mutate or conduct the final review.

Revision5 execution1 / cumulative6 admitted at 2026-09-27T13:41:26.053682+00:00. New test image includes pinned psycopg3.3.4; actual imports/native-tool/bundled-Node smoke passed. Read-only existing DB columns match the assertion schema; actual Identity readiness200. Exact browser image sha256:8f6e97e41abec5b7aff068ee5c07e112b6373df9ac7575b125a4157b85f9a9e4. Retain old image and capability-probe containers.

### Revision5 execution1 result and bounded correction

Combined execution1/cumulative6 failed after real Google account creation, explicit CLI approval, verified contact/session and empty account inventory passed. The unpaid team gate failed its expected-error assertion. A focused packaged CLI `health --base-url http://backend-blue:8000 --json` reproduced exit2: HTTPS is required except localhost. This proves a fixture-origin contract defect before an order request; the CLI transport restriction is correct. Preserve joint-revision5-first log/provider evidence and containers. Three integrated executions remain, including one reserved final-review remediation.

Root corrects only the isolated public TLS proxy to expose exact GET /health, GET /catalog and POST /orders on the existing certificate-covered warpmetal.com fixture host, pointing to real Commerce. CLI discovery and legacy unpaid prepare then use normal trusted HTTPS; account bearer requests still traverse the distinct /account/cli mTLS gateway. No TLS bypass, real-provider calls or payment routes. Existing application images and packaged CLI are unchanged. The helper's remaining output/state/DB contracts are inspected together before the next combined run. Read-only worker diagnosis is a failed-harness inspection, not the final review.

Revision5 consolidated correction also includes one actual CLI interoperability defect found by adjacent-boundary inspection: the BFF emits documented RFC problem+json top-level code, but CLI safeGatewayCode reads only nested error.code. Existing account-orders subprocess journey now uses the actual envelope and asserts a foreign-task404 is not_found with no raw private detail; RED reproduced unavailable vs not_found (revision5-gateway-problem-red.log). Root accepts this RED and authorizes the narrow decoder correction; transport/ownership/auth policies remain unchanged. One focused correction and the next combined execution cover both fixes. CLI package is resealed after the decoder change; Identity/frontend app images remain identical. Required full CLI suite will run for this shared gateway change.

Revision5 shared gateway regression GREEN passed1/1. Full CLI gate then preserved158pass/1fail: existing release-coherence test still hardcodes0.8.13 although candidate package/lock/version/skill target0.9.0. This release metadata assertion is updated to the already authorized0.9.0 target (all five exact coherence checks retained), not skipped or weakened. No other tests failed. Identity current fast gate passes207 formatted/Ruff/28-file strict typing/contracts/architecture/scope. Focused actual TLS CLI discovery passed after readiness initialization; an immediate pre-initialization false health response is retained separately as fixture timing, not a product defect or additional integrated run.

Revision5 execution2 / cumulative7 admitted at 2026-09-27T13:52:04.200689+00:00. Frozen combined oracle retained. Correction includes trusted fixture TLS, RFC problem-code parsing (focused RED/GREEN), exact release-coherence test0.9.0 and private failure diagnostics. Adjacent output/state/DB contracts inspected together. Packaged CLI SHA256 5379133fa9ae98f9a2377946b78f56bfd7c2164e75bb0dde241bdda34bb1ec5b; all app/browser image IDs unchanged. Two executions remain after this admission, one reserved final review remediation.

### Revision5 execution2 result: legacy warning oracle mismatch

Cumulative7 failed at the legacy-control assertion, after Google account login, team readiness denial, real unpaid account prepare, persistent account/order/server/intent/key invariants and exact idempotent replay all passed. The helper searched all serialized output for the literal word ownerToken. The unchanged production legacy response has a safe warning sentence “Save ownerToken offline now”, so this is not evidence that a secret leaked. Backend routes.py1718–1722 and CLI safePreparedOrder prove the warning is retained while the token property is omitted. Private legacy state is present from the actual successful unpaid prepare. Preserve joint-revision5-correction, its state and all rows.

Oracle clarification under existing finish/fix authority: require no ownerToken property at any JSON depth AND verify the actual saved secret value is absent from stdout, while preserving the existing warning. This strengthens the real confidentiality check instead of changing the required legacy behavior. No product code changes. First exercise exact replay of that retained legacy order with this corrected assertion, then one remaining pre-review combined execution. Two integrated executions remain, with the last reserved for single final-review remediation. No paid/provisioned order or runtime action exists.

Revision5 execution3 / cumulative8 admitted at 2026-09-27T13:54:17.777145+00:00. Exact retained legacy replay GREEN confirms no token field or actual token value in output, with unchanged legacy warning. Entire frozen Google/GitHub/account/legacy/refresh/denial oracle runs now. One integrated execution remains reserved for final-review remediation; no unqualified new budget is granted. Frontend vendored Identity OpenAPI snapshot/hash is synchronized to current candidate; source commit pins remain explicitly pending until final review and commit sequence.

Release logistics read-only preflight confirms unchanged remote mains and npm0.8.13; v0.9.0 is unused. CLI publish is tag-triggered with npm OIDC and required Node20/22 CI; no main auto-publication. Identity/frontend main workflows automatically deploy after qualification, so merges must be serial. API source commit A precedes frontend source/pin commit B; final Identity pin commit C names B plus exact CLI commit. Local placeholders must never be pushed as qualified pins. Normal Identity release with customerCLI absent/false precedes frontend release; after independent checks activate only customerCLI on the same Identity image via preflight and API/worker Compose recreation. Do not run full deploy.sh for this toggle: it includes migrations, DB dumps and signer initialization. Env absence is accepted as false by preflight; activation preserves all other bytes, rejects duplicates, retains a root-only backup and has exact flag rollback. Deployment docs now specify this sequence. The existing Identity live helper expects disabled discovery, so run it before activation; use separate redacted flag-on smoke. No real provider consent is implied by public pending/slow_down proof.

### Revision5 integrated gate GREEN; one final review admitted

Root inspected joint-revision5-final/cli-browser.json: both Google and GitHub passed fresh account-first signup, explicit device approve/deny, one-use exchange, verified contact, real account inventory, real unpaid account prepare and exact replay, durable AccountOrder/AccountServer/consumed intent/key records, cross-owner404 for the existing Google task under GitHub, real legacy unpaid mode separation, unchanged team runtime denial, independent browser/CLI logout, returning read-only session and three-process serialized refresh. Zero payment attempts, provisioned VPS or runtime state. External providers and cached readiness are explicit fixtures; no production consent claim. Exact packaged CLI SHA5379133fa9ae98f9a2377946b78f56bfd7c2164e75bb0dde241bdda34bb1ec5b; application image IDs in joint-revision5-final-fixture.json.

Cumulative integrated usage8 completed executions (seven failures, latest pass), plus interrupted setup1; only one reserved integrated review-remediation execution remains. Local Identity451-test qualification and current full fast gate stand. CLI full gate158/159 plus focused2/2 release-version correction proves all159 cases; the exact CI/publication workflows must still run their complete package gate. Frontend prior actual58 BFF tests/24 PostgreSQL cases/build/lint remain applicable; changed vendored OpenAPI is exact current source with hash, immutable source pin finalized before push.

Admit exactly one fresh read-only integrated final review across all three candidates using gpt-5.6-sol high, selected for cross-component auth/persistence/release risk. No children, edits or exploratory test loop. Root retains plan/commit/pin/publication ownership; reviewer returns one consolidated actionable set with regression oracles. At most one accepted remediation set, no second review. P1 stays in_progress until review/remediation completed; P2 pending.

Pre-release live-probe preparation: /tmp/warpmetal-customer-cli-live-protocol.py is syntax-checked only and has not contacted production. It asserts enabled metadata/readiness, public approval page, anonymous+invalid-bearer401, closed client/scope/duplicate/extra forms, one anonymous cli:read device start and pending/slow_down/invalid-code failures, retaining no codes/tokens. It reports that provider consent/token issuance are not proven. Mac native availability remains locked on fresh discovery; Google password reauth tab still exists. No OAuth attempt, Google token retry or canceled-heartbeat recreation occurred. Real provider consent remains an explicit live limitation; it is not fabricated from fixture or read-only page success.

### Single final review: consolidated remediation decision

Fresh reviewer returned FAIL with four concrete findings, all accepted by root:
R1 high: an approved/unredeemed device grant can create a CLI family after global logout/password reset because the approving browser family is not revalidated active/unexpired during redemption.
R2 medium: Identity invalid_customer_authorization401 maps to BFF503 instead of public401 invalid_token.
R3 medium: the frozen separate short-user-code attempt limit is absent on the private begin route.
R4 medium: Commerce registration-intent idempotency409 is collapsed to BFF503.

One consolidated remediation set is authorized. Each behavior must be reproduced RED across its real affected boundary before production edits. Identity owner handles R1/R3 and existing ASGI/Postgres cases; root handles R2/R4 and existing built/BFF/Commerce journey assertions. Identity and frontend writes are disjoint. No second review, scope expansion or test weakening. Full Identity qualification may be rerun once because R1/R3 invalidate the previous runtime proof, with affected frontend checks/build and one reserved combined execution9. Local focused RED/GREEN is bounded by these four findings and the revision5 time checkpoint; no additional integrated budget is created. Publication stays blocked until the consolidated gate passes. The actual review reported gpt-6-sol high despite requested gpt-5.6-sol routing; it remained a fresh independent read-only lineage.

### Final remediation R2/R4 RED accepted

The retained real BFF/Identity/Commerce/Postgres fixture reproduced invalid CLI bearer503 identity_unavailable and changed-body idempotent replay inventory_unavailable, while task count and original task remained unchanged. Evidence: Identity artifacts/cli-final-remediation-20260927/frontend-boundary-red.log; exact probe /tmp/customer-cli-final-boundary-probe.py and retained customer-cli-final-boundary-red container. Root accepts this as the test-first checkpoint and now authorizes only the bounded cli_authorize invalid-customer-token mapping and typed registration-intent idempotency conflict propagation for the CLI prepare route. Existing old checkout behavior and private transport failures remain unchanged. Existing combined CLI journey was extended before product edits to assert both regressions. This is focused review RED, not another integrated gate; cumulative8 plus interrupted1 remains, one final integrated execution reserved.

### Final remediation R1/R3 RED accepted

Root inspected r1-r3-red.md: four real ASGI/PostgreSQL cases failed as expected before product edits. Approved device codes still minted CLI authority after actual logout-all, actual password reset and browser-family expiry; user-code guesses returned400 instead of429. Agent now authorized to revalidate active/unexpired customer web family and serialize redemption/global revocation without introducing family/principal lock inversion, plus durable client+trusted-principal user-code limiter using existing10/min setting. Focused green then one full Identity qualification are required; earlier451 proof is invalidated by these runtime changes. Root extended the existing joint journey with actual BFF429/Retry-After and next-window recovery/denial. No second review; the single remaining integrated gate is unchanged.

Focused frontend remediation GREEN admission initially stopped after the readiness helper gave no seed output within20 seconds. The process was not OOM-killed; the runner then stopped it (137). No regression request or order mutation was executed. New image4c1258a7 was already healthy in both slots. A bounded unchanged-helper startup diagnostic observed actual successful seed after10.24 seconds, with zero provider/payment calls; cold-start/scheduling delay remains the limited explanation, not a product success claim. Preserve stopped container and readiness-startup-diagnostic.json. Continue the focused real-boundary probe once using this now-admitted helper; no source/runtime retry or new integrated allowance.

Final remediation focused GREEN inspected: real gateway invalid bearer401 invalid_token; changed-body replay409 surfaced by packaged CLI as idempotency_conflict; task count/original task unchanged. Both frontend slots run4c1258a7; production build passes, lint0errors15existingwarnings,11 affected existing tests pass (two optional local-Identity suites were skipped and are replaced in scope by actual joint proof, not claimed passed). Identity realASGI/Postgres four review regressions and33 affected lifecycle cases pass. Full Identity qualification is running once; new runtime image8c2188ed is built. Root full fast gate first retained a two-helper format failure, then formatting-only correction passes207 files/Ruff/28-file strict typing/contracts/architecture/scope. Consumer API snapshot/hash resynchronized to a0ef8d034426eaffa78922a7d70c402040e58d719e43dd6360baf540ef40e1f4; immutable source pins still pending commit sequence. No second review.

The single full Identity final-remediation qualification attempt failed450pass/5readiness-metrics tests because the agent restarted the retained tmpfs PostgreSQL but omitted Alembic admission. Root independently inspected seven PostgreSQL errors: missing alembic_version. This invalidates environment qualification, not the customer code or gates. Preserve full failed attempt1. Exact snapshot migration/current-head admission and focused five-case recovery are authorized before considering a full rerun; no source mutation/unchanged blind retry. Adjacent admission now includes isolated DSN, correct cli1 revision, source hash identity and writable backup/evidence paths.

Separately, bounded Commerce helper cold-start admission is increased from20 to60 seconds after the recorded fresh-start timeout and unchanged successful10.24-second diagnostic. The required actual seed JSON and all product/time-limit assertions stay intact; this only gives the fixture process a bounded startup window under the shared Docker host. This harness correction is included before the one final integrated run; no new run allowance or product change.

Final integrated remediation execution9 admitted at 2026-09-27T14:31:57.800661+00:00. Required focused R1–R4 regressions, affected lifecycle/static/build gates are green; candidate inputs/package hash reconcile. Standalone qualification environment recovery is a separate pending gate and cannot be bypassed by this run. This is the only remaining integrated execution: cumulative9 admitted plus interrupted setup1; zero further integrated retries remain. Identity8c2188ed/frontend4c1258a7/backendb6dfd906; original fixture signing key retained and readiness passed. Both provider account/order/legacy/refresh/revocation/idempotency and real code-attempt rate/recovery journeys run against the final candidate. No production/provider/payment action.

Manager replan of standalone qualification admission (scope remains final review remediation): focused tests had created ORM tables without Alembic state, so attempting upgrade in that DB correctly failed DuplicateTable. Preserve this additional harness preflight failure. Agent created only task-owned identity_cli_final_remediation DB in the existing isolated PG, ran actual exact-snapshot migrations, verified cli1 head, source hashes, writable output and tools. Root independently inspected all5 prior failures now passing5/5 on that DSN. This demonstrates the missing migration-admission boundary and corrects it together with adjacent schema/output/tool assumptions; no product mutation or oracle change. Under existing owner finish/fix/publish authority, manager authorizes ONE corrected full local qualification (cumulative final-remediation full attempt2, first failed environment preserved), with zero further local full retries. Exact DSN must be used by all qualification/backup checks. This explicit environment replan does not increase the integrated9-run ceiling or authorize a second review.

### Standalone local qualification budget exhausted; unchanged oracle moves to required CI

The corrected full container collected zero tests: pytest-cov attempted to erase /app/.coverage in the read-only snapshot, while only /app/artifacts was writable. Preserve cli-final-remediation-full-qualification-corrected and the admission error. This is a second setup failure and consumes the final local correction; STOP all local complete-suite retries. Source, migrated isolated DB and focused33+5 results remain unchanged. No local full green is claimed.

Manager changes gate placement within existing owner publication authority: submission of exact candidate PRs is moved into P1 qualification, so the already-required hosted Identity qualification job executes the identical complete suite, coverage floors, migration and backup gates in its standard writable runner. This is the planned mandatory hosted execution, not a replacement oracle, extra local retry or a new failure budget. The final joint local primary journey must first pass. P1 remains in_progress until hosted full qualification and all exact joint/frontend/CLI checks actually pass; P2 serial merges/deploy/activation/npm stays pending. No gate is bypassed and the existing maximum2 genuine hosted correction batches is unchanged. This resolves the repeated local snapshot admission failures by using the normal release environment rather than extending local retries again. One final review only; all4 accepted review changes already have actual focused GREEN.

### Final integrated remediation GREEN; hosted qualification handoff

Root inspected final joint/cli-browser.json: both Google/GitHub passed the full packaged CLI/browser/service/DB journey, including all accepted R2/R4 regressions, actual durable code-attempt429/Retry-After/next-window recovery, revoked bearer401, explicitapprove/deny, account order persistence/replay/conflict, foreign404, legacy separation and concurrent refresh. Zero payment/provision/runtime action. External providers and cached readiness remain explicit fixtures; production consent false. Cumulative integrated executions9 complete:7failed+2passed, plus interrupted1. No integrated retries remain, no second review. Local full Identity qualification remains unqualified due preserved admission failures; exact hosted complete qualification is the remaining P1 exit gate.

Identity source commitA9654809831033c9bde00d709f3f680d93934220b and frontend sourceB28540387add438ffa452f1b746f7bd89394cf515 are committed locally. Frontend pins exactA with API hash a0ef8d034426eaffa78922a7d70c402040e58d719e43dd6360baf540ef40e1f4. The CLI source commit and final Identity consumer-pin commit follow before any push/PR. Normal required exact CI must pass before serial Identity-disabled rollout, frontend rollout, same-image CLI activation and npm0.9.0 publication.
