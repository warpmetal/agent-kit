import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { readSandboxFile } from "../src/runtime.js";
import { StateStore } from "../src/state.js";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ID = "srv_tools123";
const SANDBOX_ID = "sbx_tools456";
const PROFILE_ID = "codex";
const CLAUDE_CODE_PROFILE_ID = "claude-code";
const CLAUDE_MANAGED_ANT_PROFILE_ID = "claude-managed-ant";
const AUTOMATIC_PROFILE_IDS = [
  PROFILE_ID,
  CLAUDE_CODE_PROFILE_ID,
  CLAUDE_MANAGED_ANT_PROFILE_ID,
];
const OWNER_TOKEN = "owner_tools_super_secret";

const profile = {
  id: PROFILE_ID,
  revision: 3,
  digest: `sha256:${"a".repeat(64)}`,
  platform: "linux/amd64",
};

function setupOperation(state, overrides = {}) {
  return {
    id: "setup-op-123",
    sandboxId: SANDBOX_ID,
    sandboxGeneration: 4,
    profileId: PROFILE_ID,
    profileRevision: profile.revision,
    profileDigest: profile.digest,
    state,
    ...overrides,
  };
}

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

async function stateFixture() {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-tools-test-"));
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  await store.savePreparedOrder(
    {
      task: {
        id: "task_tools123",
        serverId: SERVER_ID,
        planId: "agent",
        checkoutPath: "/checkout/agent",
      },
      ownerToken: OWNER_TOKEN,
    },
    '{"taskId":"task_tools123"}',
  );
  return { directory, stateDirectory };
}

function commandArguments(stateDirectory, values) {
  return [
    ...values,
    "--base-url",
    "http://localhost",
    "--state-dir",
    stateDirectory,
    "--json",
  ];
}

test("tools list resolves the stored owner token and uses the exact profile API", async () => {
  assert.equal(PROFILE_ID, "codex");
  const { directory, stateDirectory } = await stateFixture();
  const stdout = capture();
  const stderr = capture();
  const requests = [];
  try {
    const exitCode = await main(
      commandArguments(stateDirectory, ["tools", "list", "--server", SERVER_ID]),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async (url, request = {}) => {
          requests.push({ url: String(url), request });
          return jsonResponse(200, { profiles: [profile] });
        },
      },
    );

    assert.equal(exitCode, 0, stderr.value());
    assert.equal(stderr.value(), "");
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, "/agent-tool-profiles");
    assert.equal(requests[0].request.method, "GET");
    assert.equal(requests[0].request.body, undefined);
    assert.equal(requests[0].request.headers.Authorization, `Bearer ${OWNER_TOKEN}`);
    assert.equal("Idempotency-Key" in requests[0].request.headers, false);
    assert.deepEqual(JSON.parse(stdout.value()), { profiles: [profile] });
    assert.equal(stdout.value().includes(OWNER_TOKEN), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tools list discovers the exact Codex, Claude Code, and install-only Managed ant profile IDs", async () => {
  const { directory, stateDirectory } = await stateFixture();
  const stdout = capture();
  const stderr = capture();
  const profiles = AUTOMATIC_PROFILE_IDS.map((id, index) => ({
    id,
    revision: index + 1,
    digest: `sha256:${String(index + 1).repeat(64)}`,
    platform: "linux/amd64",
    mode: id === "claude-managed-ant" ? "managed-worker-binary" : "ordinary-cli",
    availability: "unreleased-candidate",
    credential: `must-not-leak-${id}`,
  }));
  try {
    const exitCode = await main(
      commandArguments(stateDirectory, ["tools", "list", "--server", SERVER_ID]),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async () => jsonResponse(200, { profiles }),
      },
    );

    assert.equal(exitCode, 0, stderr.value());
    assert.equal(stderr.value(), "");
    assert.deepEqual(
      JSON.parse(stdout.value()),
      {
        profiles: profiles.map(({ credential: _credential, ...publicProfile }) =>
          publicProfile,
        ),
      },
    );
    assert.deepEqual(
      JSON.parse(stdout.value()).profiles.map(({ id }) => id),
      AUTOMATIC_PROFILE_IDS,
    );
    assert.doesNotMatch(stdout.value(), /must-not-leak/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tools install posts only profileId with idempotency and waits for its operation", async () => {
  const { directory, stateDirectory } = await stateFixture();
  const stdout = capture();
  const stderr = capture();
  const requests = [];
  const applying = setupOperation("applying");
  const ready = setupOperation("ready", {
    receiptDigest: `sha256:${"b".repeat(64)}`,
  });
  try {
    const exitCode = await main(
      commandArguments(stateDirectory, [
        "tools",
        "install",
        "--server",
        SERVER_ID,
        "--sandbox",
        SANDBOX_ID,
        "--profile",
        PROFILE_ID,
        "--idempotency-key",
        "tools-install-test-123",
        "--wait",
        "--timeout-seconds",
        "3",
      ]),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async (url, request = {}) => {
          const path = new URL(url).pathname;
          requests.push({ path, request });
          if (
            path ===
            `/servers/${SERVER_ID}/sandboxes/${SANDBOX_ID}/tool-setup-operations`
          ) {
            return jsonResponse(202, { setupOperation: applying });
          }
          if (path === `/servers/${SERVER_ID}/agent-setup`) {
            return jsonResponse(200, { setupOperations: [ready] });
          }
          return jsonResponse(404, { error: { message: "unexpected path" } });
        },
      },
    );

    assert.equal(exitCode, 0, stderr.value());
    assert.deepEqual(
      requests.map(({ path, request }) => [path, request.method]),
      [
        [
          `/servers/${SERVER_ID}/sandboxes/${SANDBOX_ID}/tool-setup-operations`,
          "POST",
        ],
        [`/servers/${SERVER_ID}/agent-setup`, "GET"],
      ],
    );
    assert.deepEqual(JSON.parse(requests[0].request.body), {
      profileId: PROFILE_ID,
    });
    assert.equal(
      requests[0].request.headers["Idempotency-Key"],
      "tools-install-test-123",
    );
    for (const { request } of requests) {
      assert.equal(request.headers.Authorization, `Bearer ${OWNER_TOKEN}`);
    }
    const output = JSON.parse(stdout.value());
    assert.deepEqual(output, { setupOperation: ready });
    assert.equal(stdout.value().includes(OWNER_TOKEN), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tools install without wait accepts a pending operation without exposing its credential", async () => {
  const { directory, stateDirectory } = await stateFixture();
  const stdout = capture();
  const stderr = capture();
  const pending = setupOperation("pending", { accessToken: OWNER_TOKEN });
  try {
    const exitCode = await main(
      commandArguments(stateDirectory, [
        "tools", "install", "--server", SERVER_ID, "--sandbox", SANDBOX_ID,
        "--profile", PROFILE_ID,
      ]),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async () => jsonResponse(202, { setupOperation: pending }),
      },
    );
    assert.equal(exitCode, 0, stderr.value());
    assert.match(stdout.value(), /setup-op-123|pending/i);
    assert.equal(stdout.value().includes(OWNER_TOKEN), false);
    assert.equal(stderr.value().includes(OWNER_TOKEN), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("later installs preserve both exact Claude profile IDs and JSON exit-code parity", async (t) => {
  for (const [profileId, wait] of [
    [CLAUDE_CODE_PROFILE_ID, true],
    [CLAUDE_MANAGED_ANT_PROFILE_ID, false],
  ]) {
    await t.test(`${profileId}${wait ? " with wait" : " without wait"}`, async () => {
      const { directory, stateDirectory } = await stateFixture();
      const stdout = capture();
      const stderr = capture();
      const requests = [];
      const applying = setupOperation("applying", { profileId });
      const ready = setupOperation("ready", {
        profileId,
        receiptDigest: `sha256:${"d".repeat(64)}`,
        providerCredential: "must-not-leak-provider-credential",
      });
      try {
        const argv = [
          "tools",
          "install",
          "--server",
          SERVER_ID,
          "--sandbox",
          SANDBOX_ID,
          "--profile",
          profileId,
          "--idempotency-key",
          `tools-${profileId}-123`,
        ];
        if (wait) argv.push("--wait", "--timeout-seconds", "3");
        const exitCode = await main(commandArguments(stateDirectory, argv), {
          stdout: stdout.stream,
          stderr: stderr.stream,
          env: {},
          fetchImpl: async (url, request = {}) => {
            const path = new URL(url).pathname;
            requests.push({ path, request });
            if (
              path ===
              `/servers/${SERVER_ID}/sandboxes/${SANDBOX_ID}/tool-setup-operations`
            ) {
              return jsonResponse(202, {
                setupOperation: wait ? applying : ready,
              });
            }
            if (path === `/servers/${SERVER_ID}/agent-setup`) {
              return jsonResponse(200, { setupOperations: [ready] });
            }
            return jsonResponse(404, { error: { message: "unexpected path" } });
          },
        });

        assert.equal(exitCode, 0, stderr.value());
        assert.deepEqual(JSON.parse(requests[0].request.body), { profileId });
        assert.equal(
          requests[0].request.headers["Idempotency-Key"],
          `tools-${profileId}-123`,
        );
        assert.equal(requests.length, wait ? 2 : 1);
        assert.deepEqual(JSON.parse(stdout.value()), {
          setupOperation: {
            id: ready.id,
            sandboxId: ready.sandboxId,
            sandboxGeneration: ready.sandboxGeneration,
            profileId,
            profileRevision: ready.profileRevision,
            profileDigest: ready.profileDigest,
            state: "ready",
            receiptDigest: ready.receiptDigest,
          },
        });
        assert.doesNotMatch(stdout.value(), /must-not-leak-provider-credential/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("tools status treats ready as success and failed or cancelled as failure", async () => {
  const { directory, stateDirectory } = await stateFixture();
  try {
    for (const [state, expectedExit] of [
      ["ready", 0],
      ["failed", 5],
      ["cancelled", 5],
    ]) {
      const stdout = capture();
      const stderr = capture();
      let requests = 0;
      const operation = setupOperation(
        state,
        state === "ready"
          ? { receiptDigest: `sha256:${"c".repeat(64)}` }
          : { errorCode: `setup_${state}` },
      );
      const exitCode = await main(
        commandArguments(stateDirectory, [
          "tools",
          "status",
          "--server",
          SERVER_ID,
          "--wait",
          "--timeout-seconds",
          "2",
        ]),
        {
          stdout: stdout.stream,
          stderr: stderr.stream,
          env: {},
          fetchImpl: async (url, request = {}) => {
            requests += 1;
            assert.equal(
              new URL(url).pathname,
              `/servers/${SERVER_ID}/agent-setup`,
            );
            assert.equal(request.method, "GET");
            assert.equal(request.headers.Authorization, `Bearer ${OWNER_TOKEN}`);
            return jsonResponse(200, { setupOperations: [operation] });
          },
        },
      );
      assert.equal(exitCode, expectedExit, `${state}: ${stderr.value()}`);
      assert.equal(requests, 1);
      assert.deepEqual(JSON.parse(stdout.value()), {
        setupOperations: [operation],
      });
      assert.equal(stdout.value().includes(OWNER_TOKEN), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tools status without wait is successful for applying and empty inspections", async () => {
  const { directory, stateDirectory } = await stateFixture();
  try {
    for (const setupOperations of [[setupOperation("applying")], []]) {
      const stdout = capture();
      const stderr = capture();
      const exitCode = await main(
        commandArguments(stateDirectory, ["tools", "status", "--server", SERVER_ID]),
        {
          stdout: stdout.stream,
          stderr: stderr.stream,
          env: {},
          fetchImpl: async () => jsonResponse(200, { setupOperations }),
        },
      );
      assert.equal(exitCode, 0, stderr.value());
      assert.deepEqual(JSON.parse(stdout.value()), { setupOperations });
      assert.equal(stdout.value().includes(OWNER_TOKEN), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tools status wait is deadline bounded and reports timeout without secrets", async () => {
  const { directory, stateDirectory } = await stateFixture();
  const stdout = capture();
  const stderr = capture();
  let requests = 0;
  try {
    const startedAt = Date.now();
    const exitCode = await main(
      commandArguments(stateDirectory, [
        "tools",
        "status",
        "--server",
        SERVER_ID,
        "--wait",
        "--timeout-seconds",
        "1",
      ]),
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async () => {
          requests += 1;
          return jsonResponse(
            200,
            { setupOperations: [setupOperation("applying")] },
            { "retry-after": "1" },
          );
        },
      },
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(exitCode, 8);
    assert.equal(stdout.value(), "");
    assert.ok(requests >= 1 && requests <= 2, `unexpected requests: ${requests}`);
    assert.ok(elapsedMs >= 900 && elapsedMs < 2500, `unbounded wait: ${elapsedMs}ms`);
    const error = JSON.parse(stderr.value());
    assert.match(error.error.message, /did not reach a terminal state.*timeout/i);
    assert.equal(stderr.value().includes(OWNER_TOKEN), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tools commands reject missing arguments, unknown options, and token argv", async () => {
  const { directory, stateDirectory } = await stateFixture();
  const cases = [
    { argv: ["tools", "list"], message: /--server requires a value/ },
    {
      argv: ["tools", "install", "--server", SERVER_ID],
      message: /--sandbox requires a value/,
    },
    {
      argv: [
        "tools",
        "install",
        "--server",
        SERVER_ID,
        "--sandbox",
        SANDBOX_ID,
      ],
      message: /--profile requires a value/,
    },
    { argv: ["tools", "status"], message: /--server requires a value/ },
    {
      argv: ["tools", "list", "--server", SERVER_ID, "--bogus"],
      message: /Unknown option: --bogus/,
    },
    {
      argv: [
        "tools",
        "status",
        "--server",
        SERVER_ID,
        "--token",
        OWNER_TOKEN,
      ],
      message: /Unknown option: --token/,
    },
    {
      argv: [
        "tools",
        "status",
        "--server",
        SERVER_ID,
        "--wait",
        "--timeout-seconds",
        "0",
      ],
      message: /--timeout-seconds must be a positive integer/,
    },
  ];
  try {
    for (const item of cases) {
      const stdout = capture();
      const stderr = capture();
      let requested = false;
      const exitCode = await main(
        commandArguments(stateDirectory, item.argv),
        {
          stdout: stdout.stream,
          stderr: stderr.stream,
          env: {},
          fetchImpl: async () => {
            requested = true;
            throw new Error("validation must precede API access");
          },
        },
      );
      assert.equal(exitCode, 2, item.argv.join(" "));
      assert.equal(requested, false, item.argv.join(" "));
      assert.equal(stdout.value(), "");
      assert.match(JSON.parse(stderr.value()).error.message, item.message);
      assert.equal(stderr.value().includes(OWNER_TOKEN), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent install remains reserved for installing the WarpMetal skill", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(
    ["agent", "install", "--server", SERVER_ID, "--json"],
    { stdout: stdout.stream, stderr: stderr.stream, env: {} },
  );
  assert.equal(exitCode, 2);
  assert.equal(stdout.value(), "");
  assert.match(JSON.parse(stderr.value()).error.message, /Unknown option: --server/);
});

test("order runtime file preserves the closed optional setup intent exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-tools-order-"));
  const stateDirectory = join(directory, "state");
  const runtimeFile = join(directory, "runtime.json");
  const publicKeyFile = join(directory, "owner.pub");
  const runtimeIntent = {
    sandboxes: [
      { name: "codex", size: "small" },
      { name: "claude-code", size: "small" },
      { name: "claude-managed", size: "small" },
    ],
    setup: {
      version: 1,
      sandboxProfiles: [
        { sandboxName: "codex", profileId: PROFILE_ID },
        {
          sandboxName: "claude-code",
          profileId: CLAUDE_CODE_PROFILE_ID,
        },
        {
          sandboxName: "claude-managed",
          profileId: CLAUDE_MANAGED_ANT_PROFILE_ID,
        },
      ],
    },
  };
  await writeFile(runtimeFile, JSON.stringify(runtimeIntent));
  await writeFile(
    publicKeyFile,
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA owner\n",
  );
  const stdout = capture();
  const stderr = capture();
  let orderBody;
  const product = {
    id: "agent",
    priceUsd: 20,
    termDays: 30,
    operatingSystems: [
      { name: "Ubuntu 24.04 LTS", agentRuntimeSupported: true },
    ],
    agentRuntime: {
      supported: true,
      capacity: {
        cpuMillicores: 3500,
        memoryMiB: 7168,
        workspaceDiskGiB: 70,
      },
      sizes: [
        {
          id: "small",
          cpuMillicores: 500,
          memoryMiB: 1024,
          workspaceDiskGiB: 10,
          pids: 256,
        },
      ],
    },
  };
  try {
    const exitCode = await main(
      [
        "order",
        "prepare",
        "--plan",
        "agent",
        "--hostname",
        "tools-order",
        "--os",
        "Ubuntu 24.04 LTS",
        "--ssh-public-key-file",
        publicKeyFile,
        "--runtime-file",
        runtimeFile,
        "--base-url",
        "http://localhost",
        "--state-dir",
        stateDirectory,
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
        fetchImpl: async (url, request = {}) => {
          const path = new URL(url).pathname;
          if (path === "/health")
            return jsonResponse(200, { status: "ok", purchasingReady: true });
          if (path === "/catalog")
            return jsonResponse(200, { products: [product] });
          if (path === "/orders") {
            orderBody = JSON.parse(request.body);
            return jsonResponse(201, {
              task: {
                id: "task_tools_order",
                serverId: "srv_tools_order",
                planId: "agent",
                checkoutPath: "/checkout/agent",
              },
              ownerToken: "owner_order_secret",
            });
          }
          return jsonResponse(404, { error: { message: "unexpected path" } });
        },
      },
    );

    assert.equal(exitCode, 0, stderr.value());
    assert.deepEqual(orderBody.agentRuntime, runtimeIntent);
    assert.doesNotMatch(
      JSON.stringify(orderBody.agentRuntime),
      /(?:artifact)?url|shell|command|\benv\b/i,
    );
    assert.equal(stdout.value().includes("owner_order_secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("order runtime setup rejects fields that could become arbitrary installers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-tools-runtime-file-"));
  const runtimeFile = join(directory, "runtime.json");
  try {
    await writeFile(
      runtimeFile,
      JSON.stringify({
        sandboxes: [{ name: "primary", size: "small" }],
        setup: {
          version: 1,
          sandboxProfiles: [
            {
              sandboxName: "primary",
              profileId: PROFILE_ID,
              sourceUrl: "https://untrusted.example/tool.tgz",
            },
          ],
        },
      }),
    );
    await assert.rejects(readSandboxFile(runtimeFile), /unsupported field: sourceUrl/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI help, README, and both skill copies document tools commands and all profile boundaries in parity", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(["--help"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");

  const documents = {
    help: stdout.value(),
    README: await readFile(join(root, "README.md"), "utf8"),
    skill: await readFile(
      join(root, "skills", "warpmetal", "references", "cli-reference.md"),
      "utf8",
    ),
    pluginSkill: await readFile(
      join(
        root,
        "plugins",
        "warpmetal",
        "skills",
        "warpmetal",
        "references",
        "cli-reference.md",
      ),
      "utf8",
    ),
  };
  for (const [label, document] of Object.entries(documents)) {
    assert.match(
      document,
      /warpmetal tools list --server <serverId>/,
      `${label} omits tools list`,
    );
    assert.match(
      document,
      /warpmetal tools install --server <serverId> --sandbox <sandboxId> --profile <profileId>/,
      `${label} omits tools install`,
    );
    assert.match(
      document,
      /warpmetal tools status --server <serverId>/,
      `${label} omits tools status`,
    );
    assert.match(
      document,
      /warpmetal agent install --target <codex\|claude\|all>/,
      `${label} must preserve agent install`,
    );
    assert.match(
      document,
      /agent install[^.]{0,500}(?:bundled )?WarpMetal skill|(?:bundled )?WarpMetal skill[^.]{0,500}agent install/i,
      `${label} must keep agent install scoped to the WarpMetal skill rather than sandbox tools`,
    );
    assert.match(document, /\bclaude-code\b/, `${label} omits claude-code`);
    assert.match(
      document,
      /\bclaude-managed-ant\b/,
      `${label} omits claude-managed-ant`,
    );
    const codexBoundary = document
      .split(/\n\s*\n/)
      .find(
        (paragraph) =>
          /Codex/i.test(paragraph) &&
          /candidate/i.test(paragraph) &&
          /unreleased/i.test(paragraph) &&
          /automatic (?:tool )?profile/i.test(paragraph),
      );
    assert.ok(
      codexBoundary,
      `${label} does not describe Codex as a candidate/unreleased automatic profile`,
    );
    if (
      /(?:currently\s+)?qualified\s+(?:pinned\s+)?Codex\b|\bCodex\b[^.\n]{0,120}\bqualified automatic\b/i.test(
        document,
      )
    ) {
      assert.fail(`${label} still describes Codex as qualified`);
    }
    assert.match(
      document,
      /Claude Code[^.]{0,240}\bclaude-code\b[^.]{0,240}(?:candidate|unreleased)[^.]{0,240}automatic (?:tool )?profile|\bclaude-code\b[^.]{0,240}Claude Code[^.]{0,240}(?:candidate|unreleased)[^.]{0,240}automatic (?:tool )?profile/i,
      `${label} must distinguish the Claude Code automatic profile`,
    );
    assert.match(
      document,
      /Claude Managed Agents[^.]{0,320}\bclaude-managed-ant\b|\bclaude-managed-ant\b[^.]{0,320}Claude Managed Agents/i,
      `${label} must distinguish Claude Managed Agents from Claude Code`,
    );
    assert.match(
      document,
      /\bant\b[^.]{0,240}(?:does not|doesn't|neither)[^.]{0,160}authenticat[^.]{0,200}(?:does not|doesn't|nor)[^.]{0,160}activat/i,
      `${label} must state that ant installation neither authenticates nor activates a worker`,
    );
    assert.match(
      document,
      /Cursor CLI[^.]{0,320}(?:manual|unavailable)[^.]{0,320}(?:later|separately qualified)/i,
      `${label} must keep Cursor unavailable for later qualification`,
    );
    assert.doesNotMatch(
      document,
      /Claude Code[^.]{0,240}(?:manual|unavailable)[^.]{0,240}until separately qualified/i,
      `${label} still says Claude Code is unavailable until separately qualified`,
    );
    assert.doesNotMatch(
      document,
      /WarpMetal[^.]{0,120}(?:cannot|does not|doesn't)[^.]{0,120}install[^.]{0,120}Codex/i,
      `${label} contradicts the candidate Codex automatic profile`,
    );
  }
});

test("README and both skill references use all exact automatic profile IDs", async (t) => {
  const documents = {
    README: await readFile(join(root, "README.md"), "utf8"),
    skill: await readFile(
      join(root, "skills", "warpmetal", "references", "cli-reference.md"),
      "utf8",
    ),
    pluginSkill: await readFile(
      join(
        root,
        "plugins",
        "warpmetal",
        "skills",
        "warpmetal",
        "references",
        "cli-reference.md",
      ),
      "utf8",
    ),
  };
  for (const [label, document] of Object.entries(documents)) {
    await t.test(label, () => {
      for (const profileId of AUTOMATIC_PROFILE_IDS) {
        assert.match(
          document,
          new RegExp(`"profileId": "${profileId}"`),
          `${label} omits an order-time ${profileId} example`,
        );
      }
      assert.doesNotMatch(document, /codex-pinned/);
    });
  }
});

test("packaged runtime guidance preserves the Claude Code and Managed ant distinction", async (t) => {
  const documents = {
    skillRuntime: await readFile(
      join(root, "skills", "warpmetal", "references", "runtime.md"),
      "utf8",
    ),
    pluginSkillRuntime: await readFile(
      join(
        root,
        "plugins",
        "warpmetal",
        "skills",
        "warpmetal",
        "references",
        "runtime.md",
      ),
      "utf8",
    ),
  };
  for (const [label, document] of Object.entries(documents)) {
    await t.test(label, () => {
      assert.match(document, /\bclaude-code\b/);
      assert.match(document, /\bclaude-managed-ant\b/);
      assert.match(
        document,
        /Claude Managed Agents[^.]{0,320}\bclaude-managed-ant\b|\bclaude-managed-ant\b[^.]{0,320}Claude Managed Agents/i,
      );
      assert.match(
        document,
        /\bant\b[^.]{0,240}(?:does not|doesn't|neither)[^.]{0,160}authenticat[^.]{0,200}(?:does not|doesn't|nor)[^.]{0,160}activat/i,
      );
      assert.match(
        document,
        /Cursor CLI[^.]{0,320}(?:manual|unavailable)[^.]{0,320}(?:later|separately qualified)/i,
      );
    });
  }
});

test("npm pack dry-run includes the CLI and tool documentation surfaces", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const [pack] = JSON.parse(stdout);
  const files = new Set(pack.files.map(({ path }) => path));
  for (const path of [
    "bin/warpmetal.js",
    "src/api.js",
    "src/cli.js",
    "src/runtime.js",
    "README.md",
    "skills/warpmetal/SKILL.md",
    "skills/warpmetal/references/cli-reference.md",
    "skills/warpmetal/references/runtime.md",
  ]) {
    assert.ok(files.has(path), `npm package omits ${path}`);
  }
  assert.equal([...files].some((path) => path.startsWith("test/")), false);
});
