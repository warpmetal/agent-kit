import { CliError } from "./errors.js";

export const MODEL_AUTH_MODES = new Set(["api_key", "chatgpt_subscription"]);
const CATALOG_STATES = new Set(["fresh", "stale", "suppressed"]);

function invalidCatalog() {
  throw new CliError("WarpMetal returned an invalid public model catalog.", {
    exitCode: 3,
  });
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entry(value) {
  if (
    !object(value) ||
    typeof value.entryId !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.modelId !== "string" ||
    !Array.isArray(value.authModes) ||
    value.authModes.some((mode) => !MODEL_AUTH_MODES.has(mode))
  ) {
    invalidCatalog();
  }
  return value;
}

/**
 * Validates the stable public fields needed by the CLI without projecting away
 * snapshot provenance or additive metadata published by the catalog service.
 */
export function validateModelCatalog(value) {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !CATALOG_STATES.has(value.state) ||
    !Array.isArray(value.entries) ||
    !object(value.recommended) ||
    !Array.isArray(value.recommended.managers) ||
    !Array.isArray(value.recommended.workers) ||
    value.recommended.managers.some((id) => typeof id !== "string") ||
    value.recommended.workers.some((id) => typeof id !== "string")
  ) {
    invalidCatalog();
  }
  value.entries.forEach(entry);
  return value;
}

export function filterModelCatalog(catalog, { provider, authMode } = {}) {
  const published = validateModelCatalog(catalog);
  const entries = published.entries.filter(
    (item) =>
      (provider === undefined || item.providerId === provider) &&
      (authMode === undefined || item.authModes.includes(authMode)),
  );
  const retainedIds = new Set(entries.map((item) => item.entryId));
  return {
    ...published,
    entries,
    recommended: {
      ...published.recommended,
      managers: published.recommended.managers.filter((id) => retainedIds.has(id)),
      workers: published.recommended.workers.filter((id) => retainedIds.has(id)),
    },
  };
}

export function modelCatalogHuman(catalog) {
  const header = [
    `Model catalog: ${catalog.state}`,
    `Snapshot: ${catalog.snapshotId ?? "unavailable"}`,
    `Source: ${catalog.sourceAttribution ?? catalog.source?.id ?? "unavailable"}`,
  ];
  if (catalog.entries.length === 0) {
    return [...header, "No models match the published catalog and selected filters."].join("\n");
  }
  const entries = catalog.entries.map(
    (item) =>
      `${item.entryId} (${item.authModes.join(", ")})`,
  );
  return [...header, ...entries].join("\n");
}
