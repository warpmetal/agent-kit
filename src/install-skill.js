import { cp, mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "./errors.js";

const SOURCE = fileURLToPath(new URL("../skills/warpmetal", import.meta.url));

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function destinationFor(target, scope, { cwd, env }) {
  const userHome = env.HOME || env.USERPROFILE || homedir();
  if (target === "codex") {
    if (scope === "project") return join(cwd, ".codex", "skills", "warpmetal");
    return join(resolve(env.CODEX_HOME || join(userHome, ".codex")), "skills", "warpmetal");
  }
  if (target === "claude") {
    if (scope === "project") return join(cwd, ".claude", "skills", "warpmetal");
    return join(userHome, ".claude", "skills", "warpmetal");
  }
  throw new CliError(`Unsupported agent target: ${target}`, { exitCode: 2 });
}

export async function installSkill(
  target,
  { scope = "user", force = false, cwd = process.cwd(), env = process.env } = {},
) {
  if (!["user", "project"].includes(scope)) {
    throw new CliError("--scope must be user or project.", { exitCode: 2 });
  }
  const targets = target === "all" ? ["codex", "claude"] : [target];
  const destinations = targets.map((name) => ({
    target: name,
    path: destinationFor(name, scope, { cwd, env }),
  }));

  if (!force) {
    for (const destination of destinations) {
      if (await exists(destination.path)) {
        throw new CliError(
          `A WarpMetal skill already exists for ${destination.target}: ${destination.path}. Use --force to replace it.`,
          { exitCode: 2 },
        );
      }
    }
  }

  for (const destination of destinations) {
    if (force && (await exists(destination.path))) {
      await rm(destination.path, { recursive: true, force: true });
    }
    await mkdir(dirname(destination.path), { recursive: true });
    await cp(SOURCE, destination.path, { recursive: true, errorOnExist: true });
  }
  return destinations;
}
