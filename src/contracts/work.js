// Generated from worker/account/work.ts; SHA-256 e4176707a30848118bd44d1c369fc4303a267300fc981560d58c618b279ce516.
/** Closed owner Work boundary. Content is returned only by the deliberate read. */
import { isPlainObject } from "./http.js";
export const WORK_ID = /^work_[A-Za-z0-9_-]{4,75}$/;
export const WORK_REQUEST_ID = /^req_[A-Za-z0-9_-]{4,156}$/;
export const WORK_BOX_ID = /^sbx_[A-Za-z0-9_-]{4,72}$/;
export const WORK_OPERATION_ID = /^op_[A-Za-z0-9_-]{4,75}$/;
const BINDING_ID = /^binding_[A-Za-z0-9_-]{4,71}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NATIVE_PROJECT = /^(?:global|[a-f0-9]{40})$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const isId = (value, pattern = OPAQUE_ID) => typeof value === "string" && pattern.test(value);
const positive = (value) => Number.isSafeInteger(value) && Number(value) > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const text = (value, max) => typeof value === "string" && encoder.encode(value).length <= max;
const closed = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => key in value);
const contentKeys = ["objective", "constraints", "context"];
const bindingKeys = ["bindingId", "registeredSourceId", "serviceRegistrationId", "nativeSessionId", "nativeProjectId", "nativeLocationDigest"];
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const contentValid = (value) => isPlainObject(value) && text(value.objective, 65536) && text(value.constraints, 65536) && text(value.context, 131072);
export function workListQuery(params) {
    const result = new URLSearchParams();
    for (const key of params.keys()) {
        if (!["cursor", "limit"].includes(key) || params.getAll(key).length !== 1)
            return null;
    }
    const cursor = params.get("cursor"), limit = params.get("limit");
    if (cursor !== null) {
        if (!/^[A-Za-z0-9_=-]{1,512}$/.test(cursor))
            return null;
        result.set("cursor", cursor);
    }
    if (limit !== null) {
        if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100)
            return null;
        result.set("limit", limit);
    }
    return result.size ? `?${result}` : "";
}
export function workContentQuery(params) {
    if (params.size === 0)
        return "";
    const revision = params.get("revision");
    if (params.size !== 1 || revision === null || !/^[1-9][0-9]{0,14}$/.test(revision) || !positive(Number(revision)))
        return null;
    return `?revision=${revision}`;
}
export async function readWorkBody(request) {
    // Content limits apply after JSON unescaping; bounded transport allows escaped text.
    const maximum = 2 * 1024 * 1024;
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json") || !request.body)
        return null;
    if (Number(request.headers.get("content-length") ?? 0) > maximum)
        return null;
    const reader = request.body.getReader();
    let size = 0;
    const chunks = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > maximum) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
        const joined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
        return isPlainObject(value) ? value : null;
    }
    catch {
        return null;
    }
    finally {
        reader.releaseLock();
    }
}
export function workMutationBody(value, create) {
    const keys = create ? ["version", "workId", "requestId", "projectId", "workspaceEpoch", "managedSession", "continuityEnabled", "content"]
        : ["version", "requestId", "expectedRevision", "continuityEnabled", "content"];
    if (isPlainObject(value) && "title" in value)
        keys.push("title");
    if (!closed(value, keys) || ("title" in value && !safeLabel(value.title, 160)) || value.version !== 1 || !isId(value.requestId, WORK_REQUEST_ID) || typeof value.continuityEnabled !== "boolean" ||
        !closed(value.content, contentKeys) || !contentValid(value.content))
        return null;
    if (!create)
        return positive(value.expectedRevision) ? value : null;
    if (!isId(value.workId, WORK_ID) || !isId(value.projectId) || !isId(value.workspaceEpoch) || !closed(value.managedSession, bindingKeys))
        return null;
    const managed = value.managedSession;
    if (bindingKeys.some(key => !isId(managed[key], key === "bindingId" ? BINDING_ID : key === "nativeLocationDigest" ? DIGEST : key === "nativeProjectId" ? NATIVE_PROJECT : OPAQUE_ID)))
        return null;
    return value;
}
export function projectWork(value, sandboxId, workId) {
    if (!isPlainObject(value) || !isId(value.workId, WORK_ID) || (workId !== undefined && value.workId !== workId) || value.sandboxId !== sandboxId ||
        !isId(value.projectId) || !isId(value.workspaceEpoch) || !positive(value.revision) || !["open", "active", "ready_to_continue", "waiting_for_owner", "recovery_required", "completed", "archived"].includes(String(value.lifecycle)) ||
        typeof value.continuityEnabled !== "boolean" || !date(value.createdAt) || !date(value.updatedAt) ||
        !isPlainObject(value.binding) || !isPlainObject(value.content) || !isPlainObject(value.taskLineage))
        return null;
    const binding = value.binding, content = value.content, lineage = value.taskLineage;
    if (bindingKeys.some(key => !isId(binding[key], key === "bindingId" ? BINDING_ID : key === "nativeLocationDigest" ? DIGEST : key === "nativeProjectId" ? NATIVE_PROJECT : OPAQUE_ID)) ||
        !positive(binding.bindingRevision) || !positive(binding.sandboxGeneration) ||
        !["registration_pending", "verified", "missing", "incompatible", "retired"].includes(String(binding.state)) ||
        !isId(content.contentDigest, DIGEST) || !nonnegative(content.objectiveBytes) || content.objectiveBytes > 65536 ||
        !nonnegative(content.constraintsBytes) || content.constraintsBytes > 65536 || !nonnegative(content.contextBytes) || content.contextBytes > 131072 ||
        [lineage.currentTaskId, lineage.previousTaskId].some(id => id !== null && !isId(id)))
        return null;
    const projectedBinding = pick(binding, [...bindingKeys, "state", "bindingRevision", "sandboxGeneration"]);
    if (binding.availability !== undefined) {
        if (!["available", "unavailable"].includes(String(binding.availability)) || (binding.reason !== null && !isId(binding.reason, /^[a-z][a-z0-9_]{0,79}$/)) ||
            (binding.scopeRevision !== null && !positive(binding.scopeRevision)) || (binding.serviceGeneration !== null && !positive(binding.serviceGeneration)))
            return null;
        Object.assign(projectedBinding, pick(binding, ["availability", "reason", "scopeRevision", "serviceGeneration"]));
    }
    const result = { ...pick(value, ["workId", "projectId", "sandboxId", "workspaceEpoch", "revision", "lifecycle", "continuityEnabled", "createdAt", "updatedAt"]),
        binding: projectedBinding, content: pick(content, ["contentDigest", "objectiveBytes", "constraintsBytes", "contextBytes"]),
        taskLineage: pick(lineage, ["currentTaskId", "previousTaskId"]) };
    if ("title" in value || "storagePolicy" in value || "capabilities" in value || "assignedAgent" in value) {
        const policy = projectStoragePolicy(value.storagePolicy);
        const capabilities = projectCapabilities(value.capabilities);
        if (!safeLabel(value.title, 160) || !policy || !capabilities)
            return null;
        let assigned = null;
        if (value.assignedAgent !== null) {
            if (!isPlainObject(value.assignedAgent) || !isId(value.assignedAgent.memberId) || !safeLabel(value.assignedAgent.label, 63) ||
                !["worker", "reviewer", "manager"].includes(String(value.assignedAgent.role)))
                return null;
            assigned = pick(value.assignedAgent, ["memberId", "label", "role"]);
        }
        Object.assign(result, { title: value.title, assignedAgent: assigned, storagePolicy: policy, capabilities });
    }
    if (value.currentCheckpoint !== undefined) {
        if (value.currentCheckpoint === null)
            result.currentCheckpoint = null;
        else {
            const checkpoint = projectCheckpoint(value.currentCheckpoint);
            if (!checkpoint || !isPlainObject(value.currentCheckpoint) || !isId(value.currentCheckpoint.operationId, WORK_OPERATION_ID) || !date(value.currentCheckpoint.acceptedAt))
                return null;
            result.currentCheckpoint = { ...checkpoint, operationId: value.currentCheckpoint.operationId, acceptedAt: value.currentCheckpoint.acceptedAt };
            if ("boundaryKind" in value.currentCheckpoint) {
                if (!boundaryValid(value.currentCheckpoint))
                    return null;
                Object.assign(result.currentCheckpoint, pick(value.currentCheckpoint, ["boundaryKind", "taskId", "taskAttempt"]));
            }
        }
    }
    return result;
}
const safeLabel = (value, max) => text(value, max) && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
const capabilityReasons = ["continuity_disabled", "binding_not_verified", "source_unavailable", "managed_service_not_ready", "checkpoint_required", "operation_in_progress", "hold_active", "runtime_unavailable", "continuation_not_available", "restore_not_available"];
const exclusions = ["native_history", "credentials", "runtime_state", "external_side_effects"];
function projectCapability(value) {
    if (!isPlainObject(value) || !["available", "unavailable"].includes(String(value.state)) ||
        (value.reason !== null && !capabilityReasons.includes(String(value.reason))) ||
        (value.state === "available" && value.reason !== null))
        return null;
    return pick(value, ["state", "reason"]);
}
function projectStoragePolicy(value) {
    if (!isPlainObject(value) || value.location !== "local_vps" || value.scope !== "sandbox_work" ||
        value.maxCheckpointBytes !== 268435456 || value.maxCheckpointObjectCount !== 10000 || value.maxBoxBytes !== 1073741824 ||
        value.maxCheckpointsPerBox !== 20 || value.maxAgeDays !== 30 || value.pinRule !== "latest_active_work" ||
        !Array.isArray(value.exclusions) || value.exclusions.length !== exclusions.length || value.exclusions.some((item, index) => item !== exclusions[index]))
        return null;
    return pick(value, ["location", "scope", "maxCheckpointBytes", "maxCheckpointObjectCount", "maxBoxBytes", "maxCheckpointsPerBox", "maxAgeDays", "pinRule", "exclusions"]);
}
function projectCapabilities(value) {
    if (!isPlainObject(value) || !isPlainObject(value.capture))
        return null;
    const capture = projectCapability(value.capture), continuation = projectCapability(value.continue), restore = projectCapability(value.restore);
    if (!capture || !continuation || !restore || value.capture.requiresVerifiedBinding !== true || value.capture.maxBytes !== 268435456 || value.capture.maxObjectCount !== 10000 ||
        !Array.isArray(value.capture.boundaryKinds) || JSON.stringify(value.capture.boundaryKinds) !== '["initial","task","stopped"]')
        return null;
    const captureRequest = value.capture.captureRequest;
    if (captureRequest !== null && (!closed(captureRequest, ["boundaryKind", "taskId", "taskAttempt"]) || !boundaryValid(captureRequest)))
        return null;
    if (capture.state === "available" && captureRequest === null)
        return null;
    return { capture: { ...capture, ...pick(value.capture, ["requiresVerifiedBinding", "maxBytes", "maxObjectCount", "boundaryKinds"]), captureRequest }, continue: continuation, restore };
}
export function projectWorkPolicy(value) {
    if (!isPlainObject(value) || value.policyVersion !== 1)
        return null;
    const storagePolicy = projectStoragePolicy(value.storagePolicy), continuityOptIn = projectCapability(value.continuityOptIn);
    return storagePolicy && continuityOptIn ? { policyVersion: 1, storagePolicy, continuityOptIn } : null;
}
export function workContinuityBody(value) {
    if (!closed(value, ["version", "requestId", "expectedRevision", "continuityEnabled"]) || value.version !== 1 ||
        !isId(value.requestId, WORK_REQUEST_ID) || !positive(value.expectedRevision) || typeof value.continuityEnabled !== "boolean")
        return null;
    return value;
}
export function projectWorkList(value, sandboxId) {
    if (!isPlainObject(value) || !Array.isArray(value.work) || value.work.length > 100 ||
        (value.nextCursor !== null && (typeof value.nextCursor !== "string" || !/^[A-Za-z0-9_=-]{1,512}$/.test(value.nextCursor))))
        return null;
    const work = value.work.map(item => projectWork(item, sandboxId));
    if (work.some(item => item === null) || new Set(work.map(item => item?.workId)).size !== work.length)
        return null;
    return { work, nextCursor: value.nextCursor };
}
export function projectWorkContent(value, workId, revision) {
    if (!isPlainObject(value) || value.workId !== workId || !positive(value.revision) || (revision !== null && value.revision !== Number(revision)) ||
        !contentValid(value.content) || !isId(value.content.contentDigest, DIGEST))
        return null;
    return { workId, revision: value.revision, content: pick(value.content, [...contentKeys, "contentDigest"]) };
}
export function projectCheckpoint(value) {
    if (!isPlainObject(value) || !isId(value.checkpointId) || !isId(value.captureId) || !isId(value.manifestDigest, DIGEST) ||
        !nonnegative(value.bytes) || value.bytes > 268435456 || !nonnegative(value.objectCount) || value.objectCount > 10000)
        return null;
    return pick(value, ["checkpointId", "captureId", "manifestDigest", "bytes", "objectCount"]);
}
export function projectWorkSources(value, sandboxId) {
    if (!isPlainObject(value) || !Array.isArray(value.sources) || value.sources.length > 100 ||
        (value.nextCursor !== null && (typeof value.nextCursor !== "string" || !/^[A-Za-z0-9_=-]{1,512}$/.test(value.nextCursor))))
        return null;
    const sources = [];
    for (const source of value.sources) {
        if (!isPlainObject(source) || source.formatVersion !== 1 || source.sandboxId !== sandboxId ||
            ["registeredSourceId", "serviceRegistrationId", "projectId", "workspaceEpoch", "nativeSessionId", "nativeProjectId", "nativeLocationDigest"].some(key => !isId(source[key], key === "nativeLocationDigest" ? DIGEST : key === "nativeProjectId" ? NATIVE_PROJECT : OPAQUE_ID)) ||
            ["serviceGeneration", "sandboxGeneration", "scopeRevision", "profileRevision", "instructionRevision"].some(key => !positive(source[key])) ||
            !["manager", "worker", "reviewer"].includes(String(source.role)) || !["available", "unavailable"].includes(String(source.availability)) ||
            (source.reason !== null && !isId(source.reason, /^[a-z][a-z0-9_]{0,79}$/)) || !date(source.lastObservedAt))
            return null;
        sources.push(pick(source, ["formatVersion", "registeredSourceId", "serviceRegistrationId", "serviceGeneration", "projectId", "sandboxId", "sandboxGeneration", "workspaceEpoch", "nativeSessionId", "nativeProjectId", "nativeLocationDigest", "scopeRevision", "role", "profileRevision", "instructionRevision", "availability", "reason", "lastObservedAt"]));
    }
    if (new Set(sources.map(source => source.registeredSourceId)).size !== sources.length)
        return null;
    return { sources, nextCursor: value.nextCursor };
}
const taskPair = (value) => (value.taskId === null && value.taskAttempt === null) || (isId(value.taskId) && positive(value.taskAttempt));
const boundaryValid = (value) => ["initial", "task", "stopped"].includes(String(value.boundaryKind)) && taskPair(value) &&
    (value.boundaryKind !== "initial" || value.taskId === null) && (value.boundaryKind !== "task" || value.taskId !== null);
export function workOperationBody(value) {
    if (!closed(value, ["version", "operationId", "requestId", "action", "expectedRevision", "expectedBindingRevision", "scopeRevision", "boundaryKind", "taskId", "taskAttempt"]) ||
        value.version !== 1 || !isId(value.operationId, WORK_OPERATION_ID) || !isId(value.requestId, WORK_REQUEST_ID) || value.action !== "capture_checkpoint" ||
        !positive(value.expectedRevision) || !positive(value.expectedBindingRevision) || !positive(value.scopeRevision) || !boundaryValid(value))
        return null;
    return value;
}
export function projectWorkOperation(value, workId, operationId, requestId) {
    if (!isPlainObject(value) || !isPlainObject(value.operation))
        return null;
    const op = value.operation;
    if (op.workId !== workId || !isId(op.operationId, WORK_OPERATION_ID) || !isId(op.requestId, WORK_REQUEST_ID) ||
        (operationId !== undefined && op.operationId !== operationId) || (requestId !== undefined && op.requestId !== requestId) ||
        op.action !== "capture_checkpoint" || !["pending", "reported", "accepted", "failed", "outcome_unknown", "superseded"].includes(String(op.state)) ||
        !positive(op.expectedRevision) || !positive(op.expectedBindingRevision) || !positive(op.scopeRevision) || !boundaryValid(op) ||
        (op.errorCode !== null && !isId(op.errorCode, /^[a-z][a-z0-9_]{0,79}$/)) || !date(op.createdAt) || !date(op.updatedAt) || (op.terminalAt !== null && !date(op.terminalAt)))
        return null;
    const checkpoint = op.checkpoint === null ? null : projectCheckpoint(op.checkpoint);
    if ((op.state === "accepted" && (!checkpoint || op.terminalAt === null)) || (op.state !== "accepted" && op.checkpoint !== null))
        return null;
    return { operation: { ...pick(op, ["operationId", "requestId", "workId", "action", "state", "expectedRevision", "expectedBindingRevision", "scopeRevision", "boundaryKind", "taskId", "taskAttempt", "errorCode", "createdAt", "updatedAt", "terminalAt"]), checkpoint } };
}
const STATE_COMMON = ["version", "operationId", "requestId", "expectedRevision", "expectedBindingRevision", "scopeRevision", "checkpointOperationId"];
export function workStateBody(value, kind) {
    const keys = [...STATE_COMMON, ...(kind === "continue" ? ["targetMemberId", "instruction", "turnLimit", "timeoutSeconds"] : ["targetMode"])];
    if (!closed(value, keys) || value.version !== 1 || !isId(value.operationId, WORK_OPERATION_ID) || !isId(value.requestId, WORK_REQUEST_ID) ||
        !isId(value.checkpointOperationId, WORK_OPERATION_ID) || !positive(value.expectedRevision) || !positive(value.expectedBindingRevision) || !positive(value.scopeRevision))
        return null;
    if (kind === "restore")
        return value.targetMode === "create_new" ? value : null;
    return isId(value.targetMemberId) && text(value.instruction, 8192) && value.instruction.length > 0 &&
        positive(value.turnLimit) && value.turnLimit <= 200 && positive(value.timeoutSeconds) && value.timeoutSeconds <= 1800 ? value : null;
}
export function projectWorkStateOperation(value, workId, kind, operationId, requestId) {
    if (!isPlainObject(value) || !isPlainObject(value.operation))
        return null;
    const op = value.operation;
    if (op.workId !== workId || !isId(op.operationId, WORK_OPERATION_ID) || !isId(op.requestId, WORK_REQUEST_ID) ||
        (operationId !== undefined && op.operationId !== operationId) || (requestId !== undefined && op.requestId !== requestId) ||
        op.action !== (kind === "continue" ? "prepare_continuation" : "restore_checkpoint") ||
        !["pending", "reported", "accepted", "failed", "outcome_unknown", "superseded"].includes(String(op.state)) ||
        !positive(op.expectedRevision) || !positive(op.expectedBindingRevision) || !positive(op.scopeRevision) || !isId(op.checkpointOperationId, WORK_OPERATION_ID) ||
        (op.errorCode !== null && !isId(op.errorCode, /^[a-z][a-z0-9_]{0,79}$/)) || !date(op.createdAt) || !date(op.updatedAt) ||
        (op.terminalAt !== null && !date(op.terminalAt)) || (op.state === "accepted" && op.terminalAt === null))
        return null;
    const common = pick(op, ["operationId", "requestId", "workId", "action", "state", "expectedRevision", "expectedBindingRevision", "scopeRevision", "checkpointOperationId", "errorCode", "createdAt", "updatedAt", "terminalAt"]);
    if (kind === "continue") {
        if (!isId(op.contextDigest, DIGEST) || !positive(op.contextBytes) || op.contextBytes > 32768 || !positive(op.contextTokenUpperBound) || op.contextTokenUpperBound > 8192 ||
            [op.taskId, op.parentTaskId, op.baselineId].some(value => value !== null && !isId(value)) ||
            [op.baselineConsumedAt, op.admittedAt].some(value => value !== null && !date(value)) ||
            (op.state === "accepted" && [op.taskId, op.baselineId, op.baselineConsumedAt, op.admittedAt].some(value => value === null)))
            return null;
        return { operation: { ...common, ...pick(op, ["contextDigest", "contextBytes", "contextTokenUpperBound", "taskId", "parentTaskId", "baselineId", "baselineConsumedAt", "admittedAt"]) } };
    }
    if (op.taskId !== null || (op.state === "accepted" && op.target === null))
        return null;
    let target = null;
    if (op.target !== null) {
        if (!isPlainObject(op.target) || ["selectionId", "projectId", "workspaceEpoch"].some(key => !isId(op.target && op.target[key])) ||
            !positive(op.target.scopeRevision) || !isId(op.target.rootAttestation, DIGEST))
            return null;
        target = pick(op.target, ["selectionId", "projectId", "workspaceEpoch", "scopeRevision", "rootAttestation"]);
    }
    return { operation: { ...common, taskId: null, target } };
}
