import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DOCUMENTS = [
  "README.md",
  "skills/warpmetal/references/runtime.md",
  "plugins/warpmetal/skills/warpmetal/references/runtime.md",
  "skills/warpmetal/references/cli-reference.md",
  "plugins/warpmetal/skills/warpmetal/references/cli-reference.md",
];

test("CLI guidance keeps nested Bubblewrap automatic and non-user-configurable", async () => {
  for (const path of DOCUMENTS) {
    const text = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(text, /agent-enabled[\s\S]{0,240}(?:first boot|cloud-init)/i, path);
    assert.match(
      text,
      /signed\s+Runtime[\s\S]{0,220}immutable\s+Bubblewrap/i,
      path,
    );
    assert.match(
      text,
      /(?:no\s+(?:later|follow-up)|without\s+a\s+later)\s+customer\s+SSH\s+key/i,
      path,
    );
    assert.match(text, /(?:no|not a) public[\s\S]{0,80}(?:field|CLI flag)/i, path);
    assert.match(text, /VPS-only cloud-init[\s\S]{0,50}unchanged/i, path);
    assert.match(text, /reload\/reprovision/i, path);
    assert.match(
      text,
      /(?:no|does not\s+claim a)\s+silent in-place (?:policy )?repair/i,
      path,
    );
  }
});
