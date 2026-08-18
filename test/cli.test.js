import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "../src/cli.js";

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    value: () => value,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

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

    if (request.method === "GET" && parsed.pathname === "/api/health") {
      return jsonResponse(200, { status: "ok", purchasingReady: true });
    }
    if (request.method === "GET" && parsed.pathname === "/api/catalog") {
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
    if (request.method === "POST" && parsed.pathname === "/api/orders") {
      return jsonResponse(201, {
        task: {
          id: "task_test",
          serverId: "server_test",
          planId: "agent",
          checkoutPath: "/api/checkout/agent",
          state: "prepared",
        },
        ownerToken: "owner_secret_value",
        warning: "Store this token safely.",
      });
    }
    if (request.method === "POST" && parsed.pathname === "/api/checkout/agent") {
      if (!headers.get("payment-signature")) {
        return jsonResponse(
          402,
          { status: "payment_required", paymentAttemptId: "payment_test" },
          { "payment-required": "challenge_header_value" },
        );
      }
      return jsonResponse(202, {
        status: "provisioning",
        task: { id: "task_test", state: "provisioning" },
      });
    }
    return jsonResponse(404, { error: { message: "Not found" } });
  };

  const baseUrl = "http://localhost";
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

    const orderRequest = requests.find(({ url }) => url === "/api/orders");
    assert.equal(orderRequest.idempotencyKey, "order_test_key");
    assert.deepEqual(JSON.parse(orderRequest.body), {
      planId: "agent",
      hostname: "agent-box",
      osName: "Ubuntu 24.04 LTS",
      sshPublicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestWarpMetalKey agent@example.test",
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
    assert.equal(JSON.parse(challengeOut.value()).paymentRequired, "challenge_header_value");

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

    const checkoutRequests = requests.filter(({ url }) => url === "/api/checkout/agent");
    assert.equal(checkoutRequests.length, 2);
    assert.deepEqual(
      checkoutRequests.map(({ body }) => body),
      ['{"taskId":"task_test"}', '{"taskId":"task_test"}'],
    );
    assert.deepEqual(
      checkoutRequests.map(({ authorization }) => authorization),
      ["Bearer owner_secret_value", "Bearer owner_secret_value"],
    );
    assert.deepEqual(
      checkoutRequests.map(({ paymentSignature }) => paymentSignature),
      [undefined, "signed_header_value"],
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
    assert.equal((await readFile(join(stateDirectory, "state.json"), "utf8")).includes("owner_secret_value"), true);
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
