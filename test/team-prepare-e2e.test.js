import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = new URL("..", import.meta.url).pathname;
const intent = {
  sandboxes: [{ name: "manager", size: "small" }, { name: "worker", size: "small" }],
  teams: { version: 1, teams: [{ name: "Build team", members: [
    { sandboxName: "manager", role: "manager", providerId: "openai", modelId: "fixture-manager", authMode: "chatgpt_subscription" },
    { sandboxName: "worker", role: "worker", providerId: "anthropic", modelId: "fixture-worker", authMode: "api_key" },
  ], links: [{ from: "manager", to: "worker", capability: "task.delegate" }], startPolicy: "manual" }] },
};

test("packaged order preparation preserves explicit team intent, rejects malformed input and respects server gates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-cli-team-e2e-"));
  const file = join(directory, "runtime.json");
  const key = join(directory, "owner.pub");
  await writeFile(key, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fixture\n");
  const requests = [];
  let blocked = false;
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, path: request.url, body: raw ? JSON.parse(raw) : null });
    let status = 200;
    let body;
    if (request.url === "/health") body = { purchasingReady: true };
    else if (request.url === "/catalog") body = { products: [{ id: "fixture-plan", operatingSystems: [{ name: "Fixture OS", agentRuntimeSupported: true }], agentRuntime: { supported: true, sizes: [{ id: "small", cpuMillicores: 500, memoryMiB: 1024, workspaceDiskGiB: 10 }], capacity: { cpuMillicores: 4000, memoryMiB: 8192, workspaceDiskGiB: 80 } } }] };
    else if (request.url === "/orders" && blocked) { status = 409; body = { error: { code: "agent_teams_unavailable", message: "Agent Teams are not ready." } }; }
    else if (request.url === "/orders") { status = 201; body = { task: { id: "task_fixture", serverId: "srv_fixture", planId: "fixture-plan", checkoutPath: "/checkout/fixture-plan" }, ownerToken: "owner-fixture-not-for-output" }; }
    else { status = 404; body = { error: { code: "not_found" } }; }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  async function prepare(value) {
    await writeFile(file, JSON.stringify(value));
    try {
      return { code: 0, ...await execFile(process.execPath, ["bin/warpmetal.js", "order", "prepare", "--plan", "fixture-plan", "--hostname", "fixture", "--os", "Fixture OS", "--ssh-public-key-file", key, "--runtime-file", file, "--base-url", base, "--state-dir", join(directory, "state"), "--json"], { cwd: root }) };
    } catch (error) { return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
  }
  try {
    let result = await prepare(intent);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.find((request) => request.path === "/orders").body.agentRuntime, intent);
    assert.ok(!result.stdout.includes("owner-fixture-not-for-output"));
    const beforeSandbox = requests.length;
    let sandboxResult;
    try {
      await execFile(process.execPath, ["bin/warpmetal.js", "sandbox", "create", "--server", "srv_fixture", "--file", file, "--base-url", base, "--state-dir", join(directory, "state"), "--json"], { cwd: root });
      sandboxResult = { code: 0, stderr: "" };
    } catch (error) { sandboxResult = error; }
    assert.equal(sandboxResult.code, 2, sandboxResult.stderr);
    assert.match(sandboxResult.stderr, /order preparation/);
    assert.equal(requests.length, beforeSandbox, "order-only team fields cannot be silently sent as sandbox batches");
    // Explicit files without teams are retained as-is; upgrading the CLI cannot
    // silently turn an existing box-only script into team provisioning.
    result = await prepare({ sandboxes: intent.sandboxes });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.filter((request) => request.path === "/orders").at(-1).body.agentRuntime, { sandboxes: intent.sandboxes });
    for (const mutate of [
      (value) => { value.teams.teams[0].members[0].apiKey = "never-send"; },
      (value) => { value.teams.teams[0].members[1].sandboxName = "not-declared"; },
      (value) => { value.teams.teams[0].members[1].role = "manager"; },
      (value) => { value.teams.teams[0].startPolicy = "automatic"; },
      (value) => { value.teams.teams[0].members[1].authMode = "chatgpt_subscription"; },
      (value) => { value.teams.teams[0].links[0].from = "worker"; },
    ]) {
      const invalid = structuredClone(intent);
      mutate(invalid);
      const before = requests.length;
      result = await prepare(invalid);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(requests.length, before, "invalid team rejected before network");
      assert.ok(!`${result.stdout}${result.stderr}`.includes("never-send"));
    }
    blocked = true;
    result = await prepare(intent);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Agent Teams are not ready/);
    assert.ok(requests.every((request) => !/checkout|payment|provision/.test(request.path)));
  } finally { server.close(); await once(server, "close"); }
});
