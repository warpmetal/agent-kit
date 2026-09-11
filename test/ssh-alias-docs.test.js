import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceSkill = join(repository, "skills", "warpmetal");
const pluginSkill = join(
  repository,
  "plugins",
  "warpmetal",
  "skills",
  "warpmetal",
);
const skillFiles = [
  "SKILL.md",
  join("references", "cli-reference.md"),
  join("references", "runtime.md"),
];

async function skillSurface(root) {
  return (
    await Promise.all(skillFiles.map((path) => readFile(join(root, path), "utf8")))
  ).join("\n");
}

function normalized(value) {
  return value.replace(/[`\n\r\t]+/g, " ").replace(/\s+/g, " ");
}

function missingAliasDocumentation(value) {
  const text = normalized(value);
  const requirements = [
    [
      "install-ssh with profile, sandbox identity, and concrete alias",
      /warpmetal sandbox access install-ssh .*--connection-file <(?:profile|profile-path)> .*--identity <(?:key|sandbox-private-key-path)> .*--alias <alias>/i,
    ],
    [
      "authenticated profile refresh before explicit alias refresh",
      /warpmetal sandbox access refresh .*--confirm REFRESH .*warpmetal sandbox access install-ssh .*--confirm REFRESH/i,
    ],
    [
      "remove-ssh with explicit removal confirmation",
      /warpmetal sandbox access remove-ssh .*--alias <alias> .*--confirm REMOVE/i,
    ],
    ["interactive ssh alias", /ssh <alias>(?:\s|$)/i],
    ["interactive Codex", /ssh <alias> ["']?codex(?:["']?\s|$)/i],
    ["one-shot Codex", /ssh <alias> ["']?codex exec(?:["']?\s|$)/i],
    ["interactive Claude Code", /ssh <alias> ["']?claude(?:["']?\s|$)/i],
    ["one-shot Claude Code", /ssh <alias> ["']?claude -p(?:["']?\s|$)/i],
    ["interactive Cursor CLI", /ssh <alias> ["']?agent(?:["']?\s|$)/i],
    ["one-shot Cursor CLI", /ssh <alias> ["']?agent -p(?:["']?\s|$)/i],
    [
      "sandbox-owned provider authentication",
      /(?:authenticate|authentication|credentials?)[^.]{0,160}(?:inside|within|in) (?:the )?sandbox|sandbox-owned [^.]{0,80}(?:authentication|credentials?)/i,
    ],
    [
      "a separate key and grant per sandbox",
      /(?:separate|distinct)[^.]{0,100}(?:key|keypair)[^.]{0,100}grant[^.]{0,100}(?:each|every|per) sandbox|(?:each|every) sandbox[^.]{0,100}(?:separate|distinct)[^.]{0,100}(?:key|keypair)[^.]{0,100}grant/i,
    ],
    ["Codex Desktop", /Codex Desktop/i],
    ["Codex Desktop concrete alias", /concrete [^.]{0,60}alias/i],
    ["Codex Desktop OpenSSH config discovery", /~\/\.ssh\/config/i],
    ["Codex Desktop remote login shell", /login shell/i],
    ["Codex available on the login-shell PATH", /[Cc]odex[^.]{0,100}(?:on|in)[^.]{0,40}PATH|PATH[^.]{0,100}[Cc]odex/],
    [
      "sandbox aliases never use or expose the VPS owner key",
      /(?:without|does not|do not|never)[^.]{0,160}owner(?: management)? key|owner(?: management)? key[^.]{0,160}(?:never|not|without)/i,
    ],
    [
      "sandbox aliases cannot open a host shell",
      /(?:cannot|does not|do not|never)[^.]{0,120}host shell|host shell[^.]{0,120}(?:denied|unavailable|not)/i,
    ],
    [
      "sandbox aliases do not relax forwarding denial",
      /ClearAllForwardings yes|disables? (?:all )?forwarding|forwarding[^.]{0,120}(?:disabled|denied|not enabled|remains (?:disabled|denied|off))/i,
    ],
  ];
  return requirements
    .filter(([, pattern]) => !pattern.test(text))
    .map(([description]) => description);
}

function assertAliasDocumentation(name, value) {
  assert.deepEqual(
    missingAliasDocumentation(value),
    [],
    `${name} must document the complete concrete sandbox SSH alias contract`,
  );
  assert.doesNotMatch(
    value,
    /\bcursor-agent\b/i,
    `${name} must use Cursor's current agent executable`,
  );
}

function assertOfficialCompatibilitySources(name, value) {
  assert.match(
    value,
    /https:\/\/developers\.openai\.com\/codex\/remote-connections/,
    `${name} must link the authoritative Codex remote-connections contract`,
  );
  assert.match(
    value,
    /https:\/\/cursor\.com\/docs\/cli\/(?:overview|headless)/,
    `${name} must link authoritative Cursor interactive or headless CLI guidance`,
  );
}

test("CLI help documents the complete concrete sandbox SSH alias workflow", () => {
  const result = spawnSync(process.execPath, [join(repository, "bin", "warpmetal.js"), "--help"], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assertAliasDocumentation("CLI help", result.stdout);
});

test("README documents alias lifecycle, tool entry points, and unchanged isolation", async () => {
  const readme = await readFile(join(repository, "README.md"), "utf8");
  assertAliasDocumentation("README", readme);
  assertOfficialCompatibilitySources("README", readme);
});

test("authoritative skill documents alias lifecycle, compatibility, and boundaries", async () => {
  const skill = await skillSurface(sourceSkill);
  assertAliasDocumentation("authoritative skill", skill);
  assertOfficialCompatibilitySources("authoritative skill", skill);
});

test("bundled plugin mirrors the authoritative SSH alias guidance byte-for-byte", async () => {
  for (const path of skillFiles) {
    const [source, bundled] = await Promise.all([
      readFile(join(sourceSkill, path)),
      readFile(join(pluginSkill, path)),
    ]);
    assert.deepEqual(bundled, source, `plugin skill drifted: ${path}`);
  }
  const skill = await skillSurface(pluginSkill);
  assertAliasDocumentation("bundled plugin skill", skill);
  assertOfficialCompatibilitySources("bundled plugin skill", skill);
});
