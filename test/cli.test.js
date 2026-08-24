import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main, refillRenewBy } from "../src/cli.js";
import { digestJson } from "../src/payment.js";
import { StateStore } from "../src/state.js";

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
        billingParty: "tenant_service_credit",
        maximumReservationEvidenceDigest: `sha256:${"5".repeat(64)}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        finalChargePolicy: "canonical_actual_gas_capped_by_reservation",
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
    if (
      request.method === "POST" &&
      parsed.pathname === "/checkout/agent"
    ) {
      if (!headers.get("payment-signature")) {
        return jsonResponse(
          402,
          { status: "payment_required", paymentAttemptId: "payment_test" },
          { "payment-required": paymentRequiredHeader },
        );
      }
      return jsonResponse(202, {
        status: "provisioning",
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
      version: "0.2.1",
      spec: "@x402api/agent-wallet-cli@0.2.1",
      registryUrl: "https://www.npmjs.com/package/@x402api/agent-wallet-cli",
      install: {
        argv: ["npm", "install", "--global", "@x402api/agent-wallet-cli@0.2.1"],
      },
    });
    assert.deepEqual(challenge.paymentWorkflow.signerContract.probe.argv, [
      "x402api",
      "help",
      "--json",
    ]);
    assert.deepEqual(challenge.paymentWorkflow.authorize.argv.slice(0, 3), [
      "x402api",
      "payment",
      "authorize",
    ]);
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
    assert.equal(checkoutRequests.length, 3);
    assert.deepEqual(
      checkoutRequests.map(({ body }) => body),
      [
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
      ],
    );
    assert.deepEqual(
      checkoutRequests.map(({ paymentSignature }) => paymentSignature),
      [undefined, "signed_header_value", artifactSignature],
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
      (await readFile(join(stateDirectory, "state.json"), "utf8")).includes(
        "owner_secret_value",
      ),
      true,
    );
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
        request.method === "POST" &&
        path === "/checkout/agent/renew"
      ) {
        return jsonResponse(
          402,
          { status: "payment_required", paymentAttemptId: "payment_renewal" },
          { "payment-required": renewalHeader },
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
