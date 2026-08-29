import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(root, "plugins", "warpmetal");
const sourceSkill = join(root, "skills", "warpmetal");
const bundledSkill = join(pluginRoot, "skills", "warpmetal");
const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
const marketplacePath = join(root, ".agents", "plugins", "marketplace.json");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

test("public plugin packages the authoritative skill without CLI code", async () => {
  const sourceFiles = await filesUnder(sourceSkill);
  const bundledFiles = await filesUnder(bundledSkill);
  assert.deepEqual(
    bundledFiles.map((path) => relative(bundledSkill, path)),
    sourceFiles.map((path) => relative(sourceSkill, path)),
  );

  for (const sourcePath of sourceFiles) {
    const relativePath = relative(sourceSkill, sourcePath);
    const [source, bundled] = await Promise.all([
      readFile(sourcePath),
      readFile(join(bundledSkill, relativePath)),
    ]);
    assert.deepEqual(bundled, source, `plugin skill drifted: ${relativePath}`);
  }

  await assert.rejects(stat(join(pluginRoot, "bin")), { code: "ENOENT" });
  await assert.rejects(stat(join(pluginRoot, "src")), { code: "ENOENT" });

  assert.deepEqual((await readdir(pluginRoot)).sort(), [
    ".codex-plugin",
    "README.md",
    "assets",
    "skills",
  ]);
});

test("plugin manifest and local marketplace preserve the skills-only boundary", async () => {
  const manifest = await readJson(manifestPath);
  assert.equal(manifest.name, "warpmetal");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.displayName, "WarpMetal");
  assert.equal(manifest.interface.category, "Developer Tools");
  assert.equal(manifest.interface.defaultPrompt.length, 3);
  for (const prompt of manifest.interface.defaultPrompt) {
    assert.ok(prompt.length > 0 && prompt.length <= 128);
  }
  for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    assert.match(manifest.interface[field], /^https:\/\//);
  }
  assert.ok(!("mcpServers" in manifest));
  assert.ok(!("apps" in manifest));

  const marketplace = await readJson(marketplacePath);
  assert.equal(marketplace.name, "warpmetal");
  assert.equal(marketplace.interface.displayName, "WarpMetal");
  const entry = marketplace.plugins.find(({ name }) => name === "warpmetal");
  assert.equal(entry.source.path, "./plugins/warpmetal");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.equal(entry.category, manifest.interface.category);
});

test("plugin assets are production-size PNG files", async () => {
  for (const name of ["icon.png", "logo.png"]) {
    const asset = await readFile(join(pluginRoot, "assets", name));
    assert.deepEqual(
      [...asset.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    assert.equal(asset.readUInt32BE(16), 512);
    assert.equal(asset.readUInt32BE(20), 512);
  }
});

test("submission pack contains complete, unique reviewer cases", async () => {
  const cases = await readJson(
    join(root, "submission", "openai", "reviewer-tests.json"),
  );
  assert.equal(cases.positive.length, 6);
  assert.equal(cases.negative.length, 3);

  const names = [...cases.positive, ...cases.negative].map(({ name }) => name);
  assert.equal(new Set(names).size, names.length);

  for (const item of cases.positive) {
    assert.ok(item.name);
    assert.ok(item.prompt);
    assert.ok(Array.isArray(item.expectedBehavior));
    assert.ok(item.expectedBehavior.length > 0);
    assert.ok(item.expectedResultShape);
    assert.ok(item.fixtures);
  }
  for (const item of cases.negative) {
    assert.ok(item.name);
    assert.ok(item.prompt);
    assert.ok(item.expectedBehavior);
    assert.ok(item.whyNot);
  }
});
