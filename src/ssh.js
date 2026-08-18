import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";

import { CliError } from "./errors.js";

export async function readSshPublicKey(path) {
  const resolved = resolve(path);
  const value = (await readFile(resolved, "utf8")).trim();
  if (value.includes("PRIVATE KEY") || !/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(256|384|521))\s+/.test(value)) {
    throw new CliError(
      "The SSH public-key file must contain one supported OpenSSH public key and never a private key.",
      { exitCode: 2 },
    );
  }
  if (value.includes("\n")) {
    throw new CliError("The SSH public-key file must contain exactly one key.", { exitCode: 2 });
  }
  return value;
}

export async function signSshChallenge(payload, identityPath, { spawn = spawnSync } = {}) {
  if (typeof payload !== "string" || !payload.startsWith("warpmetal-ssh-auth-v1\n")) {
    throw new CliError("WarpMetal returned an invalid SSH signing payload.");
  }
  const identity = resolve(identityPath);
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-ssh-"));
  const payloadPath = join(directory, "challenge.txt");
  const signaturePath = `${payloadPath}.sig`;
  try {
    await writeFile(payloadPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const result = spawn(
      "ssh-keygen",
      ["-Y", "sign", "-f", identity, "-n", "warpmetal", payloadPath],
      { stdio: ["inherit", "ignore", "inherit"] },
    );
    if (result.error?.code === "ENOENT") {
      throw new CliError("ssh-keygen is required for WarpMetal SSH proof.", { exitCode: 2 });
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new CliError("ssh-keygen did not create a WarpMetal SSH signature.", { exitCode: 4 });
    }
    const signature = await readFile(signaturePath, "utf8");
    if (
      !signature.includes("-----BEGIN SSH SIGNATURE-----") ||
      !signature.includes("-----END SSH SIGNATURE-----")
    ) {
      throw new CliError("ssh-keygen returned an invalid SSH signature.", { exitCode: 4 });
    }
    return signature;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
