import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WarpMetalClient } from "./api.js";
import { ApiError, CliError } from "./errors.js";

const MAX_RESPONSE = 2 * 1024 * 1024;
const safeCode = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : "agent_management_unavailable";
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

export async function readManagementInput(path, maxBytes = 64 * 1024) {
  let file;
  try {
    if (typeof path !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE) throw new Error();
    file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error();
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw new Error();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new CliError("Input must be a bounded JSON object in a regular file.", { exitCode: 2, code: "invalid_management_input" });
  } finally {
    await file?.close();
  }
}

export function managementClient({ baseUrl, fetchImpl }) {
  const client = new WarpMetalClient({ baseUrl, fetchImpl: async (url, options) => {
    const response = await fetchImpl(url, { ...options, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new Error("redirect refused");
    const reader = response.body?.getReader();
    let length = 0;
    const chunks = [];
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE) {
          await reader.cancel();
          throw new Error("response exceeds bound");
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader?.releaseLock(); }
    const body = [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks);
    return new Response(body, { status: response.status, headers: response.headers });
  } });
  return {
    baseUrl: client.baseUrl,
    async request(...args) {
      try { return await client.request(...args); }
      catch (error) {
        if (error instanceof ApiError) throw new ApiError("Agent management request was refused.", {
          status: error.status, code: safeCode(error.code),
          retryAfter: /^\d{1,6}$/.test(String(error.retryAfter)) ? error.retryAfter : undefined,
        });
        throw new CliError("Agent management response is unavailable; reconcile the same request ID.", {
          exitCode: 3, code: "agent_management_unavailable",
        });
      }
    },
  };
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function saveRecord(path, record, exclusive = false) {
  const target = exclusive ? path : `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!exclusive) await rename(target, path);
  } finally {
    await handle?.close();
    if (!exclusive) await rm(target, { force: true });
  }
}

/** Private opaque intent only. A saved intent never causes another mutation. */
export function managementMutations(stateDirectory, origin) {
  const directory = join(stateDirectory, "agent-management-operations");
  return async ({ path, serverId, sandboxId, kind, requestId, body, submit, reconcile }) => {
    if (typeof path !== "string" || !path.startsWith("/servers/") || path.includes("?") ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{3,159}$/.test(requestId || "") ||
        typeof submit !== "function" || typeof reconcile !== "function") {
      throw new CliError("A fixed route and recoverable request ID are required.", { exitCode: 2, code: "invalid_management_intent" });
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new CliError("Management intent storage is unavailable.", { exitCode: 3 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const file = join(directory, `${hash(canonical({ origin, path, requestId }))}.json`);
    const identity = { version: 1, origin, path, serverId, sandboxId, kind, requestId, bodyDigest: hash(canonical(body)) };
    let record = { ...identity, state: "dispatching" };
    let fresh = false;
    try {
      await saveRecord(file, record, true);
      await syncDirectory(directory);
      fresh = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw new CliError("Could not persist management intent; no request was sent.", { exitCode: 3, code: "management_storage_unavailable" });
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > 8192 || process.platform !== "win32" && (info.mode & 0o077)) throw new Error();
        record = JSON.parse(await readFile(file, "utf8"));
      } catch {
        throw new CliError("Saved management intent is unavailable; no mutation was sent.", { exitCode: 3, code: "management_storage_unavailable" });
      }
      if (Object.entries(identity).some(([key, value]) => record[key] !== value)) {
        throw new CliError("This request ID already names a different management intent.", { exitCode: 5, code: "management_intent_conflict" });
      }
    }
    let result;
    try { result = await (fresh ? submit() : reconcile()); }
    catch (error) {
      await saveRecord(file, { ...identity, state: "outcome_unknown" }).catch(() => {});
      throw error;
    }
    // Keep no response, prompt, content, authentication or local file path.
    await saveRecord(file, { ...identity, state: "submitted" });
    await syncDirectory(directory);
    return result;
  };
}
