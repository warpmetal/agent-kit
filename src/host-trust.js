import { createHash, randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { CliError } from "./errors.js";
import { readSshPublicKey, sshFingerprint } from "./ssh.js";

const SERVER_ID = /^srv_[A-Za-z0-9_-]{8,60}$/;
const TRUST_EPOCH = /^(?:initial|reload-[A-Za-z0-9_-]{8,128})$/;

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function exactMode(metadata) {
  return metadata.mode & 0o777;
}

async function requirePrivateDirectory(path) {
  const metadata = await lstat(path);
  const uid = currentUid();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && exactMode(metadata) !== 0o700) ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new CliError("The managed SSH trust directory is not private.", {
      exitCode: 4,
      code: "host_trust_directory_unsafe",
    });
  }
}

async function ensurePrivateDirectory(path) {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (created && process.platform !== "win32") await chmod(path, 0o700);
  await requirePrivateDirectory(path);
  if (created) await syncPath(dirname(path));
}

async function syncPath(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requirePrivateFile(path, label) {
  const metadata = await lstat(path);
  const uid = currentUid();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (process.platform !== "win32" && exactMode(metadata) !== 0o600) ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new CliError(`${label} is not an owner-only regular file.`, {
      exitCode: 4,
      code: "host_trust_file_unsafe",
    });
  }
}

async function requireIdentity(identityPath, expectedFingerprint) {
  const identity = resolve(identityPath);
  await requirePrivateFile(identity, "The SSH identity");
  const publicPath = `${identity}.pub`;
  const publicMetadata = await lstat(publicPath);
  const uid = currentUid();
  if (
    !publicMetadata.isFile() ||
    publicMetadata.isSymbolicLink() ||
    publicMetadata.nlink !== 1 ||
    (uid !== undefined && publicMetadata.uid !== uid)
  ) {
    throw new CliError("The SSH public identity is not a safe regular file.", {
      exitCode: 4,
      code: "host_trust_identity_unsafe",
    });
  }
  const fingerprint = sshFingerprint(await readSshPublicKey(publicPath));
  if (fingerprint !== expectedFingerprint) {
    throw new CliError(
      "The local SSH identity does not match the server owner key.",
      { exitCode: 4, code: "host_trust_identity_mismatch" },
    );
  }
  return { identity, fingerprint };
}

export function hostTrustPaths(stateDirectory, serverId, trustEpoch = "initial") {
  if (!SERVER_ID.test(serverId)) {
    throw new CliError("The server ID is invalid.", { exitCode: 2 });
  }
  if (!TRUST_EPOCH.test(trustEpoch)) {
    throw new CliError("The SSH host-trust epoch is invalid.", {
      exitCode: 4,
      code: "host_trust_epoch_invalid",
    });
  }
  const stateRoot = resolve(stateDirectory);
  const sshDirectory = join(stateRoot, "ssh");
  const knownHostsDirectory = join(sshDirectory, "known-hosts");
  const serverDirectory = join(knownHostsDirectory, serverId);
  return {
    stateRoot,
    sshDirectory,
    knownHostsDirectory,
    serverDirectory,
    knownHostsFile: join(serverDirectory, `${trustEpoch}.known_hosts`),
  };
}

async function ensureTrustDirectories(paths) {
  await requirePrivateDirectory(paths.stateRoot);
  await ensurePrivateDirectory(paths.sshDirectory);
  await ensurePrivateDirectory(paths.knownHostsDirectory);
  await ensurePrivateDirectory(paths.serverDirectory);
}

function decodeEd25519(material) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(material)) return undefined;
  const decoded = Buffer.from(material, "base64");
  if (decoded.toString("base64") !== material) return undefined;
  if (decoded.length !== 51 || decoded.readUInt32BE(0) !== 11) return undefined;
  if (decoded.subarray(4, 15).toString("utf8") !== "ssh-ed25519") {
    return undefined;
  }
  if (decoded.readUInt32BE(15) !== 32) return undefined;
  return decoded;
}

export function validateKnownHosts(content, publicIp, sshPort = 22) {
  if (isIP(publicIp) !== 4) {
    throw new CliError("The server returned an invalid public IP.", {
      exitCode: 3,
      code: "host_trust_ip_invalid",
    });
  }
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65_535) {
    throw new CliError("The SSH port is invalid.", { exitCode: 2 });
  }
  const expectedHost =
    sshPort === 22 ? publicIp : `[${publicIp}]:${sshPort}`;
  const lines = String(content).split(/\r?\n/).filter(Boolean);
  const match = /^([^ ]+) (ssh-ed25519) ([A-Za-z0-9+/]+={0,2})$/.exec(
    lines[0] || "",
  );
  const decoded = match && decodeEd25519(match[3]);
  if (lines.length !== 1 || !match || match[1] !== expectedHost || !decoded) {
    throw new CliError("The observed SSH host key is not a canonical Ed25519 pin.", {
      exitCode: 4,
      code: "host_trust_pin_invalid",
    });
  }
  return {
    content: `${match[1]} ${match[2]} ${match[3]}\n`,
    algorithm: match[2],
    fingerprint: `SHA256:${createHash("sha256")
      .update(decoded)
      .digest("base64")
      .replace(/=+$/, "")}`,
  };
}

export function strictSshOptions(identityPath, knownHostsFile) {
  if (!isAbsolute(knownHostsFile)) {
    throw new CliError("The managed SSH host pin path is invalid.", {
      exitCode: 4,
      code: "host_trust_path_invalid",
    });
  }
  return [
    "-F",
    "/dev/null",
    "-i",
    resolve(identityPath),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=1",
    "-o",
    "PubkeyAuthentication=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ChallengeResponseAuthentication=no",
    "-o",
    "GSSAPIAuthentication=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "HashKnownHosts=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "VerifyHostKeyDNS=no",
    "-o",
    "HostKeyAlgorithms=ssh-ed25519",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ProxyCommand=none",
    "-o",
    "RequestTTY=no",
  ];
}

function firstUseSshOptions(identityPath, candidatePath) {
  const args = strictSshOptions(identityPath, candidatePath);
  const index = args.indexOf("StrictHostKeyChecking=yes");
  args[index] = "StrictHostKeyChecking=accept-new";
  return args;
}

async function spawnSsh(
  args,
  spawnImpl,
  errorMessage,
  diagnosticDirectory,
  publicIp,
  sshPort,
) {
  const diagnosticPath = join(
    diagnosticDirectory,
    `.ssh-auth.${process.pid}.${randomUUID()}.log`,
  );
  const diagnosticHandle = await open(diagnosticPath, "wx", 0o600);
  await diagnosticHandle.close();
  let result;
  try {
    try {
      result = await new Promise((resolvePromise, reject) => {
        const child = spawnImpl("ssh", ["-v", "-E", diagnosticPath, ...args], {
          shell: false,
          stdio: ["ignore", "ignore", "ignore"],
        });
        child.once("error", reject);
        child.once("close", (status) => resolvePromise({ status }));
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new CliError("OpenSSH is required to establish VPS host trust.", {
          exitCode: 2,
          code: "host_trust_ssh_unavailable",
        });
      }
      throw error;
    }
    if (result.status !== 0) {
      throw new CliError(errorMessage, {
        exitCode: 4,
        code: "host_trust_authentication_failed",
      });
    }
    await requirePrivateFile(diagnosticPath, "The private OpenSSH diagnostic");
    const diagnostic = await readFile(diagnosticPath, "utf8");
    const authenticationResults = diagnostic
      .split(/\r?\n/)
      .filter((line) => /^Authenticated to .* using "[^"]+"\.$/.test(line));
    const expectedResult = `Authenticated to ${publicIp} ([${publicIp}]:${sshPort}) using "publickey".`;
    if (
      authenticationResults.length !== 1 ||
      authenticationResults[0] !== expectedResult
    ) {
      throw new CliError(
        "SSH did not prove authentication with the exact owner public key. No runtime bootstrap was requested.",
        { exitCode: 4, code: "host_trust_authentication_method_invalid" },
      );
    }
  } finally {
    await rm(diagnosticPath, { force: true });
  }
}

async function strictProbe({
  identity,
  publicIp,
  sshPort,
  sshUser,
  knownHostsFile,
  spawnImpl,
}) {
  await spawnSsh(
    [
      ...strictSshOptions(identity, knownHostsFile),
      ...(sshPort === 22 ? [] : ["-p", String(sshPort)]),
      `${sshUser}@${publicIp}`,
      "true",
    ],
    spawnImpl,
    "The VPS host key or owner SSH authentication did not match the managed pin.",
    dirname(knownHostsFile),
    publicIp,
    sshPort,
  );
}

async function publishCandidate(
  candidatePath,
  knownHostsFile,
  expectedContent,
  publicIp,
  sshPort,
) {
  await syncPath(candidatePath);
  try {
    await link(candidatePath, knownHostsFile);
    await unlink(candidatePath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = validateKnownHosts(
      await readFile(knownHostsFile, "utf8"),
      publicIp,
      sshPort,
    );
    if (existing.content !== expectedContent) {
      throw new CliError("The VPS host key changed during first-use pinning.", {
        exitCode: 4,
        code: "host_trust_race_mismatch",
      });
    }
    await unlink(candidatePath);
  }
  await requirePrivateFile(knownHostsFile, "The managed SSH host pin");
  await syncPath(knownHostsFile);
  await syncPath(resolve(knownHostsFile, ".."));
}

export async function establishHostTrust({
  stateDirectory,
  serverId,
  trustEpoch = "initial",
  server,
  identityPath,
  sshUser,
  sshPort = 22,
  reinspectServer,
  spawnImpl = nodeSpawn,
}) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(sshUser)) {
    throw new CliError("--ssh-user is invalid.", { exitCode: 2 });
  }
  if (!server || isIP(server.publicIp) !== 4) {
    throw new CliError("The server returned an invalid public IP.", {
      exitCode: 3,
    });
  }
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65_535) {
    throw new CliError("The SSH port is invalid.", { exitCode: 2 });
  }
  const activeCancellation =
    ["cancellation_pending", "cancelled"].includes(server.state) &&
    Number.isFinite(Date.parse(server.termEndsAt || "")) &&
    Date.parse(server.termEndsAt) > Date.now();
  if (
    server.serverId !== serverId ||
    (server.state !== "ready" && !activeCancellation)
  ) {
    throw new CliError(
      "The VPS must be ready and bound to this server before SSH host trust is established.",
      { exitCode: 5, code: "host_trust_server_unavailable" },
    );
  }
  if (typeof server.sshFingerprint !== "string") {
    throw new CliError("The server did not return its owner-key fingerprint.", {
      exitCode: 3,
    });
  }
  const { identity } = await requireIdentity(
    identityPath,
    server.sshFingerprint,
  );
  const paths = hostTrustPaths(stateDirectory, serverId, trustEpoch);
  await ensureTrustDirectories(paths);

  try {
    await requirePrivateFile(paths.knownHostsFile, "The managed SSH host pin");
    const pin = validateKnownHosts(
      await readFile(paths.knownHostsFile, "utf8"),
      server.publicIp,
      sshPort,
    );
    await strictProbe({
      identity,
      publicIp: server.publicIp,
      sshPort,
      sshUser,
      knownHostsFile: paths.knownHostsFile,
      spawnImpl,
    });
    return {
      state: "matched",
      algorithm: pin.algorithm,
      fingerprint: pin.fingerprint,
      knownHostsFile: paths.knownHostsFile,
      publicIp: server.publicIp,
      trustEpoch,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (typeof reinspectServer !== "function") {
    throw new CliError(
      "A fresh server inspection is required before first-use SSH trust can be published.",
      { exitCode: 4, code: "host_trust_reinspection_required" },
    );
  }

  const candidatePath = join(
    paths.serverDirectory,
    `.${trustEpoch}.${process.pid}.${randomUUID()}.candidate`,
  );
  const handle = await open(candidatePath, "wx", 0o600);
  await handle.close();
  try {
    await spawnSsh(
      [
        ...firstUseSshOptions(identity, candidatePath),
        ...(sshPort === 22 ? [] : ["-p", String(sshPort)]),
        `${sshUser}@${server.publicIp}`,
        "true",
      ],
      spawnImpl,
      "Could not authenticate the first SSH connection to the exact VPS. No runtime bootstrap was requested.",
      paths.serverDirectory,
      server.publicIp,
      sshPort,
    );
    await requirePrivateFile(candidatePath, "The observed SSH host-key candidate");
    const pin = validateKnownHosts(
      await readFile(candidatePath, "utf8"),
      server.publicIp,
      sshPort,
    );
    const refreshedServer = await reinspectServer();
    const refreshedCancellation =
      ["cancellation_pending", "cancelled"].includes(refreshedServer?.state) &&
      Number.isFinite(Date.parse(refreshedServer?.termEndsAt || "")) &&
      Date.parse(refreshedServer.termEndsAt) > Date.now();
    if (
      refreshedServer?.serverId !== serverId ||
      (refreshedServer.state !== "ready" && !refreshedCancellation) ||
      refreshedServer.publicIp !== server.publicIp ||
      refreshedServer.sshFingerprint !== server.sshFingerprint
    ) {
      throw new CliError(
        "The server identity changed while first-use SSH trust was being established. No host pin or runtime bootstrap was created.",
        { exitCode: 4, code: "host_trust_server_changed" },
      );
    }
    await publishCandidate(
      candidatePath,
      paths.knownHostsFile,
      pin.content,
      server.publicIp,
      sshPort,
    );
    await strictProbe({
      identity,
      publicIp: server.publicIp,
      sshPort,
      sshUser,
      knownHostsFile: paths.knownHostsFile,
      spawnImpl,
    });
    return {
      state: "trusted_first_use",
      algorithm: pin.algorithm,
      fingerprint: pin.fingerprint,
      knownHostsFile: paths.knownHostsFile,
      publicIp: server.publicIp,
      trustEpoch,
    };
  } finally {
    await rm(candidatePath, { force: true });
  }
}
