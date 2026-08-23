import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "warpmetal",
);

test("bundled skill covers runtime safety and forbids raw fallbacks", async () => {
  const skill = await readFile(join(root, "SKILL.md"), "utf8");
  const runtime = await readFile(
    join(root, "references", "runtime.md"),
    "utf8",
  );
  const payments = await readFile(
    join(root, "references", "payments.md"),
    "utf8",
  );
  const safety = await readFile(join(root, "references", "safety.md"), "utf8");
  const combined = `${skill}\n${runtime}\n${payments}\n${safety}`;
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
    "powerOffFirst: true",
    "PasswordAuthentication no",
    "AuthenticationMethods publickey",
    "--power-off-first",
    "--acknowledge-agent-runtime-reset",
    "sandbox access refresh",
    "--confirm REFRESH",
    "paymentWorkflow.authorize.argv",
    "--payment-artifact",
    "x402api payment authorize",
    "request envelope",
    "Node.js 20 or 22",
    "@x402api/agent-wallet-cli@0.2.1",
    "agentWalletSupported: true",
    "com.x402api.gas-sponsorship",
    "x402api pay",
  ]) {
    assert.ok(
      combined.includes(required),
      `missing runtime skill rule: ${required}`,
    );
  }
  assert.match(
    skill,
    /If the installed CLI lacks a required runtime command, stop/i,
  );
  assert.match(
    skill,
    /Never request,\s+store, invent, or expect a VPS login password/i,
  );
  assert.match(runtime, /permanently deletes the workspace/i);
  assert.match(payments, /never\s+authorize again/i);
  assert.match(payments, /Require contract version 1/i);
  assert.match(payments, /never ask the buyer to fund ETH or SOL/i);
});
