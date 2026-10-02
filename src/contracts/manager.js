// Generated from worker/account/manager.ts; SHA-256 2f97f5d43411ef68208cd0a9b001416d535ae51e6b14cfd0a3164eb39d72a787.
/** The owner boundary accepts only the canonical closed, metadata-only schema. */
import { readFileSync } from "node:fs";
const contract = JSON.parse(readFileSync(new URL("./agent-manager-control-v1.schema.json", import.meta.url), "utf8"));
import { isPlainObject } from "./http.js";
export const MANAGER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,159}$/;
const definitions = contract.$defs;
// This small interpreter is deliberately limited to the vocabulary in this
// versioned contract. Unsupported schema additions fail closed at the boundary.
const vocabulary = new Set(["$ref", "type", "const", "enum", "oneOf", "allOf", "properties", "required", "additionalProperties", "items", "maximum", "minimum", "maxItems", "minItems", "uniqueItems", "pattern", "format"]);
function matches(value, rule, depth = 0) {
    if (!rule || depth > 32 || Object.keys(rule).some(key => !vocabulary.has(key)))
        return false;
    if (rule.$ref)
        return rule.$ref.startsWith("#/$defs/") && matches(value, definitions[rule.$ref.slice(8)], depth + 1);
    if ("const" in rule && value !== rule.const || rule.enum && !rule.enum.includes(value))
        return false;
    if (rule.oneOf && rule.oneOf.filter(r => matches(value, r, depth + 1)).length !== 1 || rule.allOf && !rule.allOf.every(r => matches(value, r, depth + 1)))
        return false;
    if (rule.type) {
        const types = Array.isArray(rule.type) ? rule.type : [rule.type];
        const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        if (!types.includes(type) && !(types.includes("integer") && typeof value === "number" && Number.isSafeInteger(value)))
            return false;
        if (type === "object" && !isPlainObject(value))
            return false;
    }
    if (typeof value === "number" && (!Number.isSafeInteger(value) || rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum))
        return false;
    if (typeof value === "string" && (rule.pattern && !new RegExp(rule.pattern).test(value) || rule.format && (rule.format !== "date-time" || value.length > 40 || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))))
        return false;
    if (Array.isArray(value)) {
        if (rule.maxItems !== undefined && value.length > rule.maxItems || rule.minItems !== undefined && value.length < rule.minItems ||
            rule.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length || rule.items && !value.every(v => matches(v, rule.items, depth + 1)))
            return false;
    }
    if (isPlainObject(value)) {
        if (rule.required?.some(key => !Object.hasOwn(value, key)) || rule.additionalProperties === false && Object.keys(value).some(key => !rule.properties || !Object.hasOwn(rule.properties, key)))
            return false;
        if (rule.properties && Object.entries(rule.properties).some(([key, child]) => Object.hasOwn(value, key) && !matches(value[key], child, depth + 1)))
            return false;
    }
    return true;
}
export function projectManager(value, shape, scope = {}) {
    if (!matches(value, definitions[shape]) || !isPlainObject(value))
        return null;
    if (shape === "activityList" || shape === "takeoverList") {
        const rows = value[shape === "activityList" ? "runs" : "takeovers"];
        const field = shape === "activityList" ? "runId" : "operationId";
        if (new Set(rows.map(row => row[field])).size !== rows.length || rows.some(row => !projectManager(row, shape === "activityList" ? "activity" : "takeover", scope)))
            return null;
    }
    else
        for (const [key, wanted] of Object.entries(scope))
            if (wanted !== undefined && value[key] !== wanted)
                return null;
    if (shape === "policy" && value.appliedRevision !== null && Number(value.appliedRevision) > Number(value.revision))
        return null;
    if (shape === "takeover") {
        const receipt = value;
        const policy = receipt.monitorPolicy, hold = receipt.memberHold;
        if (policy.appliedRevision !== null && policy.appliedRevision > policy.desiredRevision ||
            hold.nodeAppliedRevision !== null && hold.nodeAppliedRevision > hold.desiredRevision)
            return null;
        if (["ready", "resumed"].includes(receipt.state) && (policy.appliedRevision !== policy.desiredRevision ||
            hold.nodeAppliedRevision !== hold.desiredRevision || !hold.brokerApplied ||
            !["none_pending", "canceled", "already_available_to_worker"].includes(receipt.pendingInput.state) ||
            (receipt.state === "ready" ? receipt.action !== "pause_manager_and_hold_member" || hold.desiredState !== "active"
                : receipt.action !== "resume_manager_and_release_member" || hold.desiredState !== "released")))
            return null;
    }
    return structuredClone(value);
}
export function managerMutation(value, shape) {
    return matches(value, definitions[shape]) && isPlainObject(value) ? value : null;
}
export function managerListQuery(params, allowFinding = false) {
    for (const key of params.keys()) {
        const value = params.get(key);
        if (!(allowFinding ? ["limit", "cursor", "findingId"] : ["limit", "cursor"]).includes(key) || params.getAll(key).length !== 1 ||
            (key === "limit" ? !/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100 : !MANAGER_ID.test(value)))
            return null;
    }
    return params.size ? `?${params}` : "";
}
