// Generated from worker/account/insights.ts; SHA-256 826eb08f9496415b408fe943d9eec33a6c8480a52474df76c118f471f6d42d1f.
/** Sanitized owner Insights projection and explicit metadata-only mutations. */
import { isPlainObject } from "./http.js";
export const FINDING_ID = /^finding_[A-Za-z0-9_-]{4,96}$/;
export const INSIGHTS_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RULES = ["repeated_identical_failure@1", "repeated_identical_call@1", "empty_result_loop@1", "suspected_stall@1"];
const GAPS = ["monitor_gap", "journal_generation_changed", "cursor_ahead", "source_unavailable", "unsupported_agent_version", "monitor_disabled", "export_unavailable", "capacity_exceeded"];
const PHASES = ["unknown", "idle", "running_model", "running_tool", "running_background", "waiting_permission", "waiting_input", "waiting_retry", "compacting"];
const SUGGESTIONS = ["inspect_first_failure", "check_repeated_operation", "refine_query", "inspect_active_phase"];
const RECOVERY = ["matching_operation_succeeded", "qualified_progress_resumed", "nonempty_refined_query", "qualified_progress_resumed"];
const id = (value, pattern = INSIGHTS_ID) => typeof value === "string" && pattern.test(value);
const positive = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const date = (value) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const oneOf = (value, options) => typeof value === "string" && options.includes(value);
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const exact = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => key in value);
export function insightsMutation(value, action = false) {
    const keys = ["version", "requestId", "expectedRevision", ...(action ? ["action", "snoozeSeconds"] : ["enabled"])];
    if (!exact(value, keys) || value.version !== 1 || !id(value.requestId) || !positive(value.expectedRevision))
        return null;
    if (!action)
        return typeof value.enabled === "boolean" ? value : null;
    if (value.action === "snooze")
        return positive(value.snoozeSeconds) && value.snoozeSeconds >= 60 && value.snoozeSeconds <= 86400 ? value : null;
    return oneOf(value.action, ["acknowledge", "dismiss"]) && value.snoozeSeconds === null ? value : null;
}
export function insightsQuery(params) {
    const result = new URLSearchParams();
    for (const key of params.keys()) {
        if (!["limit", "cursor", "state", "session", "severity", "attention", "rule", "recentHours"].includes(key) || params.getAll(key).length !== 1)
            return null;
        const value = params.get(key);
        if (key === "limit" ? !/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100
            : key === "cursor" ? !id(value, FINDING_ID) : key === "session" ? !id(value)
                : key === "state" ? !["open", "resolved"].includes(value)
                    : key === "attention" ? !["unacknowledged", "acknowledged", "snoozed", "dismissed"].includes(value)
                        : key === "rule" ? !RULES.includes(value) : key === "recentHours" ? !["1", "24", "168", "720"].includes(value) : value !== "warning")
            return null;
        result.set(key, value);
    }
    return result.size ? `?${result}` : "";
}
export function projectInsightsSettings(value) {
    if (!isPlainObject(value) || !isPlainObject(value.settings))
        return null;
    const s = value.settings;
    if (s.version !== 1 || !positive(s.revision) || typeof s.enabled !== "boolean" ||
        !(s.observedRevision === null || positive(s.observedRevision) && s.observedRevision <= s.revision) ||
        !oneOf(s.status, ["pending", "ready", "degraded", "unsupported", "disabled", "unavailable"]) ||
        !(s.lastObservedAt === null || date(s.lastObservedAt)) || !(s.gapReason === null || oneOf(s.gapReason, GAPS)) || s.retentionDays !== 30)
        return null;
    return { settings: pick(s, ["version", "revision", "enabled", "observedRevision", "status", "lastObservedAt", "gapReason", "retentionDays"]) };
}
export function projectInsight(value, findingId) {
    if (!isPlainObject(value) || !id(value.findingId, FINDING_ID) || findingId !== undefined && value.findingId !== findingId ||
        !oneOf(value.ruleId, RULES) || !oneOf(value.state, ["open", "resolved"]) || !positive(value.revision) ||
        !positive(value.firstSequence) || !positive(value.lastSequence) || value.lastSequence < value.firstSequence ||
        !positive(value.count) || !positive(value.threshold) || value.count < value.threshold || !date(value.firstObservedAt) ||
        !date(value.lastObservedAt) || Date.parse(value.lastObservedAt) < Date.parse(value.firstObservedAt) ||
        !oneOf(value.coverage, ["complete", "partial"]) || !oneOf(value.toolCategory, ["shell", "search", "file", "network", "other", "unknown"]) ||
        !oneOf(value.phase, PHASES) || !positive(value.serviceGeneration) || !date(value.expiresAt) || value.severity !== "warning" ||
        value.templateId !== value.ruleId || value.suggestionId !== SUGGESTIONS[RULES.indexOf(value.ruleId)] ||
        !oneOf(value.sourceAvailability, ["available", "unavailable"]) ||
        !(value.role === null || oneOf(value.role, ["manager", "worker", "reviewer"])) || !isPlainObject(value.attention))
        return null;
    for (const key of ["registeredSourceId", "workspaceEpoch", "nativeSessionId", "journalGeneration"])
        if (!id(value[key]))
            return null;
    for (const key of ["phaseStartedAt", "lastProgressAt", "healthObservedAt"])
        if (!(value[key] === null || date(value[key])))
            return null;
    if (!(value.stallThresholdMs === null || positive(value.stallThresholdMs)) || !Array.isArray(value.matchedCallIds) || value.matchedCallIds.length > 16 ||
        value.matchedCallIds.some(ref => !id(ref)) || new Set(value.matchedCallIds).size !== value.matchedCallIds.length)
        return null;
    const a = value.attention;
    if (!oneOf(a.state, ["unacknowledged", "acknowledged", "snoozed", "dismissed"]) || !positive(a.revision) || !(a.snoozedUntil === null || date(a.snoozedUntil)))
        return null;
    let recovery = null;
    if (value.state === "resolved") {
        const r = value.recovery;
        if (!isPlainObject(r) || r.predicate !== RECOVERY[RULES.indexOf(value.ruleId)] || !positive(r.sequence) || r.sequence <= value.lastSequence || !id(r.referenceId))
            return null;
        recovery = pick(r, ["predicate", "sequence", "referenceId"]);
    }
    else if (value.recovery !== null)
        return null;
    return { ...pick(value, ["findingId", "ruleId", "state", "revision", "firstSequence", "lastSequence", "count", "threshold", "firstObservedAt", "lastObservedAt",
            "coverage", "toolCategory", "phase", "phaseStartedAt", "lastProgressAt", "healthObservedAt", "stallThresholdMs", "registeredSourceId", "workspaceEpoch", "nativeSessionId",
            "serviceGeneration", "journalGeneration", "severity", "templateId", "suggestionId", "sourceAvailability", "role", "expiresAt"]),
        matchedCallIds: [...value.matchedCallIds], recovery, attention: pick(a, ["state", "revision", "snoozedUntil"]) };
}
export function projectInsightDetail(value, findingId) {
    if (!isPlainObject(value))
        return null;
    const finding = projectInsight(value.finding, findingId);
    return finding ? { finding } : null;
}
export function projectInsightsList(value) {
    const settings = projectInsightsSettings(value);
    if (!settings || !isPlainObject(value) || !Array.isArray(value.findings) || value.findings.length > 100 || !(value.nextCursor === null || id(value.nextCursor, FINDING_ID)))
        return null;
    const findings = value.findings.map(finding => projectInsight(finding));
    if (findings.some(finding => finding === null) || new Set(findings.map(finding => finding.findingId)).size !== findings.length)
        return null;
    return { ...settings, findings, nextCursor: value.nextCursor };
}
export function projectInsightsSummary(value, serverId) {
    if (!isPlainObject(value) || value.serverId !== serverId || !Array.isArray(value.boxes) || value.boxes.length > 100 ||
        !(value.nextCursor === null || id(value.nextCursor, /^sbx_[A-Za-z0-9_-]{4,72}$/)))
        return null;
    const boxes = [];
    for (const box of value.boxes) {
        if (!isPlainObject(box) || !id(box.sandboxId, /^sbx_[A-Za-z0-9_-]{4,72}$/) ||
            !Number.isSafeInteger(box.openFindings) || Number(box.openFindings) < 0 || Number(box.openFindings) > 1000 ||
            !Number.isSafeInteger(box.attentionNeeded) || Number(box.attentionNeeded) < 0 || Number(box.attentionNeeded) > Number(box.openFindings))
            return null;
        const monitor = projectInsightsSettings({ settings: box.monitor });
        if (!monitor)
            return null;
        let latest = null;
        if (box.latestFinding !== null) {
            const f = box.latestFinding;
            if (!isPlainObject(f) || !id(f.findingId, FINDING_ID) || !oneOf(f.ruleId, RULES) || !positive(f.count) || !date(f.lastObservedAt) ||
                !(f.role === null || oneOf(f.role, ["manager", "worker", "reviewer"])))
                return null;
            latest = pick(f, ["findingId", "ruleId", "count", "lastObservedAt", "role"]);
        }
        boxes.push({ sandboxId: box.sandboxId, monitor: monitor.settings, openFindings: box.openFindings, attentionNeeded: box.attentionNeeded, latestFinding: latest });
    }
    if (new Set(boxes.map(box => box.sandboxId)).size !== boxes.length)
        return null;
    return { serverId, boxes, nextCursor: value.nextCursor };
}
