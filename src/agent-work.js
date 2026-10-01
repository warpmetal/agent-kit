import {
  booleanOption,
  integerOption,
  rejectUnknownOptions,
  stringOption,
} from "./args.js";
import {
  projectWork,
  projectWorkContent,
  projectWorkList,
  projectWorkOperation,
  projectWorkPolicy,
  projectWorkSources,
  projectWorkStateOperation,
  WORK_BOX_ID,
  WORK_ID,
  WORK_OPERATION_ID,
  WORK_REQUEST_ID,
  workContentQuery,
  workContinuityBody,
  workListQuery,
  workMutationBody,
  workOperationBody,
  workStateBody,
} from "./contracts/work.js";
import {
  projectWorkHandoff,
  projectWorkHandoffTargets,
  workHandoffBody,
} from "./contracts/work-handoff.js";
import { projectSessionHandoff } from "./contracts/session-handoff.js";
import { CliError } from "./errors.js";

const COMMON_OPTIONS = [
  "base-url",
  "state-dir",
  "token-file",
  "json",
  "help",
];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,160}$/;
const OPERATION_KINDS = new Set([
  "checkpoint",
  "continue",
  "restore",
  "handoff",
]);

function invalid(message) {
  throw new CliError(message, { exitCode: 2 });
}

function invalidResponse(label = "Work") {
  throw new CliError(`WarpMetal returned invalid ${label} data.`, {
    exitCode: 3,
  });
}

function exactPositionals(positionals, action, count) {
  if (positionals.length !== count + 1 || positionals[0] !== action) {
    invalid(`work ${action} received invalid positional arguments.`);
  }
  return positionals.slice(1);
}

function validateScope(serverId, sandboxId, workId) {
  if (!SAFE_ID.test(serverId) || !WORK_BOX_ID.test(sandboxId)) {
    invalid("Work requires valid SERVER and BOX identifiers.");
  }
  if (workId !== undefined && !WORK_ID.test(workId)) {
    invalid("Work requires a valid WORK identifier.");
  }
}

function fixedPath(serverId, sandboxId, suffix) {
  return `/servers/${encodeURIComponent(serverId)}/sandboxes/${encodeURIComponent(sandboxId)}${suffix}`;
}

function workPath(serverId, sandboxId, workId, suffix = "") {
  return fixedPath(
    serverId,
    sandboxId,
    `/work/${encodeURIComponent(workId)}${suffix}`,
  );
}

function checkedIdempotencyKey(options, body) {
  const key = stringOption(options, "idempotency-key") || body.requestId;
  if (!IDEMPOTENCY_KEY.test(key)) {
    invalid("--idempotency-key must be 8 to 160 safe characters.");
  }
  return key;
}

function checkedRequestId(value, label) {
  if (!WORK_REQUEST_ID.test(value || "")) {
    invalid(`${label} requires a valid request ID.`);
  }
  return value;
}

function checkedOperationId(value, label) {
  if (!WORK_OPERATION_ID.test(value || "")) {
    invalid(`${label} requires a valid operation ID.`);
  }
  return value;
}

function projected(result, project, label) {
  const data = project(result?.data);
  if (!data) invalidResponse(label);
  return { ...result, data };
}

function workHuman(value) {
  const work = value.work;
  return `${work.workId}: ${work.title ?? work.lifecycle} (revision ${work.revision}, ${work.lifecycle})`;
}

function operationHuman(kind, state) {
  if (state === "accepted") {
    if (kind === "checkpoint") return "Checkpoint saved.";
    if (kind === "restore") return "Workspace restored.";
    if (kind === "continue")
      return "Continuation admitted; task outcome pending.";
    return "Handoff admitted; task outcome pending.";
  }
  return `${kind} operation: ${state}`;
}

function emitOperation(services, kind, result) {
  const state = result.data.operation.state;
  services.emit(
    services.context.stdout,
    result.data,
    services.context.json,
    operationHuman(kind, state),
  );
  if (result.status === 202 || ["pending", "reported", "outcome_unknown"].includes(state)) {
    return 8;
  }
  if (["failed", "superseded"].includes(state)) return 5;
  if (state !== "accepted") invalidResponse(`${kind} operation`);
  return 0;
}

function workResult(result, sandboxId, workId) {
  return projected(
    result,
    (value) => {
      const work = value?.work;
      const projectedWork = projectWork(work, sandboxId, workId);
      return projectedWork ? { work: projectedWork } : null;
    },
    "Work",
  );
}

function exactWorkMutationResult(result, sandboxId, workId, body, create) {
  const checked = workResult(result, sandboxId, workId);
  const work = checked.data.work;
  const expectedRevision = create ? 1 : body.expectedRevision + 1;
  if (
    work.revision !== expectedRevision ||
    work.continuityEnabled !== body.continuityEnabled ||
    (body.title !== undefined && work.title !== body.title) ||
    (create &&
      (work.projectId !== body.projectId ||
        work.workspaceEpoch !== body.workspaceEpoch ||
        work.binding.bindingId !== body.managedSession.bindingId ||
        work.binding.registeredSourceId !==
          body.managedSession.registeredSourceId ||
        work.binding.serviceRegistrationId !==
          body.managedSession.serviceRegistrationId ||
        work.binding.nativeSessionId !== body.managedSession.nativeSessionId ||
        work.binding.nativeProjectId !== body.managedSession.nativeProjectId ||
        work.binding.nativeLocationDigest !==
          body.managedSession.nativeLocationDigest))
  ) {
    invalidResponse("Work mutation receipt");
  }
  return checked;
}

async function exactContent(
  services,
  token,
  serverId,
  sandboxId,
  workId,
  revision,
  expected,
) {
  const path = `${workPath(serverId, sandboxId, workId, "/content")}?revision=${revision}`;
  const result = projected(
    await services.client.request("GET", path, { token }),
    (value) => projectWorkContent(value, workId, String(revision)),
    "Work content",
  );
  const content = result.data.content;
  if (
    content.objective !== expected.objective ||
    content.constraints !== expected.constraints ||
    content.context !== expected.context
  ) {
    invalidResponse("Work mutation reconciliation");
  }
}

async function readWorkMutationBody(services, options, create) {
  const file = stringOption(options, "file", { required: true });
  const input = await services.readInput(file, 2 * 1024 * 1024);
  const body = workMutationBody(input, create);
  if (!body) invalid("The Work request file is invalid.");
  return body;
}

async function handleList(positionals, options, services) {
  rejectUnknownOptions(options, [...COMMON_OPTIONS, "cursor", "limit"]);
  const [serverId, sandboxId] = exactPositionals(positionals, "list", 2);
  validateScope(serverId, sandboxId);
  const params = new URLSearchParams();
  const cursor = stringOption(options, "cursor");
  const limit = integerOption(options, "limit", undefined);
  if (cursor !== undefined) params.set("cursor", cursor);
  if (limit !== undefined) params.set("limit", String(limit));
  const query = workListQuery(params);
  if (query === null) invalid("The Work list query is invalid.");
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const result = projected(
    await services.client.request(
      "GET",
      `${fixedPath(serverId, sandboxId, "/work")}${query}`,
      { token },
    ),
    (value) => projectWorkList(value, sandboxId),
    "Work list",
  );
  services.emit(
    services.context.stdout,
    result.data,
    services.context.json,
    result.data.work.map((work) => workHuman({ work })).join("\n") ||
      "No retained Work.",
  );
  return 0;
}

async function handleShow(positionals, options, services) {
  rejectUnknownOptions(options, COMMON_OPTIONS);
  const [serverId, sandboxId, workId] = exactPositionals(
    positionals,
    "show",
    3,
  );
  validateScope(serverId, sandboxId, workId);
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const result = workResult(
    await services.client.request("GET", workPath(serverId, sandboxId, workId), {
      token,
    }),
    sandboxId,
    workId,
  );
  services.emit(
    services.context.stdout,
    result.data,
    services.context.json,
    workHuman(result.data),
  );
  return 0;
}

async function handleContent(positionals, options, services) {
  rejectUnknownOptions(options, [...COMMON_OPTIONS, "revision"]);
  const [serverId, sandboxId, workId] = exactPositionals(
    positionals,
    "content",
    3,
  );
  validateScope(serverId, sandboxId, workId);
  const revision = integerOption(options, "revision", undefined);
  const params = new URLSearchParams();
  if (revision !== undefined) params.set("revision", String(revision));
  const query = workContentQuery(params);
  if (query === null) invalid("The Work content revision is invalid.");
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const result = projected(
    await services.client.request(
      "GET",
      `${workPath(serverId, sandboxId, workId, "/content")}${query}`,
      { token },
    ),
    (value) =>
      projectWorkContent(
        value,
        workId,
        revision === undefined ? null : String(revision),
      ),
    "Work content",
  );
  services.emit(
    services.context.stdout,
    result.data,
    services.context.json,
    [
      `Objective:\n${result.data.content.objective}`,
      `Constraints:\n${result.data.content.constraints}`,
      `Context:\n${result.data.content.context}`,
    ].join("\n\n"),
  );
  return 0;
}

async function handleSources(positionals, options, services) {
  rejectUnknownOptions(options, [...COMMON_OPTIONS, "cursor", "limit"]);
  const [serverId, sandboxId] = exactPositionals(positionals, "sources", 2);
  validateScope(serverId, sandboxId);
  const params = new URLSearchParams();
  const cursor = stringOption(options, "cursor");
  const limit = integerOption(options, "limit", undefined);
  if (cursor !== undefined) params.set("cursor", cursor);
  if (limit !== undefined) params.set("limit", String(limit));
  const query = workListQuery(params);
  if (query === null) invalid("The Work source query is invalid.");
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const result = projected(
    await services.client.request(
      "GET",
      `${fixedPath(serverId, sandboxId, "/work-sources")}${query}`,
      { token },
    ),
    (value) => projectWorkSources(value, sandboxId),
    "Work source",
  );
  services.emit(
    services.context.stdout,
    result.data,
    services.context.json,
    result.data.sources
      .map(
        (source) =>
          `${source.registeredSourceId}: ${source.role} (${source.availability})`,
      )
      .join("\n") || "No managed Work sources.",
  );
  return 0;
}

async function handlePolicy(positionals, options, services) {
  rejectUnknownOptions(options, COMMON_OPTIONS);
  const [serverId, sandboxId] = exactPositionals(positionals, "policy", 2);
  validateScope(serverId, sandboxId);
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const result = projected(
    await services.client.request(
      "GET",
      fixedPath(serverId, sandboxId, "/work-policy"),
      { token },
    ),
    projectWorkPolicy,
    "Work policy",
  );
  services.emit(
    services.context.stdout,
    result.data,
    services.context.json,
    `Continuity: ${result.data.continuityOptIn.state}\nCheckpoint limit: ${result.data.storagePolicy.maxCheckpointsPerBox} per box`,
  );
  return 0;
}

async function handleWorkMutation(positionals, options, services, create) {
  const action = create ? "create" : "update";
  rejectUnknownOptions(options, [
    ...COMMON_OPTIONS,
    "file",
    "idempotency-key",
  ]);
  const values = exactPositionals(positionals, action, create ? 2 : 3);
  const [serverId, sandboxId, positionalWorkId] = values;
  validateScope(serverId, sandboxId, positionalWorkId);
  const body = await readWorkMutationBody(services, options, create);
  const workId = create ? body.workId : positionalWorkId;
  if (!create && workId !== positionalWorkId) invalid("Work identity changed.");
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const path = create
    ? fixedPath(serverId, sandboxId, "/work")
    : workPath(serverId, sandboxId, workId);
  const result = await services.runMutation({
    serverId,
    sandboxId,
    kind: `work-${action}`,
    path,
    requestId: body.requestId,
    body,
    submit: async () =>
      exactWorkMutationResult(
        await services.client.request(create ? "POST" : "PATCH", path, {
          token,
          body,
          idempotencyKey: checkedIdempotencyKey(options, body),
        }),
        sandboxId,
        workId,
        body,
        create,
      ),
    reconcile: async () => {
      const expectedRevision = create ? 1 : body.expectedRevision + 1;
      const detail = exactWorkMutationResult(
        await services.client.request(
          "GET",
          workPath(serverId, sandboxId, workId),
          { token },
        ),
        sandboxId,
        workId,
        body,
        create,
      );
      await exactContent(
        services,
        token,
        serverId,
        sandboxId,
        workId,
        expectedRevision,
        body.content,
      );
      return detail;
    },
  });
  services.emit(
    services.context.stdout,
    result.data,
    services.context.json,
    `${create ? "Created" : "Updated"} ${workHuman(result.data)}`,
  );
  return 0;
}

async function handleEnable(positionals, options, services) {
  rejectUnknownOptions(options, [
    ...COMMON_OPTIONS,
    "file",
    "idempotency-key",
  ]);
  const [serverId, sandboxId, workId] = exactPositionals(
    positionals,
    "enable",
    3,
  );
  validateScope(serverId, sandboxId, workId);
  const file = stringOption(options, "file", { required: true });
  const body = workContinuityBody(await services.readInput(file, 64 * 1024));
  if (!body) invalid("The Work continuity request file is invalid.");
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const path = workPath(serverId, sandboxId, workId, "/continuity");
  const verify = (result) => {
    const checked = workResult(result, sandboxId, workId);
    if (
      checked.data.work.revision !== body.expectedRevision + 1 ||
      checked.data.work.continuityEnabled !== body.continuityEnabled
    ) {
      invalidResponse("Work continuity receipt");
    }
    return checked;
  };
  const result = await services.runMutation({
    serverId,
    sandboxId,
    kind: "work-enable",
    path,
    requestId: body.requestId,
    body,
    submit: async () =>
      verify(
        await services.client.request("PATCH", path, {
          token,
          body,
          idempotencyKey: checkedIdempotencyKey(options, body),
        }),
      ),
    reconcile: async () =>
      verify(
        await services.client.request(
          "GET",
          workPath(serverId, sandboxId, workId),
          { token },
        ),
      ),
  });
  services.emit(
    services.context.stdout,
    result.data,
    services.context.json,
    `Continuity ${body.continuityEnabled ? "enabled" : "disabled"} for ${workId}.`,
  );
  return 0;
}

function operationRoute(kind) {
  if (kind === "checkpoint") return "operations";
  if (kind === "continue") return "continuations";
  if (kind === "restore") return "restores";
  return "handoffs";
}

function operationProjector(kind, workId, operationId, requestId) {
  if (kind === "checkpoint") {
    return (value) =>
      projectWorkOperation(value, workId, operationId, requestId);
  }
  if (kind === "handoff") {
    return (value) => projectWorkHandoff(value, workId, operationId, requestId);
  }
  return (value) =>
    projectWorkStateOperation(
      value,
      workId,
      kind,
      operationId,
      requestId,
    );
}

async function handleOperationMutation(
  positionals,
  options,
  services,
  kind,
) {
  rejectUnknownOptions(options, [
    ...COMMON_OPTIONS,
    "file",
    "idempotency-key",
  ]);
  const [serverId, sandboxId, workId] = exactPositionals(
    positionals,
    kind,
    3,
  );
  validateScope(serverId, sandboxId, workId);
  const file = stringOption(options, "file", { required: true });
  const input = await services.readInput(file, 64 * 1024);
  const body =
    kind === "checkpoint"
      ? workOperationBody(input)
      : kind === "handoff"
        ? workHandoffBody(input)
        : workStateBody(input, kind);
  if (!body) invalid(`The Work ${kind} request file is invalid.`);
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const route = operationRoute(kind);
  const path = workPath(serverId, sandboxId, workId, `/${route}`);
  const project = operationProjector(
    kind,
    workId,
    body.operationId,
    body.requestId,
  );
  const result = await services.runMutation({
    serverId,
    sandboxId,
    kind: `work-${kind}`,
    path,
    requestId: body.requestId,
    body,
    submit: async () =>
      projected(
        await services.client.request("POST", path, {
          token,
          body,
          idempotencyKey: checkedIdempotencyKey(options, body),
        }),
        project,
        `Work ${kind} receipt`,
      ),
    reconcile: async () => {
      const query = new URLSearchParams({ requestId: body.requestId });
      return projected(
        await services.client.request("GET", `${path}?${query}`, { token }),
        project,
        `Work ${kind} receipt`,
      );
    },
  });
  return emitOperation(services, kind, result);
}

async function handleTargets(positionals, options, services) {
  rejectUnknownOptions(options, COMMON_OPTIONS);
  const [serverId, sandboxId, workId] = exactPositionals(
    positionals,
    "targets",
    3,
  );
  validateScope(serverId, sandboxId, workId);
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const result = projected(
    await services.client.request(
      "GET",
      workPath(serverId, sandboxId, workId, "/handoff-targets"),
      { token },
    ),
    projectWorkHandoffTargets,
    "Work handoff target",
  );
  services.emit(
    services.context.stdout,
    result.data,
    services.context.json,
    result.data.targets
      .map((target) => `${target.memberId}: ${target.label} (${target.role})`)
      .join("\n") || "No handoff targets.",
  );
  return 0;
}

async function handleStatus(positionals, options, services) {
  rejectUnknownOptions(options, [
    ...COMMON_OPTIONS,
    "kind",
    "request",
    "operation",
  ]);
  const [serverId, sandboxId, workId] = exactPositionals(
    positionals,
    "status",
    3,
  );
  validateScope(serverId, sandboxId, workId);
  const kind = stringOption(options, "kind", { required: true });
  if (!OPERATION_KINDS.has(kind)) invalid("--kind is invalid.");
  const requestId = stringOption(options, "request");
  const operationId = stringOption(options, "operation");
  if ((requestId === undefined) === (operationId === undefined)) {
    invalid("work status requires exactly one --request or --operation.");
  }
  if (requestId !== undefined) checkedRequestId(requestId, "work status");
  if (operationId !== undefined)
    checkedOperationId(operationId, "work status");
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const route = operationRoute(kind);
  const base = workPath(serverId, sandboxId, workId, `/${route}`);
  const path =
    operationId !== undefined
      ? `${base}/${encodeURIComponent(operationId)}`
      : `${base}?${new URLSearchParams({ requestId })}`;
  const result = projected(
    await services.client.request("GET", path, { token }),
    operationProjector(kind, workId, operationId, requestId),
    `Work ${kind} status`,
  );
  return emitOperation(services, kind, result);
}

async function handleOpen(positionals, options, services) {
  rejectUnknownOptions(options, [
    ...COMMON_OPTIONS,
    "connection-file",
    "identity",
  ]);
  const [serverId, sandboxId, workId] = exactPositionals(
    positionals,
    "open",
    3,
  );
  validateScope(serverId, sandboxId, workId);
  const token = await services.requireServerToken(
    services.store,
    serverId,
    options,
    services.context.env,
  );
  const result = projected(
    await services.client.request(
      "GET",
      workPath(serverId, sandboxId, workId, "/session-handoff"),
      { token },
    ),
    (value) => projectSessionHandoff(value, serverId, sandboxId, workId),
    "Work session handoff",
  );
  if (services.context.json) {
    services.emit(
      services.context.stdout,
      result.data,
      true,
      "",
    );
    return result.data.capability === "exact_session" ? 0 : 5;
  }
  if (result.data.capability !== "exact_session") {
    services.emit(
      services.context.stdout,
      result.data,
      false,
      `Session unavailable: ${result.data.reason}`,
    );
    return 5;
  }
  const code = await services.openSessionHandoff(result.data, {
    connectionFile: stringOption(options, "connection-file"),
    identityPath: stringOption(options, "identity"),
    context: services.context,
  });
  return Number.isInteger(code) ? code : 0;
}

export async function handleWork(positionals, options, services) {
  if (Array.isArray(positionals) && positionals[0] === "work") {
    positionals = positionals.slice(1);
  }
  if (!Array.isArray(positionals) || positionals.length === 0) {
    invalid("A Work command is required.");
  }
  if (
    !services?.client ||
    !services.store ||
    !services.context ||
    typeof services.requireServerToken !== "function" ||
    typeof services.emit !== "function" ||
    typeof services.readInput !== "function" ||
    typeof services.runMutation !== "function" ||
    typeof services.openSessionHandoff !== "function"
  ) {
    throw new CliError("The Work command is unavailable.", { exitCode: 1 });
  }
  const action = positionals[0];
  if (action === "list") return handleList(positionals, options, services);
  if (action === "show") return handleShow(positionals, options, services);
  if (action === "content") return handleContent(positionals, options, services);
  if (action === "sources") return handleSources(positionals, options, services);
  if (action === "policy") return handlePolicy(positionals, options, services);
  if (action === "create")
    return handleWorkMutation(positionals, options, services, true);
  if (action === "update")
    return handleWorkMutation(positionals, options, services, false);
  if (action === "enable") return handleEnable(positionals, options, services);
  if (["checkpoint", "continue", "restore", "handoff"].includes(action)) {
    return handleOperationMutation(positionals, options, services, action);
  }
  if (action === "targets") return handleTargets(positionals, options, services);
  if (action === "status") return handleStatus(positionals, options, services);
  if (action === "open") return handleOpen(positionals, options, services);
  invalid(`Unknown Work command: ${action}`);
}
