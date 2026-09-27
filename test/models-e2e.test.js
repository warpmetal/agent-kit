import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = new URL("..", import.meta.url).pathname;

const source = {
  id: "models-dev",
  url: "https://models.dev/api.json",
  observedAt: "2026-09-25T15:01:07Z",
  sourceUpdatedAt: "2026-09-25T15:00:00Z",
  etag: "\"catalog-fixture-v1\"",
  status: "ok",
};

function entry({ entryId, providerId, modelId, authModes, managerRank, workerRank }) {
  return {
    entryId,
    canonicalId: modelId,
    alternates: [],
    displayName: modelId,
    family: providerId,
    providerId,
    providerName: providerId,
    modelId,
    route: { region: "global", snapshot: null },
    suggestedRoles: managerRank ? ["manager"] : ["worker"],
    engine: { profileVersion: "opencode-2.0.14", adapterVersion: "team-adapter-1" },
    authModes,
    capabilities: {
      toolCall: true,
      structuredOutput: true,
      reasoning: true,
      contextTokens: 128000,
      outputTokens: 8192,
    },
    price: {
      currency: "USD",
      unit: "per_million_tokens",
      input: 1,
      output: 2,
      cacheRead: null,
      cacheWrite: null,
      scope: "standard synchronous text",
      source: "models.dev",
      observedAt: "2026-09-25T15:01:07Z",
      status: "current",
    },
    quality: { scoreSource: null, score: null, evidenceRef: null, status: "pending" },
    eligibility: {
      state: "qualified",
      qualifiedAt: "2026-09-23T00:00:00Z",
      deprecated: false,
      replacement: null,
    },
    rank: { managers: managerRank ?? null, workers: workerRank ?? null, reason: null },
    referenceWorkloadCost: 0.014,
  };
}

const openai = entry({
  entryId: "openai/gpt-6-sol",
  providerId: "openai",
  modelId: "gpt-6-sol",
  authModes: ["api_key", "chatgpt_subscription"],
  managerRank: 1,
});
const anthropic = entry({
  entryId: "anthropic/claude-haiku-5",
  providerId: "anthropic",
  modelId: "claude-haiku-5",
  authModes: ["api_key"],
  workerRank: 1,
});

function catalog(state, entries = [openai, anthropic]) {
  return {
    schemaVersion: 1,
    snapshotId: state === "empty" ? null : `snapshot-${state}`,
    generatedAt: state === "empty" ? null : "2026-09-25T15:01:07Z",
    state,
    lastSuccessfulSourceCheckAt: state === "empty" ? null : "2026-09-25T15:01:07Z",
    freshUntil: state === "fresh" ? "2026-09-26T15:01:07Z" : null,
    policyVersion: "rank-v1",
    qualificationRevision: "qualification-v1",
    sourceAttribution: "Frozen public catalog fixture",
    source,
    recommended: {
      managers: entries.some((item) => item.entryId === openai.entryId) ? [openai.entryId] : [],
      workers: entries.some((item) => item.entryId === anthropic.entryId) ? [anthropic.entryId] : [],
    },
    entries,
  };
}

async function startCatalogServer() {
  let document = catalog("fresh");
  let status = 200;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method !== "GET" || request.url !== "/agent-team-model-catalog") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 200 ? document : { error: { code: "catalog_unavailable", message: "unavailable" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setDocument(value) { document = value; status = 200; },
    setError(value) { status = value; },
    async close() { server.close(); await once(server, "close"); },
  };
}

async function run(baseUrl, ...args) {
  try {
    const result = await execFile(process.execPath, ["bin/warpmetal.js", ...args, "--base-url", baseUrl], {
      cwd: root,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function filtered(document, predicate) {
  const entries = document.entries.filter(predicate);
  const ids = new Set(entries.map((item) => item.entryId));
  return {
    ...document,
    entries,
    recommended: {
      managers: document.recommended.managers.filter((id) => ids.has(id)),
      workers: document.recommended.workers.filter((id) => ids.has(id)),
    },
  };
}

test("models subprocess renders only the published catalog and fails locally for invalid filters", async () => {
  const server = await startCatalogServer();
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  try {
    let result = await run(server.baseUrl, "models", "--json");
    expect(result.code === 0, `fresh JSON exits 0 (got ${result.code}: ${result.stderr})`);
    if (result.code === 0) expect(JSON.stringify(JSON.parse(result.stdout)) === JSON.stringify(catalog("fresh")), "fresh JSON preserves the published snapshot");

    result = await run(server.baseUrl, "models", "--provider", "openai", "--json");
    expect(result.code === 0, "provider-filtered JSON exits 0");
    if (result.code === 0) expect(JSON.stringify(JSON.parse(result.stdout)) === JSON.stringify(filtered(catalog("fresh"), (item) => item.providerId === "openai")), "provider filtering preserves metadata and removes dangling recommendations");

    result = await run(server.baseUrl, "models", "--auth-mode", "chatgpt_subscription", "--json");
    expect(result.code === 0, "auth-filtered JSON exits 0");
    if (result.code === 0) expect(JSON.stringify(JSON.parse(result.stdout)) === JSON.stringify(filtered(catalog("fresh"), (item) => item.authModes.includes("chatgpt_subscription"))), "auth filtering retains published auth metadata and removes dangling recommendations");

    server.setDocument(catalog("stale"));
    result = await run(server.baseUrl, "models");
    expect(result.code === 0 && /stale/i.test(result.stdout), "human output explicitly identifies stale catalog state");

    server.setDocument(catalog("suppressed", []));
    result = await run(server.baseUrl, "models");
    expect(result.code === 0 && /suppressed/i.test(result.stdout) && /no models|empty|unavailable/i.test(result.stdout), "human output explicitly identifies suppressed empty catalog state");

    server.setDocument(catalog("fresh", []));
    result = await run(server.baseUrl, "models", "--json");
    expect(result.code === 0 && JSON.stringify(JSON.parse(result.stdout)) === JSON.stringify(catalog("fresh", [])), "empty JSON preserves the empty public snapshot");

    server.setError(503);
    result = await run(server.baseUrl, "models", "--json");
    expect(result.code !== 0 && result.stdout === "", "catalog HTTP errors do not emit fabricated model data");

    const beforeInvalid = server.requests.length;
    result = await run(server.baseUrl, "models", "--auth-mode", "not-a-mode");
    expect(result.code === 2 && server.requests.length === beforeInvalid, "invalid auth mode fails before network");
    result = await run(server.baseUrl, "models", "--unexpected");
    expect(result.code === 2 && server.requests.length === beforeInvalid, "unknown option fails before network");
    expect(server.requests.every((request) => request.method === "GET" && request.url === "/agent-team-model-catalog"), "models sends only public catalog GET requests");
  } finally {
    await server.close();
  }
  assert.deepEqual(failures, []);
});
