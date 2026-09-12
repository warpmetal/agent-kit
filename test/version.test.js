import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { USER_AGENT, VERSION } from "../src/version.js";

test("the next Agent Kit release is 0.8.12 everywhere", async () => {
  const packageDocument = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const lockDocument = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  assert.equal(packageDocument.version, "0.8.12");
  assert.equal(lockDocument.version, "0.8.12");
  assert.equal(lockDocument.packages[""].version, "0.8.12");
  assert.equal(VERSION, "0.8.12");
  assert.equal(USER_AGENT, "warpmetal-cli/0.8.12");
});
