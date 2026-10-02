import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  connectionProfile,
  writeConnectionProfile,
} from "../src/connection.js";
import { openSessionHandoff } from "../src/session-handoff.js";

const WIRE = JSON.parse(
  await readFile(
    new URL("./fixtures/agent-session-handoff-v1.backend-wire.fixture.json", import.meta.url),
    "utf8",
  ),
);
const HOST_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HOST_FINGERPRINT = `SHA256:${createHash("sha256")
  .update(Buffer.from(HOST_PUBLIC_KEY.split(" ")[1], "base64"))
  .digest("base64")
  .replace(/=+$/, "")}`;

const FAKE_SSH = String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
const log = (value) => appendFileSync(process.env.WM_HANDOFF_TEST_LOG, JSON.stringify(value) + "\n");
let buffered = Buffer.alloc(0);
const send = (type, value) => {
  const payload = Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(value))]);
  const head = Buffer.alloc(4); head.writeUInt32BE(payload.length); process.stdout.write(Buffer.concat([head, payload]));
};
const sendData = (id, bytes) => {
  const name = Buffer.from(id); const payload = Buffer.concat([Buffer.from([0x83, name.length]), name, Buffer.from(bytes)]);
  const head = Buffer.alloc(4); head.writeUInt32BE(payload.length); process.stdout.write(Buffer.concat([head, payload]));
};
const consume = () => {
  while (buffered.length >= 4) {
    const size = buffered.readUInt32BE(0); if (buffered.length < 4 + size) return;
    const payload = buffered.subarray(4, 4 + size); buffered = buffered.subarray(4 + size);
    const type = payload[0]; const value = JSON.parse(payload.subarray(1).toString("utf8"));
    if (type === 0x01) {
      log({ event: "hello", argv: process.argv.slice(2), value,
        secretsPresent: Boolean(process.env.OPENCODE_SERVER_PASSWORD || process.env.WARPMETAL_OWNER_TOKEN || process.env.WARPMETAL_ACCESS_TOKEN) });
      const target = value.handoff;
      const acknowledgedTarget = process.env.WM_GATEWAY_MODE === "changed"
        ? { ...target, handoffId: "handoff_changed_target" } : target;
      const expectedGrant = "grt_" + createHash("sha256")
        .update(process.env.WM_PROFILE_GRANT_ID + "\0" + target.handoffId).digest("hex").slice(0, 24);
      send(0x81, {
        v: 1, protocol: process.env.WM_GATEWAY_MODE === "protocol" ? "other/1" : "wm-team-control/1",
        helper: "warpmetal-team-bridge/1",
        box: { serverId: process.env.WM_GATEWAY_MODE === "box" ? "srv_otherbox" : target.identity.serverId,
          sandboxId: target.identity.sandboxId,
          instance: target.identity.instance, generation: target.identity.sandboxGeneration,
          grantId: process.env.WM_GATEWAY_MODE === "grant" ? "grt_000000000000000000000000" : expectedGrant,
          sessionId: "bridge_fixture", hostKeyFingerprint: process.env.WM_HOST_FINGERPRINT,
          expiresAt: "2026-09-27T17:30:00Z" },
        engine: { host: "127.0.0.1", port: 48111 }, limits: { maxInflight: 32 },
        handoff: { formatVersion: 1, action: "open_session", status: "ready",
          capability: "exact_session", handoffId: acknowledgedTarget.handoffId,
          target: acknowledgedTarget },
      });
      log({ event: "hello_ack_sent", handoffId: acknowledgedTarget.handoffId });
      if (process.env.WM_GATEWAY_MODE === "disconnect") setTimeout(() => process.exit(23), 300);
    } else if (type === 0x02) {
      log({ event: "request", method: value.method, path: value.path,
        hasAuthorization: Object.keys(value.headers || {}).some((name) => name.toLowerCase() === "authorization") });
      if (value.method === "POST" && value.path.endsWith("/prompt") && process.env.WM_MANAGER_READ_ONLY === "1") {
        send(0x85, { id: value.id, code: "team_helper_manager_review_read_only",
          message: "manager review handoff is inspection-only" });
        continue;
      }
      const sse = value.path === "/api/event";
      send(0x82, { id: value.id, status: 200,
        headers: { "content-type": sse ? "text/event-stream" : "application/json" } });
      sendData(value.id, sse ? "data: {\"type\":\"server.connected\"}\n\n" : JSON.stringify({ id: value.path.split("/").at(-1) }));
      send(0x84, { id: value.id });
    } else if (type === 0x05) {
      log({ event: "close", reason: value.reason }); process.exit(0);
    }
  }
};
process.stdin.on("data", (chunk) => { buffered = Buffer.concat([buffered, chunk]); consume(); });
process.stdin.on("end", () => process.exit(0));
`;

const FAKE_CLIENT = String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import http from "node:http";
const log = (value) => appendFileSync(process.env.WM_HANDOFF_TEST_LOG, JSON.stringify(value) + "\n");
const args = process.argv.slice(2);
const server = args[args.indexOf("--server") + 1];
const session = args[args.indexOf("--session") + 1];
const request = (path, auth = true, method = "GET", body = undefined) => new Promise((resolve, reject) => {
  const target = new URL(path, server);
  const headers = auth ? { authorization: "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64") } : {};
  if (body) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(body); }
  const req = http.request(target, { method, headers }, (res) => {
    const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});
log({ event: "client_started", args, passwordPresent: Boolean(process.env.OPENCODE_PASSWORD),
  serverPasswordPresent: Boolean(process.env.OPENCODE_SERVER_PASSWORD),
  warpmetalTokenPresent: Boolean(process.env.WARPMETAL_OWNER_TOKEN || process.env.WARPMETAL_ACCESS_TOKEN) });
const unauthorized = await request("/api/session/" + session, false);
const exact = await request("/api/session/" + session);
const events = await request("/api/event");
log({ event: "client_results", unauthorized: unauthorized.status, exact, events });
process.exit(17);
`;

const FAKE_MANAGER_CLIENT = String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import http from "node:http";
const log = (value) => appendFileSync(process.env.WM_HANDOFF_TEST_LOG, JSON.stringify(value) + "\n");
const args = process.argv.slice(2); const server = args[args.indexOf("--server") + 1]; const session = args[args.indexOf("--session") + 1];
const body = JSON.stringify({ parts: [{ type: "text", text: "owner input must stay denied" }] });
const target = new URL("/api/session/" + session + "/prompt", server);
const authorization = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64");
const result = await new Promise((resolve, reject) => {
  const req = http.request(target, { method: "POST", headers: { authorization, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
    const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  }); req.on("error", reject); req.write(body); req.end();
});
log({ event: "manager_result", result });
process.exit(result.status === 403 ? 0 : 19);
`;

const FAKE_HANGING_CLIENT = String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const log = (value) => appendFileSync(process.env.WM_HANDOFF_TEST_LOG, JSON.stringify(value) + "\n");
log({ event: "client_started", args: process.argv.slice(2) });
process.on("SIGTERM", () => { log({ event: "client_terminated" }); process.exit(0); });
setInterval(() => {}, 1000);
`;

async function executable(path, content) {
  await writeFile(path, content, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

function records(content) {
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function fixture(descriptor = WIRE.finding) {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-handoff-e2e-"));
  const bin = join(directory, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  const ssh = join(bin, "ssh");
  const client = join(directory, "opencode-fixture");
  const managerClient = join(directory, "opencode-manager-fixture");
  const hangingClient = join(directory, "opencode-hanging-fixture");
  const connectionFile = join(directory, "connection.json");
  const identityPath = join(directory, "sandbox_ed25519");
  const log = join(directory, "wire.jsonl");
  await executable(ssh, FAKE_SSH);
  await executable(client, FAKE_CLIENT);
  await executable(managerClient, FAKE_MANAGER_CLIENT);
  await executable(hangingClient, FAKE_HANGING_CLIENT);
  await writeFile(identityPath, "fixture private key bytes never read by the connector\n", { mode: 0o600 });
  await writeConnectionProfile(
    connectionFile,
    connectionProfile(
      descriptor.handoff.identity.serverId,
      descriptor.handoff.identity.sandboxId,
      "grant_localfixture",
      { host: "127.0.0.1", port: 2222, username: "warpmetal-sandbox",
        hostKeys: [{ publicKey: HOST_PUBLIC_KEY, fingerprint: HOST_FINGERPRINT }] },
    ),
  );
  return {
    directory, client, managerClient, hangingClient, connectionFile, identityPath, log,
    context: {
      now: () => Date.parse("2026-09-27T17:11:30Z"),
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
        WM_HANDOFF_TEST_LOG: log, WM_PROFILE_GRANT_ID: "grant_localfixture",
        WM_HOST_FINGERPRINT: HOST_FINGERPRINT,
        OPENCODE_SERVER_PASSWORD: "must-not-reach-child",
        WARPMETAL_OWNER_TOKEN: "must-not-reach-child",
        WARPMETAL_ACCESS_TOKEN: "must-not-reach-child" },
      handshakeTimeoutMs: 2_000,
    },
  };
}

test("opens the exact backend-produced session through authenticated loopback HTTP/SSE after HELLO_ACK", async () => {
  const target = structuredClone(WIRE.finding);
  const setup = await fixture(target);
  try {
    const exitCode = await openSessionHandoff(target, {
      connectionFile: setup.connectionFile,
      identityPath: setup.identityPath,
      context: setup.context,
      clientPath: setup.client,
    });
    assert.equal(exitCode, 17);
    const log = records(await readFile(setup.log, "utf8"));
    const hello = log.find((entry) => entry.event === "hello");
    assert.deepEqual(hello.value, { v: 1, protocol: "wm-team-control/1", handoff: target.handoff });
    assert.equal(hello.secretsPresent, false);
    assert.ok(hello.argv.includes("-T"));
    assert.ok(hello.argv.includes("BatchMode=yes"));
    assert.ok(hello.argv.includes("PasswordAuthentication=no"));
    assert.ok(hello.argv.includes("KbdInteractiveAuthentication=no"));
    assert.ok(hello.argv.includes("StrictHostKeyChecking=yes"));
    assert.ok(hello.argv.includes("ClearAllForwardings=yes"));
    assert.ok(hello.argv.includes("ForwardAgent=no"));
    assert.ok(hello.argv.includes("ForwardX11=no"));
    assert.ok(hello.argv.includes("ProxyCommand=none"));
    assert.ok(hello.argv.includes("ProxyJump=none"));
    assert.equal(hello.argv.at(-1), "warpmetal-team-control");
    assert.ok(log.findIndex((entry) => entry.event === "hello_ack_sent") < log.findIndex((entry) => entry.event === "client_started"));
    const client = log.find((entry) => entry.event === "client_started");
    assert.equal(client.args.length, 4);
    assert.equal(client.args[0], "--server");
    assert.match(client.args[1], /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(client.args.slice(2), ["--session", target.handoff.source.nativeSessionId]);
    assert.equal(client.passwordPresent, true);
    assert.equal(client.serverPasswordPresent, false);
    assert.equal(client.warpmetalTokenPresent, false);
    const result = log.find((entry) => entry.event === "client_results");
    assert.equal(result.unauthorized, 401);
    assert.equal(result.exact.status, 200);
    assert.match(result.events.body, /server\.connected/);
    const requests = log.filter((entry) => entry.event === "request");
    assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
      { method: "GET", path: `/api/session/${target.handoff.source.nativeSessionId}` },
      { method: "GET", path: "/api/event" },
    ]);
    assert.ok(requests.every((request) => request.hasAuthorization === false));
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("refuses expired, malformed, private-override, and profile-mismatched targets before SSH", async () => {
  const setup = await fixture(WIRE.finding);
  try {
    const cases = [
      ["expired", structuredClone(WIRE.finding), { ...setup.context, now: () => Date.parse("2026-09-27T17:13:00Z") }],
      ["private override", { ...structuredClone(WIRE.finding), privatePath: "/tmp/escape" }, setup.context],
      ["transport", { ...structuredClone(WIRE.finding), access: { ...WIRE.finding.access, transport: "ssh-pty" } }, setup.context],
    ];
    for (const [name, descriptor, context] of cases) {
      await assert.rejects(
        openSessionHandoff(descriptor, { connectionFile: setup.connectionFile,
          identityPath: setup.identityPath, context, clientPath: setup.client }),
        (error) => typeof error?.code === "string" && error.code.startsWith("session_handoff_"),
        name,
      );
    }
    const otherProfile = join(setup.directory, "other.json");
    await writeConnectionProfile(otherProfile, connectionProfile(
      "srv_otherfixture", WIRE.finding.handoff.identity.sandboxId, "grant_localfixture",
      { host: "127.0.0.1", port: 2222, username: "warpmetal-sandbox",
        hostKeys: [{ publicKey: HOST_PUBLIC_KEY, fingerprint: HOST_FINGERPRINT }] },
    ));
    await assert.rejects(openSessionHandoff(WIRE.finding, { connectionFile: otherProfile,
      identityPath: setup.identityPath, context: setup.context, clientPath: setup.client }),
      (error) => error?.code === "session_handoff_profile_mismatch");
    await assert.rejects(readFile(setup.log, "utf8"), (error) => error?.code === "ENOENT");
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("refuses changed protocol, target, box, derived grant, and host identity ACKs before launching the client", async () => {
  for (const [mode, code, environment] of [
    ["protocol", "session_handoff_target_changed", {}],
    ["changed", "session_handoff_target_changed", {}],
    ["box", "session_handoff_ack_mismatch", {}],
    ["grant", "session_handoff_ack_mismatch", {}],
    ["host", "session_handoff_ack_mismatch", { WM_HOST_FINGERPRINT: "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }],
  ]) {
    const setup = await fixture(WIRE.finding);
    try {
      await assert.rejects(
        openSessionHandoff(WIRE.finding, { connectionFile: setup.connectionFile,
          identityPath: setup.identityPath,
          context: { ...setup.context, env: { ...setup.context.env, ...environment, WM_GATEWAY_MODE: mode } },
          clientPath: setup.client }),
        (error) => error?.code === code,
        mode,
      );
      const log = records(await readFile(setup.log, "utf8"));
      assert.equal(log.some((entry) => entry.event === "client_started"), false);
    } finally {
      await rm(setup.directory, { recursive: true, force: true });
    }
  }
});

test("SSH loss terminates only the owned local client and relay", async () => {
  const setup = await fixture(WIRE.finding);
  try {
    await assert.rejects(
      openSessionHandoff(WIRE.finding, { connectionFile: setup.connectionFile,
        identityPath: setup.identityPath,
        context: { ...setup.context, env: { ...setup.context.env, WM_GATEWAY_MODE: "disconnect" } },
        clientPath: setup.hangingClient }),
      (error) => error?.code === "session_handoff_bridge_closed",
    );
    const log = records(await readFile(setup.log, "utf8"));
    assert.equal(log.some((entry) => entry.event === "client_started"), true);
    assert.equal(log.some((entry) => entry.event === "client_terminated"), true);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("preserves the manager-review bridge's inspection-only refusal", async () => {
  const descriptor = structuredClone(WIRE.finding);
  descriptor.handoff.identity.role = "manager";
  descriptor.handoff.source.registeredSourceId = "manager_f71a39ba9a9e341186e855db";
  descriptor.handoff.source.nativeSessionId = "ses_managerreview0001";
  const setup = await fixture(descriptor);
  try {
    const exitCode = await openSessionHandoff(descriptor, {
      connectionFile: setup.connectionFile,
      identityPath: setup.identityPath,
      context: { ...setup.context, env: { ...setup.context.env, WM_MANAGER_READ_ONLY: "1" } },
      clientPath: setup.managerClient,
    });
    assert.equal(exitCode, 0);
    const log = records(await readFile(setup.log, "utf8"));
    const result = log.find((entry) => entry.event === "manager_result").result;
    assert.equal(result.status, 403);
    assert.match(result.body, /team_helper_manager_review_read_only/);
    assert.equal(log.filter((entry) => entry.event === "request").length, 1);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});
