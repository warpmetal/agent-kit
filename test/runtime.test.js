import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../src/args.js";
import { main } from "../src/cli.js";
import { validateSandboxBatch } from "../src/runtime.js";

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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const sizes = [
  {
    id: "small",
    cpuMillicores: 500,
    memoryMiB: 1024,
    workspaceDiskGiB: 10,
    pids: 256,
  },
  {
    id: "medium",
    cpuMillicores: 1000,
    memoryMiB: 2048,
    workspaceDiskGiB: 20,
    pids: 512,
  },
  {
    id: "large",
    cpuMillicores: 2000,
    memoryMiB: 4096,
    workspaceDiskGiB: 40,
    pids: 1024,
  },
  {
    id: "xlarge",
    cpuMillicores: 4000,
    memoryMiB: 8192,
    workspaceDiskGiB: 80,
    pids: 2048,
  },
];

const product = {
  id: "agent",
  priceUsd: 20,
  termDays: 30,
  operatingSystems: [{ name: "Ubuntu 24.04 LTS", agentRuntimeSupported: true }],
  agentRuntime: {
    supported: true,
    capacity: { cpuMillicores: 3500, memoryMiB: 7168, workspaceDiskGiB: 70 },
    sizes,
  },
};

test("argument parser preserves SSH command tokens after --", () => {
  const parsed = parseArguments([
    "sandbox",
    "connect",
    "--connection-file",
    "profile.json",
    "--",
    "printf",
    "%s",
    "hello world",
  ]);
  assert.deepEqual(parsed.positionals, ["sandbox", "connect"]);
  assert.deepEqual(parsed.passthrough, ["printf", "%s", "hello world"]);
});

test("runtime validation is persistent by default and temporary is bounded", () => {
  assert.deepEqual(validateSandboxBatch([{ name: "main", size: "small" }]), [
    { name: "main", size: "small" },
  ]);
  assert.deepEqual(
    validateSandboxBatch([
      { name: "review", size: "small", lifetime: "temporary" },
    ]),
    [
      {
        name: "review",
        size: "small",
        lifetime: "temporary",
        expiresInSeconds: 86_400,
      },
    ],
  );
  assert.throws(
    () =>
      validateSandboxBatch([
        {
          name: "review",
          size: "small",
          lifetime: "temporary",
          expiresInSeconds: 899,
        },
      ]),
    /between 900 and 86400/,
  );
  assert.throws(
    () =>
      validateSandboxBatch([
        { name: "review", size: "small", expiresInSeconds: 900 },
      ]),
    /requires lifetime temporary/,
  );
});

test("order runtime file sends exact intent without changing checkout body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-runtime-order-"));
  const stateDirectory = join(directory, "state");
  const runtimeFile = join(directory, "runtime.json");
  const publicKeyFile = join(directory, "owner.pub");
  const requests = [];
  await writeFile(
    runtimeFile,
    JSON.stringify({
      sandboxes: [
        { name: "planner", size: "small" },
        {
          name: "reviewer",
          size: "medium",
          lifetime: "temporary",
          expiresInSeconds: 3600,
        },
      ],
    }),
  );
  await writeFile(
    publicKeyFile,
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA owner\n",
  );
  const fetchImpl = async (url, request = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: request.body });
    if (path === "/api/health")
      return jsonResponse(200, { status: "ok", purchasingReady: true });
    if (path === "/api/catalog")
      return jsonResponse(200, { products: [product] });
    if (path === "/api/orders") {
      return jsonResponse(201, {
        task: {
          id: "task_runtime",
          serverId: "srv_runtime12345",
          planId: "agent",
          checkoutPath: "/api/checkout/agent",
          agentRuntime: { state: "pending_server", desiredSandboxCount: 2 },
        },
        ownerToken: "owner_runtime_secret",
      });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  };
  const stdout = capture();
  const stderr = capture();
  try {
    const code = await main(
      [
        "order",
        "prepare",
        "--plan",
        "agent",
        "--hostname",
        "agent-team",
        "--os",
        "Ubuntu 24.04 LTS",
        "--ssh-public-key-file",
        publicKeyFile,
        "--runtime-file",
        runtimeFile,
        "--confirm",
        "TEMPORARY",
        "--base-url",
        "http://localhost",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      { stdout: stdout.stream, stderr: stderr.stream, env: {}, fetchImpl },
    );
    assert.equal(code, 0, stderr.value());
    assert.equal(stdout.value().includes("owner_runtime_secret"), false);
    const order = requests.find((item) => item.path === "/api/orders");
    assert.deepEqual(JSON.parse(order.body).agentRuntime, {
      sandboxes: [
        { name: "planner", size: "small" },
        {
          name: "reviewer",
          size: "medium",
          lifetime: "temporary",
          expiresInSeconds: 3600,
        },
      ],
    });
    const state = JSON.parse(
      await readFile(join(stateDirectory, "state.json"), "utf8"),
    );
    assert.equal(
      state.orders.task_runtime.checkoutBody,
      '{"taskId":"task_runtime"}',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("temporary sandbox creation requires exact confirmation before API access", async () => {
  const stderr = capture();
  let requested = false;
  const code = await main(
    [
      "sandbox",
      "create",
      "--server",
      "srv_runtime12345",
      "--name",
      "review",
      "--size",
      "small",
      "--lifetime",
      "temporary",
      "--base-url",
      "http://localhost",
      "--json",
    ],
    {
      stdout: capture().stream,
      stderr: stderr.stream,
      env: { WARPMETAL_OWNER_TOKEN: "owner-secret" },
      fetchImpl: async () => {
        requested = true;
        return jsonResponse(500, {});
      },
    },
  );
  assert.equal(code, 2);
  assert.equal(requested, false);
  assert.match(stderr.value(), /confirm TEMPORARY/i);
});

test("sandbox creation uses the fixed public contract and reports pending as exit 8", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-sandbox-create-"));
  const requests = [];
  const fetchImpl = async (url, request = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: request.body, authorization: new Headers(request.headers).get("authorization") });
    if (path === "/api/servers/srv_runtime12345") {
      return jsonResponse(200, {
        task: { serverId: "srv_runtime12345", planId: "agent", osName: "Ubuntu 24.04 LTS" },
      });
    }
    if (path === "/api/catalog") return jsonResponse(200, { products: [product] });
    if (path === "/api/servers/srv_runtime12345/sandboxes") {
      return jsonResponse(202, {
        runtime: { state: "pending_install", desiredRevision: 2, appliedRevision: 0 },
        sandboxes: [
          {
            id: "sbx_review12345",
            name: "review",
            size: "small",
            lifetime: "temporary",
            expiresInSeconds: 900,
            desiredState: "running",
            observedState: "pending",
          },
        ],
      });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  };
  const stdout = capture();
  const stderr = capture();
  try {
    const code = await main(
      [
        "sandbox",
        "create",
        "--server",
        "srv_runtime12345",
        "--name",
        "review",
        "--size",
        "small",
        "--lifetime",
        "temporary",
        "--expires-in-seconds",
        "900",
        "--confirm",
        "TEMPORARY",
        "--base-url",
        "http://localhost",
        "--state-dir",
        join(directory, "state"),
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: { WARPMETAL_OWNER_TOKEN: "owner-management-secret" },
        fetchImpl,
      },
    );
    assert.equal(code, 8, stderr.value());
    assert.equal(stdout.value().includes("owner-management-secret"), false);
    const mutation = requests.find((item) => item.path.endsWith("/sandboxes"));
    assert.equal(mutation.authorization, "Bearer owner-management-secret");
    assert.deepEqual(JSON.parse(mutation.body), {
      sandboxes: [
        {
          name: "review",
          size: "small",
          lifetime: "temporary",
          expiresInSeconds: 900,
        },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applied access grant writes a token-free profile without printing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-access-grant-"));
  const stateDirectory = join(directory, "state");
  const publicKeyPath = join(directory, "agent.pub");
  const profilePath = join(directory, "agent.connection.json");
  const publicKey =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA agent";
  const hostKey = publicKey.split(" agent")[0];
  const hostFingerprint = `SHA256:${createHash("sha256")
    .update(Buffer.from(hostKey.split(" ")[1], "base64"))
    .digest("base64")
    .replace(/=+$/, "")}`;
  await writeFile(publicKeyPath, `${publicKey}\n`);
  const fetchImpl = async (url, request = {}) => {
    const path = new URL(url).pathname;
    if (request.method === "POST" && path.endsWith("/access-grants")) {
      return jsonResponse(202, {
        accessGrant: {
          id: "grant_review12345",
          sandboxId: "sbx_review12345",
          name: "review-agent",
          sshFingerprint: "SHA256:agent",
          desiredState: "active",
          observedState: "pending",
        },
        connection: { host: "203.0.113.10", port: 22, username: "warpmetal-sandbox", hostKeys: [] },
      });
    }
    if (request.method === "GET" && path.endsWith("/access-grants/grant_review12345")) {
      return jsonResponse(200, {
        accessGrant: {
          id: "grant_review12345",
          sandboxId: "sbx_review12345",
          name: "review-agent",
          sshFingerprint: "SHA256:agent",
          desiredState: "active",
          observedState: "applied",
        },
        connection: {
          host: "203.0.113.10",
          port: 22,
          username: "warpmetal-sandbox",
          hostKeys: [{ publicKey: hostKey, fingerprint: hostFingerprint }],
        },
      });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  };
  const stdout = capture();
  const stderr = capture();
  try {
    const code = await main(
      [
        "sandbox",
        "access",
        "grant",
        "--server",
        "srv_runtime12345",
        "--sandbox",
        "sbx_review12345",
        "--name",
        "review-agent",
        "--ssh-public-key-file",
        publicKeyPath,
        "--connection-file",
        profilePath,
        "--wait",
        "--base-url",
        "http://localhost",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: { WARPMETAL_OWNER_TOKEN: "owner-management-secret" },
        fetchImpl,
      },
    );
    assert.equal(code, 0, stderr.value());
    assert.equal(stdout.value().includes("203.0.113.10"), false);
    assert.equal(stdout.value().includes(hostKey), false);
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    assert.equal(profile.host, "203.0.113.10");
    assert.equal(JSON.stringify(profile).includes("owner-management-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
