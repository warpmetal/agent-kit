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
  envelope.handoff.task = null;
  envelope.handoff.work = null;
  return envelope;
}

test("Insights CLI reads only scoped sanitized metadata and exact existing sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-insights-read-"));
  const stateDirectory = await fixtureState(directory);
  const takeover = structuredClone(managerWire.takeoverReady);
  Object.assign(takeover.target, {
    workId: "work_insightstakeover0001", workRevision: 2,
    bindingId: "binding_insightstakeover0001", bindingRevision: 1,
  });
  const scopedFinding = {
    ...finding, registeredSourceId: takeover.source.registeredSourceId,
    workspaceEpoch: takeover.source.workspaceEpoch, nativeSessionId: takeover.source.nativeSessionId,
    serviceGeneration: takeover.source.serviceGeneration,
  };
  const exactHandoff = exactTakeoverHandoff(takeover);
  const currentTarget = {
    ...structuredClone(managerWire.managerTarget), findingRevision: scopedFinding.revision,
    source: structuredClone(takeover.source), target: structuredClone(takeover.target),
  };
  const superseded = { ...takeover, state: "superseded" };
  let currentManagerRun = structuredClone(managerWire.automaticReportResponse);
  let activityValue = managerWire.activityList;
  let managerPolicyValue = managerWire.appliedPolicy;
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
        `?limit=1&state=open&session=${scopedFinding.nativeSessionId}&severity=warning&attention=unacknowledged&rule=${encodeURIComponent(finding.ruleId)}&recentHours=24`,
      );
      return response(200, { settings, findings: [scopedFinding], nextCursor: null });
    }
    if (path.endsWith("/finding_expanded0001")) {
      return response(200, { finding: { ...finding, findingId: "finding_expanded0001", privatePrompt: "DO-NOT-PRINT-private-prompt" } });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/${FINDING}`) {
      return response(200, { finding: scopedFinding });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/${FINDING}/handoff`) {
      return response(200, exactHandoff);
    }
    if (path.endsWith("/takeovers/takeover_managertest0001")) {
      return response(200, takeover);
    }
    if (path.endsWith(`/${FINDING}/takeovers`)) {
      assert.equal(query, "?limit=100");
      return response(200, { takeovers: [takeover], nextCursor: null });
    }
    if (path.endsWith("/takeovers/takeover_superseded0001")) {
      return response(200, { ...superseded, operationId: "takeover_superseded0001" });
    }
    if (path === `/servers/${OPEN_SERVER}/sandboxes/${OPEN_BOX}/insights/manager/settings`) {
      return response(200, {
        ...managerWire.appliedPolicy,
        sandboxId: OPEN_BOX,
        revision: takeover.monitorPolicy.desiredRevision,
        mode: "off",
        appliedRevision: takeover.monitorPolicy.appliedRevision,
        status: "applied",
        authorizationExpiresAt: null,
      });
    }
    if (path === `/servers/${MANAGER_SERVER}/sandboxes/${MANAGER_BOX}/insights/manager/settings`) {
      return response(200, managerPolicyValue);
    }
    if (path === `/servers/${MANAGER_SERVER}/sandboxes/${MANAGER_BOX}/insights/manager/activity`) {
      assert.equal(query, `?limit=2&findingId=${FINDING}`);
      return response(200, activityValue);
    }
    if (path.endsWith(`/manager/activity/${managerWire.automaticReportResponse.runId}`)) {
      return response(200, currentManagerRun);
    }
    if (path.endsWith(`/manager/activity/${managerWire.automaticReportResponse.runId}/session-handoff`)) {
      return response(200, managerWire.managerSessionHandoff);
    }
    if (path.endsWith(`/${FINDING}/manager-target`)) {
      return response(200, path.includes(`/sandboxes/${OPEN_BOX}/`) ? currentTarget : managerWire.managerTarget);
    }
    return response(404, { error: { code: "not_found", message: "private upstream detail" } });
  });
  const run = runner(service.baseUrl, stateDirectory);
  try {
    const commands = [
      [0, "insights", "summary", OPEN_SERVER, "--limit", "1", "--cursor", "sbx_cursor0001"],
      [0, "insights", "status", OPEN_SERVER, OPEN_BOX],
      [0, "insights", "list", OPEN_SERVER, OPEN_BOX, "--limit", "1", "--state", "open", "--session", scopedFinding.nativeSessionId, "--severity", "warning", "--attention", "unacknowledged", "--rule", finding.ruleId, "--recent-hours", "24"],
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
    // The canonical terminal result must survive the ordinary CLI process and
    // strict owner-response decoder without becoming a recommendation/failure.
    currentManagerRun = {
      ...currentManagerRun, state: "no_action", rationaleCode: "no_safe_action",
    };
    const noAction = await run([
      "insights", "manager", "run", MANAGER_SERVER, MANAGER_BOX, currentManagerRun.runId,
    ]);
    assert.equal(noAction.code, 0, noAction.stderr);
    assert.deepEqual(JSON.parse(noAction.stdout), currentManagerRun);
    assert.equal(noAction.stderr, "");

    // 0.9.2: negotiated guidance metadata, awaited Off receipt, explicit auto capability.
    activityValue = managerWire.guidanceActivityList;
    let guidanceResult = await run(["insights", "manager", "activity", MANAGER_SERVER, MANAGER_BOX, "--limit", "2", "--finding", FINDING, "--json"]);
    assert.equal(guidanceResult.code, 0, guidanceResult.stderr);
    const guidanceRun = JSON.parse(guidanceResult.stdout).runs[0];
    assert.equal(guidanceRun.guidance.state, "available_to_worker");
    assert.deepEqual(Object.keys(guidanceRun.guidance).sort(), [
      "admittedAt", "availableAt", "bindingDigest", "formatVersion", "guardId", "guidanceDigest",
      "logCursor", "observedAt", "pendingInputId", "receiptDigest", "refusalCode", "reservationId",
      "revision", "runId", "sandboxId", "settledAt", "state",
    ]);
    assert.equal(guidanceRun.guidance.admittedAt, "2026-10-02T15:55:00.030Z");
    activityValue = managerWire.activityList;

    managerPolicyValue = managerWire.awaitingGuidancePolicy;
    const awaitedResult = await run(["insights", "manager", "settings", MANAGER_SERVER, MANAGER_BOX, "--json"]);
    assert.equal(awaitedResult.code, 5, awaitedResult.stderr);
    const awaitedOff = JSON.parse(awaitedResult.stdout);
    assert.equal(awaitedOff.status, "awaiting_guidance");
    assert.equal(awaitedOff.appliedRevision, null);
    assert.equal(awaitedOff.autoSteerPolicy.available, true);
    assert.equal(awaitedOff.autoSteerPolicy.reason, null);
    assert.equal(awaitedOff.autoSteerPolicy.qualifiedTuple.customNativeVersion, "2.0.14-wm.1");
    managerPolicyValue = managerWire.appliedPolicy;
    const beforeSuperseded = service.requests.length;
    let result = await run(["insights", "open", OPEN_SERVER, OPEN_BOX, FINDING, "--takeover", "takeover_superseded0001"]);
    assert.equal(result.code, 5, result.stderr);
    assert.equal(service.requests.length, beforeSuperseded + 1, "superseded pause must fail before handoff lookup");
    const beforeStaleTarget = service.requests.length;
    currentTarget.target.workRevision += 1;
    currentTarget.target.bindingRevision += 1;
    result = await run(["insights", "open", OPEN_SERVER, OPEN_BOX, FINDING, "--takeover", takeover.operationId]);
    assert.equal(result.code, 5, result.stderr);
    assert.match(result.stderr, /manager_takeover_stale/);
    assert.ok(service.requests.slice(beforeStaleTarget).some(row => row.path.endsWith("/manager-target")),
      "current Work authority must be checked through the manager-target HTTP boundary");
    assert.ok(service.requests.slice(beforeStaleTarget).every(row => !row.path.endsWith("/handoff")),
      "stale current Work/binding authority must fail before session lookup or launch");
    currentTarget.target = structuredClone(takeover.target);
    exactHandoff.handoff.source.nativeSessionId = "ses_changedtakeover0001";
    result = await run(["insights", "open", OPEN_SERVER, OPEN_BOX, FINDING, "--takeover", takeover.operationId]);
    assert.equal(result.code, 5, result.stderr);
    assert.match(result.stderr, /manager_takeover_stale/);
    exactHandoff.handoff.source.nativeSessionId = takeover.source.nativeSessionId;
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
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "56c171b125a7d4d5e27f90aba66e9f5d966cd723b2c08aa60e00c5fc08f00383");
});


test("qualified AutoResume journeys accept auto_steer and refuse unknown or malformed receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-insights-autoresume-"));
  const stateDirectory = await fixtureState(directory);
  const predecessorId = "takeover_autoresume0001";
  const predecessorBase = structuredClone(managerWire.takeoverReady);
  predecessorBase.operationId = predecessorId;
  let scenario = {
    mode: "auto_steer",
    resumeOperationId: "resume_autoresume0001",
    requestId: "req_autoresume0001",
    predecessor: predecessorBase,
    malformed: false,
    unqualified: false,
  };
  const qualifiedBody = () => {
    const predecessor = scenario.predecessor;
    return {
      ...managerContract.resumeRequest,
      resumeOperationId: scenario.resumeOperationId,
      requestId: scenario.requestId,
      expectedTakeoverRevision: predecessor.revision,
      expectedPolicyRevision: predecessor.monitorPolicy.desiredRevision,
      expectedHoldRevision: predecessor.memberHold.desiredRevision,
      restoreMode: scenario.mode,
      source: structuredClone(predecessor.source),
      target: structuredClone(predecessor.target),
    };
  };
  const qualifiedReceipt = () => {
    const body = qualifiedBody();
    const predecessor = scenario.predecessor;
    return {
      ...structuredClone(managerWire.resumeAwaiting),
      operationId: body.resumeOperationId,
      requestId: body.requestId,
      predecessorOperationId: predecessorId,
      action: "resume_manager_and_release_member",
      revision: 1,
      source: structuredClone(body.source),
      target: structuredClone(body.target),
      monitorPolicy: {
        ...managerWire.resumeAwaiting.monitorPolicy,
        desiredMode: scenario.malformed ? "recommend" : body.restoreMode,
        desiredRevision: body.expectedPolicyRevision + 1,
        appliedRevision: null,
      },
      memberHold: {
        ...managerWire.resumeAwaiting.memberHold,
        holdId: predecessor.memberHold.holdId,
        desiredState: "released",
        desiredRevision: body.expectedHoldRevision + 1,
        brokerApplied: true,
        nodeAppliedRevision: null,
      },
      state: "awaiting_runtime",
    };
  };
  await writeFile(join(directory, "resume.json"), JSON.stringify(qualifiedBody()));
  const service = await loopback(async ({ method, path, idempotencyKey, body }) => {
    if (path.endsWith(`/${FINDING}/takeovers/${predecessorId}`) && method === "GET") {
      return response(200, scenario.predecessor);
    }
    if (path.endsWith(`/${FINDING}/takeovers/${predecessorId}/resume`) && method === "POST") {
      assert.equal(idempotencyKey, scenario.requestId);
      assert.equal(body.restoreMode, scenario.mode);
      if (scenario.unqualified) {
        return response(409, { error: { code: "manager_capability_unavailable", message: "private backend detail" } });
      }
      return response(202, qualifiedReceipt());
    }
    if (path.endsWith(`/${FINDING}/takeovers/${scenario.resumeOperationId}`) && method === "GET") {
      return response(200, qualifiedReceipt());
    }
    return response(404, { error: { code: "not_found", message: "private upstream detail" } });
  });
  const run = runner(service.baseUrl, stateDirectory);
  try {
    const resume = () => run(["insights", "takeover", "resume", MANAGER_SERVER, MANAGER_BOX, FINDING,
      "--operation", predecessorId, "--file", join(directory, "resume.json")]);

    let result = await resume();
    assert.equal(result.code, 8, result.stderr);
    result = await resume();
    assert.equal(result.code, 8, result.stderr);
    const autoPosts = service.requests.filter(({ path, method }) => path.includes("/resume") && method === "POST");
    assert.equal(new Set(autoPosts.map(({ idempotencyKey }) => idempotencyKey)).size, 1,
      "AutoResume replay must reuse one idempotency key");
    assert.equal(autoPosts[0].body.restoreMode, "auto_steer");

    for (const mode of ["recommend", "off"]) {
      scenario = {
        ...scenario,
        mode,
        resumeOperationId: `resume_${mode}0001`,
        requestId: `req_${mode}0001`,
      };
      await writeFile(join(directory, "resume.json"), JSON.stringify(qualifiedBody()));
      const modeResult = await run(["insights", "takeover", "resume", MANAGER_SERVER, MANAGER_BOX, FINDING,
        "--operation", predecessorId, "--file", join(directory, "resume.json")]);
      assert.equal(modeResult.code, 8, modeResult.stderr);
    }

    scenario = { ...scenario, mode: "turbo", resumeOperationId: "resume_turbo0001", requestId: "req_turbo0001" };
    await writeFile(join(directory, "resume.json"), JSON.stringify(qualifiedBody()));
    const beforeInvalid = service.requests.length;
    result = await run(["insights", "takeover", "resume", MANAGER_SERVER, MANAGER_BOX, FINDING,
      "--operation", predecessorId, "--file", join(directory, "resume.json")]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(service.requests.length, beforeInvalid, "unknown mode must fail before network");

    scenario = { ...scenario, mode: "auto_steer", malformed: true, resumeOperationId: "resume_malformed0001", requestId: "req_malformed0001" };
    await writeFile(join(directory, "resume.json"), JSON.stringify(qualifiedBody()));
    result = await run(["insights", "takeover", "resume", MANAGER_SERVER, MANAGER_BOX, FINDING,
      "--operation", predecessorId, "--file", join(directory, "resume.json")]);
    assert.equal(result.code, 3, result.stderr);

    scenario = { ...scenario, malformed: false, unqualified: true, resumeOperationId: "resume_unqualified0001", requestId: "req_unqualified0001" };
    await writeFile(join(directory, "resume.json"), JSON.stringify(qualifiedBody()));
    result = await run(["insights", "takeover", "resume", MANAGER_SERVER, MANAGER_BOX, FINDING,
      "--operation", predecessorId, "--file", join(directory, "resume.json")]);
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}${result.stderr}`, /manager_capability_unavailable/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private backend detail|owner-insights-private-token/);
    const unqualifiedRequests = service.requests.filter(({ idempotencyKey }) => idempotencyKey === "req_unqualified0001");
    assert.equal(unqualifiedRequests.length, 1, "unqualified Auto must not be replayed or fall back");
    assert.equal(unqualifiedRequests[0].method, "POST");
    assert.equal(unqualifiedRequests[0].path, `/servers/${MANAGER_SERVER}/sandboxes/${MANAGER_BOX}/insights/${FINDING}/takeovers/${predecessorId}/resume`);
  } finally {
    await service.close();
  }
});
