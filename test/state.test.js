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
          checkoutPath: "/api/checkout/agent",
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

test("version 1 state migrates to version 2 without losing credentials", async () => {
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
    assert.equal(migrated.version, 2);
    assert.equal(migrated.orders.task_old.ownerToken, "owner-secret");
    assert.equal(migrated.servers.srv_old.accessToken, "access-secret");
    assert.deepEqual(migrated.runtimes, {});
    assert.equal(JSON.parse(await readFile(store.path, "utf8")).version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
