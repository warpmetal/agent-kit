import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = new URL("..", import.meta.url).pathname;

test("account CLI prepares through its scoped gateway and stores ownership without an owner token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-cli-account-order-"));
  const key = join(directory, "owner.pub");
  await writeFile(key, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fixture\n");
  const requests = [];
  const task = { id: "task_account", serverId: "srv_account", planId: "fixture-plan", state: "payment_required", checkoutPath: "/checkout/fixture-plan" };
  const account = { principalId: "11111111-1111-4111-8111-111111111111", email: "verified@example.test", emailVerified: true, scopes: ["cli:read", "cli:write"], sessionFamilyId: "22222222-2222-4222-8222-222222222222", expiresAt: "2099-01-01T00:00:00Z" };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw && request.headers["content-type"]?.includes("application/json") ? JSON.parse(raw) : null;
    requests.push({ method: request.method, path: request.url, body, authorization: request.headers.authorization, idempotencyKey: request.headers["idempotency-key"] });
    let status = 200;
    let result;
    if (request.url === "/oauth/device_authorization") result = { device_code: "device-fixture", user_code: "ABCD-EFGH", verification_uri: `${base}/account/cli`, verification_uri_complete: `${base}/account/cli?user_code=ABCD-EFGH`, expires_in: 20, interval: 1 };
    else if (request.url === "/oauth/token") result = { access_token: "cli-fixture-secret", refresh_token: "wmclr_fixture-secret", token_type: "Bearer", expires_in: 3600, scope: "cli:read cli:write" };
    else if (request.url.startsWith("/account/cli/") && request.headers.authorization !== "Bearer cli-fixture-secret") { status = 401; result = { type: "about:blank", status: 401, code: "invalid_token" }; }
    else if (request.url === "/account/cli/whoami") result = account;
    else if (request.url === "/account/cli/orders" && request.method === "POST") { status = 201; result = { task, ownershipMode: "account" }; }
    else if (request.url === "/account/cli/orders") result = { orders: [task] };
    else if (request.url === "/account/cli/orders/task_account") result = { task };
    else if (request.url === "/account/cli/devices") result = { devices: [] };
    else if (request.url === "/health") result = { purchasingReady: true };
    else if (request.url === "/catalog") result = { products: [{ id: "fixture-plan", operatingSystems: [{ name: "Fixture OS", agentRuntimeSupported: true }], agentRuntime: { supported: true, sizes: [{ id: "small", cpuMillicores: 500, memoryMiB: 1024, workspaceDiskGiB: 10 }], capacity: { cpuMillicores: 4000, memoryMiB: 8192, workspaceDiskGiB: 80 } } }] };
    else { status = 404; result = { type: "about:blank", status: 404, code: "not_found", detail: "private-upstream-detail" }; }
    response.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json" });
    response.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = join(directory, "state");
  async function run(args) {
    try { return { code: 0, ...await execFile(process.execPath, ["bin/warpmetal.js", ...args, "--base-url", base, "--identity-url", base, "--account-url", base, "--state-dir", state, "--json"], { cwd: root, timeout: 20000 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
  }
  const prepare = ["order", "prepare", "--account", "--plan", "fixture-plan", "--hostname", "fixture-account", "--os", "Fixture OS", "--ssh-public-key-file", key, "--idempotency-key", "cli-account-fixture"];
  try {
    let result = await run(["order", "prepare", "--account"]);
    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /login|sign in/i);
    assert.equal(requests.length, 0, "login required before order validation/network");
    result = await run(["login", "--no-browser"]);
    assert.equal(result.code, 0, result.stderr);
    result = await run(prepare);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /team|runtime-file/);
    assert.ok(!requests.some((request) => request.method === "POST" && request.path.includes("orders")), "default team requires explicit configuration, never invent models");
    result = await run([...prepare, "--without-agent-boxes"]);
    assert.equal(result.code, 0, result.stderr);
    const sent = requests.find((request) => request.method === "POST" && request.path === "/account/cli/orders");
    assert.ok(sent);
    assert.equal(sent.idempotencyKey, "cli-account-fixture");
    assert.equal(sent.body.agentRuntime, undefined);
    assert.equal(sent.body.email, undefined, "account contact is server derived");
    assert.equal(sent.body.principalId, undefined);
    assert.ok(!requests.some((request) => request.path === "/orders"), "account mode cannot fall back to public owner-token prepare");
    const saved = JSON.parse(await readFile(join(state, "state.json"), "utf8"));
    assert.equal(saved.orders.task_account.ownershipMode, "account");
    assert.equal(saved.orders.task_account.ownerToken, undefined);
    assert.equal(saved.orders.task_account.accountPrincipalId, account.principalId);
    for (const args of [["account", "orders"], ["account", "orders", "--task", task.id], ["account", "devices"]]) {
      result = await run(args);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(!`${result.stdout}${result.stderr}`.includes("cli-fixture-secret"));
    }
    result = await run(["account", "orders", "--task", "foreign-task"]);
    assert.equal(result.code, 3, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "not_found");
    assert.ok(!result.stderr.includes("private-upstream-detail"));
    result = await run([...prepare, "--without-team"]);
    assert.equal(result.code, 0, result.stderr);
    const boxes = requests.filter((request) => request.method === "POST" && request.path.endsWith("/orders")).at(-1).body.agentRuntime;
    assert.deepEqual(boxes, { sandboxes: [{ name: "main", size: "small" }] });
    assert.ok(requests.every((request) => !/checkout|payment|provision/.test(request.path)));
  } finally { server.close(); await once(server, "close"); }
});
