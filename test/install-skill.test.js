import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installSkill } from "../src/install-skill.js";

test("portable skill installs for Codex and Claude project scopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-skill-test-"));
  try {
    const installed = await installSkill("all", {
      scope: "project",
      cwd: directory,
      env: {},
    });
    assert.deepEqual(
      installed.map(({ target }) => target),
      ["codex", "claude"],
    );

    const codex = await readFile(
      join(directory, ".codex/skills/warpmetal/SKILL.md"),
      "utf8",
    );
    const claude = await readFile(
      join(directory, ".claude/skills/warpmetal/SKILL.md"),
      "utf8",
    );
    assert.equal(codex, claude);
    assert.match(codex, /^---\nname: warpmetal\n/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
