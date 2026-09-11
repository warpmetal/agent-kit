import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  readConnectionProfile,
  writeConnectionProfile,
} from "../src/connection.js";
import { main } from "../src/cli.js";

const aliasModule = await import("../src/ssh-alias.js").catch(() => null);

function requireAliasExport(name) {
  assert.ok(aliasModule, "src/ssh-alias.js must implement the managed SSH alias contract");
  assert.equal(
    typeof aliasModule[name],
    "function",
    `src/ssh-alias.js must export ${name}`,
  );
  return aliasModule[name];
}

function hostKey(fill) {
  const material = Buffer.alloc(32, fill);
  const encoded = material.toString("base64");
  return {
    publicKey: `ssh-ed25519 ${encoded}`,
    fingerprint: `SHA256:${createHash("sha256")
      .update(material)
      .digest("base64")
      .replace(/=+$/, "")}`,
  };
}

function profile(overrides = {}) {
  return {
    version: 1,
    serverId: "srv_alias12345",
    sandboxId: "sbx_alias12345",
    grantId: "grant_alias12345",
    host: "203.0.113.42",
    port: 22443,
    username: "warpmetal-sandbox",
    hostKeys: [hostKey(7)],
    ...overrides,
  };
}

function paths(homeDirectory, alias = "wm-planner") {
  const sshDirectory = join(homeDirectory, ".ssh");
  const managedDirectory = join(sshDirectory, "warpmetal.d");
  return {
    sshDirectory,
    managedDirectory,
    sshConfigPath: join(sshDirectory, "config"),
    configPath: join(managedDirectory, `${alias}.conf`),
    knownHostsPath: join(managedDirectory, `${alias}.known_hosts`),
  };
}

async function fixture(alias = "wm-planner") {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-ssh-alias-"));
  const homeDirectory = join(directory, "home");
  const connectionFile = join(directory, "connection.json");
  const identity = join(directory, "sandbox-identity");
  await mkdir(homeDirectory, { mode: 0o700 });
  await writeConnectionProfile(connectionFile, profile());
  await writeFile(
    identity,
    "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-marker-do-not-print\n-----END OPENSSH PRIVATE KEY-----\n",
    { mode: 0o600 },
  );
  await chmod(identity, 0o600);
  return {
    directory,
    homeDirectory,
    connectionFile,
    identity,
    alias,
    ...paths(homeDirectory, alias),
  };
}

async function snapshot(filePaths) {
  const result = {};
  for (const path of filePaths) {
    try {
      const metadata = await lstat(path);
      result[path] = {
        bytes: metadata.isFile() ? await readFile(path) : null,
        ino: metadata.ino,
        mode: metadata.mode & 0o777,
        mtimeMs: metadata.mtimeMs,
        type: metadata.isFile()
          ? "file"
          : metadata.isDirectory()
            ? "directory"
            : metadata.isSymbolicLink()
              ? "symlink"
              : "other",
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      result[path] = null;
    }
  }
  return result;
}

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    value: () => value,
  };
}

function installOptions(item, overrides = {}) {
  return {
    alias: item.alias,
    connectionFile: item.connectionFile,
    identity: item.identity,
    homeDirectory: item.homeDirectory,
    ...overrides,
  };
}

const expectedOptionLines = (item) => [
  "# Managed by WarpMetal. Do not edit.",
  `Host ${item.alias}`,
  "  HostName 203.0.113.42",
  "  Port 22443",
  "  User warpmetal-sandbox",
  `  IdentityFile ${resolve(item.identity)}`,
  "  IdentitiesOnly yes",
  "  PubkeyAuthentication yes",
  "  PreferredAuthentications publickey",
  "  PasswordAuthentication no",
  "  KbdInteractiveAuthentication no",
  "  ChallengeResponseAuthentication no",
  "  GSSAPIAuthentication no",
  "  StrictHostKeyChecking yes",
  `  UserKnownHostsFile ${resolve(item.knownHostsPath)}`,
  "  GlobalKnownHostsFile /dev/null",
  "  HashKnownHosts no",
  "  UpdateHostKeys no",
  "  VerifyHostKeyDNS no",
  "  ClearAllForwardings yes",
  "  ForwardAgent no",
  "  ForwardX11 no",
  "  PermitLocalCommand no",
  "  ProxyCommand none",
  "  ProxyJump none",
  "  ExitOnForwardFailure yes",
  "  ControlMaster no",
  "  ControlPath none",
  "",
].join("\n");

test("connection profiles remain closed and recompute every host-key fingerprint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-closed-profile-"));
  try {
    const invalid = join(directory, "invalid.json");
    await writeFile(invalid, JSON.stringify({ ...profile(), ownerToken: "secret" }));
    await assert.rejects(() => readConnectionProfile(invalid), /unsupported fields/);
    await writeFile(
      invalid,
      JSON.stringify({
        ...profile(),
        hostKeys: [
          hostKey(7),
          { ...hostKey(8), fingerprint: "SHA256:not-the-key" },
        ],
      }),
    );
    await assert.rejects(() => readConnectionProfile(invalid), /fingerprint/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concrete aliases use one closed, injection-safe grammar", () => {
  const validateSshAlias = requireAliasExport("validateSshAlias");
  assert.equal(validateSshAlias("wm-planner-1"), "wm-planner-1");
  for (const unsafe of [
    "",
    "Planner",
    "-planner",
    "planner-",
    "planner.example",
    "planner_*",
    "planner?",
    "planner other",
    "planner/other",
    "planner%h",
    "planner\nHost attacker",
    "a".repeat(64),
  ]) {
    assert.throws(() => validateSshAlias(unsafe), /alias/i, unsafe);
  }
});

test("renderer emits the exact hardened Host block without a forced command or TTY", async () => {
  const item = await fixture();
  try {
    const renderSshHostBlock = requireAliasExport("renderSshHostBlock");
    const rendered = renderSshHostBlock({
      alias: item.alias,
      profile: await readConnectionProfile(item.connectionFile),
      identityPath: item.identity,
      knownHostsPath: item.knownHostsPath,
    });
    assert.equal(rendered, expectedOptionLines(item));
    assert.doesNotMatch(rendered, /^\s*(RemoteCommand|RequestTTY)\b/im);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("install writes private managed files, prepends the include, and returns only safe metadata", async () => {
  const item = await fixture();
  const originalConfig = "Host *\n  ServerAliveInterval 30\n";
  try {
    await mkdir(item.sshDirectory, { mode: 0o700 });
    await writeFile(item.sshConfigPath, originalConfig, { mode: 0o644 });
    const installSshAlias = requireAliasExport("installSshAlias");
    const result = await installSshAlias(installOptions(item));

    assert.equal(
      await readFile(item.sshConfigPath, "utf8"),
      `Include ${item.managedDirectory}/*.conf\n${originalConfig}`,
    );
    assert.equal(await readFile(item.configPath, "utf8"), expectedOptionLines(item));
    assert.equal(
      await readFile(item.knownHostsPath, "utf8"),
      `[203.0.113.42]:22443 ${hostKey(7).publicKey}\n`,
    );
    for (const directory of [item.sshDirectory, item.managedDirectory]) {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
    const identityMetadata = await stat(item.identity);
    assert.equal(identityMetadata.isFile(), true);
    if (typeof process.getuid === "function") {
      assert.equal(identityMetadata.uid, process.getuid());
    }
    for (const path of [item.sshConfigPath, item.configPath, item.knownHostsPath]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }

    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "alias",
        "configPath",
        "grantId",
        "identityPath",
        "knownHostsPath",
        "operation",
        "sandboxId",
        "serverId",
        "sshConfigPath",
      ].sort(),
    );
    assert.equal(result.operation, "installed");
    const safe = JSON.stringify(result);
    for (const forbidden of [
      "203.0.113.42",
      "22443",
      "warpmetal-sandbox",
      hostKey(7).publicKey,
      hostKey(7).fingerprint,
      "private-marker-do-not-print",
      "ownerToken",
      "connection.json",
    ]) {
      assert.equal(safe.includes(forbidden), false, forbidden);
    }
    for (const path of [
      result.configPath,
      result.knownHostsPath,
      result.identityPath,
      result.sshConfigPath,
    ]) {
      assert.equal(path, resolve(path));
    }
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("OpenSSH resolves the concrete alias through the first-precedence managed include", async (context) => {
  const item = await fixture();
  try {
    try {
      execFileSync("ssh", ["-V"], { stdio: "ignore" });
    } catch {
      context.skip("OpenSSH is not installed");
      return;
    }
    await mkdir(item.sshDirectory, { mode: 0o700 });
    await writeFile(
      item.sshConfigPath,
      [
        "Host *",
        "  HostName attacker.invalid",
        "  Port 1",
        "  User root",
        "  StrictHostKeyChecking no",
        "  PasswordAuthentication yes",
        "  KbdInteractiveAuthentication yes",
        "  ClearAllForwardings no",
        "  ForwardAgent yes",
        "  ForwardX11 yes",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const installSshAlias = requireAliasExport("installSshAlias");
    await installSshAlias(installOptions(item));

    const resolvedConfig = execFileSync(
      "ssh",
      ["-G", "-F", item.sshConfigPath, item.alias],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const values = new Map();
    for (const line of resolvedConfig.trim().split("\n")) {
      const separator = line.indexOf(" ");
      const key = line.slice(0, separator);
      if (!values.has(key)) values.set(key, line.slice(separator + 1));
    }
    assert.deepEqual(
      Object.fromEntries(
        [
          "hostname",
          "port",
          "user",
          "identityfile",
          "identitiesonly",
          "pubkeyauthentication",
          "preferredauthentications",
          "passwordauthentication",
          "kbdinteractiveauthentication",
          "gssapiauthentication",
          "stricthostkeychecking",
          "userknownhostsfile",
          "globalknownhostsfile",
          "hashknownhosts",
          "updatehostkeys",
          "verifyhostkeydns",
          "clearallforwardings",
          "forwardagent",
          "forwardx11",
          "permitlocalcommand",
          "exitonforwardfailure",
          "controlmaster",
        ].map((key) => [key, values.get(key)]),
      ),
      {
        hostname: "203.0.113.42",
        port: "22443",
        user: "warpmetal-sandbox",
        identityfile: item.identity,
        identitiesonly: "yes",
        pubkeyauthentication: "true",
        preferredauthentications: "publickey",
        passwordauthentication: "no",
        kbdinteractiveauthentication: "no",
        gssapiauthentication: "no",
        stricthostkeychecking: "true",
        userknownhostsfile: item.knownHostsPath,
        globalknownhostsfile: "/dev/null",
        hashknownhosts: "no",
        updatehostkeys: "false",
        verifyhostkeydns: "false",
        clearallforwardings: "yes",
        forwardagent: "no",
        forwardx11: "no",
        permitlocalcommand: "no",
        exitonforwardfailure: "yes",
        controlmaster: "false",
      },
    );
    assert.ok(
      !values.has("controlpath") || values.get("controlpath") === "none",
      "ssh -G may omit ControlPath when ControlMaster is disabled, but must never resolve another path",
    );
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("install refuses unsafe identity and managed paths without creating files", async (t) => {
  const installSshAlias = requireAliasExport("installSshAlias");
  await t.test("world-readable identity", async () => {
    const item = await fixture();
    try {
      await chmod(item.identity, 0o644);
      await assert.rejects(() => installSshAlias(installOptions(item)), /identity|private|mode/i);
      assert.equal((await snapshot([item.sshDirectory]))[item.sshDirectory], null);
    } finally {
      await rm(item.directory, { recursive: true, force: true });
    }
  });
  await t.test("identity symlink", async () => {
    const item = await fixture();
    try {
      const link = join(item.directory, "identity-link");
      await symlink(item.identity, link);
      await assert.rejects(
        () => installSshAlias(installOptions(item, { identity: link })),
        /identity|regular|symlink/i,
      );
      assert.equal((await snapshot([item.sshDirectory]))[item.sshDirectory], null);
    } finally {
      await rm(item.directory, { recursive: true, force: true });
    }
  });
  await t.test("managed directory symlink", async () => {
    const item = await fixture();
    const outside = join(item.directory, "outside");
    try {
      await mkdir(item.sshDirectory, { mode: 0o700 });
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, item.managedDirectory);
      await assert.rejects(() => installSshAlias(installOptions(item)), /path|symlink|managed/i);
      assert.deepEqual(await readdir(outside), []);
      assert.deepEqual(await snapshot([item.sshConfigPath]), { [item.sshConfigPath]: null });
    } finally {
      await rm(item.directory, { recursive: true, force: true });
    }
  });
  await t.test("percent, quote, newline, and non-absolute paths", async () => {
    const item = await fixture();
    try {
      for (const identity of ["relative-key", `${item.identity}%h`, `${item.identity}\"`, `${item.identity}\nnext`]) {
        await assert.rejects(
          () => installSshAlias(installOptions(item, { identity })),
          /path|identity|unsafe|absolute/i,
          identity,
        );
      }
      for (const homeDirectory of [
        `${item.homeDirectory}%h`,
        `${item.homeDirectory}\"`,
        `${item.homeDirectory}\nnext`,
      ]) {
        await assert.rejects(
          () => installSshAlias(installOptions(item, { homeDirectory })),
          /path|home|unsafe|absolute/i,
          homeDirectory,
        );
      }
      assert.equal((await snapshot([item.sshDirectory]))[item.sshDirectory], null);
    } finally {
      await rm(item.directory, { recursive: true, force: true });
    }
  });
});

test("unmanaged concrete alias collisions and obstructed targets cause no partial writes", async (t) => {
  const installSshAlias = requireAliasExport("installSshAlias");
  await t.test("unmanaged Host collision", async () => {
    const item = await fixture();
    const original = `Host github.com ${item.alias}\n  User git\n`;
    try {
      await mkdir(item.sshDirectory, { mode: 0o700 });
      await writeFile(item.sshConfigPath, original, { mode: 0o600 });
      const before = await snapshot([item.sshConfigPath, item.managedDirectory]);
      await assert.rejects(() => installSshAlias(installOptions(item)), /collision|already|unmanaged/i);
      assert.deepEqual(await snapshot([item.sshConfigPath, item.managedDirectory]), before);
    } finally {
      await rm(item.directory, { recursive: true, force: true });
    }
  });
  await t.test("non-regular known-hosts target", async () => {
    const item = await fixture();
    const original = "Host github.com\n  User git\n";
    try {
      await mkdir(item.managedDirectory, { recursive: true, mode: 0o700 });
      await mkdir(item.knownHostsPath, { mode: 0o700 });
      await writeFile(item.sshConfigPath, original, { mode: 0o600 });
      const before = await snapshot([
        item.sshConfigPath,
        item.configPath,
        item.knownHostsPath,
      ]);
      await assert.rejects(() => installSshAlias(installOptions(item)), /regular|target|managed/i);
      assert.deepEqual(
        await snapshot([item.sshConfigPath, item.configPath, item.knownHostsPath]),
        before,
      );
    } finally {
      await rm(item.directory, { recursive: true, force: true });
    }
  });
});

test("remove with no managed alias target preserves an identical Include and unrelated files exactly", async () => {
  const item = await fixture();
  const unrelated = join(item.managedDirectory, "owner-notes.txt");
  try {
    await mkdir(item.managedDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      item.sshConfigPath,
      `Include ${item.managedDirectory}/*.conf\nHost github.com\n  User git\n`,
      { mode: 0o600 },
    );
    await writeFile(unrelated, "owner bytes must survive\n", { mode: 0o600 });
    const protectedPaths = [
      item.sshConfigPath,
      unrelated,
      item.configPath,
      item.knownHostsPath,
    ];
    const before = await snapshot(protectedPaths);
    const removeSshAlias = requireAliasExport("removeSshAlias");
    const result = await removeSshAlias({
      alias: item.alias,
      homeDirectory: item.homeDirectory,
      confirm: "REMOVE",
    });
    assert.equal(result.operation, "unchanged");
    assert.deepEqual(await snapshot(protectedPaths), before);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("unproven alias artifacts are never overwritten or deleted by REFRESH or REMOVE", async (t) => {
  const installSshAlias = requireAliasExport("installSshAlias");
  const removeSshAlias = requireAliasExport("removeSshAlias");
  for (const artifact of ["unmarked config", "orphan known hosts"]) {
    for (const action of ["REFRESH", "REMOVE"]) {
      await t.test(`${artifact} via ${action}`, async () => {
        const item = await fixture();
        try {
          await mkdir(item.managedDirectory, { recursive: true, mode: 0o700 });
          await writeFile(
            item.sshConfigPath,
            `Include ${item.managedDirectory}/*.conf\nHost github.com\n  User git\n`,
            { mode: 0o600 },
          );
          if (artifact === "unmarked config") {
            await writeFile(
              item.configPath,
              `Host ${item.alias}\n  HostName owner-managed.invalid\n`,
              { mode: 0o600 },
            );
          } else {
            await writeFile(
              item.knownHostsPath,
              "owner-managed.invalid ssh-ed25519 owner-bytes\n",
              { mode: 0o600 },
            );
          }
          const protectedPaths = [
            item.sshConfigPath,
            item.configPath,
            item.knownHostsPath,
          ];
          const before = await snapshot(protectedPaths);
          if (action === "REFRESH") {
            await assert.rejects(
              () =>
                installSshAlias({
                  ...installOptions(item),
                  confirm: "REFRESH",
                }),
              /managed|ownership|orphan|refus/i,
            );
          } else {
            await assert.rejects(
              () =>
                removeSshAlias({
                  alias: item.alias,
                  homeDirectory: item.homeDirectory,
                  confirm: "REMOVE",
                }),
              /managed|ownership|orphan|refus/i,
            );
          }
          assert.deepEqual(await snapshot(protectedPaths), before);
        } finally {
          await rm(item.directory, { recursive: true, force: true });
        }
      });
    }
  }
});

test("absolute home and identity paths containing spaces install and resolve safely", async (context) => {
  try {
    execFileSync("ssh", ["-V"], { stdio: "ignore" });
  } catch {
    context.skip("OpenSSH is not installed");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "warpmetal ssh alias "));
  const directory = join(root, "fixture with spaces");
  const homeDirectory = join(directory, "home with spaces");
  const connectionFile = join(directory, "connection profile.json");
  const identity = join(directory, "sandbox identity");
  const alias = "wm-spaces";
  const item = {
    directory: root,
    homeDirectory,
    connectionFile,
    identity,
    alias,
    ...paths(homeDirectory, alias),
  };
  try {
    await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
    await writeConnectionProfile(connectionFile, profile());
    await writeFile(identity, "private key in an ordinary spaced path\n", {
      mode: 0o600,
    });
    await chmod(identity, 0o600);
    const installSshAlias = requireAliasExport("installSshAlias");
    const result = await installSshAlias(installOptions(item));
    assert.equal(result.operation, "installed");
    assert.match(
      await readFile(item.sshConfigPath, "utf8"),
      /^Include "[^"]+\/warpmetal\.d\/\*\.conf"$/m,
    );
    const fragment = await readFile(item.configPath, "utf8");
    assert.match(fragment, /^\s*IdentityFile "[^"]+\/sandbox identity"$/m);
    assert.match(
      fragment,
      /^\s*UserKnownHostsFile "[^"]+\/wm-spaces\.known_hosts"$/m,
    );
    const resolvedConfig = execFileSync(
      "ssh",
      ["-G", "-F", item.sshConfigPath, alias],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const resolvedLines = new Map(
      resolvedConfig.trim().split("\n").map((line) => {
        const separator = line.indexOf(" ");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    assert.equal(resolvedLines.get("hostname"), "203.0.113.42");
    assert.equal(resolvedLines.get("identityfile"), identity);
    assert.equal(resolvedLines.get("userknownhostsfile"), item.knownHostsPath);
    assert.equal(resolvedLines.get("stricthostkeychecking"), "true");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install refuses a concrete alias declared by a directly included user config without writes", async () => {
  const item = await fixture();
  const included = join(item.directory, "owner-ssh.conf");
  try {
    await mkdir(item.sshDirectory, { mode: 0o700 });
    await writeFile(item.sshConfigPath, `Include ${included}\nHost *\n  User owner\n`, {
      mode: 0o600,
    });
    await writeFile(
      included,
      `Host ${item.alias}\n  HostName owner-managed.invalid\n`,
      { mode: 0o600 },
    );
    const protectedPaths = [
      item.sshConfigPath,
      included,
      item.managedDirectory,
    ];
    const before = await snapshot(protectedPaths);
    const installSshAlias = requireAliasExport("installSshAlias");
    await assert.rejects(
      () => installSshAlias(installOptions(item)),
      /collision|included|already|unmanaged/i,
    );
    assert.deepEqual(await snapshot(protectedPaths), before);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("install refuses a concrete alias reached through wildcard and recursive user Includes", async () => {
  const item = await fixture();
  const ownerDirectory = join(item.sshDirectory, "owner.d");
  const nestedDirectory = join(ownerDirectory, "nested");
  const firstInclude = join(ownerDirectory, "level-one.conf");
  const collision = join(nestedDirectory, "collision.conf");
  try {
    await mkdir(nestedDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      item.sshConfigPath,
      `Include ${ownerDirectory}/*.conf\nHost *\n  User owner\n`,
      { mode: 0o600 },
    );
    await writeFile(firstInclude, `Include ${nestedDirectory}/*.conf\n`, {
      mode: 0o600,
    });
    await writeFile(
      collision,
      `Host ${item.alias}\n  HostName owner-managed.invalid\n`,
      { mode: 0o600 },
    );
    const protectedPaths = [
      item.sshConfigPath,
      firstInclude,
      collision,
      item.managedDirectory,
    ];
    const before = await snapshot(protectedPaths);
    const installSshAlias = requireAliasExport("installSshAlias");
    await assert.rejects(
      () => installSshAlias(installOptions(item)),
      /collision|included|already|unmanaged/i,
    );
    assert.deepEqual(await snapshot(protectedPaths), before);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("exact reinstall is byte- and inode-idempotent", async () => {
  const item = await fixture();
  try {
    const installSshAlias = requireAliasExport("installSshAlias");
    const first = await installSshAlias(installOptions(item));
    const managed = [item.sshConfigPath, item.configPath, item.knownHostsPath];
    const before = await snapshot(managed);
    const replay = await installSshAlias(installOptions(item));
    assert.equal(first.operation, "installed");
    assert.equal(replay.operation, "unchanged");
    assert.deepEqual(await snapshot(managed), before);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("endpoint, pin, or identity changes require exact REFRESH and update atomically", async (t) => {
  const installSshAlias = requireAliasExport("installSshAlias");
  for (const change of ["endpoint", "pin", "identity"]) {
    await t.test(change, async () => {
      const item = await fixture();
      try {
        await installSshAlias(installOptions(item));
        let options = installOptions(item);
        if (change === "identity") {
          const replacement = join(item.directory, "replacement-identity");
          await writeFile(replacement, "replacement-private-key-marker\n", { mode: 0o600 });
          await chmod(replacement, 0o600);
          options = { ...options, identity: replacement };
        } else {
          const changed =
            change === "endpoint"
              ? profile({ host: "198.51.100.24", port: 22022 })
              : profile({ hostKeys: [hostKey(8)] });
          const replacementProfile = join(item.directory, `${change}.json`);
          await writeConnectionProfile(replacementProfile, changed);
          options = { ...options, connectionFile: replacementProfile };
        }
        const managed = [item.sshConfigPath, item.configPath, item.knownHostsPath];
        const before = await snapshot(managed);
        await assert.rejects(() => installSshAlias(options), /confirm.*REFRESH|REFRESH/i);
        assert.deepEqual(await snapshot(managed), before);
        const refreshed = await installSshAlias({ ...options, confirm: "REFRESH" });
        assert.equal(refreshed.operation, "refreshed");
        assert.notDeepEqual(await snapshot(managed), before);
      } finally {
        await rm(item.directory, { recursive: true, force: true });
      }
    });
  }
});

test("locally changed managed bytes require REFRESH before exact replacement", async () => {
  const item = await fixture();
  try {
    const installSshAlias = requireAliasExport("installSshAlias");
    await installSshAlias(installOptions(item));
    await writeFile(item.configPath, `${await readFile(item.configPath, "utf8")}# local edit\n`);
    const managed = [item.sshConfigPath, item.configPath, item.knownHostsPath];
    const before = await snapshot(managed);
    await assert.rejects(() => installSshAlias(installOptions(item)), /confirm.*REFRESH|REFRESH/i);
    assert.deepEqual(await snapshot(managed), before);
    const refreshed = await installSshAlias({
      ...installOptions(item),
      confirm: "REFRESH",
    });
    assert.equal(refreshed.operation, "refreshed");
    assert.equal(await readFile(item.configPath, "utf8"), expectedOptionLines(item));
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("remove requires exact confirmation and restores unrelated SSH config bytes", async () => {
  const item = await fixture();
  const original = "# personal SSH config\nHost github.com\n  User git\n";
  try {
    await mkdir(item.sshDirectory, { mode: 0o700 });
    await writeFile(item.sshConfigPath, original, { mode: 0o600 });
    const installSshAlias = requireAliasExport("installSshAlias");
    const removeSshAlias = requireAliasExport("removeSshAlias");
    await installSshAlias(installOptions(item));
    const before = await snapshot([item.sshConfigPath, item.configPath, item.knownHostsPath]);
    await assert.rejects(
      () => removeSshAlias({ alias: item.alias, homeDirectory: item.homeDirectory }),
      /confirm.*REMOVE|REMOVE/i,
    );
    assert.deepEqual(
      await snapshot([item.sshConfigPath, item.configPath, item.knownHostsPath]),
      before,
    );

    const removed = await removeSshAlias({
      alias: item.alias,
      homeDirectory: item.homeDirectory,
      confirm: "REMOVE",
    });
    assert.equal(removed.operation, "removed");
    assert.equal(await readFile(item.sshConfigPath, "utf8"), original);
    assert.equal((await stat(item.sshConfigPath)).mode & 0o777, 0o600);
    assert.equal((await snapshot([item.configPath]))[item.configPath], null);
    assert.equal((await snapshot([item.knownHostsPath]))[item.knownHostsPath], null);
    assert.equal((await stat(item.identity)).isFile(), true);
    assert.equal((await stat(item.connectionFile)).isFile(), true);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("CLI install/remove dispatch is local-only and JSON output contains no profile or key material", async () => {
  const item = await fixture();
  const stdout = capture();
  const stderr = capture();
  let networkCalls = 0;
  try {
    const installCode = await main(
      [
        "sandbox",
        "access",
        "install-ssh",
        "--connection-file",
        item.connectionFile,
        "--identity",
        item.identity,
        "--alias",
        item.alias,
        "--json",
      ],
      {
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: { HOME: item.homeDirectory },
        fetchImpl: async () => {
          networkCalls += 1;
          throw new Error("unexpected network access");
        },
      },
    );
    assert.equal(installCode, 0, stderr.value());
    assert.equal(networkCalls, 0);
    const installed = JSON.parse(stdout.value());
    assert.equal(installed.operation, "installed");
    const safe = JSON.stringify(installed);
    for (const forbidden of [
      "203.0.113.42",
      "22443",
      "warpmetal-sandbox",
      hostKey(7).publicKey,
      hostKey(7).fingerprint,
      "private-marker-do-not-print",
      "connection.json",
    ]) {
      assert.equal(safe.includes(forbidden), false, forbidden);
    }

    const removeOut = capture();
    const removeErr = capture();
    const removeCode = await main(
      [
        "sandbox",
        "access",
        "remove-ssh",
        "--alias",
        item.alias,
        "--confirm",
        "REMOVE",
        "--json",
      ],
      {
        stdout: removeOut.stream,
        stderr: removeErr.stream,
        env: { HOME: item.homeDirectory },
        fetchImpl: async () => {
          networkCalls += 1;
          throw new Error("unexpected network access");
        },
      },
    );
    assert.equal(removeCode, 0, removeErr.value());
    assert.equal(JSON.parse(removeOut.value()).operation, "removed");
    assert.equal(networkCalls, 0);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});
