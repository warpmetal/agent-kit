import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = new URL("..", import.meta.url).pathname;
const CLIENT = "warpmetal-customer-cli";

// This protocol peer qualifies packaged CLI transport/persistence only. Real
// Identity/Postgres/BFF approval is a separate required integration gate.
async function peer() {
  const requests = [];
  const secrets = ["device-secret-do-not-print", "access-secret-do-not-print", "wmclr_initial-secret", "wmclr_rotated-secret"];
  let mode = "approve";
  let polls = 0;
  let refreshes = 0;
  let revoked = false;
  let activeRefresh = secrets[2];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const fields = new URLSearchParams(raw);
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, fields: Object.fromEntries(fields) });
    const send = (status, value) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/oauth/device_authorization") {
      if (mode === "redirect") {
        response.writeHead(307, { location: `${base}/leaked` }).end();
        return;
      }
      if (fields.get("client_id") !== CLIENT) return send(400, { error: "invalid_client" });
      return send(200, { device_code: secrets[0], user_code: "ABCD-EFGH", verification_uri: `${base}/account/cli`, verification_uri_complete: `${base}/account/cli?user_code=ABCD-EFGH`, expires_in: 15, interval: 1 });
    }
    if (request.url === "/oauth/token") {
      if (fields.get("client_id") !== CLIENT) return send(400, { error: "invalid_client" });
      if (fields.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        if (fields.get("device_code") !== secrets[0]) return send(400, { error: "invalid_grant" });
        polls += 1;
        if (mode === "deny") return send(400, { error: "access_denied" });
        if (mode === "expire") return send(400, { error: "expired_token" });
        if (polls === 1) return send(400, { error: "authorization_pending" });
        return send(200, { access_token: secrets[1], refresh_token: secrets[2], token_type: "Bearer", expires_in: 1, scope: "cli:read cli:write" });
      }
      if (fields.get("grant_type") === "refresh_token") {
        refreshes += 1;
        if (revoked || fields.get("refresh_token") !== activeRefresh) return send(400, { error: "invalid_grant" });
        activeRefresh = secrets[3];
        return send(200, { access_token: secrets[1], refresh_token: activeRefresh, token_type: "Bearer", expires_in: 3600, scope: "cli:read cli:write" });
      }
    }
    if (request.url === "/oauth/revoke") {
      if (fields.get("token") !== activeRefresh || fields.get("client_id") !== CLIENT) return send(400, { error: "invalid_request" });
      revoked = true;
      return send(200, {});
    }
    if (request.url === "/account/cli/whoami") {
      if (revoked || request.headers.authorization !== `Bearer ${secrets[1]}`) return send(401, { error: { code: "invalid_token" } });
      return send(200, { principalId: "11111111-1111-4111-8111-111111111111", email: "customer@example.test", emailVerified: true, scopes: ["cli:read", "cli:write"], sessionFamilyId: "22222222-2222-4222-8222-222222222222", expiresAt: "2099-01-01T00:00:00Z" });
    }
    return send(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, secrets, setMode(value) { mode = value; }, get refreshes() { return refreshes; }, get revoked() { return revoked; }, async close() { server.close(); await once(server, "close"); } };
}

async function run(server, state, args, extra = []) {
  try {
    return { code: 0, ...await execFile(process.execPath, ["bin/warpmetal.js", ...args, "--identity-url", server.base, "--account-url", server.base, "--state-dir", state, "--json", ...extra], { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024 }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function privateFiles(directory) {
  const found = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await stat(path);
    assert.equal(info.mode & 0o077, 0, `private permissions: ${path}`);
    if (info.isDirectory()) found.push(...await privateFiles(path));
    else found.push({ path, text: await readFile(path, "utf8") });
  }
  return found;
}

test("packaged CLI has an independent private session, serialized refresh, origin binding and logout", async () => {
  const server = await peer();
  const other = await peer();
  const state = await mkdtemp(join(tmpdir(), "warpmetal-cli-auth-e2e-"));
  const legacy = JSON.stringify({ version: 4, sentinel: "legacy owner-token state remains untouched" });
  await writeFile(join(state, "state.json"), legacy, { mode: 0o600 });
  try {
    let result = await run(server, state, ["login", "--no-browser"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).authenticated, true);
    assert.match(result.stderr, /ABCD-EFGH/);
    for (const secret of server.secrets) assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "no credential output");
    const start = server.requests.find((request) => request.path === "/oauth/device_authorization");
    assert.deepEqual(start.fields, { client_id: CLIENT, scope: "cli:read cli:write" });
    assert.ok(server.requests.every((request) => !/orders|ssh|catalog/.test(request.path)));
    assert.equal(await readFile(join(state, "state.json"), "utf8"), legacy);
    assert.ok((await privateFiles(state)).some((file) => file.text.includes(server.secrets[2])), "durable independent refresh credential");

    const statuses = await Promise.all(Array.from({ length: 3 }, () => run(server, state, ["auth", "status"])));
    for (const status of statuses) {
      assert.equal(status.code, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).authenticated, true);
      for (const secret of server.secrets) assert.ok(!`${status.stdout}${status.stderr}`.includes(secret));
    }
    assert.equal(server.refreshes, 1, "concurrent processes rotate only once");
    const stored = await privateFiles(state);
    assert.ok(stored.some((file) => file.text.includes(server.secrets[3])));
    assert.ok(stored.every((file) => !file.text.includes(server.secrets[2])), "old refresh material replaced");

    result = await run(other, state, ["auth", "status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).authenticated, false);
    assert.equal(other.requests.length, 0, "a different origin never receives credentials");

    result = await run(server, state, ["logout"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(server.revoked, true);
    result = await run(server, state, ["auth", "status"]);
    assert.equal(JSON.parse(result.stdout).authenticated, false);
    assert.equal(await readFile(join(state, "state.json"), "utf8"), legacy);
    for (const file of await privateFiles(state)) for (const secret of server.secrets) assert.ok(!file.text.includes(secret));
  } finally { await server.close(); await other.close(); }
});

test("device denial, expiry, invalid options and HTTP redirects never establish a session", async () => {
  const server = await peer();
  const state = await mkdtemp(join(tmpdir(), "warpmetal-cli-auth-denial-"));
  try {
    for (const [mode, expected] of [["deny", /access_denied/], ["expire", /expired_token/], ["redirect", /redirect|HTTP 307/]]) {
      server.setMode(mode);
      const result = await run(server, state, ["login", "--no-browser"]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, expected);
      for (const secret of server.secrets) assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    }
    assert.ok(!server.requests.some((request) => request.path === "/leaked"));
    const before = server.requests.length;
    const invalid = await run(server, state, ["login", "--unexpected"]);
    assert.equal(invalid.code, 2);
    assert.equal(server.requests.length, before);
    const result = await run(server, state, ["auth", "status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).authenticated, false);
  } finally { await server.close(); }
});
