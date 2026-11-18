/**
 * DB-mode persist queue: coalesces snapshots and drains serially.
 * Uses computeDeltaOps for zero-edit detection (no count-only fingerprint).
 */
import { computeDeltaOps } from "./deltaApply.js";

export function createDbPersistQueue({
  applyDelta,
  onSaving,
  onSaved,
  onError,
  isOffline = () => false,
}) {
  let inFlight = false;
  let pendingSnap = null;
  let lastSavedSnap = null;
  let drainPromise = null;

  async function runDrainLoop() {
    while (pendingSnap) {
      if (isOffline()) return;

      const before = lastSavedSnap;
      const snap = pendingSnap;
      pendingSnap = null;

      if (!before) {
        lastSavedSnap = snap;
        return;
      }

      const ops = computeDeltaOps(before, snap);
      if (ops.length === 0) {
        lastSavedSnap = snap;
        continue;
      }

      inFlight = true;
      onSaving?.();
      try {
        const result = await applyDelta(before, snap);
        lastSavedSnap = snap;
        onSaved?.({ ops, result });
      } catch (err) {
        pendingSnap = snap;
        onError?.(err);
        return;
      } finally {
        inFlight = false;
      }
    }
  }

  function drain() {
    if (isOffline()) return Promise.resolve();
    if (drainPromise) return drainPromise;
    drainPromise = runDrainLoop().finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  function schedule(snap) {
    pendingSnap = snap;
    void drain();
  }

  function setBaseline(snap) {
    lastSavedSnap = snap;
    pendingSnap = null;
    inFlight = false;
    drainPromise = null;
  }

  function pendingDeltaCount(snap) {
    if (!lastSavedSnap || !snap) return 0;
    return computeDeltaOps(lastSavedSnap, snap).length;
  }

  function isBusy() {
    return inFlight || pendingSnap != null || drainPromise != null;
  }

  async function flush() {
    while (isBusy()) {
      await drain();
    }
  }

  return { schedule, setBaseline, pendingDeltaCount, drain, flush, isBusy };
}
