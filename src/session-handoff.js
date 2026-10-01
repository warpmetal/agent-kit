import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { knownHosts, readConnectionProfile } from "./connection.js";
import { CliError } from "./errors.js";

const PROTOCOL = "wm-team-control/1";
const FRAME_HELLO = 0x01;
const FRAME_REQUEST = 0x02;
const FRAME_CANCEL = 0x03;
const FRAME_PING = 0x04;
const FRAME_CLOSE = 0x05;
const FRAME_HELLO_ACK = 0x81;
const FRAME_RESPONSE_HEAD = 0x82;
const FRAME_DATA = 0x83;
const FRAME_END = 0x84;
const FRAME_ERROR = 0x85;
const FRAME_PONG = 0x86;

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INFLIGHT = 32;
const MAX_REQUEST_ID_BYTES = 32;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 2_000;

const ENVELOPE_FIELDS = new Set([
  "formatVersion",
  "capability",
  "handoff",
  "reason",
  "access",
]);
const ACCESS_FIELDS = new Set([
  "transport",
  "requiresSandboxGrant",
  "requiresPinnedHostKey",
  "requiresLocalOwnerCredential",
]);
const HANDOFF_FIELDS = new Set([
  "formatVersion",
  "action",
  "handoffId",
  "issuedAt",
  "expiresAt",
  "identity",
  "source",
  "task",
  "work",
]);
const IDENTITY_FIELDS = new Set([
  "serverId",
  "teamId",
  "memberId",
  "sandboxId",
  "sandboxGeneration",
  "serviceRegistrationId",
  "serviceGeneration",
  "instance",
  "role",
  "projectId",
  "workspaceEpoch",
  "profileId",
  "profileRevision",
  "profileDigest",
  "instructionRevision",
  "instructionDigest",
]);
const SOURCE_FIELDS = new Set([
  "registeredSourceId",
  "nativeSessionId",
  "nativeProjectId",
  "nativeLocationDigest",
]);
const TASK_FIELDS = new Set(["taskId", "taskAttempt"]);
const WORK_FIELDS = new Set([
  "workId",
  "expectedRevision",
  "bindingId",
  "bindingRevision",
]);
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/;
const INSTANCE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SESSION_ID = /^ses_[A-Za-z0-9_-]{4,64}$/;
const NATIVE_PROJECT_ID = /^(?:global|[a-f0-9]{40})$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const SAFE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "retry-after",
  "x-request-id",
]);
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);
const CHILD_SECRET_ENV = new Set([
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "WARPMETAL_OWNER_TOKEN",
  "WARPMETAL_ACCESS_TOKEN",
]);

function fail(code, message, exitCode = 4) {
  throw new CliError(message, { code, exitCode });
}

function record(value, fields, code = "session_handoff_invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "The session handoff is invalid.", 2);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    fail(code, "The session handoff contains unsupported fields.", 2);
  }
  return value;
}

function identifier(value, pattern = OPAQUE_ID) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("session_handoff_invalid", "The session handoff contains an invalid identifier.", 2);
  }
  return value;
}

function revision(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    fail("session_handoff_invalid", "The session handoff contains an invalid revision.", 2);
  }
  return value;
}

function instant(value) {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("session_handoff_invalid", "The session handoff contains an invalid timestamp.", 2);
  }
  return Date.parse(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function validateDescriptor(descriptor, now) {
  let encoded;
  try {
    encoded = JSON.stringify(descriptor);
  } catch {
    fail("session_handoff_invalid", "The session handoff is not JSON-safe.", 2);
  }
  if (Buffer.byteLength(encoded || "", "utf8") > MAX_DESCRIPTOR_BYTES) {
    fail("session_handoff_invalid", "The session handoff exceeds the size limit.", 2);
  }
  const envelope = record(descriptor, ENVELOPE_FIELDS);
  if (
    envelope.formatVersion !== 1 ||
    envelope.capability !== "exact_session" ||
    envelope.reason !== null
  ) {
    fail("session_handoff_unavailable", "The exact managed session is unavailable.", 2);
  }
  const access = record(envelope.access, ACCESS_FIELDS);
  if (
    access.transport !== PROTOCOL ||
    access.requiresSandboxGrant !== true ||
    access.requiresPinnedHostKey !== true ||
    access.requiresLocalOwnerCredential !== true
  ) {
    fail("session_handoff_unavailable", "The required managed access is unavailable.", 2);
  }
  const handoff = record(envelope.handoff, HANDOFF_FIELDS);
  if (handoff.formatVersion !== 1 || handoff.action !== "open_session") {
    fail("session_handoff_invalid", "The session handoff action is invalid.", 2);
  }
  identifier(handoff.handoffId);
  const issuedAt = instant(handoff.issuedAt);
  const expiresAt = instant(handoff.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 120_000) {
    fail("session_handoff_invalid", "The session handoff lifetime is invalid.", 2);
  }
  if (now < issuedAt || now >= expiresAt) {
    fail("session_handoff_expired", "The session handoff has expired.", 4);
  }

  const identity = record(handoff.identity, IDENTITY_FIELDS);
  for (const field of [
    "serverId",
    "teamId",
    "memberId",
    "sandboxId",
    "serviceRegistrationId",
    "projectId",
    "workspaceEpoch",
  ]) {
    identifier(identity[field]);
  }
  identifier(identity.instance, INSTANCE);
  if (!["worker", "manager", "reviewer"].includes(identity.role)) {
    fail("session_handoff_invalid", "The session handoff role is invalid.", 2);
  }
  if (identity.profileId !== "opencode") {
    fail("session_handoff_unavailable", "The session profile is unsupported.", 2);
  }
  revision(identity.sandboxGeneration);
  revision(identity.serviceGeneration);
  revision(identity.profileRevision);
  revision(identity.instructionRevision);
  if (!DIGEST.test(identity.profileDigest) || !DIGEST.test(identity.instructionDigest)) {
    fail("session_handoff_invalid", "The session handoff digest is invalid.", 2);
  }

  const source = record(handoff.source, SOURCE_FIELDS);
  identifier(source.registeredSourceId);
  identifier(source.nativeSessionId, SESSION_ID);
  if (typeof source.nativeProjectId !== "string" || !NATIVE_PROJECT_ID.test(source.nativeProjectId)) {
    fail("session_handoff_invalid", "The native project identity is invalid.", 2);
  }
  if (typeof source.nativeLocationDigest !== "string" || !DIGEST.test(source.nativeLocationDigest)) {
    fail("session_handoff_invalid", "The native location identity is invalid.", 2);
  }

  if (handoff.task !== null) {
    const task = record(handoff.task, TASK_FIELDS);
    identifier(task.taskId);
    revision(task.taskAttempt);
  }
  if (handoff.work !== null) {
    const work = record(handoff.work, WORK_FIELDS);
    identifier(work.workId);
    identifier(work.bindingId);
    revision(work.expectedRevision);
    revision(work.bindingRevision);
  }
  return handoff;
}

async function validateIdentityPath(identityPath) {
  if (typeof identityPath !== "string" || !isAbsolute(identityPath) || identityPath.includes("\0")) {
    fail("session_handoff_identity_invalid", "The sandbox SSH identity path must be absolute.", 2);
  }
  let metadata;
  try {
    metadata = await lstat(identityPath);
  } catch {
    fail("session_handoff_identity_invalid", "The sandbox SSH identity is unavailable.", 2);
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > 64 * 1024 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    fail("session_handoff_identity_invalid", "The sandbox SSH identity is not a private regular file.", 2);
  }
  return identityPath;
}

function sanitizedEnvironment(source) {
  const environment = { ...(source || {}) };
  for (const name of CHILD_SECRET_ENV) delete environment[name];
  return environment;
}

function expectedBridgeGrantId(publicGrantId, handoffId) {
  return `grt_${createHash("sha256")
    .update(`${publicGrantId}\0${handoffId}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function encodeControl(type, value) {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  const size = 1 + json.length;
  if (size > MAX_FRAME_BYTES) {
    fail("session_handoff_frame_invalid", "A bridge frame exceeds the size limit.");
  }
  const frame = Buffer.allocUnsafe(4 + size);
  frame.writeUInt32BE(size, 0);
  frame[4] = type;
  json.copy(frame, 5);
  return frame;
}

class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (this.buffer.length + chunk.length > MAX_FRAME_BYTES + 4) {
      fail("session_handoff_frame_invalid", "The bridge frame buffer exceeds the size limit.");
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (size < 1 || size > MAX_FRAME_BYTES) {
        fail("session_handoff_frame_invalid", "The bridge declared an invalid frame length.");
      }
      if (this.buffer.length < 4 + size) break;
      const body = this.buffer.subarray(4, 4 + size);
      this.buffer = this.buffer.subarray(4 + size);
      const type = body[0];
      if (type === FRAME_DATA) {
        const idLength = body[1];
        if (!Number.isInteger(idLength) || idLength < 1 || idLength > MAX_REQUEST_ID_BYTES || body.length < 2 + idLength) {
          fail("session_handoff_frame_invalid", "The bridge returned an invalid data frame.");
        }
        frames.push({
          type,
          id: body.subarray(2, 2 + idLength).toString("utf8"),
          bytes: body.subarray(2 + idLength),
        });
        continue;
      }
      if (![FRAME_HELLO_ACK, FRAME_RESPONSE_HEAD, FRAME_END, FRAME_ERROR, FRAME_PONG, FRAME_CLOSE].includes(type)) {
        fail("session_handoff_frame_invalid", "The bridge returned an unsupported frame.");
      }
      let value;
      try {
        value = JSON.parse(body.subarray(1).toString("utf8"));
      } catch {
        fail("session_handoff_frame_invalid", "The bridge returned malformed JSON.");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("session_handoff_frame_invalid", "The bridge returned a malformed control frame.");
      }
      frames.push({ type, value });
    }
    return frames;
  }
}

function safeWrite(stream, bytes) {
  if (!stream || stream.destroyed || stream.writableEnded) {
    fail("session_handoff_bridge_closed", "The managed bridge closed unexpectedly.");
  }
  stream.write(bytes);
}

function validateAcknowledgement(value, descriptor, profile, now) {
  const target = descriptor.handoff;
  if (now >= instant(target.expiresAt)) {
    fail("session_handoff_expired", "The session handoff expired before acknowledgement.", 4);
  }
  if (
    value?.v !== 1 ||
    value?.protocol !== PROTOCOL ||
    value?.helper !== "warpmetal-team-bridge/1" ||
    value?.handoff?.formatVersion !== 1 ||
    value?.handoff?.action !== "open_session" ||
    value?.handoff?.status !== "ready" ||
    value?.handoff?.capability !== "exact_session" ||
    value?.handoff?.handoffId !== target.handoffId ||
    !same(value?.handoff?.target, target)
  ) {
    fail("session_handoff_target_changed", "The managed bridge acknowledged another target.");
  }
  const box = value.box;
  const expectedGrant = expectedBridgeGrantId(profile.grantId, target.handoffId);
  const fingerprints = new Set(profile.hostKeys.map((key) => key.fingerprint));
  if (
    !box ||
    box.serverId !== target.identity.serverId ||
    box.sandboxId !== target.identity.sandboxId ||
    box.instance !== target.identity.instance ||
    box.generation !== target.identity.sandboxGeneration ||
    box.grantId !== expectedGrant ||
    !fingerprints.has(box.hostKeyFingerprint) ||
    typeof box.sessionId !== "string" ||
    !OPAQUE_ID.test(box.sessionId) ||
    typeof box.expiresAt !== "string" ||
    instant(box.expiresAt) < instant(target.expiresAt) ||
    instant(box.expiresAt) <= now
  ) {
    fail("session_handoff_ack_mismatch", "The managed bridge identity does not match the connection profile.");
  }
  if (
    !value.engine ||
    !["127.0.0.1", "::1"].includes(value.engine.host) ||
    !Number.isInteger(value.engine.port) ||
    value.engine.port < 1 ||
    value.engine.port > 65_535
  ) {
    fail("session_handoff_ack_mismatch", "The managed bridge engine receipt is invalid.");
  }
}

class BridgeChannel {
  constructor(child) {
    this.child = child;
    this.decoder = new FrameDecoder();
    this.pending = new Map();
    this.hello = null;
    this.failure = null;
    this.closed = false;
    this.failurePromise = new Promise((resolvePromise) => {
      this.resolveFailure = resolvePromise;
    });
    child.stdout.on("data", (chunk) => this.receive(chunk));
    child.once("error", (error) => this.stop(error));
    child.once("close", (code, signal) => {
      if (!this.closed) {
        this.stop(new CliError("The managed bridge closed unexpectedly.", {
          code: "session_handoff_bridge_closed",
          exitCode: Number.isInteger(code) && code > 0 ? code : signal ? 4 : 1,
        }));
      }
    });
  }

  receive(chunk) {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.stop(error);
      return;
    }
    for (const frame of frames) this.route(frame);
  }

  route(frame) {
    if (this.hello) {
      if (frame.type === FRAME_HELLO_ACK) {
        const pending = this.hello;
        this.hello = null;
        pending.resolve(frame.value);
        return;
      }
      if (frame.type === FRAME_ERROR || frame.type === FRAME_CLOSE) {
        this.stop(new CliError("The managed bridge refused the session handoff.", {
          code: "session_handoff_bridge_refused",
          exitCode: 4,
        }));
        return;
      }
      this.stop(new CliError("The managed bridge replied before acknowledging the handoff.", {
        code: "session_handoff_frame_invalid",
        exitCode: 4,
      }));
      return;
    }
    if (frame.type === FRAME_PING) {
      safeWrite(this.child.stdin, encodeControl(FRAME_PONG, { id: frame.value.id }));
      return;
    }
    if (frame.type === FRAME_CLOSE) {
      this.stop(new CliError("The managed bridge closed the session.", {
        code: "session_handoff_bridge_closed",
        exitCode: 4,
      }));
      return;
    }
    const id = frame.type === FRAME_DATA ? frame.id : frame.value?.id;
    const request = typeof id === "string" ? this.pending.get(id) : undefined;
    if (!request) {
      this.stop(new CliError("The managed bridge returned an unknown request.", {
        code: "session_handoff_frame_invalid",
        exitCode: 4,
      }));
      return;
    }
    if (frame.type === FRAME_RESPONSE_HEAD) {
      if (request.head || !Number.isInteger(frame.value.status) || frame.value.status < 100 || frame.value.status > 599) {
        this.stop(new CliError("The managed bridge returned an invalid response.", {
          code: "session_handoff_frame_invalid",
          exitCode: 4,
        }));
        return;
      }
      request.head = true;
      const headers = {};
      if (frame.value.headers && typeof frame.value.headers === "object" && !Array.isArray(frame.value.headers)) {
        for (const [name, value] of Object.entries(frame.value.headers)) {
          const lower = name.toLowerCase();
          if (SAFE_RESPONSE_HEADERS.has(lower) && typeof value === "string" && value.length <= 8192) {
            headers[lower] = value;
          }
        }
      }
      request.response.writeHead(frame.value.status, headers);
      return;
    }
    if (frame.type === FRAME_DATA) {
      if (!request.head) {
        this.stop(new CliError("The managed bridge returned data before response headers.", {
          code: "session_handoff_frame_invalid",
          exitCode: 4,
        }));
        return;
      }
      request.response.write(frame.bytes);
      return;
    }
    if (frame.type === FRAME_END) {
      this.pending.delete(id);
      if (!request.head) request.response.writeHead(204);
      request.response.end();
      return;
    }
    if (frame.type === FRAME_ERROR) {
      this.pending.delete(id);
      const code = typeof frame.value.code === "string" && /^[a-z0-9_]{3,80}$/.test(frame.value.code)
        ? frame.value.code
        : "team_helper_error";
      const status = code === "team_helper_manager_review_read_only" || code.endsWith("_denied")
        ? 403
        : code.includes("stale")
          ? 409
          : code.includes("busy")
            ? 503
            : 502;
      if (!request.response.headersSent) {
        request.response.writeHead(status, { "content-type": "application/json" });
      }
      request.response.end(`${JSON.stringify({ error: code })}\n`);
    }
  }

  async handshake(descriptor, timeoutMs) {
    if (this.failure) throw this.failure;
    const acknowledgement = new Promise((resolvePromise, rejectPromise) => {
      this.hello = { resolve: resolvePromise, reject: rejectPromise };
    });
    safeWrite(this.child.stdin, encodeControl(FRAME_HELLO, {
      v: 1,
      protocol: PROTOCOL,
      handoff: descriptor.handoff,
    }));
    let timer;
    try {
      return await Promise.race([
        acknowledgement,
        new Promise((_, rejectPromise) => {
          timer = setTimeout(() => rejectPromise(new CliError(
            "The managed bridge did not acknowledge the handoff in time.",
            { code: "session_handoff_timeout", exitCode: 4 },
          )), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.hello = null;
    }
  }

  request(value, response) {
    if (this.failure) throw this.failure;
    if (this.pending.size >= MAX_INFLIGHT) return false;
    this.pending.set(value.id, { response, head: false });
    try {
      safeWrite(this.child.stdin, encodeControl(FRAME_REQUEST, value));
    } catch (error) {
      this.pending.delete(value.id);
      throw error;
    }
    return true;
  }

  cancel(id) {
    if (!this.pending.delete(id) || this.closed) return;
    try {
      safeWrite(this.child.stdin, encodeControl(FRAME_CANCEL, { id }));
    } catch {
      // The bridge is already gone; stop() owns remaining request cleanup.
    }
  }

  stop(error) {
    if (this.failure || this.closed) return;
    this.failure = error instanceof CliError
      ? error
      : new CliError("The managed bridge failed.", {
        code: error?.code === "ENOENT" ? "session_handoff_ssh_unavailable" : "session_handoff_bridge_closed",
        exitCode: error?.code === "ENOENT" ? 2 : 4,
      });
    this.resolveFailure(this.failure);
    if (this.hello) this.hello.reject(this.failure);
    this.hello = null;
    for (const request of this.pending.values()) {
      if (!request.response.headersSent) request.response.writeHead(502, { "content-type": "application/json" });
      request.response.end(`${JSON.stringify({ error: this.failure.code })}\n`);
    }
    this.pending.clear();
  }

  close(reason = "owner_disconnect") {
    if (this.closed) return;
    this.closed = true;
    try {
      if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
        this.child.stdin.end(encodeControl(FRAME_CLOSE, { reason }));
      }
    } catch {
      this.child.stdin.destroy();
    }
  }
}

function authorized(request, password) {
  const expected = Buffer.from(`Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`, "utf8");
  const supplied = Buffer.from(String(request.headers.authorization || ""), "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function loopbackOrigin(value, port) {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const origin = new URL(value);
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(origin.hostname) &&
      (!origin.port || Number(origin.port) === port);
  } catch {
    return false;
  }
}

function collectBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new CliError("The native request body exceeds 1 MiB.", {
          code: "session_handoff_body_too_large",
          exitCode: 4,
        }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks)));
    request.on("error", rejectPromise);
  });
}

async function startRelay(channel, password, random = randomBytes) {
  let port = 0;
  const server = http.createServer(async (request, response) => {
    if (!authorized(request, password)) {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Basic realm="WarpMetal managed session"',
      });
      response.end('{"error":"unauthorized"}\n');
      return;
    }
    const expectedHost = `127.0.0.1:${port}`;
    if (request.headers.host !== expectedHost || !loopbackOrigin(request.headers.origin, port)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"loopback_boundary_denied"}\n');
      return;
    }
    let parsed;
    try {
      parsed = new URL(request.url || "", `http://${expectedHost}`);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"invalid_request"}\n');
      return;
    }
    if (!(parsed.pathname === "/api" || parsed.pathname.startsWith("/api/"))) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"destination_denied"}\n');
      return;
    }
    let body;
    try {
      body = await collectBody(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(error?.code === "session_handoff_body_too_large" ? 413 : 400, {
          "content-type": "application/json",
        });
        response.end(`${JSON.stringify({ error: error?.code || "invalid_request" })}\n`);
      }
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (!STRIPPED_REQUEST_HEADERS.has(lower) && typeof value === "string" && value.length <= 8192) {
        headers[lower] = value;
      }
    }
    const id = random(12).toString("hex");
    try {
      if (!channel.request({
        id,
        method: request.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        bodyBase64: body.length ? body.toString("base64") : "",
      }, response)) {
        response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
        response.end('{"error":"team_helper_busy"}\n');
        return;
      }
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(`${JSON.stringify({ error: error?.code || "session_handoff_bridge_closed" })}\n`);
      return;
    }
    request.once("aborted", () => channel.cancel(id));
    response.once("close", () => {
      if (!response.writableEnded) channel.cancel(id);
    });
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    fail("session_handoff_relay_unavailable", "The local session relay could not bind.");
  }
  port = address.port;
  return { server, url: `http://127.0.0.1:${port}` };
}

function waitForChild(child, unavailableCode) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", (error) => rejectPromise(new CliError(
      error?.code === "ENOENT" ? "The required local executable is unavailable." : "The local process failed.",
      { code: error?.code === "ENOENT" ? unavailableCode : "session_handoff_process_failed", exitCode: error?.code === "ENOENT" ? 2 : 4 },
    )));
    child.once("close", (code, signal) => resolvePromise({
      code: Number.isInteger(code) ? code : signal ? 1 : 0,
      signal,
    }));
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timer;
  await Promise.race([
    new Promise((resolvePromise) => child.once("close", resolvePromise)),
    new Promise((resolvePromise) => {
      timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolvePromise();
      }, CLEANUP_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}

export async function openSessionHandoff(
  descriptor,
  { connectionFile, identityPath, context = {}, clientPath = "opencode" } = {},
) {
  const nowFn = typeof context.now === "function" ? context.now : Date.now;
  const now = Number(nowFn());
  if (!Number.isFinite(now)) fail("session_handoff_invalid", "The local clock is unavailable.", 2);
  const handoff = validateDescriptor(descriptor, now);
  if (typeof connectionFile !== "string" || !isAbsolute(connectionFile) || connectionFile.includes("\0")) {
    fail("session_handoff_profile_invalid", "The sandbox connection profile path must be absolute.", 2);
  }
  const profile = await readConnectionProfile(connectionFile);
  if (
    profile.serverId !== handoff.identity.serverId ||
    profile.sandboxId !== handoff.identity.sandboxId
  ) {
    fail("session_handoff_profile_mismatch", "The sandbox connection profile targets another session owner.", 2);
  }
  const identity = await validateIdentityPath(identityPath);
  if (typeof clientPath !== "string" || !clientPath || clientPath.length > 1024 || clientPath.includes("\0")) {
    fail("session_handoff_client_invalid", "The local OpenCode client path is invalid.", 2);
  }
  if (clientPath.includes("/") && !isAbsolute(clientPath)) {
    fail("session_handoff_client_invalid", "The local OpenCode client path must be absolute.", 2);
  }
  const spawn = typeof context.spawn === "function" ? context.spawn : spawnChild;
  const random = typeof context.randomBytes === "function" ? context.randomBytes : randomBytes;
  const environment = sanitizedEnvironment(context.env || process.env);
  const handshakeTimeoutMs = Number.isInteger(context.handshakeTimeoutMs) &&
    context.handshakeTimeoutMs >= 100 && context.handshakeTimeoutMs <= MAX_HANDSHAKE_TIMEOUT_MS
    ? context.handshakeTimeoutMs
    : DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-session-handoff-"));
  const knownHostsPath = join(directory, "known_hosts");
  const emptyPath = join(directory, "empty");
  let ssh;
  let client;
  let relay;
  let channel;
  let passwordBytes;
  let clientEnvironment;
  try {
    await writeFile(knownHostsPath, knownHosts(profile), { mode: 0o600, flag: "wx" });
    await writeFile(emptyPath, "", { mode: 0o600, flag: "wx" });
    const sshArgs = [
      "-F", emptyPath,
      "-T",
      "-i", resolve(identity),
      "-o", "BatchMode=yes",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHostsPath}`,
      "-o", `GlobalKnownHostsFile=${emptyPath}`,
      "-o", "UpdateHostKeys=no",
      "-o", "VerifyHostKeyDNS=no",
      "-o", "ClearAllForwardings=yes",
      "-o", "ForwardAgent=no",
      "-o", "ForwardX11=no",
      "-o", "PermitLocalCommand=no",
      "-o", "RequestTTY=no",
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-o", "ProxyCommand=none",
      "-o", "ProxyJump=none",
      "-p", String(profile.port),
      `${profile.username}@${profile.host}`,
      "warpmetal-team-control",
    ];
    ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "inherit"],
      shell: false,
      env: environment,
    });
    channel = new BridgeChannel(ssh);
    const acknowledgement = await channel.handshake(descriptor, handshakeTimeoutMs);
    validateAcknowledgement(acknowledgement, descriptor, profile, Number(nowFn()));

    passwordBytes = random(32);
    if (!Buffer.isBuffer(passwordBytes) || passwordBytes.length !== 32) {
      fail("session_handoff_relay_unavailable", "The local relay credential could not be generated.");
    }
    const password = passwordBytes.toString("base64url");
    relay = await startRelay(channel, password, random);
    clientEnvironment = {
      ...environment,
      OPENCODE_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    };
    client = spawn(clientPath, [
      "--server", relay.url,
      "--session", handoff.source.nativeSessionId,
    ], {
      stdio: "inherit",
      shell: false,
      env: clientEnvironment,
    });
    const outcome = await Promise.race([
      waitForChild(client, "session_handoff_client_unavailable")
        .then((result) => ({ type: "client", result })),
      channel.failurePromise.then((error) => ({ type: "bridge", error })),
    ]);
    if (outcome.type === "bridge") {
      await stopChild(client);
      throw outcome.error;
    }
    return outcome.result.code;
  } finally {
    if (clientEnvironment) delete clientEnvironment.OPENCODE_PASSWORD;
    if (passwordBytes) passwordBytes.fill(0);
    if (relay?.server) {
      relay.server.closeAllConnections?.();
      await new Promise((resolvePromise) => relay.server.close(resolvePromise)).catch(() => {});
    }
    channel?.close();
    await stopChild(client).catch(() => {});
    await stopChild(ssh).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
