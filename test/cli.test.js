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
          {
            status: "payment_required",
            paymentAttemptId: "payment_test",
            challengeDigest: authoritativeChallengeDigest,
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
      version: "0.2.8",
      spec: "@x402api/agent-wallet-cli@0.2.8",
      registryUrl: "https://www.npmjs.com/package/@x402api/agent-wallet-cli",
      install: {
        argv: ["npm", "install", "--global", "@x402api/agent-wallet-cli@0.2.8"],
      },
    });
    assert.deepEqual(challenge.paymentWorkflow.signerContract.probe.argv, [
      "x402api",
      "help",
      "--json",
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
    assert.equal(
      Object.hasOwn(requestEnvelope, "challengeHandle"),
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
      JSON.parse(stateListOut.value()).orders[0].paymentId,
      "00000000-0000-4000-8000-000000000012",
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
        return jsonResponse(
          402,
          {
            status: "payment_required",
            paymentAttemptId: "payment_renewal",
            challengeDigest: authoritativeChallengeDigest,
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
