import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = new URL("..", import.meta.url).pathname;
const fixtureDirectory = join(root, "test", "fixtures");
const fixture = async (name) =>
  JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));

const serverId = "srv_cliwork0001";
const sandboxId = "sbx_cliwork0001";
const workId = "work_cliwork0001";
const foreignWorkId = "work_foreign0001";
const redirectWorkId = "work_redirect0001";
const refusedWorkId = "work_refused0001";
const oversizedWorkId = "work_oversized0001";
const privateObjective = "private owner objective: do not print during metadata commands";
const privateContext = "private owner context: shown only by deliberate work content";

function workProjection(ownerFixture, revision = 1, continuityEnabled = true, title = ownerFixture.workProjection.title) {
  return {
    workId,
    projectId: "project_cliwork0001",
    sandboxId,
    workspaceEpoch: "epoch_cliwork0001",
    revision,
    lifecycle: "active",
    continuityEnabled,
    createdAt: "2026-09-27T12:00:00Z",
    updatedAt: "2026-09-27T12:01:00Z",
    binding: {
      bindingId: "binding_cliwork0001",
      registeredSourceId: "source_cliwork0001",
      serviceRegistrationId: "service_cliwork0001",
      nativeSessionId: "ses_cliwork0001",
      nativeProjectId: "0123456789abcdef0123456789abcdef01234567",
      nativeLocationDigest: `sha256:${"a".repeat(64)}`,
      state: "verified",
      bindingRevision: revision,
      sandboxGeneration: 1,
      availability: "available",
      reason: null,
      scopeRevision: revision + 1,
      serviceGeneration: 3,
    },
    content: {
      contentDigest: `sha256:${"b".repeat(64)}`,
      objectiveBytes: Buffer.byteLength(privateObjective),
      constraintsBytes: 14,
      contextBytes: Buffer.byteLength(privateContext),
    },
    taskLineage: { currentTaskId: null, previousTaskId: null },
    ...ownerFixture.workProjection,
    title,
  };
}

function checkpointResponse(continuityFixture, state = "accepted") {
  const manifest = continuityFixture.operationManifest;
  const report = continuityFixture.operationReport;
  return {
    operation: {
      operationId: manifest.operationId,
      requestId: "req_continuity_capture_0001",
      workId: manifest.identity.workId,
      action: manifest.action,
      state,
      expectedRevision: manifest.identity.expectedRevision,
      expectedBindingRevision: manifest.binding.bindingRevision,
      scopeRevision: manifest.scopeRevision,
      boundaryKind: manifest.boundaryKind,
      taskId: manifest.identity.taskId,
      taskAttempt: manifest.identity.taskAttempt,
      errorCode: null,
      createdAt: "2026-09-27T16:00:00Z",
      updatedAt: "2026-09-27T16:00:01Z",
      terminalAt: state === "accepted" ? "2026-09-27T16:00:01Z" : null,
      checkpoint:
        state === "accepted"
          ? {
              checkpointId: report.checkpointId,
              captureId: report.captureId,
              manifestDigest: report.manifestDigest,
              bytes: report.bytes,
              objectCount: report.objectCount,
            }
          : null,
    },
  };
}

function failedCheckpointResponse(continuityFixture) {
  const value = checkpointResponse(continuityFixture, "failed");
  value.operation.operationId = "op_continuity_failed_0001";
  value.operation.requestId = "req_continuity_failed_0001";
  value.operation.errorCode = "capture_failed";
  value.operation.terminalAt = "2026-09-27T16:00:01Z";
  return value;
}

test("packaged positional Work CLI preserves closed authority, private content, replay, status, and handoff", async () => {
  const [owner, continuity, continuation, handoffContract, handoff, sessionHandoff] =
    await Promise.all([
      fixture("agent-work-owner-v1.fixture.json"),
      fixture("agent-continuity-v1.fixture.json"),
      fixture("agent-continuation-v1.backend-wire.fixture.json"),
      fixture("agent-continuation-handoff-v1.fixture.json"),
      fixture("agent-continuation-handoff-v1.backend-wire.fixture.json"),
      fixture("agent-session-handoff-v1.backend-wire.fixture.json"),
    ]);
  const directory = await mkdtemp(join(tmpdir(), "warpmetal-work-e2e-"));
  const stateDirectory = join(directory, "state");
  await mkdir(stateDirectory, { recursive: true });
  const createBody = {
    version: 1,
    workId,
    requestId: "req_cliwork_create0001",
    projectId: "project_cliwork0001",
    workspaceEpoch: "epoch_cliwork0001",
    managedSession: {
      bindingId: "binding_cliwork0001",
      registeredSourceId: "source_cliwork0001",
      serviceRegistrationId: "service_cliwork0001",
      nativeSessionId: "ses_cliwork0001",
      nativeProjectId: "0123456789abcdef0123456789abcdef01234567",
      nativeLocationDigest: `sha256:${"a".repeat(64)}`,
    },
    title: "CLI retained work",
    continuityEnabled: true,
    content: {
      objective: privateObjective,
      constraints: "remain scoped",
      context: privateContext,
    },
  };
  const updateBody = {
    version: 1,
    requestId: "req_cliwork_update0001",
    expectedRevision: 1,
    title: "CLI retained work updated",
    continuityEnabled: true,
    content: {
      objective: `${privateObjective} updated`,
      constraints: "remain scoped",
      context: `${privateContext} updated`,
    },
  };
  const checkpointBody = {
    version: 1,
    operationId: continuity.operationManifest.operationId,
    requestId: "req_continuity_capture_0001",
    action: "capture_checkpoint",
    expectedRevision: continuity.operationManifest.identity.expectedRevision,
    expectedBindingRevision: continuity.operationManifest.binding.bindingRevision,
    scopeRevision: continuity.operationManifest.scopeRevision,
    boundaryKind: continuity.operationManifest.boundaryKind,
    taskId: continuity.operationManifest.identity.taskId,
    taskAttempt: continuity.operationManifest.identity.taskAttempt,
  };
  const handoffBody = {
    ...handoffContract.reviewerRequest,
    operationId: handoff.reviewerOwnerPending.operationId,
    requestId: handoff.reviewerOwnerPending.requestId,
    expectedRevision: handoff.reviewerOwnerPending.sourceRevision,
    expectedBindingRevision: 1,
    scopeRevision: 2,
    checkpointOperationId: handoff.reviewerOwnerPending.checkpointOperationId,
    targetMemberId: handoff.reviewerOwnerPending.targetMember.memberId,
  };
  const bodies = {
    create: createBody,
    update: updateBody,
    enable: { ...owner.optInRequest, expectedRevision: 2 },
    checkpoint: checkpointBody,
    continue: continuation.continuationRequest,
    restore: continuation.restoreRequest,
    handoff: handoffBody,
  };
  for (const [name, body] of Object.entries(bodies)) {
    await writeFile(join(directory, `${name}.json`), `${JSON.stringify(body)}\n`);
  }
  await writeFile(
    join(directory, "invalid-create.json"),
    `${JSON.stringify({ ...createBody, ownerToken: "private-request-field" })}\n`,
  );
  await writeFile(
    join(directory, "oversized-create.json"),
    `${JSON.stringify({ ...createBody, content: { ...createBody.content, context: "x".repeat(2 * 1024 * 1024) } })}\n`,
  );

  const requests = [];
  let loseCheckpointResponse = true;
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      body,
    });
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname;
    let status = 200;
    let result;
    if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work` && request.method === "GET") {
      result = { work: [workProjection(owner)], nextCursor: null };
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work` && request.method === "POST") {
      status = 201;
      result = { work: workProjection(owner, 1, true, createBody.title) };
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work/${foreignWorkId}` && request.method === "GET") {
      result = {
        work: {
          ...workProjection(owner),
          workId: foreignWorkId,
          sandboxId: "sbx_foreign0001",
          privateInternal: "backend-private-leak",
        },
      };
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work/${redirectWorkId}` && request.method === "GET") {
      response.writeHead(307, {
        location: `/servers/${serverId}/sandboxes/${sandboxId}/work/${workId}`,
      });
      response.end();
      return;
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work/${refusedWorkId}` && request.method === "GET") {
      status = 409;
      result = {
        error: {
          code: "work_conflict",
          message: "private backend refusal details must stay hidden",
        },
      };
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work/${oversizedWorkId}` && request.method === "GET") {
      result = { oversized: "x".repeat(2 * 1024 * 1024) };
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work/${workId}` && request.method === "GET") {
      result = { work: workProjection(owner, 3, true) };
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work/${workId}` && request.method === "PATCH") {
      result = { work: workProjection(owner, 2, true, updateBody.title) };
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work/${workId}/continuity`) {
      result = { work: workProjection(owner, 3, true) };
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work/${workId}/content`) {
      result = {
        workId,
        revision: 1,
        content: {
          objective: privateObjective,
          constraints: "remain scoped",
          context: privateContext,
          contentDigest: `sha256:${"b".repeat(64)}`,
        },
      };
    } else if (path === `/servers/${serverId}/sandboxes/${sandboxId}/work-policy`) {
      result = owner.policyResponse;
    } else if (path === `/servers/${serverId}/sandboxes/${continuity.sourceReport.sandboxId}/work-sources`) {
      result = { sources: [continuity.sourceReport], nextCursor: null };
    } else if (path.endsWith(`/${continuity.operationManifest.identity.workId}/operations`) && request.method === "POST") {
      if (loseCheckpointResponse) {
        loseCheckpointResponse = false;
        request.socket.destroy();
        return;
      }
      throw new Error("checkpoint mutation was replayed instead of reconciled");
    } else if (path.endsWith(`/${continuity.operationManifest.identity.workId}/operations`) && request.method === "GET") {
      result = checkpointResponse(continuity);
    } else if (path.endsWith(`/${continuity.operationManifest.identity.workId}/operations/op_continuity_failed_0001`)) {
      result = failedCheckpointResponse(continuity);
    } else if (path.endsWith(`/${continuation.continuationOwnerResponse.operation.workId}/continuations`) && request.method === "POST") {
      result = continuation.continuationOwnerResponse;
    } else if (path.endsWith(`/${continuation.continuationOwnerResponse.operation.workId}/continuations`) && request.method === "GET") {
      result = continuation.continuationOwnerResponse;
    } else if (path.endsWith(`/${continuation.continuationOwnerResponse.operation.workId}/continuations/${continuation.continuationOwnerResponse.operation.operationId}`)) {
      result = continuation.continuationOwnerResponse;
    } else if (path.endsWith(`/${continuation.restoreOwnerResponse.operation.workId}/restores`) && request.method === "POST") {
      result = continuation.restoreOwnerResponse;
    } else if (path.endsWith(`/${handoff.reviewerOwnerPending.sourceWorkId}/handoffs`) && request.method === "POST") {
      status = 202;
      result = { operation: handoff.reviewerOwnerPending };
    } else if (path.endsWith(`/${handoff.reviewerOwnerPending.sourceWorkId}/handoffs/${handoff.reviewerOwnerPending.operationId}`)) {
      result = { operation: handoff.reviewerOwnerAccepted };
    } else if (path.endsWith(`/${handoff.reviewerOwnerPending.sourceWorkId}/handoff-targets`)) {
      result = handoffContract.handoffTargets;
    } else if (path === `/servers/${sessionHandoff.work.handoff.identity.serverId}/sandboxes/${sessionHandoff.work.handoff.identity.sandboxId}/work/${sessionHandoff.work.handoff.work.workId}/session-handoff`) {
      result = sessionHandoff.work;
    } else {
      status = 404;
      result = { error: { code: "not_found", message: `No fixture for ${request.method} ${request.url}` } };
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function run(args, { json = true } = {}) {
    const complete = [
      "bin/warpmetal.js",
      ...args,
      "--base-url",
      baseUrl,
      "--state-dir",
      stateDirectory,
      ...(json ? ["--json"] : []),
    ];
    try {
      return {
        code: 0,
        ...(await execFile(process.execPath, complete, {
          cwd: root,
          env: { ...process.env, WARPMETAL_OWNER_TOKEN: "owner-cli-work-secret" },
          timeout: 20_000,
        })),
      };
    } catch (error) {
      return {
        code: error.code,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }
  }
  const expectSuccess = async (args, options) => {
    const result = await run(args, options);
    assert.equal(result.code, 0, `${args.join(" ")}\n${result.stderr}`);
    return result;
  };

  try {
    let before = requests.length;
    let result = await run(["work", "list", serverId, sandboxId, "unexpected"]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(requests.length, before, "extra positional argument reached the network");
    before = requests.length;
    result = await run(["work", "create", serverId, sandboxId, "--file", join(directory, "invalid-create.json")]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(requests.length, before, "unknown request field reached the network");
    assert.ok(!`${result.stdout}${result.stderr}`.includes("private-request-field"));
    before = requests.length;
    result = await run(["work", "create", serverId, sandboxId, "--file", join(directory, "oversized-create.json")]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(requests.length, before, "oversized input reached the network");
    result = await run(["work", "show", serverId, sandboxId, foreignWorkId]);
    assert.equal(result.code, 3, result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("backend-private-leak"));
    result = await run(["work", "show", serverId, sandboxId, redirectWorkId]);
    assert.equal(result.code, 3, result.stderr);
    assert.equal(
      requests.filter((entry) => entry.path.endsWith(`/work/${workId}`)).length,
      0,
      "management response redirect was followed",
    );
    result = await run(["work", "show", serverId, sandboxId, refusedWorkId]);
    assert.equal(result.code, 5, result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("private backend refusal details"));
    result = await run(["work", "show", serverId, sandboxId, oversizedWorkId]);
    assert.equal(result.code, 3, result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("xxxxxxxx"));

    const metadataResults = [];
    metadataResults.push(await expectSuccess(["work", "list", serverId, sandboxId]));
    metadataResults.push(await expectSuccess(["work", "show", serverId, sandboxId, workId]));
    const content = await expectSuccess(["work", "content", serverId, sandboxId, workId, "--revision", "1"]);
    assert.match(content.stdout, /private owner context/);
    metadataResults.push(await expectSuccess(["work", "policy", serverId, sandboxId]));
    metadataResults.push(await expectSuccess(["work", "sources", serverId, continuity.sourceReport.sandboxId]));
    metadataResults.push(await expectSuccess(["work", "create", serverId, sandboxId, "--file", join(directory, "create.json")]));
    metadataResults.push(await expectSuccess(["work", "update", serverId, sandboxId, workId, "--file", join(directory, "update.json")]));
    metadataResults.push(await expectSuccess(["work", "enable", serverId, sandboxId, workId, "--file", join(directory, "enable.json")]));
    for (const result of metadataResults) {
      assert.ok(!result.stdout.includes(privateObjective));
      assert.ok(!result.stdout.includes(privateContext));
      assert.ok(!result.stdout.includes("owner-cli-work-secret"));
    }

    result = await run(["work", "checkpoint", serverId, continuity.operationManifest.identity.sandboxId, continuity.operationManifest.identity.workId, "--file", join(directory, "checkpoint.json")]);
    assert.equal(result.code, 3, result.stderr);
    result = await expectSuccess(["work", "checkpoint", serverId, continuity.operationManifest.identity.sandboxId, continuity.operationManifest.identity.workId, "--file", join(directory, "checkpoint.json")], { json: false });
    assert.match(result.stdout, /checkpoint saved/i);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path.includes("/operations")).length, 1, "lost checkpoint response must reconcile by GET only");

    result = await expectSuccess(["work", "continue", serverId, sandboxId, continuation.continuationOwnerResponse.operation.workId, "--file", join(directory, "continue.json"), "--idempotency-key", "cli-work-explicit-key"], { json: false });
    assert.match(result.stdout, /continuation admitted; task outcome pending/i);
    result = await expectSuccess(["work", "restore", serverId, sandboxId, continuation.restoreOwnerResponse.operation.workId, "--file", join(directory, "restore.json")], { json: false });
    assert.match(result.stdout, /workspace restored/i);
    result = await run(["work", "handoff", serverId, sandboxId, handoff.reviewerOwnerPending.sourceWorkId, "--file", join(directory, "handoff.json")], { json: false });
    assert.equal(result.code, 8, result.stderr);
    assert.match(result.stdout, /pending/i);
    result = await expectSuccess(["work", "targets", serverId, sandboxId, handoff.reviewerOwnerPending.sourceWorkId]);
    assert.equal(JSON.parse(result.stdout).targets.length, 1);
    result = await expectSuccess(["work", "status", serverId, sandboxId, handoff.reviewerOwnerPending.sourceWorkId, "--kind", "handoff", "--operation", handoff.reviewerOwnerPending.operationId], { json: false });
    assert.match(result.stdout, /handoff admitted; task outcome pending/i);
    result = await expectSuccess(["work", "status", serverId, sandboxId, continuation.continuationOwnerResponse.operation.workId, "--kind", "continue", "--request", continuation.continuationOwnerResponse.operation.requestId]);
    assert.equal(JSON.parse(result.stdout).operation.state, "accepted");
    result = await run(["work", "status", serverId, continuity.operationManifest.identity.sandboxId, continuity.operationManifest.identity.workId, "--kind", "checkpoint", "--operation", "op_continuity_failed_0001"]);
    assert.equal(result.code, 5, result.stderr);

    result = await expectSuccess(["work", "open", sessionHandoff.work.handoff.identity.serverId, sessionHandoff.work.handoff.identity.sandboxId, sessionHandoff.work.handoff.work.workId]);
    assert.deepEqual(JSON.parse(result.stdout), sessionHandoff.work);
    assert.ok(requests.every((entry) => entry.authorization === "Bearer owner-cli-work-secret"));
    assert.equal(requests.find((entry) => entry.body?.requestId === continuation.continuationRequest.requestId)?.idempotencyKey, "cli-work-explicit-key");
    for (const entry of requests.filter((request) => request.method !== "GET")) {
      assert.equal(entry.idempotencyKey, entry.body.requestId === continuation.continuationRequest.requestId ? "cli-work-explicit-key" : entry.body.requestId);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});
