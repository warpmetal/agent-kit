// Generated from worker/account/work-handoff.ts; SHA-256 d89273eeab925968f757e6458542681d88356a494e6fc7d7af800193c371fb3d.
/** Explicit separate-session Work handoff; opaque owner receipts only. */
import { isPlainObject } from "./http.js";
import { WORK_ID, WORK_OPERATION_ID, WORK_REQUEST_ID, WORK_BOX_ID, workStateBody } from "./work.js";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const id = (value, pattern = ID) => typeof value === "string" && pattern.test(value);
const positive = (v) => Number.isSafeInteger(v) && Number(v) > 0;
const date = (v) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const label = (v) => typeof v === "string" && v.trim() === v && v.length > 0 && new TextEncoder().encode(v).length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
const pick = (v, keys) => Object.fromEntries(keys.map(k => [k, v[k]]));
export function workHandoffBody(value) {
    if (!isPlainObject(value))
        return null;
    const extra = ["handoffKind", "restoreOperationId", "sessionChoice", "title"];
    if (extra.some(k => !(k in value)) || value.sessionChoice !== "create_separate" || !label(value.title) ||
        !(value.handoffKind === "reviewer" && value.restoreOperationId === null || value.handoffKind === "restored_target" && id(value.restoreOperationId, WORK_OPERATION_ID)))
        return null;
    const common = Object.fromEntries(Object.entries(value).filter(([k]) => !extra.includes(k)));
    return workStateBody(common, "continue") ? value : null;
}
function member(value) {
    if (!isPlainObject(value) || !id(value.memberId) || !label(value.label) || !["worker", "reviewer"].includes(String(value.role)) || !id(value.sandboxId, WORK_BOX_ID))
        return null;
    return pick(value, ["memberId", "label", "role", "sandboxId"]);
}
export function projectWorkHandoffTargets(value) {
    if (!isPlainObject(value) || !Array.isArray(value.targets) || value.targets.length > 8 || value.nextCursor !== null || !Array.isArray(value.restores) || value.restores.length > 20 || typeof value.restoresTruncated !== "boolean")
        return null;
    const targets = value.targets.map(member);
    if (targets.some(v => v === null) || new Set(targets.map(v => v.memberId)).size !== targets.length)
        return null;
    const restores = [];
    for (const r of value.restores) {
        if (!isPlainObject(r) || !id(r.operationId, WORK_OPERATION_ID) || !id(r.projectId) || !id(r.workspaceEpoch) || !id(r.sandboxId, WORK_BOX_ID))
            return null;
        restores.push(pick(r, ["operationId", "projectId", "workspaceEpoch", "sandboxId"]));
    }
    if (new Set(restores.map(r => r.operationId)).size !== restores.length)
        return null;
    return { targets: targets, nextCursor: null, restores, restoresTruncated: value.restoresTruncated };
}
export function projectWorkHandoff(value, workId, operationId, requestId) {
    if (!isPlainObject(value) || !isPlainObject(value.operation))
        return null;
    const op = value.operation, target = member(op.targetMember);
    if (!target || op.sourceWorkId !== workId || !id(op.operationId, WORK_OPERATION_ID) || !id(op.requestId, WORK_REQUEST_ID) ||
        operationId !== undefined && op.operationId !== operationId || requestId !== undefined && op.requestId !== requestId ||
        op.action !== "prepare_handoff" || op.sessionChoice !== "create_separate" || !["pending", "accepted", "failed", "superseded", "outcome_unknown"].includes(String(op.state)) ||
        !positive(op.sourceRevision) || !id(op.targetWorkId, WORK_ID) || !id(op.checkpointOperationId, WORK_OPERATION_ID) ||
        !(op.handoffKind === "reviewer" && op.restoreOperationId === null && target.role === "reviewer" || op.handoffKind === "restored_target" && id(op.restoreOperationId, WORK_OPERATION_ID)) ||
        !date(op.createdAt) || !date(op.updatedAt) || ![op.baselineId, op.taskId, op.parentTaskId].every(v => v === null || id(v)) ||
        !(op.errorCode === null || id(op.errorCode, /^[a-z][a-z0-9_]{0,79}$/)))
        return null;
    let workspace = null, session = null;
    if (op.targetWorkspace !== null) {
        const w = op.targetWorkspace;
        if (!isPlainObject(w) || !id(w.selectionId) || !id(w.projectId) || !id(w.workspaceEpoch) || !positive(w.scopeRevision) || !id(w.rootAttestation, DIGEST))
            return null;
        workspace = pick(w, ["selectionId", "projectId", "workspaceEpoch", "scopeRevision", "rootAttestation"]);
    }
    if (op.session !== null) {
        const s = op.session;
        if (!isPlainObject(s) || !id(s.mappingId) || !id(s.registeredSourceId) || !id(s.nativeSessionId, /^ses_[A-Za-z0-9_-]{4,64}$/) ||
            !id(s.nativeProjectId, /^(global|[a-f0-9]{40})$/) || !id(s.nativeLocationDigest, DIGEST))
            return null;
        session = pick(s, ["mappingId", "registeredSourceId", "nativeSessionId", "nativeProjectId", "nativeLocationDigest"]);
    }
    if (op.state === "accepted" && (!workspace || !session || !op.taskId || !op.baselineId))
        return null;
    return { operation: { ...pick(op, ["operationId", "requestId", "action", "handoffKind", "sessionChoice", "state", "sourceWorkId", "sourceRevision", "targetWorkId", "checkpointOperationId", "restoreOperationId", "baselineId", "taskId", "parentTaskId", "errorCode", "createdAt", "updatedAt"]),
            targetMember: target, targetWorkspace: workspace, session } };
}
