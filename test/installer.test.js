import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";

import { installRuntime, verifyRuntimeArtifact } from "../src/installer.js";

const BUNDLE_FILES = [
  "install.sh",
  "warpmetal-agentctl",
  "warpmetal-sandbox-gateway",
  "warpmetal-sandbox-shell",
  "warpmetald",
  "warpmetald.service",
  "warpmetal-sandbox.conf",
];

function artifactFixture() {
  const content = Buffer.from("signed WarpMetal runtime archive");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    content,
    metadata: {
      version: "0.2.0",
      url: "https://releases.warpmetal.com/runtime.tar.gz",
      sha256: createHash("sha256").update(content).digest("hex"),
      signature: sign(null, content, privateKey).toString("base64"),
      signingPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    },
  };
}

function spawnRecorder({ failInstall = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "tar" && args[0] === "-xzf") {
      const extractPath = args[args.indexOf("-C") + 1];
      mkdirSync(extractPath, { recursive: true });
      for (const file of BUNDLE_FILES)
        writeFileSync(`${extractPath}/${file}`, "fixture");
    }
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const isInstall =
      command === "ssh" && args.some((argument) => argument.endsWith("/install.sh"));
    queueMicrotask(() => {
      if (failInstall && isInstall) child.stderr.end("install failed");
      else child.stderr.end();
      child.stdout.end();
      child.emit("close", failInstall && isInstall ? 1 : 0);
    });
    return child;
  };
  return { calls, spawnImpl };
}

function installFixture(options = {}) {
  const { content, metadata } = artifactFixture();
  return {
    arguments: {
      client: {
        baseUrl: "https://api.warpmetal.com",
        getServer: async () => ({
          data: { task: { state: "ready", publicIp: "203.0.113.10" } },
        }),
      },
      serverId: "srv_example123",
      token: "owner-token",
      identity: "/tmp/owner-key",
      sshUser: "root",
      bootstrap: { artifact: metadata, bootstrapToken: "rtb_secret" },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(content.length) }),
        arrayBuffer: async () => content,
      }),
      ...options,
    },
  };
}

test("runtime artifact requires both checksum and signature", () => {
  const content = Buffer.from("signed WarpMetal runtime artifact");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const metadata = {
    version: "0.1.0",
    url: "https://releases.warpmetal.com/runtime.tar.gz",
    sha256: createHash("sha256").update(content).digest("hex"),
    signature: sign(null, content, privateKey).toString("base64"),
    signingPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  };
  assert.equal(verifyRuntimeArtifact(content, metadata).version, "0.1.0");
  assert.throws(
    () => verifyRuntimeArtifact(Buffer.from("changed"), metadata),
    /checksum/,
  );
  assert.throws(
    () =>
      verifyRuntimeArtifact(content, {
        ...metadata,
        signature: Buffer.alloc(64).toString("base64"),
      }),
    /signature/,
  );
});

test("runtime installation uses argument arrays and removes remote staging", async () => {
  const recorder = spawnRecorder();
  const fixture = installFixture({ spawnImpl: recorder.spawnImpl });
  const result = await installRuntime(fixture.arguments);
  assert.equal(result.installed, true);
  assert.ok(recorder.calls.every((call) => call.options.shell === false));
  const cleanup = recorder.calls.at(-1);
  assert.equal(cleanup.command, "ssh");
  assert.deepEqual(cleanup.args.slice(-6, -2), ["sudo", "rm", "-rf", "--"]);
  assert.match(cleanup.args.at(-2), /^\/tmp\/warpmetal-runtime-[a-f0-9]{32}$/);
  assert.match(
    cleanup.args.at(-1),
    /^\/tmp\/warpmetal-runtime-[a-f0-9]{32}\.tar\.gz$/,
  );
});

test("runtime installation still removes remote staging after failure", async () => {
  const recorder = spawnRecorder({ failInstall: true });
  const fixture = installFixture({ spawnImpl: recorder.spawnImpl });
  await assert.rejects(() => installRuntime(fixture.arguments), /install failed/);
  const cleanup = recorder.calls.at(-1);
  assert.equal(cleanup.command, "ssh");
  assert.deepEqual(cleanup.args.slice(-6, -2), ["sudo", "rm", "-rf", "--"]);
});
