import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";

import { installRuntime, verifyRuntimeArtifact } from "../src/installer.js";

const BASE_BUNDLE_FILES = [
  "install.sh",
  "warpmetal-agentctl",
  "warpmetal-sandbox-gateway",
  "warpmetal-sandbox-shell",
  "warpmetal-podman-service",
  "warpmetal-podman.service",
  "warpmetald",
  "warpmetald.service",
  "warpmetal-sandbox.conf",
];

const NESTED_PRIVATE_PROCFS_FILES = [
  "nested-private-procfs-oracle.sh",
  "warpmetal-agent-runtime-bwrap",
  "warpmetal-apparmor-policy.sh",
  "warpmetal-policy-metadata",
];

const PRIVATE_PROCFS_BUNDLE_FILES = [
  ...BASE_BUNDLE_FILES,
  ...NESTED_PRIVATE_PROCFS_FILES,
];

function artifactFixture(version = "0.1.24") {
  const content = Buffer.from("signed WarpMetal runtime archive");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    content,
    metadata: {
      version,
      url: "https://releases.warpmetal.com/runtime.tar.gz",
      sha256: createHash("sha256").update(content).digest("hex"),
      signature: sign(null, content, privateKey).toString("base64"),
      signingPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    },
  };
}

function spawnRecorder({
  failInstall = false,
  installError = "install failed",
  bundleFiles = BASE_BUNDLE_FILES,
} = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "tar" && args[0] === "-xzf") {
      const extractPath = args[args.indexOf("-C") + 1];
      mkdirSync(extractPath, { recursive: true });
      for (const file of bundleFiles)
        writeFileSync(`${extractPath}/${file}`, "fixture");
    }
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const isInstall =
      command === "ssh" && args.some((argument) => argument.endsWith("/install.sh"));
    queueMicrotask(() => {
      if (failInstall && isInstall) child.stderr.end(installError);
      else child.stderr.end();
      child.stdout.end();
      child.emit("close", failInstall && isInstall ? 1 : 0);
    });
    return child;
  };
  return { calls, spawnImpl };
}

function installFixture(options = {}) {
  const { artifactVersion = "0.1.24", ...runtimeOptions } = options;
  const { content, metadata } = artifactFixture(artifactVersion);
  return {
    arguments: {
      client: {
        baseUrl: "https://api.warpmetal.com",
        getServer: async () => ({
          data: { task: { state: "ready", publicIp: "203.0.113.10" } },
        }),
      },
      serverId: "srv_example123",
      token: "owner-token",
      identity: "/tmp/owner-key",
      sshUser: "root",
      bootstrap: { artifact: metadata, bootstrapToken: "rtb_secret" },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(content.length) }),
        arrayBuffer: async () => content,
      }),
      ...runtimeOptions,
    },
  };
}

test("runtime artifact requires both checksum and signature", () => {
  const content = Buffer.from("signed WarpMetal runtime artifact");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const metadata = {
    version: "0.1.0",
    url: "https://releases.warpmetal.com/runtime.tar.gz",
    sha256: createHash("sha256").update(content).digest("hex"),
    signature: sign(null, content, privateKey).toString("base64"),
    signingPublicKey: publicKey.export({ type: "spki", format: "pem" }),
  };
  assert.equal(verifyRuntimeArtifact(content, metadata).version, "0.1.0");
  assert.throws(
    () => verifyRuntimeArtifact(Buffer.from("changed"), metadata),
    /checksum/,
  );
  assert.throws(
    () =>
      verifyRuntimeArtifact(content, {
        ...metadata,
        signature: Buffer.alloc(64).toString("base64"),
      }),
    /signature/,
  );
});

test("runtime installation uses argument arrays and removes remote staging", async () => {
  const recorder = spawnRecorder();
  const fixture = installFixture({
    nestedPrivateProcfs: "preserve",
    spawnImpl: recorder.spawnImpl,
  });
  const result = await installRuntime(fixture.arguments);
  assert.equal(result.installed, true);
  assert.equal(result.nestedPrivateProcfsAction, "preserve");
  assert.ok(recorder.calls.every((call) => call.options.shell === false));
  const install = recorder.calls.find(
    (call) =>
      call.command === "ssh" &&
      call.args.some((argument) => argument.endsWith("/install.sh")),
  );
  assert.ok(install);
  assert.equal(install.args.includes("--nested-private-procfs"), false);
  const cleanup = recorder.calls.at(-1);
  assert.equal(cleanup.command, "ssh");
  assert.deepEqual(cleanup.args.slice(-6, -2), ["sudo", "rm", "-rf", "--"]);
  assert.match(cleanup.args.at(-2), /^\/tmp\/warpmetal-runtime-[a-f0-9]{32}$/);
  assert.match(
    cleanup.args.at(-1),
    /^\/tmp\/warpmetal-runtime-[a-f0-9]{32}\.tar\.gz$/,
  );
});

test("runtime v0.1.25 accepts the exact policy bundle and preserves policy state by default", async () => {
  const recorder = spawnRecorder({ bundleFiles: PRIVATE_PROCFS_BUNDLE_FILES });
  const fixture = installFixture({
    artifactVersion: "0.1.25",
    spawnImpl: recorder.spawnImpl,
  });

  const result = await installRuntime(fixture.arguments);

  assert.equal(result.nestedPrivateProcfsAction, "preserve");
  const install = recorder.calls.find(
    (call) =>
      call.command === "ssh" &&
      call.args.some((argument) => argument.endsWith("/install.sh")),
  );
  assert.ok(install);
  assert.equal(install.args.includes("--nested-private-procfs"), false);
});

for (const action of ["enable", "disable"]) {
  test(`runtime v0.1.25 forwards the explicit nested private procfs ${action} action`, async () => {
    const recorder = spawnRecorder({ bundleFiles: PRIVATE_PROCFS_BUNDLE_FILES });
    const fixture = installFixture({
      artifactVersion: "0.1.25",
      nestedPrivateProcfs: action,
      spawnImpl: recorder.spawnImpl,
    });

    const result = await installRuntime(fixture.arguments);

    assert.equal(result.nestedPrivateProcfsAction, action);
    const install = recorder.calls.find(
      (call) =>
        call.command === "ssh" &&
        call.args.some((argument) => argument.endsWith("/install.sh")),
    );
    assert.ok(install);
    const option = install.args.indexOf("--nested-private-procfs");
    assert.equal(install.args[option + 1], action);
  });
}

test("older Runtime artifacts reject nested private procfs actions before upload", async () => {
  const recorder = spawnRecorder();
  const fixture = installFixture({
    nestedPrivateProcfs: "enable",
    spawnImpl: recorder.spawnImpl,
  });

  await assert.rejects(
    () => installRuntime(fixture.arguments),
    /does not support nested private procfs actions/,
  );
  assert.equal(recorder.calls.length, 0);
});

test("runtime installation rejects an unknown nested private procfs action", async () => {
  const recorder = spawnRecorder({ bundleFiles: PRIVATE_PROCFS_BUNDLE_FILES });
  const fixture = installFixture({
    artifactVersion: "0.1.25",
    nestedPrivateProcfs: "automatic",
    spawnImpl: recorder.spawnImpl,
  });

  await assert.rejects(
    () => installRuntime(fixture.arguments),
    /nested private procfs action is invalid/,
  );
  assert.equal(recorder.calls.length, 0);
});

test("runtime v0.1.25 rejects a bundle missing a policy file before upload", async () => {
  const recorder = spawnRecorder({
    bundleFiles: PRIVATE_PROCFS_BUNDLE_FILES.filter(
      (file) => file !== "warpmetal-policy-metadata",
    ),
  });
  const fixture = installFixture({
    artifactVersion: "0.1.25",
    spawnImpl: recorder.spawnImpl,
  });

  await assert.rejects(
    () => installRuntime(fixture.arguments),
    /bundle files do not match this CLI version/,
  );
  assert.equal(recorder.calls.some((call) => call.command === "scp"), false);
});

for (const [version, bundleFiles] of [
  ["0.1.24", [...BASE_BUNDLE_FILES, "unexpected-policy-helper"]],
  ["0.1.25", [...PRIVATE_PROCFS_BUNDLE_FILES, "unexpected-policy-helper"]],
]) {
  test(`runtime ${version} rejects an unexpected bundle file before upload`, async () => {
    const recorder = spawnRecorder({ bundleFiles });
    const fixture = installFixture({
      artifactVersion: version,
      spawnImpl: recorder.spawnImpl,
    });

    await assert.rejects(
      () => installRuntime(fixture.arguments),
      /bundle files do not match this CLI version/,
    );
    assert.equal(recorder.calls.some((call) => call.command === "scp"), false);
  });
}

for (const state of ["cancellation_pending", "cancelled"]) {
  test(`runtime installation accepts ${state} while the paid term is active`, async () => {
    const recorder = spawnRecorder();
    const fixture = installFixture({
      spawnImpl: recorder.spawnImpl,
      client: {
        baseUrl: "https://api.warpmetal.com",
        getServer: async () => ({
          data: {
            task: {
              state,
              publicIp: "203.0.113.10",
              termEndsAt: "2099-01-01T00:00:00.000Z",
            },
          },
        }),
      },
    });
    const result = await installRuntime(fixture.arguments);
    assert.equal(result.installed, true);
    assert.ok(recorder.calls.some((call) => call.command === "scp"));
  });
}

test("runtime installation rejects a cancelled server after its paid term", async () => {
  const recorder = spawnRecorder();
  const fixture = installFixture({
    spawnImpl: recorder.spawnImpl,
    client: {
      baseUrl: "https://api.warpmetal.com",
      getServer: async () => ({
        data: {
          task: {
            state: "cancelled",
            publicIp: "203.0.113.10",
            termEndsAt: "2000-01-01T00:00:00.000Z",
          },
        },
      }),
    },
  });
  await assert.rejects(
    () => installRuntime(fixture.arguments),
    /active paid term/,
  );
  assert.equal(recorder.calls.length, 0);
});

test("runtime installation still removes remote staging after failure", async () => {
  const recorder = spawnRecorder({ failInstall: true });
  const fixture = installFixture({ spawnImpl: recorder.spawnImpl });
  await assert.rejects(() => installRuntime(fixture.arguments), /install failed/);
  const cleanup = recorder.calls.at(-1);
  assert.equal(cleanup.command, "ssh");
  assert.deepEqual(cleanup.args.slice(-6, -2), ["sudo", "rm", "-rf", "--"]);
});

test("runtime installation maps fail-closed host checks without raw package output", async () => {
  const recorder = spawnRecorder({
    failInstall: true,
    installError:
      "apt emitted bounded diagnostic output\nruntime_package_plan_unsafe\n",
  });
  const fixture = installFixture({ spawnImpl: recorder.spawnImpl });
  await assert.rejects(
    () => installRuntime(fixture.arguments),
    (error) => {
      assert.equal(error.code, "runtime_package_plan_unsafe");
      assert.match(error.message, /refused a package transaction/);
      assert.match(error.message, /runtime_package_plan_unsafe/);
      assert.doesNotMatch(error.message, /apt emitted/);
      return true;
    },
  );
  const cleanup = recorder.calls.at(-1);
  assert.equal(cleanup.command, "ssh");
  assert.deepEqual(cleanup.args.slice(-6, -2), ["sudo", "rm", "-rf", "--"]);
});

test("runtime installation maps nested private procfs failures without raw host output", async () => {
  const recorder = spawnRecorder({
    failInstall: true,
    installError:
      "apparmor_parser emitted private host state\nruntime_apparmor_policy_rollback_failed\n",
    bundleFiles: PRIVATE_PROCFS_BUNDLE_FILES,
  });
  const fixture = installFixture({
    artifactVersion: "0.1.25",
    nestedPrivateProcfs: "enable",
    spawnImpl: recorder.spawnImpl,
  });

  await assert.rejects(
    () => installRuntime(fixture.arguments),
    (error) => {
      assert.equal(error.code, "runtime_apparmor_policy_rollback_failed");
      assert.match(error.message, /operator recovery is required/);
      assert.doesNotMatch(error.message, /apparmor_parser emitted/);
      return true;
    },
  );
});

test("runtime rollback failure takes priority over an ordinary policy failure", async () => {
  const recorder = spawnRecorder({
    failInstall: true,
    installError:
      "runtime_apparmor_policy_install_failed\nruntime_apparmor_policy_rollback_failed\n",
    bundleFiles: PRIVATE_PROCFS_BUNDLE_FILES,
  });
  const fixture = installFixture({
    artifactVersion: "0.1.25",
    nestedPrivateProcfs: "enable",
    spawnImpl: recorder.spawnImpl,
  });

  await assert.rejects(
    () => installRuntime(fixture.arguments),
    (error) => {
      assert.equal(error.code, "runtime_apparmor_policy_rollback_failed");
      assert.match(error.message, /operator recovery is required/);
      assert.doesNotMatch(error.message, /install_failed/);
      return true;
    },
  );
});
