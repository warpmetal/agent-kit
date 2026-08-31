import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StateStore } from "../src/state.js";

test("state keeps credentials private and redacts summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-state-test-"));
  const store = new StateStore(directory);
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_test",
          serverId: "server_test",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "owner_secret_value",
      },
      '{"taskId":"task_test"}',
    );

    const summary = await store.summary();
    assert.equal(summary.orders[0].credentialStored, true);
    assert.equal(summary.servers[0].recoveryCredentialStored, true);
    assert.equal(JSON.stringify(summary).includes("owner_secret_value"), false);

    const persisted = await readFile(store.path, "utf8");
    assert.equal(persisted.includes("owner_secret_value"), true);
    if (process.platform !== "win32")
      assert.equal(await store.permissions(), 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("version 1 state migrates to version 3 without losing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-state-migration-"));
  const store = new StateStore(directory);
  const legacy = {
    version: 1,
    orders: { task_old: { taskId: "task_old", ownerToken: "owner-secret" } },
    servers: { srv_old: { serverId: "srv_old", accessToken: "access-secret" } },
    operations: { op_old: { operationId: "op_old" } },
  };
  try {
    await writeFile(store.path, JSON.stringify(legacy), { mode: 0o600 });
    const migrated = await store.read();
    assert.equal(migrated.version, 3);
    assert.equal(migrated.orders.task_old.ownerToken, "owner-secret");
    assert.equal(migrated.servers.srv_old.accessToken, "access-secret");
    assert.deepEqual(migrated.runtimes, {});
    assert.deepEqual(migrated.identities, {});
    assert.deepEqual(migrated.renewals, {});
    assert.equal(JSON.parse(await readFile(store.path, "utf8")).version, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replacement payment challenge clears stale wallet-attempt metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-state-payment-refresh-"));
  const store = new StateStore(directory);
  const firstChallenge = {
    paymentRequired: "payment-required-one",
    paymentAttemptId: "pay_first",
    challengeHandle: "challenge-first",
    paymentRequestDigest: "sha256:request-one",
    paymentChallengeDigest: "sha256:challenge-one",
    paymentWorkflow: {
      requestEnvelopePath: join(directory, "request-one.json"),
      paymentArtifactPath: join(directory, "artifact-one.json"),
    },
  };
  try {
    await store.savePreparedOrder(
      {
        task: {
          id: "task_payment_refresh",
          serverId: "server_payment_refresh",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "owner-secret",
      },
      '{"taskId":"task_payment_refresh"}',
    );
    await store.savePaymentChallenge("task_payment_refresh", firstChallenge);
    await store.saveWalletPaymentAttempt("task_payment_refresh", {
      attemptId: "wallet-attempt-one",
      requestDigest: firstChallenge.paymentRequestDigest,
      buyerPaymentIdentifier: "buyer-payment-one",
      wallet: "warpmetal-base",
      payerAddress: "0x1111111111111111111111111111111111111111",
      path: firstChallenge.paymentWorkflow.paymentArtifactPath,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await store.saveOrderPaymentId(
      "task_payment_refresh",
      "00000000-0000-4000-8000-000000000012",
    );

    await store.savePaymentChallenge("task_payment_refresh", firstChallenge);
    assert.equal(
      (await store.order("task_payment_refresh")).walletPaymentAttemptId,
      "wallet-attempt-one",
    );

    await store.savePaymentChallenge("task_payment_refresh", {
      ...firstChallenge,
      paymentRequired: "payment-required-two",
      paymentAttemptId: "pay_second",
      challengeHandle: "challenge-second",
      paymentRequestDigest: "sha256:request-two",
      paymentChallengeDigest: "sha256:challenge-two",
      paymentWorkflow: {
        requestEnvelopePath: join(directory, "request-two.json"),
        paymentArtifactPath: join(directory, "artifact-two.json"),
      },
    });

    const refreshed = await store.order("task_payment_refresh");
    assert.equal(refreshed.paymentAttemptId, "pay_second");
    assert.equal(refreshed.paymentChallengeDigest, "sha256:challenge-two");
    assert.equal(refreshed.paymentArtifactPath, join(directory, "artifact-two.json"));
    for (const name of [
      "walletPaymentAttemptId",
      "walletBuyerPaymentIdentifier",
      "walletName",
      "walletPayerAddress",
      "paymentArtifactExpiresAt",
      "paymentArtifactSavedAt",
      "gatewayPaymentId",
    ]) {
      assert.equal(refreshed[name], undefined, `${name} must not survive a new challenge`);
    }

    const firstRenewalChallenge = {
      paymentAttemptId: "renewal-pay-first",
      paymentRequestDigest: "sha256:renewal-request-one",
      paymentChallengeDigest: "sha256:renewal-challenge-one",
      paymentArtifactPath: join(directory, "renewal-artifact-one.json"),
    };
    await store.saveRenewalPolicy(
      "server_payment_refresh",
      { maximumPaymentAtomic: "20000000" },
      "warpmetal-base",
      "20000000",
    );
    await store.saveRenewalChallenge(
      "server_payment_refresh",
      firstRenewalChallenge,
    );
    await store.saveRenewalPaymentAttempt("server_payment_refresh", {
      attemptId: "renewal-wallet-attempt-one",
      requestDigest: firstRenewalChallenge.paymentRequestDigest,
      buyerPaymentIdentifier: "renewal-buyer-payment-one",
      wallet: "warpmetal-base",
      payerAddress: "0x2222222222222222222222222222222222222222",
      path: firstRenewalChallenge.paymentArtifactPath,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await store.saveRenewalPaymentId(
      "server_payment_refresh",
      "00000000-0000-4000-8000-000000000022",
    );
    await store.saveRenewalChallenge(
      "server_payment_refresh",
      firstRenewalChallenge,
    );
    assert.equal(
      (await store.renewal("server_payment_refresh")).walletPaymentAttemptId,
      "renewal-wallet-attempt-one",
    );
    await store.saveRenewalChallenge("server_payment_refresh", {
      ...firstRenewalChallenge,
      paymentAttemptId: "renewal-pay-second",
      paymentRequestDigest: "sha256:renewal-request-two",
      paymentChallengeDigest: "sha256:renewal-challenge-two",
      paymentArtifactPath: join(directory, "renewal-artifact-two.json"),
    });
    const refreshedRenewal = await store.renewal("server_payment_refresh");
    assert.equal(refreshedRenewal.paymentAttemptId, "renewal-pay-second");
    assert.equal(refreshedRenewal.walletPaymentAttemptId, undefined);
    assert.equal(refreshedRenewal.paymentArtifactExpiresAt, undefined);
    assert.equal(refreshedRenewal.gatewayPaymentId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("state binds a dedicated SSH identity and renewal policy to one server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-state-identity-"));
  const store = new StateStore(directory);
  try {
    await store.saveIdentity({
      identityId: "idn_test",
      keyName: "warpmetal-customer-api-prod",
      hostnameAtCreation: "customer-api-prod",
      privateKeyPath: join(directory, "ssh", "warpmetal-customer-api-prod"),
      publicKeyPath: join(directory, "ssh", "warpmetal-customer-api-prod.pub"),
      sshFingerprint: "SHA256:test",
    });
    await store.savePreparedOrder(
      {
        task: {
          id: "task_identity",
          serverId: "srv_identity",
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: "owner-secret",
      },
      '{"taskId":"task_identity"}',
      "idn_test",
    );
    await store.saveRenewalPolicy(
      "srv_identity",
      { maximumPaymentAtomic: "20000000" },
      "agent-wallet",
      "20000000",
    );
    const identity = await store.identityForServer("srv_identity");
    const renewal = await store.renewal("srv_identity");
    assert.equal(identity.keyName, "warpmetal-customer-api-prod");
    assert.equal(identity.taskId, "task_identity");
    assert.equal(renewal.wallet, "agent-wallet");
    assert.equal(renewal.refillTargetAtomic, "20000000");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
