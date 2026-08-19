import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "warpmetal");

test("bundled skill covers runtime safety and forbids raw fallbacks", async () => {
  const skill = await readFile(join(root, "SKILL.md"), "utf8");
  const runtime = await readFile(join(root, "references", "runtime.md"), "utf8");
  const combined = `${skill}\n${runtime}`;
  for (const required of [
    "--runtime-file",
    "--confirm INSTALL",
    "--confirm TEMPORARY",
    "--confirm DELETE",
    "--confirm REVOKE",
    "sandbox access keygen",
    "sandbox access grant",
    "sandbox connect",
    "persistent",
    "86,400",
    "distinct sandbox-specific SSH key",
    "pinned host keys",
    "Do not",
    "raw HTTP",
  ]) {
    assert.ok(combined.includes(required), `missing runtime skill rule: ${required}`);
  }
  assert.match(skill, /If the installed CLI lacks a required runtime command, stop/i);
  assert.match(runtime, /permanently deletes the workspace/i);
});
