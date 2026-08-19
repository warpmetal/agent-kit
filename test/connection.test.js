import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  connectionProfile,
  readConnectionProfile,
  writeConnectionProfile,
} from "../src/connection.js";
import { connectSandbox } from "../src/ssh.js";

const hostPublicKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const fingerprint = `SHA256:${createHash("sha256")
  .update(Buffer.from(hostPublicKey.split(" ")[1], "base64"))
  .digest("base64")
  .replace(/=+$/, "")}`;

test("connection profiles are token-free, private, and pin the host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-connection-"));
  const path = join(directory, "reviewer.json");
  try {
    const profile = connectionProfile(
      "srv_test12345",
      "sbx_test12345",
      "grant_test12345",
      {
        host: "203.0.113.10",
        port: 22,
        username: "warpmetal-sandbox",
        hostKeys: [{ publicKey: hostPublicKey, fingerprint }],
      },
    );
    await writeConnectionProfile(path, profile);
    const persisted = await readFile(path, "utf8");
    assert.equal(/token|privateKey|identity/i.test(persisted), false);
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      (await readConnectionProfile(path)).hostKeys[0].fingerprint,
      fingerprint,
    );

    let invocation;
    const status = await connectSandbox(
      path,
      join(directory, "private-key-do-not-read"),
      ["printf", "%s", "hello world"],
      {
        spawn(command, args, options) {
          invocation = { command, args, options };
          return { status: 17 };
        },
      },
    );
    assert.equal(status, 17);
    assert.equal(invocation.command, "ssh");
    assert.equal(invocation.options.shell, false);
    assert.ok(invocation.args.includes("StrictHostKeyChecking=yes"));
    assert.ok(invocation.args.includes("ClearAllForwardings=yes"));
    assert.equal(invocation.args.at(-1), "'printf' '%s' 'hello world'");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connection profile rejects a mismatched API fingerprint", () => {
  assert.throws(
    () =>
      connectionProfile("srv_test12345", "sbx_test12345", "grant_test12345", {
        host: "203.0.113.10",
        port: 22,
        username: "warpmetal-sandbox",
        hostKeys: [{ publicKey: hostPublicKey, fingerprint: "SHA256:wrong" }],
      }),
    /fingerprint/,
  );
});
