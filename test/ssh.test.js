import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSshPublicKey, signSshChallenge } from "../src/ssh.js";

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
