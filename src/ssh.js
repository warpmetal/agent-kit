import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { knownHosts, readConnectionProfile } from "./connection.js";
import { CliError } from "./errors.js";

export async function readSshPublicKey(path) {
  const resolved = resolve(path);
  const value = (await readFile(resolved, "utf8")).trim();
  if (
    value.includes("PRIVATE KEY") ||
    !/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(256|384|521))\s+/.test(value)
  ) {
    throw new CliError(
      "The SSH public-key file must contain one supported OpenSSH public key and never a private key.",
      { exitCode: 2 },
    );
  }
  if (value.includes("\n")) {
    throw new CliError(
      "The SSH public-key file must contain exactly one key.",
      { exitCode: 2 },
    );
  }
  return value;
}

export async function signSshChallenge(
  payload,
  identityPath,
  { spawn = spawnSync } = {},
) {
  if (
    typeof payload !== "string" ||
    !payload.startsWith("warpmetal-ssh-auth-v1\n")
  ) {
    throw new CliError("WarpMetal returned an invalid SSH signing payload.");
  }
  const identity = resolve(identityPath);
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-ssh-"));
  const payloadPath = join(directory, "challenge.txt");
  const signaturePath = `${payloadPath}.sig`;
  try {
    await writeFile(payloadPath, payload, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const result = spawn(
      "ssh-keygen",
      ["-Y", "sign", "-f", identity, "-n", "warpmetal", payloadPath],
      { stdio: ["inherit", "ignore", "inherit"] },
    );
    if (result.error?.code === "ENOENT") {
      throw new CliError("ssh-keygen is required for WarpMetal SSH proof.", {
        exitCode: 2,
      });
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new CliError(
        "ssh-keygen did not create a WarpMetal SSH signature.",
        { exitCode: 4 },
      );
    }
    const signature = await readFile(signaturePath, "utf8");
    if (
      !signature.includes("-----BEGIN SSH SIGNATURE-----") ||
      !signature.includes("-----END SSH SIGNATURE-----")
    ) {
      throw new CliError("ssh-keygen returned an invalid SSH signature.", {
        exitCode: 4,
      });
    }
    return signature;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function requireMissing(path) {
  try {
    await lstat(path);
    throw new CliError(`Refusing to overwrite existing path: ${path}`, {
      exitCode: 2,
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function sshFingerprint(publicKey) {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2)
    throw new CliError("The SSH public key is invalid.", { exitCode: 2 });
  const material = Buffer.from(parts[1], "base64");
  return `SHA256:${createHash("sha256").update(material).digest("base64").replace(/=+$/, "")}`;
}

export async function generateSandboxKey(
  outputPath,
  { spawn = spawnSync } = {},
) {
  const privatePath = resolve(outputPath);
  const publicPath = `${privatePath}.pub`;
  await requireMissing(privatePath);
  await requireMissing(publicPath);
  const result = spawn(
    "ssh-keygen",
    [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "warpmetal-sandbox",
      "-f",
      privatePath,
    ],
    { stdio: ["ignore", "ignore", "pipe"], shell: false },
  );
  if (result.error?.code === "ENOENT") {
    throw new CliError(
      "ssh-keygen is required to generate sandbox access keys.",
      { exitCode: 2 },
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new CliError(
      "ssh-keygen could not generate the sandbox access key.",
      { exitCode: 4 },
    );
  }
  const publicKey = await readSshPublicKey(publicPath);
  return {
    privateKeyPath: privatePath,
    publicKeyPath: publicPath,
    keyType: "ed25519",
    sshFingerprint: sshFingerprint(publicKey),
  };
}

export async function connectSandbox(
  connectionFile,
  identityPath,
  passthrough,
  { spawn = spawnSync } = {},
) {
  const profile = await readConnectionProfile(connectionFile);
  const identity = resolve(identityPath);
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-connect-"));
  const knownHostsPath = join(directory, "known_hosts");
  try {
    await writeFile(knownHostsPath, knownHosts(profile), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const args = [
      "-i",
      identity,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHostsPath}`,
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "PermitLocalCommand=no",
      "-p",
      String(profile.port),
      `${profile.username}@${profile.host}`,
    ];
    if (passthrough.length > 0) {
      args.push(
        passthrough
          .map((argument) => `'${String(argument).replaceAll("'", `'\\''`)}'`)
          .join(" "),
      );
    }
    const result = spawn("ssh", args, { stdio: "inherit", shell: false });
    if (result.error?.code === "ENOENT") {
      throw new CliError("OpenSSH is required for sandbox connections.", {
        exitCode: 2,
      });
    }
    if (result.error) throw result.error;
    return Number.isInteger(result.status) ? result.status : 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
