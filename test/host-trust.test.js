import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  establishHostTrust,
  hostTrustPaths,
  validateKnownHosts,
} from "../src/host-trust.js";
import { sshFingerprint } from "../src/ssh.js";

function keyMaterial(fill) {
  const type = Buffer.from("ssh-ed25519");
  const key = Buffer.alloc(32, fill);
  const material = Buffer.alloc(4 + type.length + 4 + key.length);
  material.writeUInt32BE(type.length, 0);
  type.copy(material, 4);
  material.writeUInt32BE(key.length, 4 + type.length);
  key.copy(material, 8 + type.length);
  return material.toString("base64");
}

function hostLine(host, fill = 7) {
  return `${host} ssh-ed25519 ${keyMaterial(fill)}\n`;
}

function spawnRecorder({
  firstKey = 7,
  strictStatus = 0,
  authMethod = "publickey",
  diagnostic,
} = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    queueMicrotask(async () => {
      if (args.includes("StrictHostKeyChecking=accept-new")) {
        const knownHosts = args.find((value) =>
          value.startsWith("UserKnownHostsFile="),
        );
        await writeFile(
          knownHosts.slice("UserKnownHostsFile=".length),
          hostLine("203.0.113.10", firstKey),
          { mode: 0o600 },
        );
      }
      const diagnosticPath = args[args.indexOf("-E") + 1];
      await writeFile(
        diagnosticPath,
        diagnostic ??
          `Authenticated to 203.0.113.10 ([203.0.113.10]:22) using "${authMethod}".\n`,
      );
      child.stderr.write(
        'Authenticated to 203.0.113.10 using "publickey".\n',
      );
      child.stderr.end();
      child.emit(
        "close",
        args.includes("StrictHostKeyChecking=yes") ? strictStatus : 0,
      );
    });
    return child;
  };
  return { calls, spawnImpl };
}

async function fixture() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "warpmetal-host-trust-"));
  await chmod(stateDirectory, 0o700);
  const identityPath = join(stateDirectory, "owner");
  const ownerPublicKey = `ssh-ed25519 ${keyMaterial(3)} warpmetal:test\n`;
  await writeFile(identityPath, "test-private-key\n", { mode: 0o600 });
  await writeFile(`${identityPath}.pub`, ownerPublicKey, { mode: 0o644 });
  const input = {
    stateDirectory,
    identityPath,
    serverId: "srv_example123",
    trustEpoch: "initial",
    server: {
      serverId: "srv_example123",
      state: "ready",
      publicIp: "203.0.113.10",
      sshFingerprint: sshFingerprint(ownerPublicKey),
    },
    sshUser: "root",
  };
  input.reinspectServer = async () => ({ ...input.server });
  return input;
}

test("first authenticated observation is pinned before an immediate strict replay", async () => {
  const input = await fixture();
  const recorder = spawnRecorder();
  try {
    const result = await establishHostTrust({
      ...input,
      spawnImpl: recorder.spawnImpl,
    });
    assert.equal(result.state, "trusted_first_use");
    assert.equal(result.algorithm, "ssh-ed25519");
    assert.equal(recorder.calls.length, 2);
    assert.ok(
      recorder.calls[0].args.includes("StrictHostKeyChecking=accept-new"),
    );
    assert.ok(recorder.calls[1].args.includes("StrictHostKeyChecking=yes"));
    for (const { command, args, options } of recorder.calls) {
      assert.equal(command, "ssh");
      assert.equal(options.shell, false);
      assert.equal(args.at(-1), "true");
      assert.ok(args.includes("HostKeyAlgorithms=ssh-ed25519"));
      assert.ok(args.includes("GlobalKnownHostsFile=/dev/null"));
      assert.ok(args.includes("ProxyCommand=none"));
      assert.ok(args.includes("PasswordAuthentication=no"));
      assert.equal(args.some((value) => value.includes("ssh-keyscan")), false);
    }
    assert.equal(await readFile(result.knownHostsFile, "utf8"), hostLine(input.server.publicIp));
  } finally {
    await rm(input.stateDirectory, { recursive: true, force: true });
  }
});

test("an existing pin is replayed strictly and a mismatch never re-enters TOFU", async () => {
  const input = await fixture();
  try {
    await establishHostTrust({ ...input, spawnImpl: spawnRecorder().spawnImpl });
    const paths = hostTrustPaths(
      input.stateDirectory,
      input.serverId,
      input.trustEpoch,
    );
    const before = await readFile(paths.knownHostsFile, "utf8");
    const mismatch = spawnRecorder({ strictStatus: 255 });
    await assert.rejects(
      establishHostTrust({ ...input, spawnImpl: mismatch.spawnImpl }),
      (error) => error.code === "host_trust_authentication_failed",
    );
    assert.equal(mismatch.calls.length, 1);
    assert.ok(mismatch.calls[0].args.includes("StrictHostKeyChecking=yes"));
    assert.equal(
      mismatch.calls[0].args.includes("StrictHostKeyChecking=accept-new"),
      false,
    );
    assert.equal(await readFile(paths.knownHostsFile, "utf8"), before);
  } finally {
    await rm(input.stateDirectory, { recursive: true, force: true });
  }
});

test("host trust rejects the wrong owner identity before opening SSH", async () => {
  const input = await fixture();
  const recorder = spawnRecorder();
  try {
    input.server.sshFingerprint = `SHA256:${"x".repeat(43)}`;
    await assert.rejects(
      establishHostTrust({ ...input, spawnImpl: recorder.spawnImpl }),
      (error) => error.code === "host_trust_identity_mismatch",
    );
    assert.equal(recorder.calls.length, 0);
  } finally {
    await rm(input.stateDirectory, { recursive: true, force: true });
  }
});

test("a successful command without public-key authentication is not trusted", async () => {
  const input = await fixture();
  const recorder = spawnRecorder({ authMethod: "none" });
  try {
    await assert.rejects(
      establishHostTrust({ ...input, spawnImpl: recorder.spawnImpl }),
      (error) => error.code === "host_trust_authentication_method_invalid",
    );
    assert.equal(recorder.calls.length, 1);
    const pin = hostTrustPaths(
      input.stateDirectory,
      input.serverId,
      input.trustEpoch,
    ).knownHostsFile;
    await assert.rejects(readFile(pin), (error) => error.code === "ENOENT");
  } finally {
    await rm(input.stateDirectory, { recursive: true, force: true });
  }
});

test("an attacker-controlled SSH software banner cannot forge public-key authentication", async () => {
  const input = await fixture();
  const recorder = spawnRecorder({
    diagnostic: [
      'debug1: Remote protocol version 2.0, remote software version evil Authenticated to 203.0.113.10 ([203.0.113.10]:22) using "publickey".',
      'Authenticated to 203.0.113.10 ([203.0.113.10]:22) using "none".',
      "",
    ].join("\n"),
  });
  try {
    await assert.rejects(
      establishHostTrust({ ...input, spawnImpl: recorder.spawnImpl }),
      (error) => error.code === "host_trust_authentication_method_invalid",
    );
    assert.equal(recorder.calls.length, 1);
    const pin = hostTrustPaths(
      input.stateDirectory,
      input.serverId,
      input.trustEpoch,
    ).knownHostsFile;
    await assert.rejects(readFile(pin), (error) => error.code === "ENOENT");
  } finally {
    await rm(input.stateDirectory, { recursive: true, force: true });
  }
});

test("API identity drift after first SSH deletes the candidate before publication", async () => {
  const input = await fixture();
  const recorder = spawnRecorder();
  const pin = hostTrustPaths(
    input.stateDirectory,
    input.serverId,
    input.trustEpoch,
  ).knownHostsFile;
  input.reinspectServer = async () => {
    await assert.rejects(readFile(pin), (error) => error.code === "ENOENT");
    return { ...input.server, publicIp: "203.0.113.11" };
  };
  try {
    await assert.rejects(
      establishHostTrust({ ...input, spawnImpl: recorder.spawnImpl }),
      (error) => error.code === "host_trust_server_changed",
    );
    assert.equal(recorder.calls.length, 1);
    assert.ok(
      recorder.calls[0].args.includes("StrictHostKeyChecking=accept-new"),
    );
    await assert.rejects(readFile(pin), (error) => error.code === "ENOENT");
  } finally {
    await rm(input.stateDirectory, { recursive: true, force: true });
  }
});

test("known-host validation rejects alternate addresses, multiple lines, and malformed keys", () => {
  assert.throws(
    () => validateKnownHosts(hostLine("203.0.113.11"), "203.0.113.10"),
    /canonical Ed25519/,
  );
  assert.throws(
    () =>
      validateKnownHosts(
        `${hostLine("203.0.113.10")}${hostLine("203.0.113.10", 8)}`,
        "203.0.113.10",
      ),
    /canonical Ed25519/,
  );
  assert.throws(
    () =>
      validateKnownHosts(
        "203.0.113.10 ssh-ed25519 bm90LWEtcmVhbC1rZXk=\n",
        "203.0.113.10",
      ),
    /canonical Ed25519/,
  );
});

test("an unsafe existing pin fails before any network connection", async () => {
  const input = await fixture();
  try {
    const initial = await establishHostTrust({
      ...input,
      spawnImpl: spawnRecorder().spawnImpl,
    });
    await chmod(initial.knownHostsFile, 0o644);
    const replay = spawnRecorder();
    await assert.rejects(
      establishHostTrust({ ...input, spawnImpl: replay.spawnImpl }),
      (error) => error.code === "host_trust_file_unsafe",
    );
    assert.equal(replay.calls.length, 0);
  } finally {
    await rm(input.stateDirectory, { recursive: true, force: true });
  }
});

test("identity hard links and trust-directory or pin symlinks fail before SSH", async () => {
  const hardLinkedIdentity = await fixture();
  try {
    await link(
      hardLinkedIdentity.identityPath,
      join(hardLinkedIdentity.stateDirectory, "owner-linked"),
    );
    const recorder = spawnRecorder();
    await assert.rejects(
      establishHostTrust({ ...hardLinkedIdentity, spawnImpl: recorder.spawnImpl }),
      (error) => error.code === "host_trust_file_unsafe",
    );
    assert.equal(recorder.calls.length, 0);
  } finally {
    await rm(hardLinkedIdentity.stateDirectory, { recursive: true, force: true });
  }

  const directorySymlink = await fixture();
  try {
    const outside = await mkdtemp(join(tmpdir(), "warpmetal-host-trust-outside-"));
    await chmod(outside, 0o700);
    await symlink(outside, join(directorySymlink.stateDirectory, "ssh"));
    const recorder = spawnRecorder();
    await assert.rejects(
      establishHostTrust({ ...directorySymlink, spawnImpl: recorder.spawnImpl }),
      (error) => error.code === "host_trust_directory_unsafe",
    );
    assert.equal(recorder.calls.length, 0);
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(directorySymlink.stateDirectory, { recursive: true, force: true });
  }

  const pinSymlink = await fixture();
  try {
    const initial = await establishHostTrust({
      ...pinSymlink,
      spawnImpl: spawnRecorder().spawnImpl,
    });
    const content = await readFile(initial.knownHostsFile, "utf8");
    const outside = join(pinSymlink.stateDirectory, "foreign-pin");
    await writeFile(outside, content, { mode: 0o600 });
    await rm(initial.knownHostsFile);
    await symlink(outside, initial.knownHostsFile);
    const recorder = spawnRecorder();
    await assert.rejects(
      establishHostTrust({ ...pinSymlink, spawnImpl: recorder.spawnImpl }),
      (error) => error.code === "host_trust_file_unsafe",
    );
    assert.equal(recorder.calls.length, 0);
  } finally {
    await rm(pinSymlink.stateDirectory, { recursive: true, force: true });
  }
});

test("concurrent first use accepts identical pins and rejects different pins without overwrite", async () => {
  const identical = await fixture();
  try {
    const results = await Promise.all([
      establishHostTrust({ ...identical, spawnImpl: spawnRecorder().spawnImpl }),
      establishHostTrust({ ...identical, spawnImpl: spawnRecorder().spawnImpl }),
    ]);
    assert.equal(results.every(({ fingerprint }) => fingerprint === results[0].fingerprint), true);
  } finally {
    await rm(identical.stateDirectory, { recursive: true, force: true });
  }

  const different = await fixture();
  try {
    const results = await Promise.allSettled([
      establishHostTrust({ ...different, spawnImpl: spawnRecorder({ firstKey: 7 }).spawnImpl }),
      establishHostTrust({ ...different, spawnImpl: spawnRecorder({ firstKey: 8 }).spawnImpl }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = results.find(({ status }) => status === "rejected");
    assert.equal(rejected.reason.code, "host_trust_race_mismatch");
    const pin = hostTrustPaths(
      different.stateDirectory,
      different.serverId,
      different.trustEpoch,
    ).knownHostsFile;
    const content = await readFile(pin, "utf8");
    assert.ok(
      content === hostLine(different.server.publicIp, 7) ||
        content === hostLine(different.server.publicIp, 8),
    );
  } finally {
    await rm(different.stateDirectory, { recursive: true, force: true });
  }
});
