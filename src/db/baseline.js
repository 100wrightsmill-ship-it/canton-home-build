import { reconcileSnapshot } from "./reconcile.js";

/** Record production baseline from fresh snapshot — defines expected values for this cutover run. */
export function recordProductionBaseline(state, meta = {}) {
  const report = reconcileSnapshot(state);
  return {
    recordedAt: new Date().toISOString(),
    purpose: "production-cutover-baseline",
    cloudRevision: state.cloudRevision ?? null,
    savedAt: state.savedAt ?? null,
    ...meta,
    counts: report.counts,
    extractedTables: report.extractedTables,
    financials: report.financials,
    storagePathCount: report.storagePaths?.length ?? 0,
    sourceWarnings: report.sourceWarnings ?? [],
    duplicateIds: report.duplicateIds ?? [],
    orphans: report.orphans ?? [],
    snapshotPassed: report.passed,
  };
}
