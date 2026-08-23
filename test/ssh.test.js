import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generateServerKey,
  readSshPublicKey,
  serverKeyName,
  signSshChallenge,
} from "../src/ssh.js";

test("server keys use the actual hostname and never overwrite collisions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-server-key-test-"));
  try {
    assert.deepEqual(serverKeyName("Customer-API-Prod"), {
      hostname: "customer-api-prod",
      keyName: "warpmetal-customer-api-prod",
    });
    const first = await generateServerKey(directory, "customer-api-prod");
    const second = await generateServerKey(
      directory,
      "customer-api-prod",
      undefined,
      { random: () => Buffer.from([0xab, 0xcd]) },
    );
    assert.equal(first.keyName, "warpmetal-customer-api-prod");
    assert.equal(second.keyName, "warpmetal-customer-api-prod-abcd");
    assert.match(await readFile(first.publicKeyPath, "utf8"), /warpmetal:customer-api-prod/);
    assert.notEqual(first.sshFingerprint, undefined);
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(first.privateKeyPath)).mode & 0o777, 0o600);
    }
  } catch (error) {
    if (error?.message?.includes("ssh-keygen is required")) {
      context.skip("ssh-keygen is not installed");
      return;
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public-key reader rejects private keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-public-key-test-"));
  const path = join(directory, "identity");
  try {
    await writeFile(
      path,
      "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n",
      "utf8",
    );
    await assert.rejects(() => readSshPublicKey(path), /never a private key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SSH challenge uses an OpenSSH namespaced signature", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-ssh-test-"));
  const identity = join(directory, "id_ed25519");
  try {
    const generated = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-f", identity],
      { stdio: "ignore" },
    );
    if (generated.error?.code === "ENOENT") {
      context.skip("ssh-keygen is not installed");
      return;
    }
    assert.equal(generated.status, 0);

    const signature = await signSshChallenge(
      "warpmetal-ssh-auth-v1\nchallenge-id\nserver-id\nnonce\n",
      identity,
    );
    assert.match(signature, /-----BEGIN SSH SIGNATURE-----/);
    assert.match(signature, /-----END SSH SIGNATURE-----/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
