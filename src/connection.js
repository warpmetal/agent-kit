import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CliError } from "./errors.js";

const ALGORITHM = /^(ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521))$/;

function parsePublicKey(value) {
  if (
    typeof value !== "string" ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new CliError("A connection host key is invalid.", { exitCode: 2 });
  }
  const parts = value.trim().split(/\s+/);
  if (
    parts.length < 2 ||
    !ALGORITHM.test(parts[0]) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])
  ) {
    throw new CliError("A connection host key is invalid.", { exitCode: 2 });
  }
  const material = Buffer.from(parts[1], "base64");
  if (material.length < 16)
    throw new CliError("A connection host key is invalid.", { exitCode: 2 });
  const fingerprint = `SHA256:${createHash("sha256").update(material).digest("base64").replace(/=+$/, "")}`;
  return {
    algorithm: parts[0],
    publicKey: `${parts[0]} ${parts[1]}`,
    fingerprint,
  };
}

export function validateConnectionProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("The connection profile is invalid.", { exitCode: 2 });
  }
  const allowed = new Set([
    "version",
    "serverId",
    "sandboxId",
    "grantId",
    "host",
    "port",
    "username",
    "hostKeys",
  ]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new CliError("The connection profile contains unsupported fields.", {
      exitCode: 2,
    });
  }
  if (
    value.version !== 1 ||
    typeof value.serverId !== "string" ||
    !value.serverId.startsWith("srv_") ||
    typeof value.sandboxId !== "string" ||
    !value.sandboxId.startsWith("sbx_") ||
    typeof value.grantId !== "string" ||
    !value.grantId.startsWith("grant_") ||
    typeof value.host !== "string" ||
    value.host.length > 253 ||
    /[\s/@]/.test(value.host) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    value.username !== "warpmetal-sandbox" ||
    !Array.isArray(value.hostKeys) ||
    value.hostKeys.length < 1 ||
    value.hostKeys.length > 8
  ) {
    throw new CliError("The connection profile is invalid.", { exitCode: 2 });
  }
  const fingerprints = new Set();
  const hostKeys = value.hostKeys.map((item) => {
    const parsed = parsePublicKey(item?.publicKey);
    if (
      item?.fingerprint !== parsed.fingerprint ||
      fingerprints.has(parsed.fingerprint)
    ) {
      throw new CliError(
        "A pinned host-key fingerprint is invalid or duplicated.",
        { exitCode: 2 },
      );
    }
    fingerprints.add(parsed.fingerprint);
    return parsed;
  });
  return { ...value, hostKeys };
}

export function connectionProfile(serverId, sandboxId, grantId, connection) {
  return validateConnectionProfile({
    version: 1,
    serverId,
    sandboxId,
    grantId,
    host: connection?.host,
    port: connection?.port,
    username: connection?.username,
    hostKeys: connection?.hostKeys,
  });
}

export async function writeConnectionProfile(path, profile) {
  const resolved = resolve(path);
  const safe = validateConnectionProfile(profile);
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    const serializable = {
      ...safe,
      hostKeys: safe.hostKeys.map(({ publicKey, fingerprint }) => ({
        publicKey,
        fingerprint,
      })),
    };
    await handle.writeFile(
      `${JSON.stringify(serializable, null, 2)}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    await rename(temporary, resolved);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  if (process.platform !== "win32") await chmod(resolved, 0o600);
  return resolved;
}

export async function readConnectionProfile(path) {
  const resolved = resolve(path);
  let value;
  try {
    value = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError("The connection profile is not valid JSON.", {
        exitCode: 2,
      });
    }
    throw error;
  }
  return validateConnectionProfile(value);
}

export function knownHosts(profile) {
  const safe = validateConnectionProfile(profile);
  const host = safe.port === 22 ? safe.host : `[${safe.host}]:${safe.port}`;
  return (
    safe.hostKeys.map((key) => `${host} ${key.publicKey}`).join("\n") + "\n"
  );
}
