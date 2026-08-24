import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalJson,
  createPaymentRequestEnvelope,
  digestJson,
  paymentWorkflow,
  readPaymentArtifact,
} from "../src/payment.js";

test("renewal payment workflow hands the exact artifact back to WarpMetal", () => {
  const workflow = paymentWorkflow({
    taskId: "task_renewal",
    serverId: "srv_renewal",
    kind: "renewal",
    requestEnvelopePath: "/private/renewal.request.json",
    paymentArtifactPath: "/private/renewal.payment.json",
  });
  assert.deepEqual(workflow.submit.argv, [
    "warpmetal",
    "renewal",
    "submit",
    "--server",
    "srv_renewal",
    "--payment-artifact",
    "/private/renewal.payment.json",
    "--wait",
    "--json",
  ]);
  assert.equal(workflow.signerPackage.spec, "@x402api/agent-wallet-cli@0.2.1");
  assert.equal(workflow.signerNodeRequirement, ">=22");
});

const requirement = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "12000000",
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
  network: requirement.network,
  address: requirement.payTo,
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

const extensions = {
  "payment-identifier": { info: { required: true } },
  "com.k1hub.external-recipient": {
    info: {
      version: 1,
      recipients: [
        {
          network: requirement.network,
          asset: requirement.asset,
          payTo: requirement.payTo,
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
          network: requirement.network,
          asset: requirement.asset,
          payloadProfile: requirement.extra.payloadProfile,
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
};

function paymentChallenge(resourceUrl) {
  return {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      mimeType: "application/json",
    },
    accepts: [requirement],
    extensions,
  };
}

function request() {
  const paymentRequired = paymentChallenge(
    "https://api.warpmetal.test/checkout/standard",
  );
  return createPaymentRequestEnvelope({
    baseUrl: "https://api.warpmetal.test",
    checkoutPath: "/checkout/standard",
    checkoutBody: '{"taskId":"task_payment"}',
    paymentRequired: Buffer.from(JSON.stringify(paymentRequired)).toString(
      "base64",
    ),
    merchantReference: "task_payment",
  });
}

function signature(
  resource,
  buyerPaymentIdentifier = "buyer_payment_test_123",
) {
  const paymentExtensions = JSON.parse(JSON.stringify(extensions));
  paymentExtensions["payment-identifier"].info.id = buyerPaymentIdentifier;
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: requirement,
      payload: { signature: "fixture" },
      extensions: paymentExtensions,
      ...(resource === undefined ? {} : { resource }),
    }),
  ).toString("base64");
}

test("payment request envelope matches the x402api canonical contract", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"b":1}',
  );
  const value = request();
  assert.deepEqual(value.envelope, {
    version: 1,
    method: "POST",
    url: "https://api.warpmetal.test/checkout/standard",
    contentType: "application/json",
    bodyBase64: Buffer.from('{"taskId":"task_payment"}').toString("base64"),
    paymentRequired: value.envelope.paymentRequired,
    challengeDigest: value.challengeDigest,
    merchantReference: "task_payment",
  });
  assert.match(value.requestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(value.terms[0].amountAtomic, "12000000");
  assert.equal(value.terms[0].network, "eip155:8453");
  assert.equal(value.terms[0].agentWalletSupported, true);
  assert.equal(value.terms[0].buyerNativeFeeRequired, false);
});

test("payment artifacts must be private and bound to the exact request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-payment-test-"));
  const artifactPath = join(directory, "payment.json");
  const expected = request();
  const artifact = {
    version: 1,
    attemptId: "00000000-0000-4000-8000-000000000001",
    requestDigest: expected.requestDigest,
    buyerPaymentIdentifier: "buyer_payment_test_123",
    wallet: "warpmetal-base",
    payerAddress: "0x2222222222222222222222222222222222222222",
    selectedRequirementDigest: expected.terms[0].requirementDigest,
    paymentSignature: signature(
      paymentChallenge("https://api.warpmetal.test/checkout/standard")
        .resource,
    ),
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  try {
    await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, {
      mode: 0o600,
    });
    const parsed = await readPaymentArtifact(artifactPath, expected);
    assert.equal(parsed.attemptId, artifact.attemptId);
    assert.equal(parsed.paymentSignature, artifact.paymentSignature);

    await writeFile(
      artifactPath,
      `${JSON.stringify({
        ...artifact,
        paymentSignature: signature({
          url: "https://merchant.example/not-warpmetal",
        }),
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      readPaymentArtifact(artifactPath, expected),
      /signature is bound to a different checkout resource/,
    );

    await writeFile(
      artifactPath,
      `${JSON.stringify({
        ...artifact,
        paymentSignature: signature(
          paymentChallenge("https://api.warpmetal.test/checkout/standard")
            .resource,
          "buyer_payment_different_123",
        ),
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      readPaymentArtifact(artifactPath, expected),
      /signature extensions do not match the saved challenge/,
    );

    await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, {
      mode: 0o600,
    });

    await assert.rejects(
      readPaymentArtifact(artifactPath, {
        ...expected,
        requestDigest: `sha256:${"0".repeat(64)}`,
      }),
      /different checkout request/,
    );

    if (process.platform !== "win32") {
      await rm(artifactPath);
      await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, {
        mode: 0o644,
      });
      await assert.rejects(
        readPaymentArtifact(artifactPath, expected),
        /owner-only permissions/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("payment request envelopes reject challenge/resource mismatches", () => {
  const paymentRequired = Buffer.from(
    JSON.stringify(paymentChallenge("https://merchant.example/not-warpmetal")),
  ).toString("base64");
  assert.throws(
    () =>
      createPaymentRequestEnvelope({
        baseUrl: "https://api.warpmetal.test",
        checkoutPath: "/checkout/standard",
        checkoutBody: '{"taskId":"task_payment"}',
        paymentRequired,
        merchantReference: "task_payment",
      }),
    /different checkout URL/,
  );
});

test("payment request envelopes reject historical buyer-funded profiles", () => {
  const historical = JSON.parse(
    JSON.stringify(
      paymentChallenge("https://api.warpmetal.test/checkout/standard"),
    ),
  );
  historical.accepts[0].extra.payloadProfile =
    "com.k1hub.x402.base-usdc-eip3009-buyer-funded.v1";
  delete historical.extensions["com.x402api.gas-sponsorship"];
  assert.throws(
    () =>
      createPaymentRequestEnvelope({
        baseUrl: "https://api.warpmetal.test",
        checkoutPath: "/checkout/standard",
        checkoutBody: '{"taskId":"task_payment"}',
        paymentRequired: Buffer.from(JSON.stringify(historical)).toString(
          "base64",
        ),
        merchantReference: "task_payment",
      }),
    /@x402api\/agent-wallet-cli@0\.2\.1/,
  );
});
