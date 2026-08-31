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
  const renewals = await readFile(
    join(root, "references", "renewals.md"),
    "utf8",
  );
  const combined = `${skill}\n${runtime}\n${payments}\n${safety}\n${renewals}`;
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
    "@x402api/agent-wallet-cli@0.2.6",
    "x402api wallet setup --json",
    "x402api wallet funding --wallet <name>",
    "agentWalletSupported: true",
    "com.x402api.gas-sponsorship",
    "x402api pay",
    "--generate-ssh-key",
    "warpmetal server identity",
    "warpmetal renewal configure",
    "warpmetal renewal prepare",
    "refillWorkflow.argv",
    "x402api wallet notify-refill",
    "subscription reference",
    "reconcile_pending",
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
  assert.match(payments, /never\s+ask the buyer to fund ETH or SOL/i);
  assert.match(
    payments,
    /unattended\s+run, do not wait for conversational approval/i,
  );
  assert.match(safety, /recheck after 60\s+seconds/i);
  assert.match(payments, /x402api wallet show --wallet <name> --json/i);
  assert.match(payments, /--maximum-payment-atomic/i);
  assert.match(payments, /first compatible term[\s\S]*advertised order/i);
  assert.match(payments, /x402api wallet address --wallet <name> --json/i);
  assert.match(payments, /not to the token contract\/mint/i);
  assert.match(payments, /not to WarpMetal's payment recipient/i);
  assert.match(payments, /funding_required/i);
  assert.doesNotMatch(payments, /funds the token address/i);
  assert.match(renewals, /Never pay outside policy|outside policy/i);
  assert.match(renewals, /do not sign again/i);
  assert.match(renewals, /cannot name a recipient\s+email/i);
});
