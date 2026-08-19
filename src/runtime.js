import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CliError } from "./errors.js";

export const SANDBOX_SIZES = new Set(["small", "medium", "large", "xlarge"]);
export const MIN_TEMPORARY_SECONDS = 900;
export const DEFAULT_TEMPORARY_SECONDS = 86_400;
export const MAX_TEMPORARY_SECONDS = 86_400;

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SANDBOX_FIELDS = new Set([
  "name",
  "size",
  "lifetime",
  "expiresInSeconds",
]);

function exactFields(value, allowed, label) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown)
    throw new CliError(`${label} contains unsupported field: ${unknown}`, {
      exitCode: 2,
    });
}

export function validateSandboxBatch(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new CliError("sandboxes must contain between 1 and 32 entries.", {
      exitCode: 2,
    });
  }
  const names = new Set();
  return value.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new CliError("Every sandbox must be a JSON object.", {
        exitCode: 2,
      });
    }
    exactFields(input, SANDBOX_FIELDS, "A sandbox");
    if (typeof input.name !== "string" || !NAME.test(input.name)) {
      throw new CliError(
        "Sandbox names use 1-63 lowercase letters, numbers, or dashes.",
        { exitCode: 2 },
      );
    }
    if (names.has(input.name)) {
      throw new CliError(`Duplicate sandbox name: ${input.name}`, {
        exitCode: 2,
      });
    }
    names.add(input.name);
    if (!SANDBOX_SIZES.has(input.size)) {
      throw new CliError(
        "Sandbox size must be small, medium, large, or xlarge.",
        {
          exitCode: 2,
        },
      );
    }
    const lifetime = input.lifetime || "persistent";
    if (!new Set(["persistent", "temporary"]).has(lifetime)) {
      throw new CliError("Sandbox lifetime must be persistent or temporary.", {
        exitCode: 2,
      });
    }
    if (lifetime === "persistent" && input.expiresInSeconds !== undefined) {
      throw new CliError("expiresInSeconds requires lifetime temporary.", {
        exitCode: 2,
      });
    }
    let expiresInSeconds;
    if (lifetime === "temporary") {
      expiresInSeconds = input.expiresInSeconds ?? DEFAULT_TEMPORARY_SECONDS;
      if (
        !Number.isInteger(expiresInSeconds) ||
        expiresInSeconds < MIN_TEMPORARY_SECONDS ||
        expiresInSeconds > MAX_TEMPORARY_SECONDS
      ) {
        throw new CliError(
          "Temporary lifetime must be between 900 and 86400 seconds.",
          {
            exitCode: 2,
          },
        );
      }
    }
    const sandbox = { name: input.name, size: input.size };
    if (lifetime === "temporary") {
      sandbox.lifetime = "temporary";
      sandbox.expiresInSeconds = expiresInSeconds;
    }
    return sandbox;
  });
}

export async function readSandboxFile(path) {
  const resolved = resolve(path);
  const content = await readFile(resolved, "utf8");
  if (Buffer.byteLength(content) > 128 * 1024) {
    throw new CliError("The sandbox JSON file is too large.", { exitCode: 2 });
  }
  let document;
  try {
    document = JSON.parse(content);
  } catch {
    throw new CliError("The sandbox JSON file is not valid JSON.", {
      exitCode: 2,
    });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new CliError("The sandbox JSON file must contain one object.", {
      exitCode: 2,
    });
  }
  exactFields(document, new Set(["sandboxes"]), "The sandbox JSON file");
  return validateSandboxBatch(document.sandboxes);
}

export function containsTemporary(sandboxes) {
  return sandboxes.some((sandbox) => sandbox.lifetime === "temporary");
}

export function requireTemporaryConfirmation(sandboxes, confirmation) {
  if (containsTemporary(sandboxes) && confirmation !== "TEMPORARY") {
    throw new CliError(
      "Temporary sandboxes permanently delete their workspace at expiry. Confirm with --confirm TEMPORARY.",
      { exitCode: 2 },
    );
  }
}

export function validateRuntimeCatalog(product, osName, sandboxes) {
  const runtime = product?.agentRuntime;
  const operatingSystem = product?.operatingSystems?.find(
    (system) => system.name === osName,
  );
  if (!runtime?.supported || operatingSystem?.agentRuntimeSupported !== true) {
    throw new CliError(
      "The selected live plan and operating system do not support Agent Runtime.",
      {
        exitCode: 2,
      },
    );
  }
  const sizes = new Map(runtime.sizes.map((size) => [size.id, size]));
  const requested = { cpuMillicores: 0, memoryMiB: 0, workspaceDiskGiB: 0 };
  for (const sandbox of sandboxes) {
    const size = sizes.get(sandbox.size);
    if (!size) {
      throw new CliError(
        `The live catalog does not publish sandbox size ${sandbox.size}.`,
        {
          exitCode: 2,
        },
      );
    }
    for (const field of Object.keys(requested))
      requested[field] += Number(size[field]);
  }
  const exceeded = Object.keys(requested).find(
    (field) => requested[field] > Number(runtime.capacity[field]),
  );
  if (exceeded) {
    throw new CliError(
      "The requested sandboxes exceed the live plan runtime capacity.",
      {
        exitCode: 5,
        details: { requested, capacity: runtime.capacity },
      },
    );
  }
  return { requested, capacity: runtime.capacity };
}

export function sandboxFromOptions({ name, size, lifetime, expiresInSeconds }) {
  const value = { name, size };
  if (lifetime !== undefined) value.lifetime = lifetime;
  if (expiresInSeconds !== undefined) value.expiresInSeconds = expiresInSeconds;
  return validateSandboxBatch([value]);
}
