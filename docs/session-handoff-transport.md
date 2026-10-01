# Exact managed-session handoff transport

Status: bounded transport implementation complete locally on 2026-09-27. Domain CLI dispatch and live native proof remain separate gates.

The reusable Agent Kit boundary is:

```js
openSessionHandoff(descriptor, {
  connectionFile,
  identityPath,
  context,
  clientPath,
}) -> Promise<number>
```

`descriptor` is the complete backend `AgentSessionHandoffEnvelope`. The function returns the local native client's numeric exit code. It throws a `CliError` with a closed `session_handoff_*` code when validation, SSH, framing, handshake, or relay setup fails. `connectionFile` and `identityPath` are explicit first-release prerequisites. `clientPath` defaults to `opencode`. `context` supplies bounded clock/environment/process seams for the real child-process journey; production defaults use the current clock, process environment, Node child processes, and cryptographic randomness.

The domain CLI owns API lookup and command dispatch. Its JSON mode validates and prints the fresh backend descriptor without calling this function, starting SSH, or claiming a native attachment. A successful `HELLO_ACK` proves only that the bridge accepted the exact target. The connector does not claim that the native TUI rendered or attached to the conversation.

## Validation and transport

The connector accepts only the closed v1 envelope with `capability: exact_session`, `reason: null`, all three required access booleans true, `transport: wm-team-control/1`, and a non-null closed handoff target. The target must be fresh at the local clock and its issuance window must be no longer than 120 seconds. Its server and sandbox IDs must exactly match the version-1 sandbox connection profile. Unknown fields, raw path/URL/credential overrides, malformed IDs, invalid revisions, mixed task/Work shapes, expired descriptors, and profile mismatches fail before SSH starts.

The sandbox identity must be an explicit regular private file. The connector never reads or exports its contents. It writes a private temporary `known_hosts` file from the validated connection profile and executes only:

```text
ssh -T -i <identity> \
  -F <private empty config> \
  -o BatchMode=yes -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=<private temporary file> \
  -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no \
  -o PermitLocalCommand=no -o RequestTTY=no \
  -o ControlMaster=no -o ProxyCommand=none -o ProxyJump=none \
  -p <profile port> warpmetal-sandbox@<profile host> \
  warpmetal-team-control
```

There is no shell, arbitrary remote command, PTY fallback, management identity, agent forwarding, X11 forwarding, or SSH port forwarding.

The first frame is the bounded `wm-team-control/1` `HELLO`:

```json
{"v":1,"protocol":"wm-team-control/1","handoff":"<exact descriptor.handoff>"}
```

No local native client starts until a bounded-time `HELLO_ACK` repeats the protocol and exact handoff receipt/target byte-equivalently as parsed JSON. The acknowledgement's box identity must also repeat the target server, sandbox, sandbox generation and instance; its host-key fingerprint must be one of the explicit profile pins. Runtime derives the private bridge grant ID as `"grt_" + sha256(profile.grantId + NUL + handoffId)[0:24 hex]`; the connector independently derives and requires that exact value, preserving the distinction between the public `grant_*` access-grant ID and the private `grt_*` bridge grant. The acknowledgement's engine fields are advisory and are never used to open a direct connection. A changed target, box, derived grant, host key, missing receipt, error, close, malformed frame, oversized frame, EOF, timeout, or SSH exit fails without launching OpenCode.

## Local native client

After the exact acknowledgement, the connector binds one ephemeral HTTP server to `127.0.0.1`. It generates a process-local password, requires HTTP Basic `opencode:<password>` on every request, removes that credential before framing, and passes it only to the owned native child as `OPENCODE_PASSWORD`. This is the pinned 2.0.14 client-side credential variable; `OPENCODE_SERVER_PASSWORD` is for the server and is removed from the local client environment. WarpMetal owner/access tokens and credential variables are also removed. It sets `OPENCODE_DISABLE_AUTOUPDATE=1` and launches exactly:

```text
opencode --server http://127.0.0.1:<ephemeral-port> \
  --session <descriptor.handoff.source.nativeSessionId>
```

It adds no project path, prompt, continue, role, agent, provider, standalone, or model argument. The bridge owns native service authentication; neither native credentials nor the local relay password cross SSH.

The relay supports bounded HTTP and SSE over request, response-head, data, end, cancel, ping/pong, error, and close frames. It rejects upgrades, non-loopback Host/Origin values, bodies over 1 MiB, more than 32 in-flight requests, response frames over 8 MiB, and unrecognized frames. Manager-review mutation remains denied by the trusted sandbox bridge; the connector preserves the bridge's `team_helper_manager_review_read_only` refusal as an HTTP 403. Ordinary worker owner input can pass only as an explicit request made by the native client and remains subject to the bridge's exact-session revalidation. Opening itself emits no prompt or session creation request.

When the native client exits, the connector sends one close frame, closes its relay, ends the owned SSH process, removes temporary host pins, clears its local password reference, and returns the client exit code. SSH loss tears down only connector-owned processes. It never stops or restarts the managed service or worker.

## Test boundary

`test/session-handoff-e2e.test.js` uses the unchanged backend fixture at `test/fixtures/agent-session-handoff-v1.backend-wire.fixture.json` (SHA-256 `75934b615896344032bc50157756264030bae87be5de6ceafd299d95f703aa56`). It starts actual fake SSH and native-client child processes plus the connector's real loopback HTTP/SSE listener. The journey proves exact HELLO/ACK order, strict SSH arguments and host pins, local Basic authentication, credential stripping, exact native arguments, GET/SSE transport, zero open-time prompt/create requests, pre-SSH target refusals, changed protocol/target/box/derived-grant/host-key refusal before client launch, bridge-loss cleanup, and manager-review mutation refusal.
