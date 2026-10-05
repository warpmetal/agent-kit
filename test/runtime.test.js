import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { parseArguments } from "../src/args.js";
import { main } from "../src/cli.js";
import { validateSandboxBatch } from "../src/runtime.js";
import { StateStore } from "../src/state.js";

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

const REMOVED_TOOL_FIELDS = [
  "cliTools",
  "observedCliTools",
  "tools",
  "toolManifest",
  "allToolsInstalled",
];

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
  assert.throws(
    () =>
      validateSandboxBatch([
        { name: "review", size: "small", cliTools: ["codex"] },
      ]),
    /unsupported field: cliTools/,
  );
});

test("capacity-only order works with a tool-free catalog and sends exact intent", async () => {
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
    if (path === "/health")
      return jsonResponse(200, { status: "ok", purchasingReady: true });
    if (path === "/catalog")
      return jsonResponse(200, { products: [product] });
    if (path === "/orders") {
      return jsonResponse(201, {
        task: {
          id: "task_runtime",
          serverId: "srv_runtime12345",
          planId: "agent",
          checkoutPath: "/checkout/agent",
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
    const order = requests.find((item) => item.path === "/orders");
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

test("guarded reload preserves reset acknowledgement and records automatic Runtime setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-reload-"));
  const requests = [];
  const fetchImpl = async (url, request = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: request.method, body: request.body });
    if (request.method === "GET" && path === "/servers/srv_runtime12345") {
      return jsonResponse(200, {
        task: {
          serverId: "srv_runtime12345",
          state: "ready",
          agentRuntime: { state: "ready", desiredSandboxCount: 3 },
        },
      });
    }
    if (request.method === "POST" && path.endsWith("/reload")) {
      return jsonResponse(202, {
        status: "accepted",
        operation: { id: "op_reload12345", kind: "reload", state: "queued" },
        pollPath: "/operations/op_reload12345",
        reloadImpact: {
          diskDataLost: true,
          ownerKnownHostsNeedRefresh: true,
          agentRuntimeAffected: true,
          workspaceDataLost: true,
          desiredSandboxesRecreatedEmpty: true,
          connectionProfilesNeedRefresh: true,
          nextAction: "wait_for_runtime",
        },
      });
    }
    if (request.method === "GET" && path === "/operations/op_reload12345") {
      return jsonResponse(200, {
        operation: {
          id: "op_reload12345",
          kind: "reload",
          state: "succeeded",
          result: {
            providerReloadAccepted: true,
            targetOperatingSystem: "Rocky Linux 9 (VPS)",
            reloadImpact: {
              diskDataLost: true,
              ownerKnownHostsNeedRefresh: true,
              agentRuntimeAffected: true,
              workspaceDataLost: true,
              desiredSandboxesRecreatedEmpty: true,
              connectionProfilesNeedRefresh: true,
              nextAction: "wait_for_runtime",
            },
          },
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
        "server",
        "reload",
        "--server",
        "srv_runtime12345",
        "--confirm",
        "ERASE",
        "--power-off-first",
        "--acknowledge-agent-runtime-reset",
        "--os",
        "Rocky Linux 9 (VPS)",
        "--wait",
        "--base-url",
        "http://localhost",
        "--state-dir",
        join(directory, "state"),
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: { WARPMETAL_OWNER_TOKEN: "owner-reload-secret" },
        fetchImpl,
      },
    );
    assert.equal(code, 0, stderr.value());
    assert.equal(stdout.value().includes("owner-reload-secret"), false);
    const mutation = requests.find(({ method, path }) =>
      method === "POST" && path.endsWith("/reload")
    );
    assert.deepEqual(JSON.parse(mutation.body), {
      confirm: "ERASE",
      powerOffFirst: true,
      acknowledgeAgentRuntimeReset: true,
      osName: "Rocky Linux 9 (VPS)",
    });
    const output = JSON.parse(stdout.value());
    assert.equal(
      output.operation.result.reloadImpact.nextAction,
      "wait_for_runtime",
    );
    assert.equal(
      await new StateStore(join(directory, "state")).hostTrustEpoch(
        "srv_runtime12345",
      ),
      "reload-op_reload12345",
    );
    const state = JSON.parse(
      await readFile(join(directory, "state", "state.json"), "utf8"),
    );
    assert.equal(
      state.runtimes.srv_runtime12345.state,
      "pending_install",
      "automatic reload must not fabricate a local needs_reinstall state",
    );
    assert.equal(
      requests.some(({ path }) => path.includes("/agent-runtime/install")),
      false,
      "successful automatic reload must not invoke manual Runtime installation",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful automatic reload tells the owner to wait and refresh sandbox profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-reload-guidance-"));
  const fetchImpl = async (url, request = {}) => {
    const path = new URL(url).pathname;
    if (request.method === "GET" && path === "/servers/srv_runtime12345") {
      return jsonResponse(200, {
        task: {
          serverId: "srv_runtime12345",
          hostname: "runtime-reload",
          state: "ready",
          agentRuntime: { state: "ready", desiredSandboxCount: 1 },
        },
      });
    }
    if (request.method === "POST" && path.endsWith("/reload")) {
      return jsonResponse(202, {
        status: "accepted",
        operation: { id: "op_reload67890", kind: "reload", state: "queued" },
        pollPath: "/operations/op_reload67890",
      });
    }
    if (request.method === "GET" && path === "/operations/op_reload67890") {
      return jsonResponse(200, {
        operation: {
          id: "op_reload67890",
          kind: "reload",
          state: "succeeded",
          result: {
            providerReloadAccepted: true,
            targetOperatingSystem: "Ubuntu 24.04 (VPS)",
            reloadImpact: {
              diskDataLost: true,
              ownerKnownHostsNeedRefresh: true,
              agentRuntimeAffected: true,
              workspaceDataLost: true,
              desiredSandboxesRecreatedEmpty: true,
              connectionProfilesNeedRefresh: true,
              nextAction: "wait_for_runtime",
            },
          },
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
        "server",
        "reload",
        "--server",
        "srv_runtime12345",
        "--confirm",
        "ERASE",
        "--power-off-first",
        "--acknowledge-agent-runtime-reset",
        "--wait",
        "--base-url",
        "http://localhost",
        "--state-dir",
        join(directory, "state"),
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: { WARPMETAL_OWNER_TOKEN: "owner-reload-secret" },
        fetchImpl,
      },
    );
    assert.equal(code, 0, stderr.value());
    assert.match(
      stdout.value(),
      /wait for Agent Runtime[\s\S]*refresh[\s\S]*sandbox[\s\S]*profiles?/i,
    );
    assert.doesNotMatch(stdout.value(), /runtime install|reinstall/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime-enabled reload stops before mutation without reset acknowledgment", async () => {
  let mutated = false;
  const stderr = capture();
  const code = await main(
    [
      "server",
      "reload",
      "--server",
      "srv_runtime12345",
      "--confirm",
      "ERASE",
      "--power-off-first",
      "--base-url",
      "http://localhost",
      "--json",
    ],
    {
      stdout: capture().stream,
      stderr: stderr.stream,
      env: { WARPMETAL_OWNER_TOKEN: "owner-reload-secret" },
      fetchImpl: async (_url, request = {}) => {
        if (request.method === "POST") mutated = true;
        return jsonResponse(200, {
          task: {
            serverId: "srv_runtime12345",
            state: "ready",
            agentRuntime: { state: "ready", desiredSandboxCount: 1 },
          },
        });
      },
    },
  );
  assert.equal(code, 2);
  assert.equal(mutated, false);
  assert.match(stderr.value(), /acknowledge-agent-runtime-reset/i);
});

test("capacity-only sandbox creation works with tool-free catalog and response JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-sandbox-create-"));
  const requests = [];
  const fetchImpl = async (url, request = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: request.body, authorization: new Headers(request.headers).get("authorization") });
    if (path === "/servers/srv_runtime12345") {
      return jsonResponse(200, {
        task: { serverId: "srv_runtime12345", planId: "agent", osName: "Ubuntu 24.04 LTS" },
      });
    }
    if (path === "/catalog") return jsonResponse(200, { products: [product] });
    if (path === "/servers/srv_runtime12345/sandboxes") {
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

test("capacity-only sandbox list, get, and restart accept tool-free JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-sandbox-capacity-"));
  const sandbox = {
    id: "sbx_review12345",
    name: "review",
    size: "small",
    lifetime: "persistent",
    desiredState: "running",
    observedState: "running",
    generation: 2,
    observedGeneration: 2,
  };
  const requests = [];
  const fetchImpl = async (url, request = {}) => {
    const path = new URL(url).pathname;
    const method = request.method || "GET";
    requests.push({ path, method, body: request.body });
    if (method === "GET" && path.endsWith("/sandboxes")) {
      return jsonResponse(200, {
        runtime: { state: "ready", desiredRevision: 2, appliedRevision: 2 },
        sandboxes: [sandbox],
      });
    }
    if (method === "GET" && path.endsWith(`/sandboxes/${sandbox.id}`)) {
      return jsonResponse(200, { sandbox });
    }
    if (method === "POST" && path.endsWith(`/sandboxes/${sandbox.id}/actions`)) {
      return jsonResponse(202, { sandbox });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  };
  const run = async (argv) => {
    const stdout = capture();
    const stderr = capture();
    const code = await main(
      [
        ...argv,
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
    assert.equal(code, 0, stderr.value());
    return JSON.parse(stdout.value());
  };

  try {
    const listed = await run([
      "sandbox",
      "list",
      "--server",
      "srv_runtime12345",
    ]);
    const fetched = await run([
      "sandbox",
      "get",
      "--server",
      "srv_runtime12345",
      "--sandbox",
      sandbox.id,
    ]);
    const restarted = await run([
      "sandbox",
      "action",
      "--server",
      "srv_runtime12345",
      "--sandbox",
      sandbox.id,
      "--action",
      "restart",
      "--confirm",
      "restart",
    ]);

    for (const result of [listed.sandboxes[0], fetched.sandbox, restarted.sandbox]) {
      for (const field of REMOVED_TOOL_FIELDS) {
        assert.equal(Object.hasOwn(result, field), false);
      }
    }
    const restart = requests.find(
      (request) =>
        request.method === "POST" && request.path.endsWith("/actions"),
    );
    assert.deepEqual(JSON.parse(restart.body), {
      action: "restart",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandbox image refresh requires exact confirmation before API access", async () => {
  let requested = false;
  const stderr = capture();
  const code = await main(
    [
      "sandbox",
      "action",
      "--server",
      "srv_runtime12345",
      "--sandbox",
      "sbx_review12345",
      "--action",
      "refresh_image",
      "--confirm",
      "not-refresh_image",
      "--base-url",
      "http://localhost",
      "--json",
    ],
    {
      stdout: capture().stream,
      stderr: stderr.stream,
      env: { WARPMETAL_OWNER_TOKEN: "owner-management-secret" },
      fetchImpl: async () => {
        requested = true;
        return jsonResponse(500, {});
      },
    },
  );
  assert.equal(code, 2);
  assert.equal(requested, false);
  assert.match(stderr.value(), /confirm refresh_image/i);
});

test("sandbox image lifecycle preserves action bodies and waits for exact digest and generation", async (t) => {
  const targetDigest = `registry.example/sandbox@sha256:${"b".repeat(64)}`;
  const oldDigest = `registry.example/sandbox@sha256:${"a".repeat(64)}`;
  const serverId = "srv_runtime12345";
  const sandboxId = "sbx_review12345";
  const ownerToken = "owner-image-fixture-only";
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-image-cli-e2e-"));
  const execFile = promisify(execFileCallback);
  const requests = [];
  let polls = 0;
  let scenario;
  const endpoint = `/servers/${serverId}/sandboxes/${sandboxId}`;
  const sandbox = (fields = {}) => ({
    id: sandboxId,
    desiredState: "running",
    observedState: "running",
    generation: 7,
    observedGeneration: 7,
    imageDigest: oldDigest,
    desiredImageDigest: oldDigest,
    ...fields,
  });
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const path = new URL(request.url, "http://localhost").pathname;
    requests.push({
      path,
      method: request.method,
      body: raw ? JSON.parse(raw) : undefined,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
    });
    let status = 404;
    let value = { error: { message: "not found" } };
    if (request.method === "POST" && path.endsWith("/actions")) {
      status = 202;
      value = { sandbox: scenario?.accepted ?? sandbox() };
    } else if (request.method === "GET" && path === endpoint) {
      polls += 1;
      status = 200;
      value = { sandbox: scenario.observations[Math.min(polls - 1, scenario.observations.length - 1)] };
    }
    response.writeHead(status, { "content-type": "application/json", "retry-after": "1" });
    response.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const run = async (action, extra = []) => {
    try {
      return {
        code: 0,
        ...(await execFile(process.execPath, [
          "bin/warpmetal.js", "sandbox", "action",
          "--server", serverId, "--sandbox", sandboxId,
          "--action", action, "--confirm", action,
          "--idempotency-key", `image-fixture-${action}`,
          "--base-url", baseUrl, "--state-dir", join(directory, "state"),
          "--json", ...extra,
        ], {
          cwd: new URL("..", import.meta.url).pathname,
          env: { WARPMETAL_OWNER_TOKEN: ownerToken },
          timeout: 20_000,
          maxBuffer: 1024 * 1024,
        })),
      };
    } catch (error) {
      return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };

  try {
    await t.test("patch_image requires an immutable digest before HTTP", async () => {
      const before = requests.length;
      const result = await run("patch_image");
      assert.equal(result.code, 2, result.stderr);
      assert.equal(requests.length, before);
      assert.match(result.stderr, /--image-digest.*(required|requires|digest)/i);
    });

    for (const action of ["start", "stop", "restart", "make_persistent", "refresh_image", "patch_image"]) {
      await t.test(`${action} sends the exact lifecycle intent`, async () => {
        const before = requests.length;
        polls = 0;
        const imageAction = ["refresh_image", "patch_image"].includes(action);
        const generation = action === "refresh_image" ? 8 : 7;
        scenario = {
          accepted: sandbox({
            generation,
            desiredImageDigest: imageAction ? targetDigest : oldDigest,
            desiredState: action === "stop" ? "stopped" : "running",
          }),
          observations: action === "refresh_image"
            ? [
                sandbox({ imageDigest: targetDigest, desiredImageDigest: targetDigest }),
                sandbox({ generation, observedGeneration: generation, desiredImageDigest: targetDigest }),
                sandbox({ generation, observedGeneration: generation, imageDigest: targetDigest, desiredImageDigest: targetDigest }),
              ]
            : [
                sandbox({ desiredImageDigest: targetDigest }),
                sandbox({ imageDigest: targetDigest, desiredImageDigest: targetDigest }),
              ],
        };
        const result = await run(action, [
          ...(action === "patch_image" ? ["--image-digest", targetDigest] : []),
          ...(imageAction ? ["--wait", "--timeout-seconds", "5"] : []),
        ]);
        assert.equal(result.code, 0, result.stderr);
        const emitted = JSON.parse(result.stdout).sandbox;
        const emittedRequests = requests.slice(before);
        const mutations = emittedRequests.filter((request) => request.method === "POST");
        assert.equal(mutations.length, 1, "one explicit lifecycle intent, without replay");
        assert.equal(mutations[0].path, `${endpoint}/actions`);
        assert.equal(mutations[0].authorization, `Bearer ${ownerToken}`);
        assert.equal(mutations[0].idempotencyKey, `image-fixture-${action}`);
        assert.deepEqual(mutations[0].body,
          action === "patch_image" ? { action, confirm: action, imageDigest: targetDigest }
            : action === "refresh_image" ? { action, confirm: action } : { action });
        assert.equal(emitted.id, sandboxId);
        assert.equal(emitted.generation, generation);
        if (imageAction) {
          assert.equal(polls, action === "refresh_image" ? 3 : 2,
            "old running image or old generation cannot satisfy image completion");
          assert.equal(emitted.imageDigest, targetDigest);
          assert.equal(emitted.observedGeneration, generation);
          assert.ok(emittedRequests.filter((request) => request.method === "GET")
            .every((request) => request.path === endpoint && request.authorization === `Bearer ${ownerToken}`));
        }
        assert.equal(result.stdout.includes(ownerToken), false);
        assert.equal(result.stderr.includes(ownerToken), false);
      });
    }

    await t.test("patch_image rejects mutable or malformed references before HTTP", async () => {
      for (const digest of [
        "registry.example/sandbox:latest",
        `registry.example/sandbox@sha256:${"a".repeat(63)}`,
        `registry.example/sandbox@sha256:${"A".repeat(64)}`,
        `registry.example/sandbox @sha256:${"a".repeat(64)}`,
      ]) {
        const before = requests.length;
        const result = await run("patch_image", ["--image-digest", digest]);
        assert.equal(result.code, 2, result.stderr);
        assert.equal(requests.length, before);
        assert.match(result.stderr, /--image-digest.*(immutable|digest-pinned|sha256)/i);
      }
    });

    await t.test("image-digest is rejected for every other lifecycle action before HTTP", async () => {
      for (const action of ["start", "stop", "restart", "make_persistent", "refresh_image"]) {
        const before = requests.length;
        const result = await run(action, ["--image-digest", targetDigest]);
        assert.equal(result.code, 2, result.stderr);
        assert.equal(requests.length, before);
        assert.match(result.stderr, /--image-digest.*(only|requires).*patch_image/i);
      }
    });

    await t.test("patch_image requires exact owner confirmation before HTTP", async () => {
      const before = requests.length;
      const result = await run("patch_image", ["--image-digest", targetDigest, "--confirm", "refresh_image"]);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(requests.length, before);
      assert.match(result.stderr, /confirm patch_image/i);
    });
  } finally {
    server.close();
    await once(server, "close");
    await rm(directory, { recursive: true, force: true });
  }
});

test("capacity-only access grant works without tool fields and writes a token-free profile", async () => {
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

test("access refresh replaces a pinned profile after reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-access-refresh-"));
  const profilePath = join(directory, "agent.connection.json");
  const hostKey =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const hostFingerprint = `SHA256:${createHash("sha256")
    .update(Buffer.from(hostKey.split(" ")[1], "base64"))
    .digest("base64")
    .replace(/=+$/, "")}`;
  await writeFile(
    profilePath,
    JSON.stringify({ stale: true }),
  );
  const stdout = capture();
  const stderr = capture();
  try {
    const code = await main(
      [
        "sandbox",
        "access",
        "refresh",
        "--server",
        "srv_runtime12345",
        "--sandbox",
        "sbx_review12345",
        "--grant",
        "grant_review12345",
        "--connection-file",
        profilePath,
        "--confirm",
        "REFRESH",
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
        fetchImpl: async () =>
          jsonResponse(200, {
            accessGrant: {
              id: "grant_review12345",
              sandboxId: "sbx_review12345",
              name: "review-agent",
              observedState: "applied",
              desiredState: "active",
              sshFingerprint: "SHA256:agent",
            },
            connection: {
              host: "203.0.113.20",
              port: 22,
              username: "warpmetal-sandbox",
              hostKeys: [
                { publicKey: hostKey, fingerprint: hostFingerprint },
              ],
            },
          }),
      },
    );
    assert.equal(code, 0, stderr.value());
    assert.equal(stdout.value().includes(hostKey), false);
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    assert.equal(profile.host, "203.0.113.20");
    assert.equal(profile.hostKeys[0].fingerprint, hostFingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing-server sandbox create survives a new-purchase catalog 503 (real CLI/HTTP)", async (t) => {
  const serverId = "srv_catalog503fixture";
  const token = "owner-catalog-503-fixture";
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-catalog-503-cli-e2e-"));
  const execFile = promisify(execFileCallback);
  const requests = [];
  let catalogStatus = 503;
  let catalogBody = { error: { code: "provider_catalog_unavailable", message: "provider catalog unavailable" } };
  let createStatus = 202;
  let createErrorCode = "capacity_exceeded";
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const path = new URL(request.url, "http://localhost").pathname;
    requests.push({
      path,
      method: request.method,
      body: raw ? JSON.parse(raw) : undefined,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
    });
    let status = 404;
    let value = { error: { message: "not found" } };
    if (request.method === "GET" && path === `/servers/${serverId}`) {
      status = 200;
      value = { task: { serverId, planId: "agent", osName: "Ubuntu 24.04 LTS" } };
    } else if (request.method === "GET" && path === "/catalog") {
      status = catalogStatus;
      value = catalogBody;
    } else if (request.method === "POST" && path === `/servers/${serverId}/sandboxes`) {
      status = createStatus;
      value = createStatus === 202
        ? {
            runtime: { state: "running", desiredRevision: 1, appliedRevision: 1 },
            sandboxes: [
              {
                id: "sbx_cat503fixture",
                name: "cat503",
                size: "small",
                desiredState: "running",
                observedState: "pending",
              },
            ],
          }
        : { error: { code: createErrorCode, message: createErrorCode } };
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const run = async (extra = []) => {
    try {
      const out = await execFile(process.execPath, [
        "bin/warpmetal.js", "sandbox", "create",
        "--server", serverId, "--name", "cat503", "--size", "small",
        "--base-url", baseUrl, "--state-dir", join(directory, "state"),
        "--json", ...extra,
      ], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { WARPMETAL_OWNER_TOKEN: token },
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
      return { code: 0, stdout: out.stdout, stderr: out.stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  try {
    await t.test("catalog 503 must not stop the existing-server sandbox POST (exit 8 pending, exactly one idempotent POST)", async () => {
      const before = requests.length;
      const result = await run(["--idempotency-key", "catalog-503-fixture"]);
      const posts = requests
        .slice(before)
        .filter((request) => request.method === "POST" && request.path === `/servers/${serverId}/sandboxes`);
      assert.equal(result.code, 8, `expected pending exit 8, got ${result.code}: ${result.stderr}`);
      assert.equal(posts.length, 1, `expected exactly one sandbox POST, got ${posts.length}`);
      assert.equal(posts[0].authorization, `Bearer ${token}`);
      assert.equal(posts[0].idempotencyKey, "catalog-503-fixture");
      assert.deepEqual(posts[0].body, { sandboxes: [{ name: "cat503", size: "small" }] });
      assert.equal(requests.slice(before).filter((request) => request.path === "/catalog").length, 0, "existing-server create must not call the purchase catalog");
    });
    await t.test("backend refusals propagate exactly once with the actual API error code", async () => {
      catalogStatus = 200;
      catalogBody = { products: [product] };
      const cases = [
        { status: 404, code: "server_not_found" },
        { status: 409, code: "inactive_server_term" },
        { status: 409, code: "insufficient_runtime_capacity" },
      ];
      for (const scenario of cases) {
        createStatus = scenario.status;
        createErrorCode = scenario.code;
        const before = requests.length;
        const result = await run(["--idempotency-key", `catalog-503-fixture-${scenario.code}`]);
        const posts = requests
          .slice(before)
          .filter((request) => request.method === "POST" && request.path === `/servers/${serverId}/sandboxes`);
        assert.notEqual(result.code, 0, `${scenario.code} must not exit 0: ${result.stdout}`);
        assert.notEqual(result.code, 8, `${scenario.code} must not look pending: ${result.stdout}`);
        assert.equal(posts.length, 1, `${scenario.code}: expected exactly one sandbox POST, got ${posts.length} (code=${result.code}, stderr=${result.stderr})`);
        assert.match(result.stderr, new RegExp(scenario.code), `${scenario.code} must surface in stderr: ${result.stderr}`);
        assert.equal(requests.slice(before).filter((request) => request.path === "/catalog").length, 0, `${scenario.code}: existing-server create must not call the purchase catalog`);
      }
    });
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

test("purchase order prepare refuses a new-purchase catalog 503 with no order mutation (real CLI/HTTP)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-order-catalog-503-"));
  const execFile = promisify(execFileCallback);
  const runtimeFile = join(directory, "runtime.json");
  const publicKeyFile = join(directory, "owner.pub");
  await writeFile(runtimeFile, JSON.stringify({ sandboxes: [{ name: "planner", size: "small" }] }));
  await writeFile(publicKeyFile, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA owner\n");
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const path = new URL(request.url, "http://localhost").pathname;
    requests.push({ path, method: request.method, body: raw ? JSON.parse(raw) : undefined, idempotencyKey: request.headers["idempotency-key"] });
    let status = 404;
    let value = { error: { code: "not_found", message: "not found" } };
    if (request.method === "GET" && path === "/health") {
      status = 200;
      value = { status: "ok", purchasingReady: true };
    } else if (request.method === "GET" && path === "/catalog") {
      status = 503;
      value = { error: { code: "provider_catalog_unavailable", message: "provider catalog unavailable" } };
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    let result;
    try {
      const out = await execFile(process.execPath, [
        "bin/warpmetal.js", "order", "prepare",
        "--plan", "agent", "--hostname", "catalog-503-team", "--os", "Ubuntu 24.04 LTS",
        "--ssh-public-key-file", publicKeyFile, "--runtime-file", runtimeFile,
        "--confirm", "TEMPORARY", "--base-url", baseUrl,
        "--state-dir", join(directory, "state"), "--json",
      ], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { WARPMETAL_OWNER_TOKEN: "order-catalog-503-fixture" },
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
      result = { code: 0, stdout: out.stdout, stderr: out.stderr };
    } catch (error) {
      result = { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
    assert.notEqual(result.code, 0, `catalog 503 must fail closed: ${result.stdout}`);
    assert.match(result.stderr, /provider_catalog_unavailable/, result.stderr);
    const posts = requests.filter((request) => request.method === "POST");
    assert.equal(posts.length, 0, "catalog 503 must not mutate any endpoint: no POST at all");
    assert.equal(requests.filter((request) => request.method === "GET" && request.path === "/catalog").length, 1, "exactly one catalog read before refusal");
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
