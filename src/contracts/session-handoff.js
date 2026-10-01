// Generated from worker/account/session-handoff.ts; SHA-256 d2bc3e8fc85cc686e4eba1fe539e18d5f1c8c2c832667b321b305fa0c8421396.
/** Closed safe metadata for the existing grant-bound managed bridge. */
import { isPlainObject } from "./http.js";
import { WORK_ID, WORK_BOX_ID } from "./work.js";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const positive = (v) => Number.isSafeInteger(v) && Number(v) > 0;
const id = (v, re = ID) => typeof v === "string" && re.test(v);
const closed = (v, keys) => isPlainObject(v) && Object.keys(v).length === keys.length && keys.every(k => k in v);
export function projectSessionHandoff(value, serverId, sandboxId, workId) {
    if (!closed(value, ["formatVersion", "capability", "reason", "handoff", "access"]) || value.formatVersion !== 1 ||
        !closed(value.access, ["transport", "requiresLocalOwnerCredential", "requiresSandboxGrant", "requiresPinnedHostKey"]) ||
        value.access.transport !== "wm-team-control/1" || value.access.requiresLocalOwnerCredential !== true ||
        value.access.requiresSandboxGrant !== true || value.access.requiresPinnedHostKey !== true)
        return null;
    if (value.capability === "unavailable")
        return value.handoff === null && ["source_unavailable", "target_changed", "binding_not_verified", "managed_service_not_ready"].includes(String(value.reason)) ? value : null;
    if (value.capability !== "exact_session" || value.reason !== null || !closed(value.handoff, ["formatVersion", "action", "handoffId", "issuedAt", "expiresAt", "identity", "source", "task", "work"]))
        return null;
    const h = value.handoff;
    if (h.formatVersion !== 1 || h.action !== "open_session" || !id(h.handoffId) || typeof h.issuedAt !== "string" || typeof h.expiresAt !== "string")
        return null;
    const duration = Date.parse(h.expiresAt) - Date.parse(h.issuedAt);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 120000)
        return null;
    const i = h.identity, s = h.source;
    if (!closed(i, ["serverId", "teamId", "memberId", "sandboxId", "sandboxGeneration", "serviceRegistrationId", "serviceGeneration", "instance", "role", "projectId", "workspaceEpoch", "profileId", "profileRevision", "profileDigest", "instructionRevision", "instructionDigest"]) ||
        i.serverId !== serverId || i.sandboxId !== sandboxId || !WORK_BOX_ID.test(sandboxId) ||
        !["worker", "reviewer", "manager"].includes(String(i.role)) || i.profileId !== "opencode" ||
        !id(i.instance, /^[a-z0-9][a-z0-9_-]{0,31}$/) || !id(i.profileDigest, DIGEST) || !id(i.instructionDigest, DIGEST))
        return null;
    for (const field of ["serverId", "teamId", "memberId", "serviceRegistrationId", "projectId", "workspaceEpoch"])
        if (!id(i[field]))
            return null;
    for (const field of ["sandboxGeneration", "serviceGeneration", "profileRevision", "instructionRevision"])
        if (!positive(i[field]))
            return null;
    if (!closed(s, ["registeredSourceId", "nativeSessionId", "nativeProjectId", "nativeLocationDigest"]) || !id(s.registeredSourceId) ||
        !id(s.nativeSessionId, /^ses_[A-Za-z0-9_-]{4,64}$/) || !id(s.nativeProjectId, /^(global|[a-f0-9]{40})$/) || !id(s.nativeLocationDigest, DIGEST))
        return null;
    if (h.task !== null && (!closed(h.task, ["taskId", "taskAttempt"]) || !id(h.task.taskId, /^task_[A-Za-z0-9_-]{4,75}$/) || !positive(h.task.taskAttempt)))
        return null;
    if (h.work !== null && (!closed(h.work, ["workId", "expectedRevision", "bindingId", "bindingRevision"]) || !id(h.work.workId, WORK_ID) ||
        !id(h.work.bindingId, /^binding_[A-Za-z0-9_-]{4,72}$/) || !positive(h.work.expectedRevision) || !positive(h.work.bindingRevision)))
        return null;
    if (workId !== undefined && (!isPlainObject(h.work) || h.work.workId !== workId))
        return null;
    return value;
}
