import { CliError } from "./errors.js";
import { rejectUnknownOptions, stringOption } from "./args.js";
import {
  FINDING_ID,
  INSIGHTS_ID,
  insightsMutation,
  insightsQuery,
  projectInsightDetail,
  projectInsightsList,
  projectInsightsSettings,
  projectInsightsSummary,
} from "./contracts/insights.js";
import {
  MANAGER_ID,
  managerListQuery,
  managerMutation,
  projectManager,
} from "./contracts/manager.js";
import { projectSessionHandoff } from "./contracts/session-handoff.js";

const COMMON = ["base-url", "json", "state-dir", "help", "token-file"];
const MUTATION = [...COMMON, "file", "idempotency-key"];
const SESSION = [...COMMON, "connection-file", "identity"];
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,159}$/;
const BOX_ID = /^sbx_[A-Za-z0-9_-]{4,72}$/;

function fail(message, exitCode = 2, code = "invalid_insights_command") {
  throw new CliError(message, { exitCode, code });
}

function invalidResponse() {
  fail("WarpMetal returned an invalid Agent Insights response.", 3, "agent_management_invalid_response");
}

function exactPositionals(positionals, expected, usage) {
  if (positionals.length !== expected) fail(`Usage: ${usage}`);
}

function identifier(value, label, pattern = INSIGHTS_ID) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`Invalid ${label}.`);
  return value;
}

function segment(value) {
  return encodeURIComponent(value);
}

function ownerBase(serverId, sandboxId) {
  return `/servers/${segment(serverId)}/sandboxes/${segment(sandboxId)}/insights`;
}

function fileOption(options) {
  return stringOption(options, "file", { required: true });
}

function idempotencyKey(options, requestId) {
  const value = stringOption(options, "idempotency-key") || requestId;
  if (!SAFE_IDEMPOTENCY_KEY.test(value)) fail("Invalid idempotency key.");
  return value;
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function canonical(value) {
  return Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
      : JSON.stringify(value);
}

function output(services, value) {
  services.emit(services.context.stdout, value, services.context.json, pretty(value));
}

function settingsExit(value) {
  return value.settings.status === "pending" ? 8
    : ["ready", "disabled"].includes(value.settings.status) ? 0 : 5;
}

function policyExit(value) {
  return value.status === "awaiting_runtime" ? 8 : value.status === "applied" ? 0 : 5;
}

function runExit(value) {
  return ["reserved", "reviewing"].includes(value.state) ? 8
    : ["recommended", "no_action", "needs_owner"].includes(value.state) ? 0 : 5;
}

function takeoverExit(value) {
  return ["awaiting_runtime", "unsettled"].includes(value.state) ? 8
    : ["ready", "resumed"].includes(value.state) ? 0 : 5;
}

function projected(result, projector) {
  const value = projector(result?.data);
  if (!value || canonical(value) !== canonical(result?.data)) invalidResponse();
  return value;
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function verifySettingsReceipt(value, body) {
  if (value.settings.revision !== body.expectedRevision + 1 || value.settings.enabled !== body.enabled) invalidResponse();
}

function verifyFindingReceipt(value, body, recovered) {
  const attention = value.finding.attention;
  const requestedState = {
    acknowledge: "acknowledged",
    snooze: "snoozed",
    dismiss: "dismissed",
  }[body.action];
  if (attention.revision !== body.expectedRevision + 1 || attention.state !== requestedState) invalidResponse();
  if (body.action === "snooze") {
    // The current-resource GET has no immutable mutation timestamp. It cannot
    // prove runtime.now()+snoozeSeconds, even when the state still says snoozed.
    if (recovered || typeof attention.snoozedUntil !== "string" || !Number.isFinite(Date.parse(attention.snoozedUntil))) invalidResponse();
  } else if (attention.snoozedUntil !== null) invalidResponse();
}

function verifyPolicyReceipt(value, body) {
  const duration = Date.parse(value.authorizationExpiresAt) - Date.parse(value.updatedAt);
  if (value.revision !== body.expectedRevision + 1 || value.mode !== body.mode ||
      !same(value.allowedRules, body.allowedRules) || value.dailyRunLimit !== body.dailyRunLimit ||
      value.dailyInputTokenLimit !== body.dailyInputTokenLimit ||
      value.dailyOutputTokenLimit !== body.dailyOutputTokenLimit ||
      !Number.isFinite(duration) || duration !== body.authorizationValidSeconds * 1000) invalidResponse();
}

function verifyRecheckReceipt(value, body) {
  if (value.manual !== true || value.findingRevision !== body.expectedFindingRevision ||
      value.policyRevision !== body.expectedPolicyRevision || !same(value.source, body.source) ||
      !same(value.target, body.target) || !same(value.reservedBudget, body.budget)) invalidResponse();
}

function verifyTakeoverReceipt(value, body) {
  if (value.revision !== 1 || value.action !== "pause_manager_and_hold_member" || value.predecessorOperationId !== null ||
      !same(value.source, body.source) || !same(value.target, body.target) ||
      value.monitorPolicy.desiredMode !== "off" ||
      value.monitorPolicy.desiredRevision !== body.expectedPolicyRevision + 1 ||
      value.memberHold.desiredState !== "active" || value.memberHold.desiredRevision !== 1 ||
      value.memberHold.brokerApplied !== true) invalidResponse();
}

function verifyResumePredecessor(value, body) {
  const prior = value.target, target = body.target;
  const taskMatches = target.taskId === null && target.taskAttempt === null ||
    target.taskId === prior.taskId && target.taskAttempt === prior.taskAttempt;
  const workMatches = ["workId", "workRevision", "bindingId", "bindingRevision"]
    .every(key => target[key] === prior[key]);
  if (value.action !== "pause_manager_and_hold_member" || value.state !== "ready" ||
      value.revision !== body.expectedTakeoverRevision ||
      value.monitorPolicy.desiredRevision !== body.expectedPolicyRevision ||
      value.memberHold.desiredState !== "active" || value.memberHold.desiredRevision !== body.expectedHoldRevision ||
      !same(value.source, body.source) || target.teamId !== prior.teamId ||
      target.memberId !== prior.memberId || !taskMatches || !workMatches) invalidResponse();
}

function verifyResumeReceipt(value, body, predecessorId, predecessor) {
  if (value.revision !== 1 || value.action !== "resume_manager_and_release_member" ||
      value.predecessorOperationId !== predecessorId || !same(value.source, body.source) ||
      !same(value.target, body.target) || value.monitorPolicy.desiredMode !== body.restoreMode ||
      value.monitorPolicy.desiredRevision !== body.expectedPolicyRevision + 1 ||
      value.memberHold.holdId !== predecessor.memberHold.holdId ||
      value.memberHold.desiredState !== "released" ||
      value.memberHold.desiredRevision !== body.expectedHoldRevision + 1 ||
      value.memberHold.brokerApplied !== true) invalidResponse();
}

async function authority(serverId, services, options) {
  return services.requireServerToken(services.store, serverId, options, services.context.env);
}

async function request(services, method, path, token, options = {}) {
  return services.client.request(method, path, { token, ...options });
}

function insightParams(options) {
  const params = new URLSearchParams();
  for (const [option, query] of [
    ["limit", "limit"], ["cursor", "cursor"], ["state", "state"],
    ["session", "session"], ["severity", "severity"], ["attention", "attention"],
    ["rule", "rule"], ["recent-hours", "recentHours"],
  ]) {
    const value = stringOption(options, option);
    if (value !== undefined) params.set(query, value);
  }
  const query = insightsQuery(params);
  if (query === null) fail("Invalid Insights list query.");
  return query;
}

function summaryParams(options) {
  const params = new URLSearchParams();
  const limit = stringOption(options, "limit");
  const cursor = stringOption(options, "cursor");
  if (limit !== undefined && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100)) fail("--limit must be between 1 and 100.");
  if (cursor !== undefined && !BOX_ID.test(cursor)) fail("Invalid summary cursor.");
  if (limit !== undefined) params.set("limit", limit);
  if (cursor !== undefined) params.set("cursor", cursor);
  return params.size ? `?${params}` : "";
}

function managerParams(options, allowFinding) {
  const params = new URLSearchParams();
  for (const [option, query] of [["limit", "limit"], ["cursor", "cursor"], ["finding", "findingId"]]) {
    const value = stringOption(options, option);
    if (value !== undefined) params.set(query, value);
  }
  const query = managerListQuery(params, allowFinding);
  if (query === null) fail("Invalid manager list query.");
  return query;
}

async function readSettings(serverId, sandboxId, services, options) {
  const token = await authority(serverId, services, options);
  const path = `${ownerBase(serverId, sandboxId)}/settings`;
  return projected(await request(services, "GET", path, token), projectInsightsSettings);
}

async function mutateSettings(verb, serverId, sandboxId, services, options) {
  const body = insightsMutation(await services.readInput(fileOption(options), 64 * 1024));
  if (!body || body.enabled !== (verb === "enable")) fail(`The input is not a valid Insights ${verb} mutation.`);
  const token = await authority(serverId, services, options);
  const path = `${ownerBase(serverId, sandboxId)}/settings`;
  const key = idempotencyKey(options, body.requestId);
  const result = await services.runMutation({
    path, serverId, sandboxId, kind: `insights_${verb}`, requestId: body.requestId, body,
    submit: () => request(services, "PATCH", path, token, { body, idempotencyKey: key }),
    reconcile: () => request(services, "GET", path, token),
  });
  const value = projected(result, projectInsightsSettings);
  verifySettingsReceipt(value, body);
  return value;
}

async function mutateFinding(verb, serverId, sandboxId, findingId, services, options) {
  const body = insightsMutation(await services.readInput(fileOption(options), 64 * 1024), true);
  const expected = verb === "acknowledge" ? "acknowledge" : verb;
  if (!body || body.action !== expected) fail(`The input is not a valid Insights ${verb} mutation.`);
  const token = await authority(serverId, services, options);
  const base = ownerBase(serverId, sandboxId);
  const path = `${base}/${segment(findingId)}/actions`;
  const key = idempotencyKey(options, body.requestId);
  let recovered = false;
  const result = await services.runMutation({
    path, serverId, sandboxId, kind: `insights_${verb}`, requestId: body.requestId, body,
    submit: () => request(services, "POST", path, token, { body, idempotencyKey: key }),
    reconcile: () => {
      recovered = true;
      return request(services, "GET", `${base}/${segment(findingId)}`, token);
    },
  });
  const value = projected(result, resultValue => projectInsightDetail(resultValue, findingId));
  verifyFindingReceipt(value, body, recovered);
  return value;
}

async function readPolicy(serverId, sandboxId, services, options, token) {
  const credential = token || await authority(serverId, services, options);
  const path = `${ownerBase(serverId, sandboxId)}/manager/settings`;
  return projected(await request(services, "GET", path, credential), value =>
    projectManager(value, "policy", { sandboxId }));
}

async function mutatePolicy(serverId, sandboxId, services, options) {
  const body = managerMutation(await services.readInput(fileOption(options), 64 * 1024), "policyPatch");
  if (!body) fail("The input is not a valid manager settings mutation.");
  const token = await authority(serverId, services, options);
  const path = `${ownerBase(serverId, sandboxId)}/manager/settings`;
  const key = idempotencyKey(options, body.requestId);
  const result = await services.runMutation({
    path, serverId, sandboxId, kind: "manager_settings", requestId: body.requestId, body,
    submit: () => request(services, "PATCH", path, token, { body, idempotencyKey: key }),
    reconcile: () => request(services, "GET", path, token),
  });
  const value = projected(result, resultValue => projectManager(resultValue, "policy", { sandboxId }));
  verifyPolicyReceipt(value, body);
  return value;
}

async function recheck(serverId, sandboxId, findingId, services, options) {
  const body = managerMutation(await services.readInput(fileOption(options), 64 * 1024), "recheckRequest");
  if (!body) fail("The input is not a valid manager Recheck request.");
  const token = await authority(serverId, services, options);
  const path = `${ownerBase(serverId, sandboxId)}/${segment(findingId)}/manager-rechecks`;
  const key = idempotencyKey(options, body.requestId);
  const result = await services.runMutation({
    path, serverId, sandboxId, kind: "manager_recheck", requestId: body.requestId, body,
    submit: () => request(services, "POST", path, token, { body, idempotencyKey: key }),
    reconcile: () => request(services, "GET", `${path}?requestId=${segment(body.requestId)}`, token),
  });
  const value = projected(result, resultValue => projectManager(resultValue, "reservation", { findingId, requestId: body.requestId }));
  verifyRecheckReceipt(value, body);
  return value;
}

async function createTakeover(serverId, sandboxId, findingId, services, options) {
  const body = managerMutation(await services.readInput(fileOption(options), 64 * 1024), "takeoverRequest");
  if (!body) fail("The input is not a valid manager Takeover request.");
  const token = await authority(serverId, services, options);
  const base = `${ownerBase(serverId, sandboxId)}/${segment(findingId)}/takeovers`;
  const key = idempotencyKey(options, body.requestId);
  const result = await services.runMutation({
    path: base, serverId, sandboxId, kind: "manager_takeover", requestId: body.requestId, body,
    submit: () => request(services, "POST", base, token, { body, idempotencyKey: key }),
    reconcile: () => request(services, "GET", `${base}/${segment(body.operationId)}`, token),
  });
  const value = projected(result, resultValue => projectManager(resultValue, "takeover", { findingId, operationId: body.operationId, requestId: body.requestId }));
  verifyTakeoverReceipt(value, body);
  return value;
}

async function resumeTakeover(serverId, sandboxId, findingId, predecessorId, services, options) {
  const body = managerMutation(await services.readInput(fileOption(options), 64 * 1024), "resumeRequest");
  if (!body) fail("The input is not a valid manager Resume request.");
  const token = await authority(serverId, services, options);
  const base = `${ownerBase(serverId, sandboxId)}/${segment(findingId)}/takeovers`;
  const path = `${base}/${segment(predecessorId)}/resume`;
  const key = idempotencyKey(options, body.requestId);
  const predecessor = projected(
    await request(services, "GET", `${base}/${segment(predecessorId)}`, token),
    value => projectManager(value, "takeover", { findingId, operationId: predecessorId }),
  );
  verifyResumePredecessor(predecessor, body);
  const result = await services.runMutation({
    path, serverId, sandboxId, kind: "manager_resume", requestId: body.requestId, body,
    submit: () => request(services, "POST", path, token, { body, idempotencyKey: key }),
    reconcile: () => request(services, "GET", `${base}/${segment(body.resumeOperationId)}`, token),
  });
  const value = projected(result, resultValue => projectManager(resultValue, "takeover", {
    findingId, operationId: body.resumeOperationId, requestId: body.requestId,
  }));
  verifyResumeReceipt(value, body, predecessorId, predecessor);
  return value;
}

function takeoverMatchesHandoff(takeover, handoff) {
  const i = handoff.identity, s = handoff.source, source = takeover.source, target = takeover.target;
  return i.teamId === target.teamId && i.memberId === target.memberId &&
    i.sandboxGeneration === source.sandboxGeneration && i.serviceRegistrationId === source.serviceRegistrationId &&
    i.serviceGeneration === source.serviceGeneration && i.workspaceEpoch === source.workspaceEpoch &&
    i.profileRevision === source.profileRevision && i.instructionRevision === source.instructionRevision &&
    s.registeredSourceId === source.registeredSourceId && s.nativeSessionId === source.nativeSessionId;
}

async function verifiedTakeover(serverId, sandboxId, findingId, operationId, services, options, token) {
  const base = `${ownerBase(serverId, sandboxId)}/${segment(findingId)}/takeovers`;
  const takeover = projected(await request(services, "GET", `${base}/${segment(operationId)}`, token), value =>
    projectManager(value, "takeover", { findingId, operationId }));
  if (takeover.state !== "ready" || takeover.action !== "pause_manager_and_hold_member" ||
      takeover.monitorPolicy.desiredMode !== "off" ||
      takeover.monitorPolicy.appliedRevision !== takeover.monitorPolicy.desiredRevision ||
      takeover.memberHold.desiredState !== "active" || !takeover.memberHold.brokerApplied ||
      takeover.memberHold.nodeAppliedRevision !== takeover.memberHold.desiredRevision) {
    fail("The requested Takeover is no longer an exact ready hold.", 5, "manager_takeover_stale");
  }
  const policy = await readPolicy(serverId, sandboxId, services, options, token);
  if (policy.mode !== "off" || policy.status !== "applied" ||
      policy.revision !== takeover.monitorPolicy.desiredRevision ||
      policy.appliedRevision !== takeover.monitorPolicy.appliedRevision) {
    fail("The requested Takeover no longer matches the current manager policy.", 5, "manager_takeover_stale");
  }
  const listing = projected(await request(services, "GET", `${base}?limit=100`, token), value =>
    projectManager(value, "takeoverList", { findingId }));
  if (listing.takeovers.some(row => row.predecessorOperationId === operationId)) {
    fail("The requested Takeover has been superseded by Resume.", 5, "manager_takeover_stale");
  }
  const finding = projected(await request(services, "GET", `${ownerBase(serverId, sandboxId)}/${segment(findingId)}`, token), value =>
    projectInsightDetail(value, findingId)).finding;
  const current = projected(await request(services, "GET", `${ownerBase(serverId, sandboxId)}/${segment(findingId)}/manager-target`, token), value =>
    projectManager(value, "managerTarget", { findingId }));
  // The current manager target owns the complete Task and Work authority.
  if (current.findingRevision !== finding.revision || !same(current.source, takeover.source) || !same(current.target, takeover.target)) {
    fail("The requested Takeover no longer matches the current finding target.", 5, "manager_takeover_stale");
  }
  return takeover;
}

async function handoff(kind, serverId, sandboxId, referenceId, services, options) {
  const token = await authority(serverId, services, options);
  let takeover = null;
  if (kind === "finding") {
    const operationId = stringOption(options, "takeover");
    if (operationId !== undefined) {
      identifier(operationId, "Takeover operation", MANAGER_ID);
      takeover = await verifiedTakeover(serverId, sandboxId, referenceId, operationId, services, options, token);
    }
  }
  const path = kind === "finding"
    ? `${ownerBase(serverId, sandboxId)}/${segment(referenceId)}/handoff`
    : `${ownerBase(serverId, sandboxId)}/manager/activity/${segment(referenceId)}/session-handoff`;
  const envelope = projected(await request(services, "GET", path, token), value =>
    projectSessionHandoff(value, serverId, sandboxId));
  if (envelope.capability !== "exact_session" || !envelope.handoff) {
    output(services, envelope);
    return 5;
  }
  if (takeover && !takeoverMatchesHandoff(takeover, envelope.handoff)) {
    fail("The Takeover does not match the current exact session.", 5, "manager_takeover_stale");
  }
  if (kind === "review" && envelope.handoff.identity.role !== "manager") {
    fail("The manager run does not resolve to a manager session.", 5, "manager_session_unavailable");
  }
  if (services.context.json) {
    output(services, envelope);
    return 0;
  }
  const result = await services.openSessionHandoff(envelope, {
    connectionFile: stringOption(options, "connection-file"),
    identityPath: stringOption(options, "identity"),
    context: { ...services.context, spawn: services.context.spawnImpl },
  });
  if (!Number.isInteger(result) || result < 0 || result > 255) {
    fail("The session handoff transport returned an invalid exit status.", 3, "session_handoff_transport_invalid");
  }
  return result;
}

/** Positional Insights/manager owner API and exact-session handler. */
export async function handleInsights(positionals, options, services) {
  const command = positionals.slice(0, 3).join(" ");
  if (positionals[0] !== "insights") fail("Invalid Insights command.");

  if (positionals[1] === "summary") {
    exactPositionals(positionals, 3, "warpmetal insights summary SERVER");
    rejectUnknownOptions(options, [...COMMON, "limit", "cursor"]);
    const serverId = identifier(positionals[2], "server ID");
    const token = await authority(serverId, services, options);
    const result = await request(services, "GET", `/servers/${segment(serverId)}/insights/summary${summaryParams(options)}`, token);
    const value = projected(result, data => projectInsightsSummary(data, serverId));
    output(services, value);
    return 0;
  }

  if (positionals[1] === "status") {
    exactPositionals(positionals, 4, "warpmetal insights status SERVER BOX");
    rejectUnknownOptions(options, COMMON);
    const serverId = identifier(positionals[2], "server ID");
    const sandboxId = identifier(positionals[3], "sandbox ID", BOX_ID);
    const value = await readSettings(serverId, sandboxId, services, options);
    output(services, value);
    return settingsExit(value);
  }

  if (["enable", "disable"].includes(positionals[1])) {
    exactPositionals(positionals, 4, `warpmetal insights ${positionals[1]} SERVER BOX --file FILE`);
    rejectUnknownOptions(options, MUTATION);
    const serverId = identifier(positionals[2], "server ID");
    const sandboxId = identifier(positionals[3], "sandbox ID", BOX_ID);
    const value = await mutateSettings(positionals[1], serverId, sandboxId, services, options);
    output(services, value);
    return settingsExit(value);
  }

  if (positionals[1] === "list") {
    exactPositionals(positionals, 4, "warpmetal insights list SERVER BOX");
    rejectUnknownOptions(options, [...COMMON, "limit", "cursor", "state", "session", "severity", "attention", "rule", "recent-hours"]);
    const serverId = identifier(positionals[2], "server ID");
    const sandboxId = identifier(positionals[3], "sandbox ID", BOX_ID);
    const token = await authority(serverId, services, options);
    const result = await request(services, "GET", `${ownerBase(serverId, sandboxId)}${insightParams(options)}`, token);
    const value = projected(result, projectInsightsList);
    output(services, value);
    return 0;
  }

  if (positionals[1] === "show") {
    exactPositionals(positionals, 5, "warpmetal insights show SERVER BOX FINDING");
    rejectUnknownOptions(options, COMMON);
    const serverId = identifier(positionals[2], "server ID");
    const sandboxId = identifier(positionals[3], "sandbox ID", BOX_ID);
    const findingId = identifier(positionals[4], "finding ID", FINDING_ID);
    const token = await authority(serverId, services, options);
    const result = await request(services, "GET", `${ownerBase(serverId, sandboxId)}/${segment(findingId)}`, token);
    const value = projected(result, data => projectInsightDetail(data, findingId));
    output(services, value);
    return 0;
  }

  if (["acknowledge", "snooze", "dismiss"].includes(positionals[1])) {
    exactPositionals(positionals, 5, `warpmetal insights ${positionals[1]} SERVER BOX FINDING --file FILE`);
    rejectUnknownOptions(options, MUTATION);
    const serverId = identifier(positionals[2], "server ID");
    const sandboxId = identifier(positionals[3], "sandbox ID", BOX_ID);
    const findingId = identifier(positionals[4], "finding ID", FINDING_ID);
    const value = await mutateFinding(positionals[1], serverId, sandboxId, findingId, services, options);
    output(services, value);
    return 0;
  }

  if (positionals[1] === "open") {
    exactPositionals(positionals, 5, "warpmetal insights open SERVER BOX FINDING");
    rejectUnknownOptions(options, [...SESSION, "takeover"]);
    return handoff("finding", identifier(positionals[2], "server ID"),
      identifier(positionals[3], "sandbox ID", BOX_ID), identifier(positionals[4], "finding ID", FINDING_ID), services, options);
  }

  if (positionals[1] === "review") {
    exactPositionals(positionals, 5, "warpmetal insights review SERVER BOX RUN");
    rejectUnknownOptions(options, SESSION);
    return handoff("review", identifier(positionals[2], "server ID"),
      identifier(positionals[3], "sandbox ID", BOX_ID), identifier(positionals[4], "run ID", MANAGER_ID), services, options);
  }

  if (command === "insights manager settings") {
    exactPositionals(positionals, 5, "warpmetal insights manager settings SERVER BOX [--file FILE]");
    rejectUnknownOptions(options, options.file === undefined ? COMMON : MUTATION);
    const serverId = identifier(positionals[3], "server ID");
    const sandboxId = identifier(positionals[4], "sandbox ID", BOX_ID);
    const value = options.file === undefined
      ? await readPolicy(serverId, sandboxId, services, options)
      : await mutatePolicy(serverId, sandboxId, services, options);
    output(services, value);
    return policyExit(value);
  }

  if (command === "insights manager activity") {
    exactPositionals(positionals, 5, "warpmetal insights manager activity SERVER BOX");
    rejectUnknownOptions(options, [...COMMON, "limit", "cursor", "finding"]);
    const serverId = identifier(positionals[3], "server ID");
    const sandboxId = identifier(positionals[4], "sandbox ID", BOX_ID);
    const token = await authority(serverId, services, options);
    const result = await request(services, "GET", `${ownerBase(serverId, sandboxId)}/manager/activity${managerParams(options, true)}`, token);
    const value = projected(result, data => projectManager(data, "activityList", {
      findingId: stringOption(options, "finding"),
    }));
    output(services, value);
    return 0;
  }

  if (command === "insights manager run") {
    exactPositionals(positionals, 6, "warpmetal insights manager run SERVER BOX RUN");
    rejectUnknownOptions(options, COMMON);
    const serverId = identifier(positionals[3], "server ID");
    const sandboxId = identifier(positionals[4], "sandbox ID", BOX_ID);
    const runId = identifier(positionals[5], "run ID", MANAGER_ID);
    const token = await authority(serverId, services, options);
    const result = await request(services, "GET", `${ownerBase(serverId, sandboxId)}/manager/activity/${segment(runId)}`, token);
    const value = projected(result, data => projectManager(data, "activity", { runId }));
    output(services, value);
    return runExit(value);
  }

  if (command === "insights manager target") {
    exactPositionals(positionals, 6, "warpmetal insights manager target SERVER BOX FINDING");
    rejectUnknownOptions(options, COMMON);
    const serverId = identifier(positionals[3], "server ID");
    const sandboxId = identifier(positionals[4], "sandbox ID", BOX_ID);
    const findingId = identifier(positionals[5], "finding ID", FINDING_ID);
    const token = await authority(serverId, services, options);
    const result = await request(services, "GET", `${ownerBase(serverId, sandboxId)}/${segment(findingId)}/manager-target`, token);
    const value = projected(result, data => projectManager(data, "managerTarget", { findingId }));
    output(services, value);
    return 0;
  }

  if (command === "insights manager recheck") {
    exactPositionals(positionals, 6, "warpmetal insights manager recheck SERVER BOX FINDING --file FILE");
    rejectUnknownOptions(options, MUTATION);
    const serverId = identifier(positionals[3], "server ID");
    const sandboxId = identifier(positionals[4], "sandbox ID", BOX_ID);
    const findingId = identifier(positionals[5], "finding ID", FINDING_ID);
    const value = await recheck(serverId, sandboxId, findingId, services, options);
    output(services, value);
    return runExit(value);
  }

  if (command === "insights manager status") {
    exactPositionals(positionals, 6, "warpmetal insights manager status SERVER BOX FINDING --request REQUEST");
    rejectUnknownOptions(options, [...COMMON, "request"]);
    const serverId = identifier(positionals[3], "server ID");
    const sandboxId = identifier(positionals[4], "sandbox ID", BOX_ID);
    const findingId = identifier(positionals[5], "finding ID", FINDING_ID);
    const requestId = identifier(stringOption(options, "request", { required: true }), "request ID", MANAGER_ID);
    const token = await authority(serverId, services, options);
    const result = await request(services, "GET", `${ownerBase(serverId, sandboxId)}/${segment(findingId)}/manager-rechecks?requestId=${segment(requestId)}`, token);
    const value = projected(result, data => projectManager(data, "reservation", { findingId, requestId }));
    output(services, value);
    return runExit(value);
  }

  if (command === "insights takeover list") {
    exactPositionals(positionals, 6, "warpmetal insights takeover list SERVER BOX FINDING");
    rejectUnknownOptions(options, [...COMMON, "limit", "cursor"]);
    const serverId = identifier(positionals[3], "server ID");
    const sandboxId = identifier(positionals[4], "sandbox ID", BOX_ID);
    const findingId = identifier(positionals[5], "finding ID", FINDING_ID);
    const token = await authority(serverId, services, options);
    const result = await request(services, "GET", `${ownerBase(serverId, sandboxId)}/${segment(findingId)}/takeovers${managerParams(options, false)}`, token);
    const value = projected(result, data => projectManager(data, "takeoverList", { findingId }));
    output(services, value);
    return 0;
  }

  if (positionals[1] === "takeover" && positionals[2] !== "status" && positionals[2] !== "resume" && positionals[2] !== "list") {
    exactPositionals(positionals, 5, "warpmetal insights takeover SERVER BOX FINDING --file FILE");
    rejectUnknownOptions(options, MUTATION);
    const serverId = identifier(positionals[2], "server ID");
    const sandboxId = identifier(positionals[3], "sandbox ID", BOX_ID);
    const findingId = identifier(positionals[4], "finding ID", FINDING_ID);
    const value = await createTakeover(serverId, sandboxId, findingId, services, options);
    output(services, value);
    return takeoverExit(value);
  }

  if (command === "insights takeover status") {
    exactPositionals(positionals, 6, "warpmetal insights takeover status SERVER BOX FINDING --operation OPERATION");
    rejectUnknownOptions(options, [...COMMON, "operation"]);
    const serverId = identifier(positionals[3], "server ID");
    const sandboxId = identifier(positionals[4], "sandbox ID", BOX_ID);
    const findingId = identifier(positionals[5], "finding ID", FINDING_ID);
    const operationId = identifier(stringOption(options, "operation", { required: true }), "operation ID", MANAGER_ID);
    const token = await authority(serverId, services, options);
    const result = await request(services, "GET", `${ownerBase(serverId, sandboxId)}/${segment(findingId)}/takeovers/${segment(operationId)}`, token);
    const value = projected(result, data => projectManager(data, "takeover", { findingId, operationId }));
    output(services, value);
    return takeoverExit(value);
  }

  if (command === "insights takeover resume") {
    exactPositionals(positionals, 6, "warpmetal insights takeover resume SERVER BOX FINDING --operation OPERATION --file FILE");
    rejectUnknownOptions(options, [...MUTATION, "operation"]);
    const serverId = identifier(positionals[3], "server ID");
    const sandboxId = identifier(positionals[4], "sandbox ID", BOX_ID);
    const findingId = identifier(positionals[5], "finding ID", FINDING_ID);
    const predecessor = identifier(stringOption(options, "operation", { required: true }), "operation ID", MANAGER_ID);
    const value = await resumeTakeover(serverId, sandboxId, findingId, predecessor, services, options);
    output(services, value);
    return takeoverExit(value);
  }

  fail(`Unknown Insights command: ${positionals.join(" ")}`);
}
