import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { handleInsights } from "../src/agent-insights.js";
import { StateStore } from "../src/state.js";

const execFile = promisify(execFileCallback);
const root = new URL("..", import.meta.url).pathname;
const OWNER_TOKEN = "owner-insights-private-token";
const FINDING = "finding_insights0001";
const OPEN_SERVER = "srv_p2c_insighthandoff";
const OPEN_BOX = "sbx_70c2ee4729f3eb2f8e0b8149";
const MANAGER_SERVER = "srv_p2c_managerreview";
const MANAGER_BOX = "sbx_44701f63569482ba475bab49";

const managerWire = JSON.parse(
  await readFile(
    new URL("fixtures/agent-manager-control-v1.backend-wire.fixture.json", import.meta.url),
    "utf8",
  ),
);
const managerContract = JSON.parse(
  await readFile(
    new URL("fixtures/agent-manager-control-v1.fixture.json", import.meta.url),
    "utf8",
  ),
);
const sessionWire = JSON.parse(
  await readFile(
    new URL("fixtures/agent-session-handoff-v1.backend-wire.fixture.json", import.meta.url),
    "utf8",
  ),
);
const insightsContract = JSON.parse(
  await readFile(new URL("fixtures/agent-insights-v1.fixture.json", import.meta.url), "utf8"),
);

const finding = {
  ...insightsContract.batch.findings[0],
  phaseStartedAt: null,
  lastProgressAt: null,
  healthObservedAt: null,
  stallThresholdMs: null,
  registeredSourceId: insightsContract.batch.registeredSourceId,
  workspaceEpoch: insightsContract.batch.workspaceEpoch,
  nativeSessionId: insightsContract.batch.nativeSessionId,
  serviceGeneration: insightsContract.batch.serviceGeneration,
  journalGeneration: insightsContract.batch.journalGeneration,
  severity: "warning",
  templateId: insightsContract.batch.findings[0].ruleId,
  suggestionId: "inspect_first_failure",
  sourceAvailability: "available",
  role: "worker",
  expiresAt: "2026-10-27T12:00:00Z",
  attention: { state: "unacknowledged", revision: 1, snoozedUntil: null },
};
const settings = {
  version: 1,
  revision: 2,
  enabled: true,
  observedRevision: 2,
  status: "ready",
  lastObservedAt: "2026-09-27T12:00:00Z",
  gapReason: null,
  retentionDays: 30,
};

function response(status, value) {
  return {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
    value,
  };
}

async function fixtureState(directory) {
  const stateDirectory = join(directory, "state");
  const store = new StateStore(stateDirectory);
  for (const [index, serverId] of [OPEN_SERVER, MANAGER_SERVER].entries()) {
    await store.savePreparedOrder(
      {
        task: {
          id: `task_cliinsights${index + 1}`,
          serverId,
          planId: "agent",
          checkoutPath: "/checkout/agent",
        },
        ownerToken: OWNER_TOKEN,
      },
      JSON.stringify({ serverId }),
    );
  }
  return stateDirectory;
}

async function loopback(handler) {
  const requests = [];
  const server = http.createServer(async (request, reply) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(request.url, "http://localhost");
    const record = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      token: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      body,
    };
    requests.push(record);
    const result = await handler(record);
    reply.writeHead(result.status, result.headers);
    reply.end(JSON.stringify(result.value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    requests,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

function runner(baseUrl, stateDirectory) {
  return async (args) => {
    try {
      return {
        code: 0,
        ...(await execFile(
          process.execPath,
          [
            "bin/warpmetal.js",
            ...args,
            "--base-url",
            baseUrl,
            "--state-dir",
            stateDirectory,
            "--json",
          ],
          { cwd: root, timeout: 20_000 },
        )),
      };
    } catch (error) {
      return {
        code: error.code,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }
  };
}

function exactTakeoverHandoff(takeover) {
  const envelope = structuredClone(sessionWire.finding);
  const { identity, source } = envelope.handoff;
  identity.serverId = OPEN_SERVER;
  identity.sandboxId = OPEN_BOX;
  identity.sandboxGeneration = takeover.source.sandboxGeneration;
  identity.teamId = takeover.target.teamId;
  identity.memberId = takeover.target.memberId;
  identity.serviceRegistrationId = takeover.source.serviceRegistrationId;
  identity.serviceGeneration = takeover.source.serviceGeneration;
  identity.workspaceEpoch = takeover.source.workspaceEpoch;
  identity.profileRevision = takeover.source.profileRevision;
  identity.instructionRevision = takeover.source.instructionRevision;
  source.registeredSourceId = takeover.source.registeredSourceId;
  source.nativeSessionId = takeover.source.nativeSessionId;
  envelope.handoff.task = {
    taskId: takeover.target.taskId,
    taskAttempt: takeover.target.taskAttempt,
  };
  return envelope;
}

test("Insights CLI reads only scoped sanitized metadata and exact existing sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-insights-read-"));
  const stateDirectory = await fixtureState(directory);
  const exactHandoff = exactTakeoverHandoff(managerWire.takeoverReady);
  const superseded = { ...managerWire.takeoverReady, state: "superseded" };
  const service = await loopback(async ({ method, path, query, token }) => {
    assert.equal(token, `Bearer ${OWNER_TOKEN}`);
    assert.equal(method, "GET", `read path unexpectedly mutated: ${method} ${path}`);
    if (path === `/servers/${OPEN_SERVER}/insights/summary`) {
      assert.equal(query, "?limit=1&cursor=sbx_cursor0001");
      return response(200, {
        serverId: OPEN_SERVER,
        boxes: [{
          sandboxId: OPEN_BOX,
          monitor: settings,
          openFindings: 1,
          attentionNeeded: 1,
          latestFinding: {
            findingId: FINDING,
            ruleId: finding.ruleId,
            count: finding.count,
            lastObservedAt: finding.lastObservedAt,
            role: "worker",
          },
        }],
        nextCursor: null,
      });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/settings`) {
      return response(200, { settings });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights`) {
      assert.equal(
        query,
        `?limit=1&state=open&session=${finding.nativeSessionId}&severity=warning&attention=unacknowledged&rule=${encodeURIComponent(finding.ruleId)}&recentHours=24`,
      );
      return response(200, { settings, findings: [finding], nextCursor: null });
    }
    if (path.endsWith("/finding_expanded0001")) {
      return response(200, { finding: { ...finding, findingId: "finding_expanded0001", privatePrompt: "DO-NOT-PRINT-private-prompt" } });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/${FINDING}`) {
      return response(200, { finding });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/${FINDING}/handoff`) {
      return response(200, exactHandoff);
    }
    if (path.endsWith("/takeovers/takeover_managertest0001")) {
      return response(200, managerWire.takeoverReady);
    }
    if (path.endsWith(`/${FINDING}/takeovers`)) {
      assert.equal(query, "?limit=100");
      return response(200, { takeovers: [managerWire.takeoverReady], nextCursor: null });
    }
    if (path.endsWith("/takeovers/takeover_superseded0001")) {
      return response(200, { ...superseded, operationId: "takeover_superseded0001" });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/manager/settings`) {
      return response(200, {
        ...managerWire.appliedPolicy,
        sandboxId: OPEN_BOX,
        revision: managerWire.takeoverReady.monitorPolicy.desiredRevision,
        mode: "off",
        appliedRevision: managerWire.takeoverReady.monitorPolicy.appliedRevision,
        status: "applied",
        authorizationExpiresAt: null,
      });
    }
    if (path === `/servers/${MANAGER_SERVER}/sandboxes/${MANAGER_BOX}/insights/manager/settings`) {
      return response(200, managerWire.appliedPolicy);
    }
    if (path === `/servers/${MANAGER_SERVER}/sandboxes/${MANAGER_BOX}/insights/manager/activity`) {
      assert.equal(query, `?limit=2&findingId=${FINDING}`);
      return response(200, managerWire.activityList);
    }
    if (path.endsWith(`/manager/activity/${managerWire.automaticReportResponse.runId}`)) {
      return response(200, managerWire.automaticReportResponse);
    }
    if (path.endsWith(`/manager/activity/${managerWire.automaticReportResponse.runId}/session-handoff`)) {
      return response(200, managerWire.managerSessionHandoff);
    }
    if (path.endsWith(`/${FINDING}/manager-target`)) {
      return response(200, managerWire.managerTarget);
    }
    return response(404, { error: { code: "not_found", message: "private upstream detail" } });
  });
  const run = runner(service.baseUrl, stateDirectory);
  try {
    const commands = [
      [0, "insights", "summary", OPEN_SERVER, "--limit", "1", "--cursor", "sbx_cursor0001"],
      [0, "insights", "status", OPEN_SERVER, OPEN_BOX],
      [0, "insights", "list", OPEN_SERVER, OPEN_BOX, "--limit", "1", "--state", "open", "--session", finding.nativeSessionId, "--severity", "warning", "--attention", "unacknowledged", "--rule", finding.ruleId, "--recent-hours", "24"],
      [0, "insights", "show", OPEN_SERVER, OPEN_BOX, FINDING],
      [8, "insights", "manager", "settings", MANAGER_SERVER, MANAGER_BOX],
      [0, "insights", "manager", "activity", MANAGER_SERVER, MANAGER_BOX, "--limit", "2", "--finding", FINDING],
      [0, "insights", "manager", "run", MANAGER_SERVER, MANAGER_BOX, managerWire.automaticReportResponse.runId],
      [0, "insights", "manager", "target", MANAGER_SERVER, MANAGER_BOX, FINDING],
      [0, "insights", "takeover", "list", OPEN_SERVER, OPEN_BOX, FINDING, "--limit", "100"],
      [0, "insights", "open", OPEN_SERVER, OPEN_BOX, FINDING],
      [0, "insights", "open", OPEN_SERVER, OPEN_BOX, FINDING, "--takeover", "takeover_managertest0001"],
      [0, "insights", "review", MANAGER_SERVER, MANAGER_BOX, managerWire.automaticReportResponse.runId],
    ];
    for (const [expectedCode, ...command] of commands) {
      const result = await run(command);
      assert.equal(result.code, expectedCode, `${command.join(" ")}\n${result.stderr}`);
      assert.equal(result.stderr, "");
      assert.doesNotMatch(result.stdout, /private|owner-insights-private-token/i);
      if (command[1] === "open") assert.deepEqual(JSON.parse(result.stdout), exactHandoff);
      if (command[1] === "review") assert.deepEqual(JSON.parse(result.stdout), managerWire.managerSessionHandoff);
    }
    const beforeSuperseded = service.requests.length;
    let result = await run(["insights", "open", OPEN_SERVER, OPEN_BOX, FINDING, "--takeover", "takeover_superseded0001"]);
    assert.equal(result.code, 5, result.stderr);
    assert.equal(service.requests.length, beforeSuperseded + 1, "superseded pause must fail before handoff lookup");
    const beforeInvalid = service.requests.length;
    result = await run(["insights", "show", OPEN_SERVER, OPEN_BOX, "finding_expanded0001"]);
    assert.equal(result.code, 3, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /DO-NOT-PRINT-private-prompt/);
    result = await run(["insights", "show", OPEN_SERVER, OPEN_BOX, FINDING, "surplus"]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(service.requests.length, beforeInvalid + 1, "surplus positional must fail before network");
    assert.ok(service.requests.every(({ method }) => method === "GET"));
  } finally {
    await service.close();
  }
});

test("Insights open and review pass the complete envelope to the session transport", async () => {
  const opened = [];
  const context = { env: {}, json: false, stdout: { write() {} } };
  const services = {
    context,
    store: {},
    requireServerToken: async () => OWNER_TOKEN,
    client: {
      async request(_method, path) {
        return { status: 200, data: path.endsWith("/session-handoff") ? managerWire.managerSessionHandoff : sessionWire.finding };
      },
    },
    emit() { throw new Error("interactive handoff must not emit JSON"); },
    async openSessionHandoff(envelope) {
      opened.push(envelope);
      return 0;
    },
  };
  assert.equal(await handleInsights(["insights", "open", OPEN_SERVER, OPEN_BOX, FINDING], {}, services), 0);
  assert.equal(await handleInsights([
    "insights", "review", MANAGER_SERVER, MANAGER_BOX, managerWire.automaticReportResponse.runId,
  ], {}, services), 0);
  assert.deepEqual(opened, [sessionWire.finding, managerWire.managerSessionHandoff]);

  await assert.rejects(
    handleInsights(["insights", "open", OPEN_SERVER, OPEN_BOX, FINDING], {}, {
      ...services,
      async openSessionHandoff() { return {}; },
    }),
    error => error?.code === "session_handoff_transport_invalid" && error?.exitCode === 3,
  );
});

test("Insights mutations are closed, scoped, durable and recover with GET only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-insights-write-"));
  const stateDirectory = await fixtureState(directory);
  const files = {};
  async function save(name, value) {
    const path = join(directory, name);
    await writeFile(path, `${JSON.stringify(value)}\n`);
    files[name] = path;
  }
  await save("enable.json", insightsContract.settings);
  await save("ack.json", insightsContract.action);
  const snooze = {
    ...insightsContract.action,
    requestId: "req_monitor_snooze0001",
    expectedRevision: 2,
    action: "snooze",
    snoozeSeconds: 60,
  };
  await save("snooze.json", snooze);
  const policy = {
    ...managerContract.policyPatch,
    expectedRevision: managerWire.appliedPolicy.revision - 1,
  };
  await save("policy.json", policy);
  const recheck = {
    ...managerContract.recheckRequest,
    requestId: managerWire.manualReservation.requestId,
    expectedFindingRevision: managerWire.managerTarget.findingRevision,
    expectedPolicyRevision: managerWire.manualReservation.policyRevision,
    source: managerWire.manualReservation.source,
    target: managerWire.manualReservation.target,
  };
  await save("recheck.json", recheck);
  const takeover = {
    ...managerContract.takeoverRequest,
    operationId: managerWire.takeoverAwaiting.operationId,
    requestId: managerWire.takeoverAwaiting.requestId,
    expectedFindingRevision: managerWire.managerTarget.findingRevision,
    expectedPolicyRevision: managerWire.takeoverAwaiting.monitorPolicy.desiredRevision - 1,
    source: managerWire.takeoverAwaiting.source,
    target: managerWire.takeoverAwaiting.target,
  };
  await save("takeover.json", takeover);
  const resume = {
    ...managerContract.resumeRequest,
    resumeOperationId: managerWire.resumeAwaiting.operationId,
    requestId: managerWire.resumeAwaiting.requestId,
    expectedTakeoverRevision: managerWire.takeoverReady.revision,
    expectedPolicyRevision: managerWire.takeoverReady.monitorPolicy.desiredRevision,
    expectedHoldRevision: managerWire.takeoverReady.memberHold.desiredRevision,
    restoreMode: managerWire.resumeAwaiting.monitorPolicy.desiredMode,
    source: managerWire.resumeAwaiting.source,
    target: managerWire.resumeAwaiting.target,
  };
  await save("resume.json", resume);
  await save("wrong-action.json", { ...insightsContract.action, action: "dismiss" });
  await writeFile(join(directory, "too-large.json"), JSON.stringify({ private: "x".repeat(70 * 1024) }));

  let settingsValue = settings;
  let findingValue = finding;
  let policyValue = managerWire.appliedPolicy;
  let recheckReceipt = managerWire.manualReservation;
  let takeoverLookupReceipt = managerWire.takeoverReady;
  let resumeReceipt = managerWire.resumeAwaiting;
  const service = await loopback(async ({ method, path, query, token, idempotencyKey, body }) => {
    assert.equal(token, `Bearer ${OWNER_TOKEN}`);
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/settings`) {
      if (method === "PATCH") {
        assert.deepEqual(body, insightsContract.settings);
        assert.equal(idempotencyKey, insightsContract.settings.requestId);
      } else assert.equal(method, "GET");
      return response(200, { settings: settingsValue });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/${FINDING}/actions`) {
      assert.equal(method, "POST");
      assert.ok([insightsContract.action.requestId, snooze.requestId].includes(body.requestId));
      assert.equal(idempotencyKey, body.requestId);
      findingValue = {
        ...finding,
        attention: {
          state: body.action === "snooze" ? "snoozed" : "acknowledged",
          revision: body.expectedRevision + 1,
          snoozedUntil: body.action === "snooze" ? new Date(Date.now() + body.snoozeSeconds * 1000).toISOString() : null,
        },
      };
      return response(200, { finding: findingValue });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/${FINDING}`) {
      assert.equal(method, "GET");
      return response(200, { finding: findingValue });
    }
    if (path === `/servers/${MANAGER_SERVER}/sandboxes/${MANAGER_BOX}/insights/manager/settings`) {
      if (method === "PATCH") {
        assert.deepEqual(body, policy);
        assert.equal(idempotencyKey, policy.requestId);
      } else assert.equal(method, "GET");
      return response(200, policyValue);
    }
    if (path.endsWith(`/${FINDING}/manager-rechecks`)) {
      if (method === "POST") {
        assert.deepEqual(body, recheck);
        assert.equal(idempotencyKey, recheck.requestId);
      } else {
        assert.equal(method, "GET");
        assert.equal(query, `?requestId=${recheck.requestId}`);
      }
      return response(method === "POST" ? 201 : 200, recheckReceipt);
    }
    if (path.endsWith(`/${FINDING}/takeovers`)) {
      assert.equal(method, "POST");
      assert.deepEqual(body, takeover);
      assert.equal(idempotencyKey, takeover.requestId);
      return response(202, managerWire.takeoverAwaiting);
    }
    if (path.endsWith(`/${FINDING}/takeovers/${takeover.operationId}`)) {
      assert.equal(method, "GET");
      return response(200, takeoverLookupReceipt);
    }
    if (path.endsWith(`/${FINDING}/takeovers/${takeover.operationId}/resume`)) {
      assert.equal(method, "POST");
      assert.deepEqual(body, resume);
      assert.equal(idempotencyKey, resume.requestId);
      return response(202, managerWire.resumeAwaiting);
    }
    if (path.endsWith(`/${FINDING}/takeovers/${resume.resumeOperationId}`)) {
      assert.equal(method, "GET");
      return response(200, resumeReceipt);
    }
    return response(404, { error: { code: "not_found", message: "private upstream detail" } });
  });
  const run = runner(service.baseUrl, stateDirectory);
  try {
    let result = await run(["insights", "enable", OPEN_SERVER, OPEN_BOX, "--file", files["enable.json"]]);
    assert.equal(result.code, 0, result.stderr);
    result = await run(["insights", "enable", OPEN_SERVER, OPEN_BOX, "--file", files["enable.json"]]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(service.requests.filter(({ path }) => path.endsWith("/insights/settings")).map(({ method }) => method), ["PATCH", "GET"]);

    result = await run(["insights", "acknowledge", OPEN_SERVER, OPEN_BOX, FINDING, "--file", files["ack.json"]]);
    assert.equal(result.code, 0, result.stderr);
    result = await run(["insights", "acknowledge", OPEN_SERVER, OPEN_BOX, FINDING, "--file", files["ack.json"]]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(service.requests.filter(({ path }) => path.includes(`/${FINDING}`)).slice(0, 2).map(({ method }) => method), ["POST", "GET"]);

    result = await run(["insights", "snooze", OPEN_SERVER, OPEN_BOX, FINDING, "--file", files["snooze.json"]]);
    assert.equal(result.code, 0, result.stderr);

    result = await run(["insights", "manager", "settings", MANAGER_SERVER, MANAGER_BOX, "--file", files["policy.json"]]);
    assert.equal(result.code, 8, result.stderr);
    result = await run(["insights", "manager", "recheck", MANAGER_SERVER, MANAGER_BOX, FINDING, "--file", files["recheck.json"]]);
    assert.equal(result.code, 8, result.stderr);
    result = await run(["insights", "manager", "status", MANAGER_SERVER, MANAGER_BOX, FINDING, "--request", recheck.requestId]);
    assert.equal(result.code, 8, result.stderr);
    result = await run(["insights", "takeover", MANAGER_SERVER, MANAGER_BOX, FINDING, "--file", files["takeover.json"]]);
    assert.equal(result.code, 8, result.stderr);
    result = await run(["insights", "takeover", "status", MANAGER_SERVER, MANAGER_BOX, FINDING, "--operation", takeover.operationId]);
    assert.equal(result.code, 0, result.stderr);
    result = await run(["insights", "takeover", "resume", MANAGER_SERVER, MANAGER_BOX, FINDING, "--operation", takeover.operationId, "--file", files["resume.json"]]);
    assert.equal(result.code, 8, result.stderr);

    const mutationsBeforeRefusals = service.requests.filter(({ method }) => ["POST", "PATCH"].includes(method)).length;
    const refusalCodes = [];
    settingsValue = { ...settings, revision: settings.revision + 1, enabled: false };
    result = await run(["insights", "enable", OPEN_SERVER, OPEN_BOX, "--file", files["enable.json"]]);
    refusalCodes.push(result.code);
    settingsValue = { ...settings, revision: insightsContract.settings.expectedRevision, enabled: false };
    result = await run(["insights", "enable", OPEN_SERVER, OPEN_BOX, "--file", files["enable.json"]]);
    refusalCodes.push(result.code);

    findingValue = { ...finding, attention: { state: "snoozed", revision: 3, snoozedUntil: null } };
    result = await run(["insights", "snooze", OPEN_SERVER, OPEN_BOX, FINDING, "--file", files["snooze.json"]]);
    refusalCodes.push(result.code);

    policyValue = { ...managerWire.appliedPolicy, revision: policy.expectedRevision + 2, mode: "off" };
    result = await run(["insights", "manager", "settings", MANAGER_SERVER, MANAGER_BOX, "--file", files["policy.json"]]);
    refusalCodes.push(result.code);

    recheckReceipt = structuredClone(managerWire.manualReservation);
    recheckReceipt.source.registeredSourceId = "source_crossreceipt0001";
    result = await run(["insights", "manager", "recheck", MANAGER_SERVER, MANAGER_BOX, FINDING, "--file", files["recheck.json"]]);
    refusalCodes.push(result.code);

    takeoverLookupReceipt = structuredClone(managerWire.takeoverReady);
    takeoverLookupReceipt.target.memberId = "tmem_crossreceipt0001";
    result = await run(["insights", "takeover", MANAGER_SERVER, MANAGER_BOX, FINDING, "--file", files["takeover.json"]]);
    refusalCodes.push(result.code);
    takeoverLookupReceipt = managerWire.takeoverReady;

    resumeReceipt = { ...managerWire.resumeAwaiting, predecessorOperationId: "takeover_foreignpredecessor0001" };
    result = await run(["insights", "takeover", "resume", MANAGER_SERVER, MANAGER_BOX, FINDING, "--operation", takeover.operationId, "--file", files["resume.json"]]);
    refusalCodes.push(result.code);
    assert.equal(service.requests.filter(({ method }) => ["POST", "PATCH"].includes(method)).length, mutationsBeforeRefusals,
      "receipt refusal recovery must remain GET-only");
    assert.deepEqual(refusalCodes, [3, 3, 3, 3, 3, 3, 3],
      "mutable or cross-authority receipts must never prove the saved intents");

    const beforeInvalid = service.requests.length;
    result = await run(["insights", "acknowledge", OPEN_SERVER, OPEN_BOX, FINDING, "--file", files["wrong-action.json"]]);
    assert.equal(result.code, 2, result.stderr);
    result = await run(["insights", "enable", OPEN_SERVER, OPEN_BOX, "--file", join(directory, "too-large.json")]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(service.requests.length, beforeInvalid, "invalid mutation files must fail before network");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /owner-insights-private-token|private upstream detail/);
  } finally {
    await service.close();
  }
});

test("packaged manager wire fixture is copied unchanged", async () => {
  const bytes = await readFile(new URL("fixtures/agent-manager-control-v1.backend-wire.fixture.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "facb56c61ae0fe00aa92a6979306ef9f862532ac702436aedb6741b8191fc018");
});
