import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { main, refillRenewBy } from "../src/cli.js";
import { digestJson } from "../src/payment.js";
import { generateServerKey } from "../src/ssh.js";
import { StateStore } from "../src/state.js";

function ed25519HostKeyLine(host) {
  const type = Buffer.from("ssh-ed25519");
  const key = Buffer.alloc(32, 7);
  const material = Buffer.alloc(4 + type.length + 4 + key.length);
  material.writeUInt32BE(type.length, 0);
  type.copy(material, 4);
  material.writeUInt32BE(key.length, 4 + type.length);
  key.copy(material, 8 + type.length);
  return `${host} ssh-ed25519 ${material.toString("base64")}\n`;
}

const paymentRequirement = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "20000000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 180,
  extra: {
    assetTransferMethod: "eip3009",
    name: "USD Coin",
    payloadProfile: "com.x402api.x402.base-usdc-eip3009-sponsored.v1",
    version: "2",
  },
};
const recipientDescriptor = {
  type: "com.k1hub.external-receiving-address.v1",
  tenantId: "018f4c76-8f9a-7d3a-8e0b-123456789abc",
  network: paymentRequirement.network,
  address: paymentRequirement.payTo,
  controlChallengeDigest: `sha256:${"4".repeat(64)}`,
};
const sponsorshipInfoKeys = [
  "version",
  "mode",
  "requirements",
  "buyerNativeFeeRequired",
  "billingParty",
  "maximumReservationEvidenceDigest",
  "expiresAt",
  "finalChargePolicy",
];
const paymentRequired = {
  x402Version: 2,
  resource: {
    url: "https://api.warpmetal.test/checkout/agent",
    mimeType: "application/json",
  },
  accepts: [paymentRequirement],
  extensions: {
    "payment-identifier": { info: { required: true } },
    "com.k1hub.external-recipient": {
      info: {
        version: 1,
        recipients: [
          {
            network: paymentRequirement.network,
            asset: paymentRequirement.asset,
            payTo: paymentRequirement.payTo,
            recipientDescriptorDigest: digestJson(recipientDescriptor),
            recipientDescriptor,
          },
        ],
      },
    },
    "com.x402api.gas-sponsorship": {
      info: {
        version: 1,
        mode: "facilitator_pays",
        requirements: [
          {
            network: paymentRequirement.network,
            asset: paymentRequirement.asset,
            payloadProfile: paymentRequirement.extra.payloadProfile,
          },
        ],
        buyerNativeFeeRequired: false,
        billingParty: "platform_treasury",
        maximumReservationEvidenceDigest: `sha256:${"5".repeat(64)}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        finalChargePolicy: "platform_treasury_actual_cost",
      },
      schema: {
        $id: "urn:com:x402api:gas-sponsorship:v1",
        type: "object",
        additionalProperties: false,
        required: sponsorshipInfoKeys,
      },
    },
  },
};
const paymentRequiredHeader = Buffer.from(
  JSON.stringify(paymentRequired),
  "utf8",
).toString("base64");
const authoritativeChallengeDigest = `sha256:${"6".repeat(64)}`;
const hostedCheckoutUrl = `https://pay.x402api.com/c/chk_${"a".repeat(32)}`;
const hostedCheckoutExpiresAt = "2099-01-01T00:00:00.000Z";

function capture() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
      },
    },
    value: () => value,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("help exposes no nested private procfs option or guidance", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(["--help"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {},
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.doesNotMatch(stdout.value(), /nested[- ]private[- ]procfs/i);
  assert.match(stdout.value(), /SSH host trust \(CLI 0\.8\.8\+\)/);
  assert.match(stdout.value(), /before requesting a Runtime bootstrap/);
  assert.match(stdout.value(), /changed key is never accepted or\s+overwritten/);
  assert.match(stdout.value(), /active attacker on the first connection/);
});

test("JSON errors include stable CliError codes as structured data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-cli-error-test-"));
  const stdout = capture();
  const stderr = capture();
  try {
    const exitCode = await main(
      [
        "server",
        "identity",
        "--server",
        "srv_missing123",
        "--state-dir",
        join(directory, "state"),
        "--json",
      ],
      { stdout: stdout.stream, stderr: stderr.stream, env: {} },
    );
    assert.equal(exitCode, 4);
    assert.equal(stdout.value(), "");
    const result = JSON.parse(stderr.value());
    assert.equal(result.error.code, "identity_required");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime install rejects the removed nested option before external work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-cli-procfs-test-"));
  const stdout = capture();
  const stderr = capture();
  let fetchCalls = 0;
  let spawnCalls = 0;
  try {
    const exitCode = await main(
      [
        "runtime",
        "install",
        "--server",
        "srv_example123",
        "--ssh-user",
        "root",
        "--identity",
        "/tmp/unused-warpmetal-key",
        "--confirm",
        "INSTALL",
        "--nested-private-procfs",
        "automatic",
        "--state-dir",
        join(directory, "state"),
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("unexpected fetch");
        },
        spawnImpl: () => {
          spawnCalls += 1;
          throw new Error("unexpected spawn");
        },
      },
    );

    assert.equal(exitCode, 2);
    assert.equal(stdout.value(), "");
    assert.equal(fetchCalls, 0);
    assert.equal(spawnCalls, 0);
    const error = JSON.parse(stderr.value());
    assert.match(error.error.message, /Unknown option: --nested-private-procfs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime install returns and forwards no nested action", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-cli-procfs-positive-"));
  const stdout = capture();
  const stderr = capture();
  try {
    let identity;
    try {
      identity = await generateServerKey(join(directory, "keys"), "procfs-test");
    } catch (error) {
      if (error?.message?.includes("ssh-keygen is required")) {
        context.skip("ssh-keygen is not installed");
        return;
      }
      throw error;
    }
    const artifactContent = Buffer.from("signed runtime v0.1.25 archive");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const artifact = {
      version: "0.1.25",
      url: "https://releases.warpmetal.test/runtime-v0.1.25.tar.gz",
      sha256: createHash("sha256").update(artifactContent).digest("hex"),
      signature: sign(null, artifactContent, privateKey).toString("base64"),
      signingPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    };
    const calls = [];
    const timeline = [];
    let serverReads = 0;
    const bundleFiles = [
      "install.sh",
      "warpmetal-agentctl",
      "warpmetal-sandbox-gateway",
      "warpmetal-sandbox-shell",
      "warpmetal-podman-service",
      "warpmetal-podman.service",
      "warpmetald",
      "warpmetald.service",
      "warpmetal-sandbox.conf",
      "nested-private-procfs-oracle.sh",
      "warpmetal-agent-runtime-bwrap",
      "warpmetal-apparmor-policy.sh",
      "warpmetal-policy-metadata",
    ];
    const spawnImpl = (command, args, options) => {
      calls.push({ command, args, options });
      timeline.push(
        command === "ssh" && args.at(-1) === "true"
          ? `ssh:${args.find((value) => value.startsWith("StrictHostKeyChecking="))}`
          : `spawn:${command}`,
      );
      if (
        command === "ssh" &&
        args.includes("StrictHostKeyChecking=accept-new")
      ) {
        const knownHosts = args.find((argument) =>
          argument.startsWith("UserKnownHostsFile="),
        );
        writeFileSync(
          knownHosts.slice("UserKnownHostsFile=".length),
          ed25519HostKeyLine("203.0.113.10"),
          { mode: 0o600 },
        );
      }
      if (command === "ssh" && args.includes("-E")) {
        writeFileSync(
          args[args.indexOf("-E") + 1],
          'Authenticated to 203.0.113.10 ([203.0.113.10]:22) using "publickey".\n',
        );
      }
      if (command === "tar" && args[0] === "-xzf") {
        const extractPath = args[args.indexOf("-C") + 1];
        mkdirSync(extractPath, { recursive: true });
        for (const file of bundleFiles) {
          writeFileSync(join(extractPath, file), "fixture");
        }
      }
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        if (command === "ssh") {
          child.stderr.write(
            'Authenticated to 203.0.113.10 ([203.0.113.10]:22) using "publickey".\n',
          );
        }
        child.stderr.end();
        child.stdout.end();
        child.emit("close", 0);
      });
      return child;
    };
    const fetchImpl = async (input, request = {}) => {
      const url = new URL(String(input));
      if (url.toString() === artifact.url) {
        return new Response(artifactContent, {
          status: 200,
          headers: { "content-length": String(artifactContent.length) },
        });
      }
      if (url.pathname.endsWith("/auth/challenges")) {
        return jsonResponse(200, {
          challengeId: "challenge_procfs_test",
          payload: "warpmetal-ssh-auth-v1\nchallenge\nserver\nnonce\n",
        });
      }
      if (url.pathname.endsWith("/auth/tokens")) {
        return jsonResponse(200, {
          accessToken: "sat_procfs_test",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.pathname.endsWith("/runtime/bootstrap")) {
        timeline.push("api:bootstrap");
        return jsonResponse(200, {
          artifact,
          bootstrapToken: "rtb_procfs_test",
        });
      }
      if (request.method === "GET" && url.pathname === "/servers/srv_example123") {
        serverReads += 1;
        timeline.push(
          serverReads === 1
            ? "api:initial-inspect"
            : serverReads === 2
              ? "api:reinspect-before-pin"
              : "api:install-inspect",
        );
        return jsonResponse(200, {
          task: {
            serverId: "srv_example123",
            state: "ready",
            publicIp: "203.0.113.10",
            sshFingerprint: identity.sshFingerprint,
          },
        });
      }
      throw new Error(`Unexpected test request: ${request.method} ${url.pathname}`);
    };

    const exitCode = await main(
      [
        "runtime",
        "install",
        "--server",
        "srv_example123",
        "--identity",
        identity.privateKeyPath,
        "--ssh-user",
        "root",
        "--confirm",
        "INSTALL",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        join(directory, "state"),
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl,
        spawnImpl,
      },
    );

    assert.equal(exitCode, 0, stderr.value());
    const output = JSON.parse(stdout.value());
    assert.equal(Object.hasOwn(output, "nestedPrivateProcfsAction"), false);
    assert.equal(output.hostKeyTrust.state, "trusted_first_use");
    assert.ok(
      timeline.indexOf("ssh:StrictHostKeyChecking=accept-new") <
        timeline.indexOf("api:reinspect-before-pin"),
    );
    assert.ok(
      timeline.indexOf("api:reinspect-before-pin") <
        timeline.indexOf("ssh:StrictHostKeyChecking=yes"),
    );
    assert.ok(
      timeline.indexOf("ssh:StrictHostKeyChecking=yes") <
        timeline.indexOf("api:bootstrap"),
    );
    const install = calls.find(
      (call) =>
        call.command === "ssh" &&
        call.args.some((argument) => argument.endsWith("/install.sh")),
    );
    assert.ok(install);
    assert.equal(install.args.includes("--nested-private-procfs"), false);
    for (const call of calls.filter(({ command }) =>
      ["ssh", "scp"].includes(command),
    )) {
      if (call.args.includes("StrictHostKeyChecking=accept-new")) continue;
      assert.ok(call.args.includes("StrictHostKeyChecking=yes"));
      assert.ok(
        call.args.some((value) => value.startsWith("UserKnownHostsFile=")),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime install publishes no host pin and requests no bootstrap after API identity drift", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-cli-host-drift-"));
  const stateDirectory = join(directory, "state");
  const stdout = capture();
  const stderr = capture();
  try {
    let identity;
    try {
      identity = await generateServerKey(join(directory, "keys"), "host-drift");
    } catch (error) {
      if (error?.message?.includes("ssh-keygen is required")) {
        context.skip("ssh-keygen is not installed");
        return;
      }
      throw error;
    }
    const serverId = "srv_hostdrift123";
    let serverReads = 0;
    let bootstrapRequests = 0;
    const fetchImpl = async (input, request = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/auth/challenges")) {
        return jsonResponse(200, {
          challengeId: "challenge_host_drift",
          payload: "warpmetal-ssh-auth-v1\nchallenge\nserver\nnonce\n",
        });
      }
      if (url.pathname.endsWith("/auth/tokens")) {
        return jsonResponse(200, {
          accessToken: "sat_host_drift",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.pathname.endsWith("/runtime/bootstrap")) {
        bootstrapRequests += 1;
        return jsonResponse(500, {});
      }
      if (request.method === "GET" && url.pathname === `/servers/${serverId}`) {
        serverReads += 1;
        return jsonResponse(200, {
          task: {
            serverId,
            state: "ready",
            publicIp:
              serverReads === 1 ? "203.0.113.10" : "203.0.113.11",
            sshFingerprint: identity.sshFingerprint,
          },
        });
      }
      throw new Error(`Unexpected test request: ${request.method} ${url.pathname}`);
    };
    const spawnImpl = (command, args, options) => {
      if (command === "ssh" && args.includes("StrictHostKeyChecking=accept-new")) {
        const knownHosts = args.find((argument) =>
          argument.startsWith("UserKnownHostsFile="),
        );
        writeFileSync(
          knownHosts.slice("UserKnownHostsFile=".length),
          ed25519HostKeyLine("203.0.113.10"),
          { mode: 0o600 },
        );
      }
      if (command === "ssh" && args.includes("-E")) {
        writeFileSync(
          args[args.indexOf("-E") + 1],
          'Authenticated to 203.0.113.10 ([203.0.113.10]:22) using "publickey".\n',
        );
      }
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stderr.end();
        child.stdout.end();
        child.emit("close", 0);
      });
      return child;
    };

    const exitCode = await main(
      [
        "runtime",
        "install",
        "--server",
        serverId,
        "--identity",
        identity.privateKeyPath,
        "--ssh-user",
        "root",
        "--confirm",
        "INSTALL",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      { stdout: stdout.stream, stderr: stderr.stream, env: {}, fetchImpl, spawnImpl },
    );

    assert.equal(exitCode, 4);
    assert.equal(stdout.value(), "");
    assert.equal(serverReads, 2);
    assert.equal(bootstrapRequests, 0);
    assert.equal(JSON.parse(stderr.value()).error.code, "host_trust_server_changed");
    const pin = join(
      stateDirectory,
      "ssh",
      "known-hosts",
      serverId,
      "initial.known_hosts",
    );
    await assert.rejects(readFile(pin), (error) => error.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime install never requests bootstrap when a managed host pin mismatches", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-cli-host-mismatch-"));
  const stateDirectory = join(directory, "state");
  const stdout = capture();
  const stderr = capture();
  try {
    let identity;
    try {
      identity = await generateServerKey(join(directory, "keys"), "host-mismatch");
    } catch (error) {
      if (error?.message?.includes("ssh-keygen is required")) {
        context.skip("ssh-keygen is not installed");
        return;
      }
      throw error;
    }
    const serverId = "srv_mismatch123";
    const pinDirectory = join(
      stateDirectory,
      "ssh",
      "known-hosts",
      serverId,
    );
    mkdirSync(pinDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(pinDirectory, "initial.known_hosts"),
      ed25519HostKeyLine("203.0.113.10"),
      { mode: 0o600 },
    );
    let bootstrapRequests = 0;
    const fetchImpl = async (input, request = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/auth/challenges")) {
        return jsonResponse(200, {
          challengeId: "challenge_host_mismatch",
          payload: "warpmetal-ssh-auth-v1\nchallenge\nserver\nnonce\n",
        });
      }
      if (url.pathname.endsWith("/auth/tokens")) {
        return jsonResponse(200, {
          accessToken: "sat_host_mismatch",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.pathname.endsWith("/runtime/bootstrap")) {
        bootstrapRequests += 1;
        return jsonResponse(500, {});
      }
      if (request.method === "GET" && url.pathname === `/servers/${serverId}`) {
        return jsonResponse(200, {
          task: {
            serverId,
            state: "ready",
            publicIp: "203.0.113.10",
            sshFingerprint: identity.sshFingerprint,
          },
        });
      }
      throw new Error(`Unexpected test request: ${request.method} ${url.pathname}`);
    };
    const spawnImpl = (command, args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stderr.end("Host key verification failed.\n");
        child.stdout.end();
        child.emit("close", command === "ssh" ? 255 : 0);
      });
      return child;
    };
    const exitCode = await main(
      [
        "runtime",
        "install",
        "--server",
        serverId,
        "--identity",
        identity.privateKeyPath,
        "--ssh-user",
        "root",
        "--confirm",
        "INSTALL",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      { stdout: stdout.stream, stderr: stderr.stream, env: {}, fetchImpl, spawnImpl },
    );
    assert.equal(exitCode, 4);
    assert.equal(stdout.value(), "");
    assert.equal(bootstrapRequests, 0);
    assert.equal(JSON.parse(stderr.value()).error.code, "host_trust_authentication_failed");
    assert.equal(
      await readFile(join(pinDirectory, "initial.known_hosts"), "utf8"),
      ed25519HostKeyLine("203.0.113.10"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI prepares, challenges, and submits without exposing the owner token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-cli-test-"));
  const requests = [];
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(url);
    const headers = new Headers(request.headers);
    requests.push({
      method: request.method,
      url: parsed.pathname,
      body: request.body || "",
      authorization: headers.get("authorization") || undefined,
      idempotencyKey: headers.get("idempotency-key") || undefined,
      paymentSignature: headers.get("payment-signature") || undefined,
    });

    if (request.method === "GET" && parsed.pathname === "/health") {
      return jsonResponse(200, { status: "ok", purchasingReady: true });
    }
    if (request.method === "GET" && parsed.pathname === "/catalog") {
      return jsonResponse(200, {
        products: [
          {
            id: "agent",
            priceUsd: 30,
            termDays: 30,
            operatingSystems: [{ name: "Ubuntu 24.04 LTS" }],
          },
        ],
      });
    }
    if (request.method === "POST" && parsed.pathname === "/orders") {
      return jsonResponse(201, {
        task: {
          id: "task_test",
          serverId: "server_test",
          planId: "agent",
          checkoutPath: "/checkout/agent",
          state: "prepared",
        },
        ownerToken: "owner_secret_value",
        warning: "Store this token safely.",
      });
    }
    if (request.method === "GET" && parsed.pathname === "/tasks/task_test") {
      return jsonResponse(200, {
        task: {
          id: "task_test",
          serverId: "server_test",
          state: "ready",
          publicIp: "192.0.2.10",
        },
      });
    }
    if (
      request.method === "GET" &&
      parsed.pathname === "/servers/server_test/notifications"
    ) {
      return jsonResponse(200, {
        configured: false,
        setupRecommended: true,
        supportedEvents: ["renewal.due", "wallet.refill_required"],
      });
    }
    if (
      request.method === "POST" &&
      parsed.pathname === "/checkout/agent"
    ) {
      if (!headers.get("payment-signature")) {
        return jsonResponse(
          402,
          {
            status: "payment_required",
            paymentAttemptId: "payment_test",
            challengeDigest: authoritativeChallengeDigest,
            humanCheckout: {
              url: hostedCheckoutUrl,
              qrPayload: hostedCheckoutUrl,
              expiresAt: hostedCheckoutExpiresAt,
            },
          },
          {
            "payment-required": paymentRequiredHeader,
            "x-x402api-challenge-handle": "charge_test",
            "x-x402api-challenge-digest": authoritativeChallengeDigest,
          },
        );
      }
      return jsonResponse(202, {
        status: "provisioning",
        paymentId: "00000000-0000-4000-8000-000000000012",
        confirmed: true,
        finalized: false,
        task: { id: "task_test", state: "provisioning" },
      });
    }
    return jsonResponse(404, { error: { message: "Not found" } });
  };

  const baseUrl = "https://api.warpmetal.test";
  const stateDirectory = join(directory, "state");
  const publicKeyPath = join(directory, "id_ed25519.pub");
  const signaturePath = join(directory, "payment-signature.txt");
  await writeFile(
    publicKeyPath,
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestWarpMetalKey agent@example.test\n",
    "utf8",
  );
  await writeFile(signaturePath, "signed_header_value\n", "utf8");

  try {
    const prepareOut = capture();
    const prepareErr = capture();
    const prepareExit = await main(
      [
        "order",
        "prepare",
        "--plan",
        "agent",
        "--hostname",
        "agent-box",
        "--os",
        "Ubuntu 24.04 LTS",
        "--ssh-public-key-file",
        publicKeyPath,
        "--idempotency-key",
        "order_test_key",
        "--base-url",
        baseUrl,
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: prepareOut.stream,
        stderr: prepareErr.stream,
        env: {},
        cwd: directory,
        fetchImpl,
      },
    );
    assert.equal(prepareExit, 0, prepareErr.value());
    assert.equal(prepareOut.value().includes("owner_secret_value"), false);
    assert.equal(prepareErr.value(), "");

    const orderRequest = requests.find(({ url }) => url === "/orders");
    assert.equal(orderRequest.idempotencyKey, "order_test_key");
    assert.deepEqual(JSON.parse(orderRequest.body), {
      planId: "agent",
      hostname: "agent-box",
      osName: "Ubuntu 24.04 LTS",
      sshPublicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestWarpMetalKey agent@example.test",
      sshKeyLabel: "warpmetal-id_ed25519",
    });

    const challengeOut = capture();
    const challengeErr = capture();
    const challengeExit = await main(
      [
        "checkout",
        "challenge",
        "--task",
        "task_test",
        "--base-url",
        baseUrl,
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: challengeOut.stream,
        stderr: challengeErr.stream,
        env: {},
        cwd: directory,
        fetchImpl,
      },
    );
    assert.equal(challengeExit, 7, challengeErr.value());
    assert.equal(
      JSON.parse(challengeOut.value()).paymentRequired,
      paymentRequiredHeader,
    );
    const challenge = JSON.parse(challengeOut.value());
    assert.equal(challenge.challengeHandle, "charge_test");
    assert.deepEqual(challenge.humanCheckout, {
      url: hostedCheckoutUrl,
      qrPayload: hostedCheckoutUrl,
      expiresAt: hostedCheckoutExpiresAt,
      afterPayment: {
        argv: [
          "warpmetal",
          "order",
          "status",
          "--task",
          "task_test",
          "--wait",
          "--base-url",
          baseUrl,
          "--state-dir",
          stateDirectory,
          "--json",
        ],
        notificationNextAction: "ask_human_for_notification_email",
      },
    });
    assert.deepEqual(challenge.paymentTerms[0], {
      scheme: "exact",
      network: "eip155:8453",
      amountAtomic: "20000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 180,
      payloadProfile: "com.x402api.x402.base-usdc-eip3009-sponsored.v1",
      agentWalletSupported: true,
      sponsoredNetworkFee: true,
      buyerNativeFeeRequired: false,
      sponsorshipExpiresAt: "2099-01-01T00:00:00.000Z",
      requirementDigest: challenge.paymentTerms[0].requirementDigest,
    });
    assert.equal(challenge.paymentWorkflow.signerExecutable, "x402api");
    assert.deepEqual(challenge.paymentWorkflow.signerPackage, {
      name: "@x402api/agent-wallet-cli",
      version: "0.2.9",
      spec: "@x402api/agent-wallet-cli@0.2.9",
      registryUrl: "https://www.npmjs.com/package/@x402api/agent-wallet-cli",
      install: {
        argv: ["npm", "install", "--global", "@x402api/agent-wallet-cli@0.2.9"],
      },
    });
    assert.deepEqual(challenge.paymentWorkflow.signerContract.probe.argv, [
      "x402api",
      "help",
      "--json",
    ]);
    assert.deepEqual(challenge.paymentWorkflow.signerContract.requiredCommands, [
      "payment authorize --wallet <name> --request-envelope <file> --artifact-out <file>",
    ]);
    assert.deepEqual(challenge.paymentWorkflow.walletWorkflow.setup.argv, [
      "x402api",
      "wallet",
      "setup",
      "--json",
    ]);
    assert.deepEqual(challenge.paymentWorkflow.sequence, [
      "wallet_setup",
      "wallet_list",
      "wallet_create_if_needed",
      "wallet_address_balance_funding",
      "payment_authorize",
      "warpmetal_submit",
    ]);
    assert.deepEqual(challenge.paymentWorkflow.walletWorkflow.list.argv, [
      "x402api",
      "wallet",
      "list",
      "--json",
    ]);
    assert.deepEqual(
      challenge.paymentWorkflow.walletWorkflow.createOptions[0].argv,
      [
        "x402api",
        "wallet",
        "create",
        "--name",
        "<wallet-name>",
        "--network",
        "eip155:8453",
        "--maximum-payment-atomic",
        "20000000",
        "--json",
      ],
    );
    assert.deepEqual(challenge.paymentWorkflow.authorize.argv.slice(0, 3), [
      "x402api",
      "payment",
      "authorize",
    ]);
    assert.deepEqual(challenge.paymentWorkflow.fundingWorkflow.address.argv, [
      "x402api",
      "wallet",
      "address",
      "--wallet",
      "<wallet-name>",
      "--json",
    ]);
    assert.deepEqual(challenge.paymentWorkflow.fundingWorkflow.funding.argv, [
      "x402api",
      "wallet",
      "funding",
      "--wallet",
      "<wallet-name>",
      "--asset",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "--target-balance-atomic",
      "20000000",
      "--json",
    ]);
    assert.equal(challenge.paymentWorkflow.fundingWorkflow.presentation.showQr, true);
    assert.equal(
      challenge.paymentWorkflow.fundingWorkflow.presentation.showAddressString,
      true,
    );
    assert.equal(
      challenge.paymentWorkflow.submit.argv.includes("--payment-artifact"),
      true,
    );
    const requestEnvelope = JSON.parse(
      await readFile(challenge.paymentWorkflow.requestEnvelopePath, "utf8"),
    );
    assert.deepEqual(requestEnvelope, {
      version: 1,
      method: "POST",
      url: "https://api.warpmetal.test/checkout/agent",
      contentType: "application/json",
      bodyBase64: Buffer.from('{"taskId":"task_test"}').toString("base64"),
      paymentRequired: paymentRequiredHeader,
      challengeDigest: challenge.paymentChallengeDigest,
      merchantReference: "task_test",
    });
    assert.equal(
      JSON.stringify(requestEnvelope).includes("owner_secret_value"),
      false,
    );
    assert.equal(JSON.stringify(requestEnvelope).includes("charge_test"), false);
    assert.equal(JSON.stringify(requestEnvelope).includes(hostedCheckoutUrl), false);
    assert.equal(
      Object.hasOwn(requestEnvelope, "challengeHandle"),
      false,
    );
    assert.equal(
      Object.hasOwn(await new StateStore(stateDirectory).order("task_test"), "humanCheckout"),
      false,
    );

    const humanChallengeOut = capture();
    const humanChallengeErr = capture();
    const humanChallengeExit = await main(
      [
        "checkout",
        "challenge",
        "--task",
        "task_test",
        "--base-url",
        baseUrl,
        "--state-dir",
        stateDirectory,
      ],
      {
        stdout: humanChallengeOut.stream,
        stderr: humanChallengeErr.stream,
        env: {},
        cwd: directory,
        fetchImpl,
      },
    );
    assert.equal(humanChallengeExit, 7, humanChallengeErr.value());
    assert.match(humanChallengeOut.value(), /Hosted human checkout \(optional/);
    assert.equal(humanChallengeOut.value().includes(hostedCheckoutUrl), true);
    assert.match(
      humanChallengeOut.value(),
      /scanning opens the checkout and does not authorize payment/,
    );
    assert.match(humanChallengeOut.value(), /x402api owns wallet selection/);
    assert.doesNotMatch(humanChallengeOut.value(), /purchase QR|Direct wallet checkout/);
    assert.match(humanChallengeOut.value(), /warpmetal order status/);
    assert.match(humanChallengeOut.value(), /lifecycle-notification email/);

    const statusOut = capture();
    const statusErr = capture();
    const statusExit = await main(challenge.humanCheckout.afterPayment.argv.slice(1), {
      stdout: statusOut.stream,
      stderr: statusErr.stream,
      env: {},
      cwd: directory,
      fetchImpl,
    });
    assert.equal(statusExit, 0, statusErr.value());
    assert.equal(
      JSON.parse(statusOut.value()).nextAction.action,
      "ask_human_for_notification_email",
    );

    const submitOut = capture();
    const submitErr = capture();
    const submitExit = await main(
      [
        "checkout",
        "submit",
        "--task",
        "task_test",
        "--payment-signature-file",
        signaturePath,
        "--base-url",
        baseUrl,
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: submitOut.stream,
        stderr: submitErr.stream,
        env: {},
        cwd: directory,
        fetchImpl,
      },
    );
    assert.equal(submitExit, 0, submitErr.value());
    assert.equal(JSON.parse(submitOut.value()).status, "provisioning");
    assert.equal(JSON.parse(submitOut.value()).confirmed, true);
    assert.equal(JSON.parse(submitOut.value()).finalized, false);
    assert.equal(
      JSON.parse(submitOut.value()).paymentId,
      "00000000-0000-4000-8000-000000000012",
    );

    const artifactSignature = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: paymentRequirement,
        payload: { signature: "fixture" },
        extensions: {
          ...paymentRequired.extensions,
          "payment-identifier": {
            info: { required: true, id: "buyer_payment_test_123" },
          },
        },
        resource: paymentRequired.resource,
      }),
      "utf8",
    ).toString("base64");
    const artifactPath = challenge.paymentWorkflow.paymentArtifactPath;
    await writeFile(
      artifactPath,
      `${JSON.stringify({
        version: 1,
        attemptId: "00000000-0000-4000-8000-000000000001",
        requestDigest: challenge.paymentRequestDigest,
        buyerPaymentIdentifier: "buyer_payment_test_123",
        wallet: "warpmetal-base",
        payerAddress: "0x2222222222222222222222222222222222222222",
        selectedRequirementDigest: challenge.paymentTerms[0].requirementDigest,
        paymentSignature: artifactSignature,
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const artifactOut = capture();
    const artifactErr = capture();
    const artifactExit = await main(
      [
        "checkout",
        "submit",
        "--task",
        "task_test",
        "--payment-artifact",
        artifactPath,
        "--base-url",
        baseUrl,
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: artifactOut.stream,
        stderr: artifactErr.stream,
        env: {},
        cwd: directory,
        fetchImpl,
      },
    );
    assert.equal(artifactExit, 0, artifactErr.value());
    const artifactResult = JSON.parse(artifactOut.value());
    assert.equal(artifactResult.walletPayment.wallet, "warpmetal-base");
    assert.equal(
      JSON.stringify(artifactResult).includes(artifactSignature),
      false,
    );

    const checkoutRequests = requests.filter(
      ({ url }) => url === "/checkout/agent",
    );
    assert.equal(checkoutRequests.length, 4);
    assert.deepEqual(
      checkoutRequests.map(({ body }) => body),
      [
        '{"taskId":"task_test"}',
        '{"taskId":"task_test"}',
        '{"taskId":"task_test"}',
        '{"taskId":"task_test"}',
      ],
    );
    assert.deepEqual(
      checkoutRequests.map(({ authorization }) => authorization),
      [
        "Bearer owner_secret_value",
        "Bearer owner_secret_value",
        "Bearer owner_secret_value",
        "Bearer owner_secret_value",
      ],
    );
    assert.deepEqual(
      checkoutRequests.map(({ paymentSignature }) => paymentSignature),
      [undefined, undefined, "signed_header_value", artifactSignature],
    );

    const stateListOut = capture();
    const stateListExit = await main(
      ["state", "list", "--state-dir", stateDirectory, "--json"],
      {
        stdout: stateListOut.stream,
        stderr: capture().stream,
        env: {},
        cwd: directory,
        fetchImpl,
      },
    );
    assert.equal(stateListExit, 0);
    assert.equal(stateListOut.value().includes("owner_secret_value"), false);
    assert.equal(
      JSON.parse(stateListOut.value()).orders[0].walletPaymentAttemptId,
      "00000000-0000-4000-8000-000000000001",
    );
    assert.equal(
      JSON.parse(stateListOut.value()).orders[0].paymentId,
      "00000000-0000-4000-8000-000000000012",
    );
    assert.equal(JSON.parse(stateListOut.value()).orders[0].paymentConfirmed, true);
    assert.equal(JSON.parse(stateListOut.value()).orders[0].paymentFinalized, false);
    assert.equal(
      (await readFile(join(stateDirectory, "state.json"), "utf8")).includes(
        "owner_secret_value",
      ),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("confirmed checkout stops exact payment replay before receipt finality", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-confirmed-payment-test-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  const signaturePath = join(directory, "payment-signature.txt");
  await store.savePreparedOrder(
    {
      task: {
        id: "task_confirmed_payment",
        serverId: "server_confirmed_payment",
        planId: "agent",
        checkoutPath: "/checkout/agent",
      },
      ownerToken: "owner-secret",
    },
    '{"taskId":"task_confirmed_payment"}',
  );
  await writeFile(signaturePath, "signed-payment\n", { mode: 0o600 });
  let submissions = 0;
  const fetchImpl = async () => {
    submissions += 1;
    return jsonResponse(202, {
      status: "payment_finalizing",
      paymentId: "00000000-0000-4000-8000-000000000012",
      confirmed: true,
      finalized: false,
      task: { id: "task_confirmed_payment", state: "paid" },
    });
  };

  try {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await main(
      [
        "checkout",
        "submit",
        "--task",
        "task_confirmed_payment",
        "--payment-signature-file",
        signaturePath,
        "--wait",
        "--timeout-seconds",
        "1",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      { stdout: stdout.stream, stderr: stderr.stream, env: {}, cwd: directory, fetchImpl },
    );

    assert.equal(exitCode, 0, stderr.value());
    assert.equal(submissions, 1);
    const output = JSON.parse(stdout.value());
    assert.equal(output.confirmed, true);
    assert.equal(output.finalized, false);
    const summary = await store.summary();
    assert.equal(summary.orders[0].paymentConfirmed, true);
    assert.equal(summary.orders[0].paymentFinalized, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkout restart retries the exact artifact and stops after confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-payment-restart-test-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  await store.savePreparedOrder(
    {
      task: {
        id: "task_payment_restart",
        serverId: "server_payment_restart",
        planId: "agent",
        checkoutPath: "/checkout/agent",
      },
      ownerToken: "owner-secret",
    },
    '{"taskId":"task_payment_restart"}',
  );
  const submitted = [];
  const fetchImpl = async (_url, request = {}) => {
    const headers = new Headers(request.headers);
    const paymentSignature = headers.get("payment-signature");
    if (!paymentSignature) {
      return jsonResponse(
        402,
        {
          status: "payment_required",
          paymentAttemptId: "payment_restart",
          challengeDigest: authoritativeChallengeDigest,
        },
        {
          "payment-required": paymentRequiredHeader,
          "x-x402api-challenge-handle": "charge_restart",
          "x-x402api-challenge-digest": authoritativeChallengeDigest,
        },
      );
    }
    submitted.push({ body: request.body, paymentSignature });
    if (submitted.length === 1) {
      return jsonResponse(202, {
        status: "payment_pending",
        paymentId: "00000000-0000-4000-8000-000000000013",
        confirmed: false,
        finalized: false,
      });
    }
    return jsonResponse(202, {
      status: "provisioning",
      paymentId: "00000000-0000-4000-8000-000000000013",
      confirmed: true,
      finalized: false,
      task: { id: "task_payment_restart", state: "provisioning" },
    });
  };

  try {
    const challengeOut = capture();
    const challengeExit = await main(
      [
        "checkout",
        "challenge",
        "--task",
        "task_payment_restart",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: challengeOut.stream,
        stderr: capture().stream,
        env: {},
        cwd: directory,
        fetchImpl,
      },
    );
    assert.equal(challengeExit, 7);
    const challenge = JSON.parse(challengeOut.value());
    const artifactSignature = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: paymentRequirement,
        payload: { signature: "restart-fixture" },
        extensions: {
          ...paymentRequired.extensions,
          "payment-identifier": {
            info: { required: true, id: "buyer_payment_restart_123" },
          },
        },
        resource: paymentRequired.resource,
      }),
      "utf8",
    ).toString("base64");
    const artifactPath = challenge.paymentWorkflow.paymentArtifactPath;
    await writeFile(
      artifactPath,
      `${JSON.stringify({
        version: 1,
        attemptId: "00000000-0000-4000-8000-000000000014",
        requestDigest: challenge.paymentRequestDigest,
        buyerPaymentIdentifier: "buyer_payment_restart_123",
        wallet: "warpmetal-base",
        payerAddress: "0x2222222222222222222222222222222222222222",
        selectedRequirementDigest: challenge.paymentTerms[0].requirementDigest,
        paymentSignature: artifactSignature,
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const submitArgv = [
      "checkout",
      "submit",
      "--task",
      "task_payment_restart",
      "--payment-artifact",
      artifactPath,
      "--base-url",
      "https://api.warpmetal.test",
      "--state-dir",
      stateDirectory,
      "--json",
    ];

    const pendingOut = capture();
    const pendingExit = await main(submitArgv, {
      stdout: pendingOut.stream,
      stderr: capture().stream,
      env: {},
      cwd: directory,
      fetchImpl,
    });
    assert.equal(pendingExit, 8);
    assert.equal(JSON.parse(pendingOut.value()).confirmed, false);

    const confirmedOut = capture();
    const confirmedErr = capture();
    const confirmedExit = await main(submitArgv, {
      stdout: confirmedOut.stream,
      stderr: confirmedErr.stream,
      env: {},
      cwd: directory,
      fetchImpl,
    });
    assert.equal(confirmedExit, 0, confirmedErr.value());
    assert.equal(JSON.parse(confirmedOut.value()).confirmed, true);
    assert.equal(JSON.parse(confirmedOut.value()).finalized, false);
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[0], submitted[1]);
    assert.equal(submitted[0].paymentSignature, artifactSignature);
    const summary = await new StateStore(stateDirectory).summary();
    assert.equal(summary.orders[0].paymentConfirmed, true);
    assert.equal(summary.orders[0].paymentFinalized, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkout rejects contradictory confirmation and finality flags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-payment-flags-test-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  const signaturePath = join(directory, "payment-signature.txt");
  await store.savePreparedOrder(
    {
      task: {
        id: "task_invalid_payment_flags",
        serverId: "server_invalid_payment_flags",
        planId: "agent",
        checkoutPath: "/checkout/agent",
      },
      ownerToken: "owner-secret",
    },
    '{"taskId":"task_invalid_payment_flags"}',
  );
  await writeFile(signaturePath, "signed-payment\n", { mode: 0o600 });

  try {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await main(
      [
        "checkout",
        "submit",
        "--task",
        "task_invalid_payment_flags",
        "--payment-signature-file",
        signaturePath,
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        cwd: directory,
        fetchImpl: async () =>
          jsonResponse(202, {
            status: "provisioning",
            paymentId: "00000000-0000-4000-8000-000000000012",
            confirmed: false,
            finalized: true,
          }),
      },
    );

    assert.equal(exitCode, 3);
    assert.equal(stdout.value(), "");
    assert.match(stderr.value(), /contradictory payment lifecycle evidence/);
    assert.equal((await store.summary()).orders[0].paymentId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkout challenge fails closed without the x402api challenge handle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-handle-test-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_missing_handle",
          serverId: "server_missing_handle",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "owner_missing_handle",
      },
      '{"taskId":"task_missing_handle"}',
    );
    const stdout = capture();
    const stderr = capture();
    const exitCode = await main(
      [
        "checkout",
        "challenge",
        "--task",
        "task_missing_handle",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async () =>
          jsonResponse(
            402,
            { status: "payment_required", paymentAttemptId: "payment_missing_handle" },
            { "payment-required": paymentRequiredHeader },
          ),
      },
    );

    assert.equal(exitCode, 1);
    assert.equal(stdout.value(), "");
    assert.match(stderr.value(), /without X-X402API-Challenge-Handle/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkout challenge rejects an untrusted hosted-checkout capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-hosted-checkout-test-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_bad_hosted_checkout",
          serverId: "server_bad_hosted_checkout",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "owner_bad_hosted_checkout",
      },
      '{"taskId":"task_bad_hosted_checkout"}',
    );
    const stdout = capture();
    const stderr = capture();
    const exitCode = await main(
      [
        "checkout",
        "challenge",
        "--task",
        "task_bad_hosted_checkout",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async () =>
          jsonResponse(
            402,
            {
              status: "payment_required",
              paymentAttemptId: "payment_bad_hosted_checkout",
              challengeDigest: authoritativeChallengeDigest,
              humanCheckout: {
                url: `https://attacker.example/c/chk_${"a".repeat(32)}`,
                qrPayload: `https://attacker.example/c/chk_${"a".repeat(32)}`,
                expiresAt: hostedCheckoutExpiresAt,
              },
            },
            {
              "payment-required": paymentRequiredHeader,
              "x-x402api-challenge-handle": "charge_bad_hosted_checkout",
              "x-x402api-challenge-digest": authoritativeChallengeDigest,
            },
          ),
      },
    );

    assert.equal(exitCode, 1);
    assert.equal(stdout.value(), "");
    assert.match(stderr.value(), /invalid hosted checkout URL/);

    const expiryOut = capture();
    const expiryErr = capture();
    const expiryExit = await main(
      [
        "checkout",
        "challenge",
        "--task",
        "task_bad_hosted_checkout",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: expiryOut.stream,
        stderr: expiryErr.stream,
        env: {},
        fetchImpl: async () =>
          jsonResponse(
            402,
            {
              status: "payment_required",
              paymentAttemptId: "payment_bad_hosted_expiry",
              challengeDigest: authoritativeChallengeDigest,
              humanCheckout: {
                url: hostedCheckoutUrl,
                qrPayload: hostedCheckoutUrl,
                expiresAt: "09/07/2099",
              },
            },
            {
              "payment-required": paymentRequiredHeader,
              "x-x402api-challenge-handle": "charge_bad_hosted_expiry",
              "x-x402api-challenge-digest": authoritativeChallengeDigest,
            },
          ),
      },
    );
    assert.equal(expiryExit, 1);
    assert.equal(expiryOut.value(), "");
    assert.match(expiryErr.value(), /invalid or expired hosted checkout expiry/);
    assert.equal(
      Object.hasOwn(await store.order("task_bad_hosted_checkout"), "humanCheckout"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkout challenge fails closed without the authoritative challenge digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-digest-test-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_missing_digest",
          serverId: "server_missing_digest",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "owner_missing_digest",
      },
      '{"taskId":"task_missing_digest"}',
    );
    const stdout = capture();
    const stderr = capture();
    const exitCode = await main(
      [
        "checkout",
        "challenge",
        "--task",
        "task_missing_digest",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async () =>
          jsonResponse(
            402,
            { status: "payment_required", paymentAttemptId: "payment_missing_digest" },
            {
              "payment-required": paymentRequiredHeader,
              "x-x402api-challenge-handle": "charge_missing_digest",
            },
          ),
      },
    );

    assert.equal(exitCode, 1);
    assert.equal(stdout.value(), "");
    assert.match(stderr.value(), /without X-X402API-Challenge-Digest/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("signed HTTP 402 without a payment ID preserves safe rejection diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-rejected-payment-test-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  const signaturePath = join(directory, "payment-signature.txt");
  await store.savePreparedOrder(
    {
      task: {
        id: "task_rejected_payment",
        serverId: "server_rejected_payment",
        planId: "agent",
        checkoutPath: "/checkout/agent",
      },
      ownerToken: "owner-secret",
    },
    '{"taskId":"task_rejected_payment"}',
  );
  await writeFile(signaturePath, "signed-payment\n", { mode: 0o600 });
  const fetchImpl = async () =>
    jsonResponse(
      402,
      {
        status: "payment_rejected",
        paymentAttemptId: "attempt-rejected",
        errorCode: "structured_compliance_not_allowed",
        requestId: "74ad1e25-b820-4979-841d-c790b5c98639",
        replacementAllowed: false,
      },
      { "payment-response": "terminal-settlement-evidence" },
    );

  try {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await main(
      [
        "checkout",
        "submit",
        "--task",
        "task_rejected_payment",
        "--payment-signature-file",
        signaturePath,
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      { stdout: stdout.stream, stderr: stderr.stream, env: {}, cwd: directory, fetchImpl },
    );

    assert.equal(exitCode, 7, stderr.value());
    const output = JSON.parse(stdout.value());
    assert.equal(output.status, "payment_rejected");
    assert.equal(output.paymentId, undefined);
    assert.equal(output.errorCode, "structured_compliance_not_allowed");
    assert.equal(output.requestId, "74ad1e25-b820-4979-841d-c790b5c98639");
    assert.equal(output.replacementAllowed, false);
    const order = await store.order("task_rejected_payment");
    assert.equal(order.gatewayPaymentId, undefined);
    assert.equal(order.rejectedPaymentAttemptId, "attempt-rejected");
    assert.equal(
      order.paymentRejectionErrorCode,
      "structured_compliance_not_allowed",
    );
    assert.equal(
      order.paymentRejectionRequestId,
      "74ad1e25-b820-4979-841d-c790b5c98639",
    );
    assert.equal(order.paymentReplacementAllowed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkout challenge guides a human through wallet onboarding before authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-wallet-guide-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_wallet_guide",
          serverId: "server_wallet_guide",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "owner_wallet_guide",
      },
      '{"taskId":"task_wallet_guide"}',
    );
    const stdout = capture();
    const stderr = capture();
    const exitCode = await main(
      [
        "checkout",
        "challenge",
        "--task",
        "task_wallet_guide",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        cwd: directory,
        fetchImpl: async () =>
          jsonResponse(
            402,
            {
              status: "payment_required",
              paymentAttemptId: "payment_wallet_guide",
              challengeDigest: authoritativeChallengeDigest,
            },
            {
              "payment-required": paymentRequiredHeader,
              "x-x402api-challenge-handle": "charge_wallet_guide",
              "x-x402api-challenge-digest": authoritativeChallengeDigest,
            },
          ),
      },
    );

    assert.equal(exitCode, 7, stderr.value());
    assert.equal(stderr.value(), "");
    const output = stdout.value();
    const setupAt = output.indexOf("x402api wallet setup --json");
    const listAt = output.indexOf("x402api wallet list --json");
    const createAt = output.indexOf("x402api wallet create --name");
    const addressAt = output.indexOf("x402api wallet address --wallet");
    const balanceAt = output.indexOf("x402api wallet balance --wallet");
    const fundingAt = output.indexOf("x402api wallet funding --wallet");
    const authorizeAt = output.indexOf("x402api payment authorize --wallet");
    const submitAt = output.indexOf("warpmetal checkout submit --task");
    assert.ok(
      [setupAt, listAt, createAt, addressAt, balanceAt, fundingAt, authorizeAt, submitAt]
        .every((index) => index >= 0),
      output,
    );
    assert.deepEqual(
      [setupAt, listAt, createAt, addressAt, balanceAt, fundingAt, authorizeAt, submitAt],
      [...[setupAt, listAt, createAt, addressAt, balanceAt, fundingAt, authorizeAt, submitAt]].sort(
        (left, right) => left - right,
      ),
    );
    assert.match(output, /--network eip155:8453/);
    assert.match(output, new RegExp(`--asset ${paymentRequirement.asset}`));
    assert.match(output, /--target-balance-atomic 20000000/);
    assert.equal(output.includes("owner_wallet_guide"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("power changes require the same explicit confirmation", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(
    [
      "server",
      "power",
      "--server",
      "server_test",
      "--action",
      "reboot",
      "--confirm",
      "shutdown",
      "--base-url",
      "http://127.0.0.1:1",
    ],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {},
      fetchImpl: async () => {
        throw new Error("power confirmation should fail before an API request");
      },
    },
  );
  assert.equal(exitCode, 2);
  assert.match(stderr.value(), /--confirm reboot/);
});

test("renewal run all-due returns exact autonomous payment and refill actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-renewal-run-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  const baseUrl = "https://api.warpmetal.test";
  const renewalRequired = {
    ...paymentRequired,
    resource: {
      ...paymentRequired.resource,
      url: `${baseUrl}/checkout/agent/renew`,
    },
  };
  const renewalHeader = Buffer.from(
    JSON.stringify(renewalRequired),
    "utf8",
  ).toString("base64");
  const policy = {
    serverId: "server_renewal",
    enabled: true,
    renewBeforeDays: 3,
    maximumPaymentAtomic: "30000000",
    maximumRenewals: 12,
    renewThrough: null,
    maximumTotalSpendAtomic: "360000000",
    renewalsCompleted: 0,
    totalSpendAtomic: "0",
    allowedNetwork: paymentRequirement.network,
    allowedAsset: paymentRequirement.asset.toLowerCase(),
    notificationReference: "wmref_test-renewal",
    nextAction: "sign_payment",
    reason: null,
  };
  let notificationsActive = true;
  let renewalConfirmed = false;
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_renewal",
          serverId: "server_renewal",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "renewal_owner_secret",
      },
      '{"taskId":"task_renewal"}',
    );
    await store.saveRenewalPolicy(
      "server_renewal",
      policy,
      "renewal-wallet",
      "30000000",
    );
    const fetchImpl = async (url, request = {}) => {
      const path = new URL(url).pathname;
      if (request.method === "GET" && path === "/servers/server_renewal") {
        return jsonResponse(200, {
          task: {
            id: "task_renewal",
            serverId: "server_renewal",
            planId: "agent",
            state: "ready",
            termEndsAt: "2099-02-01T00:00:00.000Z",
          },
        });
      }
      if (
        request.method === "GET" &&
        path === "/servers/server_renewal/renewal-policy"
      ) {
        return jsonResponse(200, { configured: true, policy });
      }
      if (
        request.method === "GET" &&
        path === "/servers/server_renewal/notifications"
      ) {
        return jsonResponse(200, {
          configured: true,
          subscription: {
            reference: "wmref_test-renewal",
            disabled: false,
            events: ["wallet.refill_required"],
            recipients: notificationsActive
              ? [{ id: "nrcp_operator", email: "o***@example.com", status: "active" }]
              : [],
          },
          supportedEvents: ["wallet.refill_required"],
        });
      }
      if (
        request.method === "POST" &&
        path === "/checkout/agent/renew"
      ) {
        if (renewalConfirmed) {
          return jsonResponse(200, {
            status: "renewed",
            paymentId: "00000000-0000-4000-8000-000000000022",
            confirmed: true,
            finalized: false,
            task: {
              id: "task_renewal",
              serverId: "server_renewal",
              state: "ready",
              termEndsAt: "2099-03-03T00:00:00.000Z",
            },
          });
        }
        return jsonResponse(
          402,
          {
            status: "payment_required",
            paymentAttemptId: "payment_renewal",
            challengeDigest: authoritativeChallengeDigest,
            humanCheckout: {
              url: hostedCheckoutUrl,
              qrPayload: hostedCheckoutUrl,
              expiresAt: hostedCheckoutExpiresAt,
            },
          },
          {
            "payment-required": renewalHeader,
            "x-x402api-challenge-handle": "charge_renewal",
            "x-x402api-challenge-digest": authoritativeChallengeDigest,
          },
        );
      }
      return jsonResponse(404, { error: { message: "Not found" } });
    };
    const stdout = capture();
    const stderr = capture();
    const exitCode = await main(
      [
        "renewal",
        "run",
        "--all-due",
        "--base-url",
        baseUrl,
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      { stdout: stdout.stream, stderr: stderr.stream, env: {}, fetchImpl },
    );
    assert.equal(exitCode, 7, stderr.value());
    const output = JSON.parse(stdout.value());
    assert.equal(output.action, "batch");
    assert.equal(output.results[0].action, "sign_payment");
    assert.equal(output.results[0].challengeHandle, "charge_renewal");
    assert.equal(Object.hasOwn(output.results[0], "humanCheckout"), false);
    assert.deepEqual(output.results[0].paymentWorkflow.authorize.argv.slice(0, 3), [
      "x402api",
      "payment",
      "authorize",
    ]);
    assert.equal(
      output.results[0].refillWorkflow.environment.X402API_NOTIFICATION_URL,
      `${baseUrl}/notifications/x402api/refill`,
    );
    assert.equal(
      output.results[0].refillWorkflow.argv.includes("wmref_test-renewal"),
      true,
    );
    assert.equal(output.results[0].refillNotification.available, true);
    assert.deepEqual(
      output.results[0].paymentWorkflow.fundingWorkflow.address.argv,
      [
        "x402api",
        "wallet",
        "address",
        "--wallet",
        "renewal-wallet",
        "--json",
      ],
    );
    assert.equal(
      output.results[0].paymentWorkflow.fundingWorkflow.targetBalanceAtomic,
      "30000000",
    );
    assert.deepEqual(
      output.results[0].paymentWorkflow.fundingWorkflow.funding.argv,
      [
        "x402api",
        "wallet",
        "funding",
        "--wallet",
        "renewal-wallet",
        "--asset",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "--target-balance-atomic",
        "30000000",
        "--json",
      ],
    );

    notificationsActive = false;
    const unverifiedOut = capture();
    const unverifiedErr = capture();
    const unverifiedExit = await main(
      [
        "renewal",
        "run",
        "--all-due",
        "--base-url",
        baseUrl,
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: unverifiedOut.stream,
        stderr: unverifiedErr.stream,
        env: {},
        fetchImpl,
      },
    );
    assert.equal(unverifiedExit, 7, unverifiedErr.value());
    const unverified = JSON.parse(unverifiedOut.value()).results[0];
    assert.equal(unverified.refillWorkflow, undefined);
    assert.equal(unverified.refillNotification.available, false);
    assert.equal(
      unverified.refillNotification.reason,
      "active_notification_recipient_required",
    );
    assert.equal(unverified.paymentWorkflow.fundingWorkflow.action, "fund_wallet");

    const artifactSignature = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: paymentRequirement,
        payload: { signature: "renewal-fixture" },
        extensions: {
          ...renewalRequired.extensions,
          "payment-identifier": {
            info: { required: true, id: "buyer_renewal_payment_123" },
          },
        },
        resource: renewalRequired.resource,
      }),
      "utf8",
    ).toString("base64");
    const artifactPath = unverified.paymentWorkflow.paymentArtifactPath;
    await writeFile(
      artifactPath,
      `${JSON.stringify({
        version: 1,
        attemptId: "00000000-0000-4000-8000-000000000021",
        requestDigest: unverified.paymentRequestDigest,
        buyerPaymentIdentifier: "buyer_renewal_payment_123",
        wallet: "renewal-wallet",
        payerAddress: "0x2222222222222222222222222222222222222222",
        selectedRequirementDigest: unverified.paymentTerms[0].requirementDigest,
        paymentSignature: artifactSignature,
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    renewalConfirmed = true;
    const submitOut = capture();
    const submitErr = capture();
    const submitExit = await main(
      [
        "renewal",
        "submit",
        "--server",
        "server_renewal",
        "--payment-artifact",
        artifactPath,
        "--wait",
        "--base-url",
        baseUrl,
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      { stdout: submitOut.stream, stderr: submitErr.stream, env: {}, fetchImpl },
    );
    assert.equal(submitExit, 0, submitErr.value());
    const submitted = JSON.parse(submitOut.value());
    assert.equal(submitted.status, "renewed");
    assert.equal(submitted.confirmed, true);
    assert.equal(submitted.finalized, false);
    const state = await store.summary();
    assert.equal(state.renewals[0].paymentConfirmed, true);
    assert.equal(state.renewals[0].paymentFinalized, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renewal configure asks for email before mutating unless explicitly skipped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-renewal-email-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  const baseUrl = "https://api.warpmetal.test";
  const requests = [];
  let notificationDocument = {
    configured: false,
    setupRecommended: true,
    subscription: null,
    supportedEvents: ["wallet.refill_required"],
  };
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_email",
          serverId: "server_email",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "renewal_owner_secret",
      },
      '{"taskId":"task_email"}',
    );
    const policy = {
      serverId: "server_email",
      enabled: true,
      renewBeforeDays: 3,
      maximumPaymentAtomic: "30000000",
      maximumRenewals: 12,
      renewThrough: null,
      maximumTotalSpendAtomic: "360000000",
      renewalsCompleted: 0,
      totalSpendAtomic: "0",
      allowedNetwork: paymentRequirement.network,
      allowedAsset: paymentRequirement.asset.toLowerCase(),
      notificationReference: "wmref_without-email",
      nextAction: "not_due",
      reason: null,
    };
    const fetchImpl = async (url, request = {}) => {
      const path = new URL(url).pathname;
      requests.push(`${request.method || "GET"} ${path}`);
      if (
        request.method === "GET" &&
        path === "/servers/server_email/notifications"
      ) {
        return jsonResponse(200, notificationDocument);
      }
      if (
        request.method === "POST" &&
        path === "/servers/server_email/notification-recipients"
      ) {
        notificationDocument = {
          configured: true,
          setupRecommended: false,
          subscription: {
            reference: "wmref_with-email",
            disabled: false,
            events: ["wallet.refill_required"],
            recipients: [
              { id: "nrcp_ops", email: "o***@example.com", status: "active" },
            ],
          },
          supportedEvents: ["wallet.refill_required"],
        };
        return jsonResponse(201, {
          ...notificationDocument,
          created: true,
          recipient: notificationDocument.subscription.recipients[0],
        });
      }
      if (
        request.method === "DELETE" &&
        path === "/servers/server_email/notifications"
      ) {
        notificationDocument = {
          ...notificationDocument,
          subscription: {
            ...notificationDocument.subscription,
            disabled: true,
          },
        };
        return jsonResponse(200, notificationDocument);
      }
      if (
        request.method === "PUT" &&
        path === "/servers/server_email/renewal-policy"
      ) {
        return jsonResponse(200, { configured: true, policy });
      }
      return jsonResponse(404, { error: { message: "Not found" } });
    };
    const common = [
      "renewal",
      "configure",
      "--server",
      "server_email",
      "--wallet",
      "renewal-wallet",
      "--renew-before-days",
      "3",
      "--maximum-payment-atomic",
      "30000000",
      "--maximum-renewals",
      "12",
      "--maximum-total-spend-atomic",
      "360000000",
      "--allowed-network",
      paymentRequirement.network,
      "--allowed-asset",
      paymentRequirement.asset,
      "--base-url",
      baseUrl,
      "--state-dir",
      stateDirectory,
      "--json",
    ];
    const promptOut = capture();
    const promptErr = capture();
    const promptExit = await main(common, {
      stdout: promptOut.stream,
      stderr: promptErr.stream,
      env: {},
      fetchImpl,
    });
    assert.equal(promptExit, 6, promptErr.value());
    assert.equal(JSON.parse(promptOut.value()).action, "email_required");
    assert.equal(
      requests.includes("PUT /servers/server_email/renewal-policy"),
      false,
    );

    const emailOut = capture();
    const emailErr = capture();
    const emailStart = requests.length;
    const emailExit = await main([...common, "--email", "ops@example.com"], {
      stdout: emailOut.stream,
      stderr: emailErr.stream,
      env: {},
      fetchImpl,
    });
    assert.equal(emailExit, 0, emailErr.value());
    const emailConfigured = JSON.parse(emailOut.value());
    assert.equal(emailConfigured.notificationState.status, "active");
    assert.deepEqual(requests.slice(emailStart), [
      "GET /servers/server_email/notifications",
      "POST /servers/server_email/notification-recipients",
      "PUT /servers/server_email/renewal-policy",
    ]);

    const skippedOut = capture();
    const skippedErr = capture();
    const skippedStart = requests.length;
    const skippedExit = await main(
      [...common, "--without-email-notifications"],
      {
        stdout: skippedOut.stream,
        stderr: skippedErr.stream,
        env: {},
        fetchImpl,
      },
    );
    assert.equal(skippedExit, 0, skippedErr.value());
    const skipped = JSON.parse(skippedOut.value());
    assert.equal(skipped.notificationState.optedOut, true);
    assert.equal(skipped.notificationState.refillAvailable, false);
    assert.deepEqual(requests.slice(skippedStart), [
      "GET /servers/server_email/notifications",
      "DELETE /servers/server_email/notifications",
      "PUT /servers/server_email/renewal-policy",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ready order status tells an agent to ask the human for an optional notification email", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-ready-notification-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_ready_notice",
          serverId: "server_ready_notice",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "ready_notice_owner_secret",
      },
      '{"taskId":"task_ready_notice"}',
    );
    const fetchImpl = async (url, request = {}) => {
      const path = new URL(url).pathname;
      if (request.method === "GET" && path === "/tasks/task_ready_notice") {
        return jsonResponse(200, {
          task: {
            id: "task_ready_notice",
            serverId: "server_ready_notice",
            state: "ready",
            publicIp: "192.0.2.80",
          },
        });
      }
      if (
        request.method === "GET" &&
        path === "/servers/server_ready_notice/notifications"
      ) {
        return jsonResponse(200, {
          configured: false,
          setupRecommended: true,
          subscription: null,
          supportedEvents: ["renewal.due"],
        });
      }
      return jsonResponse(404, { error: { message: "Not found" } });
    };
    const stdout = capture();
    const stderr = capture();
    const exitCode = await main(
      [
        "order",
        "status",
        "--task",
        "task_ready_notice",
        "--base-url",
        "https://api.warpmetal.test",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      { stdout: stdout.stream, stderr: stderr.stream, env: {}, fetchImpl },
    );
    assert.equal(exitCode, 0, stderr.value());
    const output = JSON.parse(stdout.value());
    assert.equal(output.nextAction.action, "ask_human_for_notification_email");
    assert.equal(output.nextAction.optional, true);
    assert.match(output.nextAction.addCommand, /notifications add/);
    assert.match(output.nextAction.skipCommand, /notifications disable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("notification add, list, events, remove, and disable use SSH-safe API operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-notification-commands-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  const requests = [];
  const recipient = {
    id: "nrcp_ops",
    email: "o***@example.com",
    status: "active",
    addedAt: "2026-09-02T12:00:00Z",
  };
  const subscription = {
    reference: "wmref_notifications",
    disabled: false,
    setupDismissed: false,
    events: ["renewal.due"],
    recipientLimit: 5,
    recipients: [recipient],
  };
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_notifications",
          serverId: "server_notifications",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "notification_owner_secret",
      },
      '{"taskId":"task_notifications"}',
    );
    const fetchImpl = async (url, request = {}) => {
      const path = new URL(url).pathname;
      const headers = new Headers(request.headers);
      requests.push({ method: request.method, path, key: headers.get("idempotency-key") });
      if (request.method === "POST" && path.endsWith("/notification-recipients")) {
        return jsonResponse(201, { configured: true, created: true, recipient, subscription });
      }
      if (request.method === "GET" && path.endsWith("/notifications")) {
        return jsonResponse(200, { configured: true, subscription });
      }
      if (request.method === "PATCH" && path.endsWith("/notifications")) {
        return jsonResponse(200, {
          configured: true,
          subscription: { ...subscription, events: ["renewal.due", "server.ready"] },
        });
      }
      if (request.method === "DELETE" && path.endsWith("/nrcp_ops")) {
        return jsonResponse(200, { removed: true, recipientId: "nrcp_ops" });
      }
      if (request.method === "DELETE" && path.endsWith("/notifications")) {
        return jsonResponse(200, {
          configured: true,
          subscription: { ...subscription, disabled: true, setupDismissed: true },
        });
      }
      return jsonResponse(404, { error: { message: "Not found" } });
    };
    const base = [
      "--server",
      "server_notifications",
      "--base-url",
      "https://api.warpmetal.test",
      "--state-dir",
      stateDirectory,
      "--json",
    ];
    for (const command of [
      ["add", ...base, "--email", "ops@example.com"],
      ["list", ...base],
      ["events", ...base, "--events", "renewal.due,server.ready"],
      ["remove", ...base, "--recipient", "nrcp_ops"],
      ["disable", ...base],
    ]) {
      const stdout = capture();
      const stderr = capture();
      const exitCode = await main(["notifications", ...command], {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl,
      });
      assert.equal(exitCode, 0, stderr.value());
    }
    assert.deepEqual(
      requests.map(({ method, path }) => `${method} ${path}`),
      [
        "POST /servers/server_notifications/notification-recipients",
        "GET /servers/server_notifications/notifications",
        "PATCH /servers/server_notifications/notifications",
        "DELETE /servers/server_notifications/notification-recipients/nrcp_ops",
        "DELETE /servers/server_notifications/notifications",
      ],
    );
    assert.equal(requests[1].key, null);
    assert.equal(
      requests.filter((request) => request.method !== "GET").every((request) => request.key),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refill deadlines remain valid after a server term has expired", () => {
  const current = Date.parse("2026-08-23T12:00:00.000Z");
  assert.equal(
    refillRenewBy("2026-08-23T11:00:00.000Z", current),
    "2026-08-23T12:30:00.000Z",
  );
  assert.equal(
    refillRenewBy("2026-08-30T12:00:00.000Z", current),
    "2026-08-30T12:00:00.000Z",
  );
});
