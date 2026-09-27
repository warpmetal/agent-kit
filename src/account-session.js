import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { CliError } from "./errors.js";

const SESSION_VERSION = 1;
const LOCK_WAIT_MS = 45_000;
const LOCK_STALE_MS = 30_000;

function sessionKey(identityOrigin, accountOrigin) {
  return createHash("sha256")
    .update(`${identityOrigin}\n${accountOrigin}\n`, "utf8")
    .digest("hex");
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
}

function validateSession(value, identityOrigin, accountOrigin) {
  if (
    !value ||
    value.version !== SESSION_VERSION ||
    value.identityOrigin !== identityOrigin ||
    value.accountOrigin !== accountOrigin ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    !value.refreshToken.startsWith("wmclr_") ||
    typeof value.accessExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.accessExpiresAt)) ||
    !Array.isArray(value.scopes) ||
    value.scopes.length === 0 ||
    new Set(value.scopes).size !== value.scopes.length ||
    value.scopes.some((scope) => !["cli:read", "cli:write"].includes(scope)) ||
    !value.scopes.includes("cli:read")
  ) {
    throw new CliError(
      "The saved WarpMetal account session is invalid. Run warpmetal logout, then login again.",
      { code: "invalid_session" },
    );
  }
  return value;
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function pause(milliseconds) {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

export class AccountSessionStore {
  constructor(directory, { identityOrigin, accountOrigin } = {}) {
    if (typeof directory !== "string" || directory.length === 0) {
      throw new CliError("A WarpMetal state directory is required.", {
        exitCode: 2,
      });
    }
    this.stateDirectory = isAbsolute(directory) ? directory : resolve(directory);
    this.identityOrigin = identityOrigin;
    this.accountOrigin = accountOrigin;
    this.directory = join(this.stateDirectory, "account-sessions");
    const key = sessionKey(identityOrigin, accountOrigin);
    this.path = join(this.directory, `${key}.json`);
    this.lockPath = join(this.directory, `${key}.lock`);
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      return validateSession(value, this.identityOrigin, this.accountOrigin);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof CliError) throw error;
      throw new CliError(
        "The saved WarpMetal account session could not be read. Run warpmetal logout, then login again.",
        { code: "invalid_session" },
      );
    }
  }

  async write(session) {
    await privateDirectory(this.directory);
    await atomicWrite(
      this.path,
      validateSession(
        {
          ...session,
          version: SESSION_VERSION,
          identityOrigin: this.identityOrigin,
          accountOrigin: this.accountOrigin,
        },
        this.identityOrigin,
        this.accountOrigin,
      ),
    );
  }

  async clear() {
    try {
      await unlink(this.path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async #recoverStaleLock() {
    let info;
    try {
      info = await stat(this.lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;
    let owner;
    try {
      owner = JSON.parse(await readFile(this.lockPath, "utf8"));
    } catch {
      owner = null;
    }
    if (owner && processExists(owner.pid)) return;
    try {
      await unlink(this.lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async withLock(callback) {
    await privateDirectory(this.directory);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let handle;
    while (!handle) {
      try {
        const candidate = await open(this.lockPath, "wx", 0o600);
        try {
          await candidate.writeFile(
            `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
            "utf8",
          );
          await candidate.sync();
          handle = candidate;
        } catch (error) {
          await candidate.close().catch(() => {});
          await unlink(this.lockPath).catch(() => {});
          throw error;
        }
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await this.#recoverStaleLock();
        if (Date.now() >= deadline) {
          throw new CliError(
            "Another WarpMetal process is updating this account session. Try again.",
            { exitCode: 3, code: "session_locked" },
          );
        }
        await pause(50 + Math.floor(Math.random() * 75));
      }
    }
    try {
      return await callback();
    } finally {
      await handle.close();
      try {
        await unlink(this.lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}
