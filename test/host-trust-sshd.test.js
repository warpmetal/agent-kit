import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { establishHostTrust } from "../src/host-trust.js";
import { sshFingerprint } from "../src/ssh.js";

const execFile = promisify(execFileCallback);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitForPort(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("test sshd exited early");
    const connected = await new Promise((resolvePromise) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("error", () => resolvePromise(false));
    });
    if (connected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("test sshd did not listen");
}

async function startSshd(configPath, port) {
  const child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", configPath], {
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16 * 1024);
  });
  try {
    await waitForPort(port, child);
  } catch (error) {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("close", resolvePromise));
    throw new Error(`${error.message}: ${stderr}`);
  }
  return async () => {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("close", resolvePromise));
  };
}

test(
  "real OpenSSH pins host A, replays A strictly, and rejects host B unchanged",
  { timeout: 30_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "warpmetal-host-trust-sshd-"));
    const stateDirectory = join(directory, "state");
    let stopSshd;
    try {
      await chmod(directory, 0o700);
      await execFile("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        join(directory, "owner"),
      ]);
      await execFile("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        join(directory, "host-a"),
      ]);
      await execFile("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        join(directory, "host-b"),
      ]);
      await writeFile(
        join(directory, "authorized_keys"),
        await readFile(join(directory, "owner.pub")),
        { mode: 0o600 },
      );
      await writeFile(join(directory, "state-placeholder"), "", { mode: 0o600 });
      await rm(join(directory, "state-placeholder"));
      const port = await unusedPort();
      const username = process.env.USER;
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username || "")) {
        context.skip("local username is not accepted by the production SSH-user contract");
        return;
      }
      const config = (hostKey, suffix) => {
        const path = join(directory, `sshd-${suffix}.conf`);
        return {
          path,
          content: [
            `Port ${port}`,
            "ListenAddress 127.0.0.1",
            `HostKey ${hostKey}`,
            `PidFile ${join(directory, `sshd-${suffix}.pid`)}`,
            `AuthorizedKeysFile ${join(directory, "authorized_keys")}`,
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "ChallengeResponseAuthentication no",
            "PubkeyAuthentication yes",
            "AuthenticationMethods publickey",
            "UsePAM no",
            "StrictModes no",
            "PermitRootLogin no",
            `AllowUsers ${username}`,
            "AllowTcpForwarding no",
            "X11Forwarding no",
            "PermitTunnel no",
            "PermitUserEnvironment no",
            "LogLevel VERBOSE",
            "Subsystem sftp internal-sftp",
            "",
          ].join("\n"),
        };
      };
      const configA = config(join(directory, "host-a"), "a");
      const configB = config(join(directory, "host-b"), "b");
      await writeFile(configA.path, configA.content, { mode: 0o600 });
      await writeFile(configB.path, configB.content, { mode: 0o600 });
      try {
        await execFile("/usr/sbin/sshd", ["-t", "-f", configA.path]);
      } catch (error) {
        context.skip(`local sshd cannot run an isolated integration server: ${error.stderr || error.message}`);
        return;
      }
      await mkdir(stateDirectory, { mode: 0o700 });
      const ownerPublic = await readFile(join(directory, "owner.pub"), "utf8");
      const input = {
        stateDirectory,
        serverId: "srv_sshdtest123",
        trustEpoch: "initial",
        server: {
          serverId: "srv_sshdtest123",
          state: "ready",
          publicIp: "127.0.0.1",
          sshFingerprint: sshFingerprint(ownerPublic),
        },
        identityPath: join(directory, "owner"),
        sshUser: username,
        sshPort: port,
      };
      input.reinspectServer = async () => ({ ...input.server });

      stopSshd = await startSshd(configA.path, port);
      const first = await establishHostTrust(input);
      assert.equal(first.state, "trusted_first_use");
      const replay = await establishHostTrust(input);
      assert.equal(replay.state, "matched");
      const pinned = await readFile(first.knownHostsFile, "utf8");
      await stopSshd();
      stopSshd = undefined;

      stopSshd = await startSshd(configB.path, port);
      await assert.rejects(
        establishHostTrust(input),
        (error) => error.code === "host_trust_authentication_failed",
      );
      assert.equal(await readFile(first.knownHostsFile, "utf8"), pinned);
    } finally {
      if (stopSshd) await stopSshd();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
