import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CliError } from "./errors.js";

const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const REQUIRED_FILES = [
  "install.sh",
  "warpmetal-agentctl",
  "warpmetal-sandbox-gateway",
  "warpmetal-sandbox-shell",
  "warpmetald",
  "warpmetald.service",
  "warpmetal-sandbox.conf",
];

function validateArtifact(artifact) {
  if (
    !artifact ||
    typeof artifact.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(artifact.version) ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    typeof artifact.signature !== "string" ||
    artifact.signature.length > 16 * 1024 ||
    typeof artifact.signingPublicKey !== "string" ||
    artifact.signingPublicKey.length > 32 * 1024
  ) {
    throw new CliError(
      "WarpMetal returned invalid runtime artifact metadata.",
      { exitCode: 3 },
    );
  }
  let url;
  try {
    url = new URL(artifact.url);
  } catch {
    throw new CliError("WarpMetal returned an invalid runtime artifact URL.", {
      exitCode: 3,
    });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new CliError(
      "The runtime artifact URL must be credential-free HTTPS.",
      { exitCode: 3 },
    );
  }
  return { ...artifact, url: url.toString() };
}

export function verifyRuntimeArtifact(content, metadata) {
  const artifact = validateArtifact(metadata);
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== artifact.sha256) {
    throw new CliError("The runtime artifact checksum did not match.", {
      exitCode: 4,
    });
  }
  let publicKey;
  let signature;
  try {
    publicKey = createPublicKey(artifact.signingPublicKey);
    signature = Buffer.from(artifact.signature, "base64");
  } catch {
    throw new CliError("The runtime artifact signature metadata is invalid.", {
      exitCode: 4,
    });
  }
  const algorithm = publicKey.asymmetricKeyType === "ed25519" ? null : "sha256";
  if (!verifySignature(algorithm, content, publicKey, signature)) {
    throw new CliError("The runtime artifact signature was rejected.", {
      exitCode: 4,
    });
  }
  return artifact;
}

async function downloadArtifact(metadata, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(metadata.url, {
      headers: { Accept: "application/gzip" },
    });
  } catch (error) {
    throw new CliError(
      `Could not download the signed runtime artifact: ${error.message}`,
      {
        exitCode: 3,
      },
    );
  }
  if (!response.ok) {
    throw new CliError(
      `Runtime artifact download returned HTTP ${response.status}.`,
      { exitCode: 3 },
    );
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_ARTIFACT_BYTES) {
    throw new CliError(
      "The runtime artifact is larger than the allowed limit.",
      { exitCode: 3 },
    );
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (content.length === 0 || content.length > MAX_ARTIFACT_BYTES) {
    throw new CliError("The runtime artifact has an invalid size.", {
      exitCode: 3,
    });
  }
  verifyRuntimeArtifact(content, metadata);
  return content;
}

function appendBounded(current, chunk) {
  const combined = current + String(chunk);
  return combined.length > 64 * 1024 ? combined.slice(-64 * 1024) : combined;
}

async function spawnChecked(
  command,
  args,
  { stdin, spawnImpl = nodeSpawn, redact = [] } = {},
) {
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawnImpl(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (status) => resolvePromise({ status, stdout, stderr }));
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
  if (result.status !== 0) {
    let message =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `${command} exited unsuccessfully`;
    for (const secret of redact)
      if (secret) message = message.split(secret).join("[redacted]");
    throw new CliError(message.slice(0, 500), { exitCode: 4 });
  }
  return result;
}

function sshBase(identity, sshUser, host) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(sshUser)) {
    throw new CliError("--ssh-user is invalid.", { exitCode: 2 });
  }
  if (typeof host !== "string" || /[\s/@]/.test(host)) {
    throw new CliError("The server returned an invalid public IP.", {
      exitCode: 3,
    });
  }
  return [
    "-i",
    resolve(identity),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    `${sshUser}@${host}`,
  ];
}

export async function installRuntime({
  client,
  serverId,
  token,
  identity,
  sshUser,
  bootstrap,
  fetchImpl = globalThis.fetch,
  spawnImpl = nodeSpawn,
}) {
  if (!/^srv_[A-Za-z0-9_-]{8,60}$/.test(serverId)) {
    throw new CliError("The server ID is invalid.", { exitCode: 2 });
  }
  const server = (await client.getServer(serverId, token)).data?.task;
  if (server?.state !== "ready" || !server.publicIp) {
    throw new CliError("The VPS must be ready before runtime installation.", {
      exitCode: 5,
    });
  }
  const metadata = validateArtifact(bootstrap?.artifact);
  const bootstrapToken = bootstrap?.bootstrapToken;
  if (
    typeof bootstrapToken !== "string" ||
    !bootstrapToken.startsWith("rtb_")
  ) {
    throw new CliError("WarpMetal returned an invalid runtime bootstrap.", {
      exitCode: 3,
    });
  }
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-runtime-"));
  const archivePath = join(
    directory,
    `warpmetal-runtime-${metadata.version}.tar.gz`,
  );
  const extractPath = join(directory, "bundle");
  const remoteID = randomUUID().replaceAll("-", "");
  const remoteArchive = `/tmp/warpmetal-runtime-${remoteID}.tar.gz`;
  const remoteBundle = `/tmp/warpmetal-runtime-${remoteID}`;
  const ssh = sshBase(identity, sshUser, server.publicIp);
  let remoteTouched = false;
  let operationFailed = false;
  try {
    const content = await downloadArtifact(metadata, fetchImpl);
    await writeFile(archivePath, content, { mode: 0o600, flag: "wx" });
    await spawnChecked("mkdir", ["-p", extractPath], { spawnImpl });
    await spawnChecked(
      "tar",
      ["-xzf", archivePath, "-C", extractPath, "--strip-components=1"],
      {
        spawnImpl,
      },
    );
    for (const file of REQUIRED_FILES) await access(join(extractPath, file));
    const unexpected = (await readdir(extractPath)).filter(
      (name) => !REQUIRED_FILES.includes(name),
    );
    if (unexpected.length > 0) {
      throw new CliError(
        "The signed runtime bundle contains unsupported files.",
        { exitCode: 4 },
      );
    }
    remoteTouched = true;
    await spawnChecked(
      "scp",
      [...ssh.slice(0, -1), archivePath, `${ssh.at(-1)}:${remoteArchive}`],
      {
        spawnImpl,
      },
    );
    await spawnChecked("ssh", [...ssh, "sudo", "mkdir", "-p", remoteBundle], {
      spawnImpl,
    });
    await spawnChecked(
      "ssh",
      [
        ...ssh,
        "sudo",
        "tar",
        "-xzf",
        remoteArchive,
        "-C",
        remoteBundle,
        "--strip-components=1",
      ],
      { spawnImpl },
    );
    await spawnChecked(
      "ssh",
      [
        ...ssh,
        "sudo",
        `${remoteBundle}/install.sh`,
        "--api",
        client.baseUrl,
        "--server",
        serverId,
        "--bundle",
        remoteBundle,
      ],
      { stdin: `${bootstrapToken}\n`, spawnImpl, redact: [bootstrapToken] },
    );
    await spawnChecked(
      "ssh",
      [...ssh, "sudo", "systemctl", "is-active", "warpmetald.service"],
      {
        spawnImpl,
      },
    );
    return { serverId, supervisorVersion: metadata.version, installed: true };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (remoteTouched) {
      try {
        await spawnChecked(
          "ssh",
          [
            ...ssh,
            "sudo",
            "rm",
            "-rf",
            "--",
            remoteBundle,
            remoteArchive,
          ],
          { spawnImpl },
        );
      } catch (error) {
        if (!operationFailed) throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
