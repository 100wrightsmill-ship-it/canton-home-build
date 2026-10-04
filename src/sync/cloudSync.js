/**
 * Cloud sync layer — Supabase Storage today, structured for future table-based migration.
 *
 * Save semantics:
 * - "saved" status ONLY after Supabase PUT succeeds (cloudOk: true).
 * - localStorage failures affect localOk only; cloud upload still runs.
 * - After successful cloud PUT, local cache is refreshed from that exact snapshot
 *   (full, or slim if quota exceeded) — no re-download from Supabase.
 * - "error" status when cloud upload fails (cloudOk: false).
 *
 * Migration path (not implemented yet):
 * - AppStateSnapshot (this blob) → per-entity rows (projects, pays, contacts, …)
 * - CloudUploadQueue interface stays; swap uploadFn implementation
 */

export const SYNC_SCHEMA_VERSION = 1;

export const SUPABASE_URL = "https://bdckzzweimrmvcvvahbr.supabase.co";
export const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkY2t6endlaW1ybXZjdnZhaGJyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTUyOTkyMiwiZXhwIjoyMDkxMTA1OTIyfQ.A8z-MorFw02VTw_fAsWLPq-T3-BggbdzkPDVSLIZqbg";

export const BUCKET = "cc-data";
export const STATE_PATH = "state.json";
export const STATE_BACKUP_PREFIX = "backups/state-";

export const LOCAL_KEY = "cc_data_v1";
export const UPLOAD_DEBOUNCE_MS = 2000;
export const DOCUMENTS_PREFIX = "documents";

export function sanitizeFileName(name) {
  return (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

export function documentStoragePath(projectId, docId, fileName) {
  return `${DOCUMENTS_PREFIX}/${projectId || "p1"}/${docId}/${sanitizeFileName(fileName)}`;
}

export async function uploadDocumentFile(storagePath, fileOrBlob, contentType) {
  const res = await fetch(storageUrl(storagePath), {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "true",
    },
    body: fileOrBlob,
  });
  return {
    ok: res.ok,
    status: res.status,
    path: storagePath,
    body: res.ok ? null : await res.text().catch(() => ""),
  };
}

export async function fetchDocumentBlob(storagePath) {
  try {
    const res = await fetch(storageUrl(storagePath), { headers: authHeaders() });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        blob: null,
        error: await res.text().catch(() => ""),
      };
    }
    return { ok: true, blob: await res.blob() };
  } catch (err) {
    return { ok: false, blob: null, error: err?.message || String(err) };
  }
}

/** Cloud snapshot: file bytes live in Storage; metadata-only rows in state.json. */
export function prepareCloudSnapshot(state) {
  if (!state || typeof state !== "object") return state;
  const stripDoc = (d) => {
    if (!d) return d;
    if (d.storagePath) return { ...d, data: null };
    return d;
  };
  const next = { ...state };
  if (Array.isArray(next.docs)) {
    next.docs = next.docs.map(stripDoc);
  }
  if (Array.isArray(next.contacts)) {
    next.contacts = next.contacts.map((c) => {
      if (!c) return c;
      if (!Array.isArray(c.docs)) return c;
      return { ...c, docs: c.docs.map(stripDoc) };
    });
  }
  return next;
}

const authHeaders = () => ({
  Authorization: `Bearer ${SUPABASE_KEY}`,
  apikey: SUPABASE_KEY,
});

export function storageUrl(objectPath) {
  return `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`;
}

export async function fetchStorageJson(objectPath) {
  try {
    const res = await fetch(storageUrl(objectPath), { headers: authHeaders() });
    if (res.status === 404 || res.status === 400) {
      return { ok: true, empty: true, data: null, status: res.status };
    }
    if (!res.ok) {
      return {
        ok: false,
        empty: false,
        data: null,
        status: res.status,
        error: await res.text().catch(() => ""),
      };
    }
    return {
      ok: true,
      empty: false,
      data: await res.json(),
      status: res.status,
    };
  } catch (err) {
    return {
      ok: false,
      empty: false,
      data: null,
      status: 0,
      error: err?.message || String(err),
    };
  }
}

/** Retry until cloud responds (data or confirmed empty). */
export async function fetchCloudStateFirst(maxAttempts = 8) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fetchStorageJson(STATE_PATH);
    if (result.ok) return result;
    const delay = Math.min(500 * attempt, 4000);
    await new Promise((r) => setTimeout(r, delay));
  }
  return { ok: false, empty: false, data: null, status: 0, error: "max attempts" };
}

export async function putStorageJson(objectPath, data) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  const res = await fetch(storageUrl(objectPath), {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "x-upsert": "true",
    },
    body,
  });
  return {
    ok: res.ok,
    status: res.status,
    body: res.ok ? null : await res.text().catch(() => ""),
  };
}

/** Monotonic cloud revision (optimistic concurrency). Legacy states without it are revision 0. */
export function getCloudRevision(state) {
  if (!state || typeof state !== "object") return 0;
  const r = state.cloudRevision;
  return typeof r === "number" && Number.isFinite(r) && r >= 0
    ? Math.floor(r)
    : 0;
}

/** Next revision after a successful write when current cloud revision is `currentRevision`. */
export function nextCloudRevision(currentRevision) {
  return getCloudRevision({ cloudRevision: currentRevision }) + 1;
}

/** True when cloud has advanced past the revision this device loaded. */
export function isRevisionStale(currentCloud, loadedRevision) {
  if (loadedRevision == null || loadedRevision === undefined) return true;
  return getCloudRevision(currentCloud) !== loadedRevision;
}

/** Wrap app payload with schema version for future migrations. cloudRevision is assigned at PUT time. */
export function packStateSnapshot(appState) {
  const { cloudRevision: _drop, ...rest } = appState || {};
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    ...rest,
    savedAt: Date.now(),
  };
}

/** Counts used for rollback detection and conflict UI. */
export function stateFingerprint(state) {
  if (!state || typeof state !== "object") {
    return {
      projs: 0,
      pays: 0,
      contacts: 0,
      orders: 0,
      docs: 0,
      phases: 0,
      tasks: 0,
      savedAt: 0,
    };
  }
  return {
    projs: (state.projs || []).length,
    pays: (state.pays || []).length,
    contacts: (state.contacts || []).length,
    orders: (state.orders || []).length,
    docs: (state.docs || []).length,
    phases: (state.phases || []).length,
    tasks: (state.tasks || []).length,
    savedAt: state.savedAt || 0,
  };
}

export function fingerprintSignature(fp) {
  if (!fp) return "empty";
  return [
    fp.projs,
    fp.pays,
    fp.contacts,
    fp.orders,
    fp.docs,
    fp.phases,
    fp.tasks,
  ].join("|");
}

export function formatFingerprintSummary(fp) {
  if (!fp) return "empty";
  return `${fp.projs} projects, ${fp.pays} pays, ${fp.contacts} contractors, ${fp.orders} orders, ${fp.docs} docs`;
}

export function isStorageEmpty(state) {
  return !state || !Array.isArray(state.projs) || state.projs.length === 0;
}

/** Exact match to embedded seed counts (2 projs / 9 pays / 11 contacts today). */
export function isSeedLikeState(state, seedRef) {
  if (!state || !seedRef) return false;
  const a = stateFingerprint(state);
  const s = stateFingerprint(seedRef);
  return (
    a.projs === s.projs &&
    a.pays === s.pays &&
    a.contacts === s.contacts
  );
}

export function hasRealUserData(state, seedRef) {
  if (!state || isStorageEmpty(state)) return false;
  const fp = stateFingerprint(state);
  const seed = stateFingerprint(seedRef);
  return (
    fp.projs > seed.projs ||
    fp.pays > seed.pays + 2 ||
    fp.contacts > seed.contacts + 2
  );
}

/**
 * Detect abnormal mass data loss (not single-record deletes).
 * Example: 81 pays → 9 pays or 3 projects → 2 projects.
 */
export function detectMassDataLoss(baseline, candidate) {
  if (!baseline || !candidate) return { blocked: false, reasons: [] };
  const reasons = [];
  const bP = baseline.projs || 0;
  const cP = candidate.projs || 0;
  if (bP >= 2 && cP < bP) {
    reasons.push(`projects ${bP}→${cP}`);
  }

  const checks = [
    { key: "pays", minRatio: 0.85, minDropAbs: 10 },
    { key: "contacts", minRatio: 0.85, minDropAbs: 3 },
    { key: "orders", minRatio: 0.85, minDropAbs: 2 },
    { key: "docs", minRatio: 0.75, minDropAbs: 5 },
  ];

  for (const { key, minRatio, minDropAbs } of checks) {
    const b = baseline[key] || 0;
    const c = candidate[key] || 0;
    if (b === 0 || c >= b) continue;
    const drop = b - c;
    if (c < b * minRatio || drop >= minDropAbs) {
      reasons.push(`${key} ${b}→${c}`);
    }
  }

  return { blocked: reasons.length > 0, reasons };
}

/**
 * Evaluate whether a normal (non-recovery) upload may proceed.
 * Optimistic concurrency: cloud revision must equal the revision loaded at boot.
 * savedAt is never used for overwrite permission.
 */
export function assessCloudUpload({
  cloudState,
  localPayload,
  loadedRevision,
  seedRef,
}) {
  const localFp = stateFingerprint(localPayload);
  const cloudFp = cloudState ? stateFingerprint(cloudState) : null;
  const cloudEmpty = !cloudState || isStorageEmpty(cloudState);
  const currentRevision = getCloudRevision(cloudState);

  if (
    !cloudEmpty &&
    seedRef &&
    isSeedLikeState(localPayload, seedRef) &&
    hasRealUserData(cloudState, seedRef)
  ) {
    return {
      allowed: false,
      kind: "seed-blocked",
      reasons: ["seed data cannot replace real cloud data"],
      cloud: cloudState,
      cloudFp,
      localFp,
      loadedRevision,
      currentRevision,
    };
  }

  if (loadedRevision == null && !cloudEmpty) {
    return {
      allowed: false,
      kind: "revision-not-loaded",
      reasons: ["cloud revision was not loaded — load cloud before saving"],
      cloud: cloudState,
      cloudFp,
      localFp,
      loadedRevision,
      currentRevision,
    };
  }

  if (!cloudEmpty && isRevisionStale(cloudState, loadedRevision)) {
    return {
      allowed: false,
      kind: "revision-stale",
      reasons: [
        `cloud revision ${currentRevision} ≠ loaded revision ${loadedRevision}`,
      ],
      cloud: cloudState,
      cloudFp,
      localFp,
      loadedRevision,
      currentRevision,
    };
  }

  const lossBaseline = cloudFp;
  const loss = cloudEmpty ? { blocked: false, reasons: [] } : detectMassDataLoss(lossBaseline, localFp);
  if (loss.blocked) {
    return {
      allowed: false,
      kind: "mass-loss",
      reasons: loss.reasons,
      cloud: cloudState,
      cloudFp,
      localFp,
      loadedRevision,
      currentRevision,
    };
  }

  return {
    allowed: true,
    kind: "normal",
    reasons: [],
    cloud: cloudState,
    cloudFp,
    localFp,
    loadedRevision,
    currentRevision,
    nextRevision: cloudEmpty ? 1 : nextCloudRevision(currentRevision),
  };
}

/**
 * Boot: when cloud fetch succeeded and cloud has data, always load cloud.
 * Local cache is never preferred over reachable cloud (savedAt is not used).
 */
export function resolveBootState(cloud, local, seed, { cloudFetchOk = true } = {}) {
  const cloudHas = cloud && Array.isArray(cloud.projs) && cloud.projs.length > 0;
  const localHas = local && Array.isArray(local.projs) && local.projs.length > 0;

  if (cloudHas && cloudFetchOk) {
    const cloudFp = stateFingerprint(cloud);
    const localFp = localHas ? stateFingerprint(local) : null;
    const seedLike = localHas && seed && isSeedLikeState(local, seed);
    const massLoss =
      localHas && detectMassDataLoss(cloudFp, localFp).blocked;
    const staleLocal = localHas && (seedLike || massLoss);

    return {
      source: "cloud",
      data: cloud,
      cloudRevision: getCloudRevision(cloud),
      staleLocalRejected: staleLocal,
      rejectReason: staleLocal
        ? seedLike
          ? "local cache matches seed/demo counts"
          : "local cache is incomplete vs cloud"
        : undefined,
    };
  }

  if (cloudHas) return { source: "cloud", data: cloud, cloudRevision: getCloudRevision(cloud) };
  if (localHas) return { source: "local", data: local, cloudRevision: getCloudRevision(local) };
  if (isStorageEmpty(cloud) && isStorageEmpty(local)) {
    return { source: "seed", data: seed, cloudRevision: 0 };
  }
  return { source: "seed", data: seed, cloudRevision: 0 };
}

export function backupObjectPathForState(stateData) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${STATE_BACKUP_PREFIX}${stamp}.json`;
}

/** Preserve current cloud state before replacing state.json. */
export async function archiveCloudStateBeforeReplace(cloudData) {
  if (!cloudData) return { ok: true, skipped: true, path: null };
  const path = backupObjectPathForState(cloudData);
  const result = await putStorageJson(path, cloudData);
  return { ...result, path, skipped: false };
}

export async function listCloudStateBackups(limit = 40) {
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix: STATE_BACKUP_PREFIX,
        limit,
        sortBy: { column: "created_at", order: "desc" },
      }),
    });
    if (!res.ok) {
      return {
        ok: false,
        items: [],
        error: await res.text().catch(() => ""),
      };
    }
    const items = await res.json();
    return { ok: true, items: Array.isArray(items) ? items : [] };
  } catch (err) {
    return { ok: false, items: [], error: err?.message || String(err) };
  }
}

export async function fetchCloudBackup(objectPath) {
  return fetchStorageJson(objectPath);
}

/**
 * Restore a versioned cloud backup to state.json (archives current cloud first).
 */
export async function restoreCloudBackup(objectPath, { archiveCurrent = true } = {}) {
  const backupRes = await fetchCloudBackup(objectPath);
  if (!backupRes.ok || !backupRes.data) {
    return { ok: false, error: backupRes.error || "backup not found" };
  }

  if (archiveCurrent) {
    const current = await fetchStorageJson(STATE_PATH);
    if (current.ok && current.data) {
      await archiveCloudStateBeforeReplace(current.data);
    }
  }

  const currentRev = getCloudRevision(
    (await fetchStorageJson(STATE_PATH)).data,
  );
  const restored = {
    ...backupRes.data,
    cloudRevision: nextCloudRevision(currentRev),
    savedAt: Date.now(),
    _restoredFrom: objectPath,
    _restoredAt: Date.now(),
  };
  const result = await putStorageJson(STATE_PATH, restored);
  return {
    ok: result.ok,
    data: restored,
    error: result.ok ? null : result.body || `HTTP ${result.status}`,
  };
}

export function readLocalState() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeLocalState(source, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  try {
    localStorage.setItem(LOCAL_KEY, payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/** Strip embedded file blobs before localStorage (mobile quota ~5MB). */
export function slimLocalSnapshot(state) {
  if (!state || typeof state !== "object") return state;
  const slim = { ...state, _localSlim: true };
  if (Array.isArray(slim.docs)) {
    slim.docs = slim.docs.map((d) =>
      d && d.data ? { ...d, data: null, _dataStripped: true } : d,
    );
  }
  if (Array.isArray(slim.contacts)) {
    slim.contacts = slim.contacts.map((c) => {
      if (!c) return c;
      const next = { ...c };
      if (Array.isArray(next.docs)) {
        next.docs = next.docs.map((d) =>
          d && d.data ? { ...d, data: null, _dataStripped: true } : d,
        );
      }
      return next;
    });
  }
  return slim;
}

/**
 * Write the uploaded snapshot to localStorage (cache only — Supabase is source of truth).
 * Tries full payload first, then slim if quota exceeded.
 */
export function writeLocalCacheSnapshot(state) {
  const parsed =
    typeof state === "string"
      ? (() => {
          try {
            return JSON.parse(state);
          } catch {
            return null;
          }
        })()
      : state;
  if (!parsed) {
    return {
      ok: false,
      slimmed: false,
      error: "invalid snapshot",
      bytes: 0,
      fullBytes: 0,
    };
  }
  const fullBytes = JSON.stringify(parsed).length;
  let ok = true;
  let slimmed = false;
  let error = null;
  let bytes = fullBytes;

  const tryWrite = (obj) => {
    const raw = JSON.stringify(obj);
    bytes = raw.length;
    localStorage.setItem(LOCAL_KEY, raw);
  };

  try {
    tryWrite(parsed);
  } catch (fullErr) {
    try {
      tryWrite(slimLocalSnapshot(parsed));
      slimmed = true;
    } catch (slimErr) {
      ok = false;
      error = `${slimErr.name || "Error"}: ${slimErr.message || String(slimErr)}`;
    }
  }

  return { ok, slimmed, error, bytes, fullBytes };
}

/**
 * @param {object} options
 * @param {function} [options.onBeforeUpload] async (ctx) => 'load-cloud' | 'defer'
 * @param {function} [options.onLoadCloud] (cloudData) => void
 * @param {object} [options.seedReference] embedded seed for seed-overwrite detection
 * @param {function} [options.getLoadedRevision] revision loaded at boot (optimistic concurrency token)
 * @param {function} [options.setLoadedRevision] update after load or successful save
 */
export function createCloudUploadQueue({
  onStatusChange,
  logUpload,
  onBeforeUpload,
  onLoadCloud,
  onRefreshLocalCache,
  getLoadedRevision,
  setLoadedRevision,
  seedReference,
}) {
  let cloudReady = false;
  let online = typeof navigator !== "undefined" ? navigator.onLine : true;
  let debounceTimer = null;
  let retryTimer = null;
  let retryCount = 0;
  let pendingPayload = null;
  let inFlight = false;
  let lastLocalOk = true;
  let immediateWaiter = null;

  const setStatus = (s, extra) => onStatusChange?.(s, extra);

  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    const delay = Math.min(1000 * 2 ** retryCount, 60000);
    retryCount += 1;
    retryTimer = setTimeout(() => flush(), delay);
  };

  const flush = async () => {
    if (!cloudReady || !pendingPayload || inFlight) return;

    if (!online) {
      setStatus("offline", { localOk: lastLocalOk, cloudOk: false });
      scheduleRetry();
      return;
    }

    inFlight = true;
    const payload = pendingPayload;
    const loadedRevision = getLoadedRevision?.();

    const cloudRes = await fetchStorageJson(STATE_PATH);
    const cloudState = cloudRes.ok ? cloudRes.data : null;

    const assessment = assessCloudUpload({
      cloudState,
      localPayload: payload,
      loadedRevision,
      seedRef: seedReference,
    });

    if (!assessment.allowed) {
      logUpload?.({
        phase: "blocked",
        ok: false,
        kind: assessment.kind,
        reasons: assessment.reasons,
        savedAt: payload.savedAt,
        loadedRevision: assessment.loadedRevision,
        currentRevision: assessment.currentRevision,
        cloudFp: assessment.cloudFp,
        localFp: assessment.localFp,
      });
      setStatus("conflict", {
        kind: assessment.kind,
        reasons: assessment.reasons,
        loadedRevision: assessment.loadedRevision,
        currentRevision: assessment.currentRevision,
        cloudFp: assessment.cloudFp,
        localFp: assessment.localFp,
        cloudSummary: formatFingerprintSummary(assessment.cloudFp),
        localSummary: formatFingerprintSummary(assessment.localFp),
        localOk: lastLocalOk,
        cloudOk: false,
      });

      if (onBeforeUpload) {
        try {
          const decision = await onBeforeUpload({
            ...assessment,
            cloud: assessment.cloud,
            pending: payload,
          });
          if (decision === "load-cloud") {
            pendingPayload = null;
            const rev = getCloudRevision(assessment.cloud);
            setLoadedRevision?.(rev);
            onLoadCloud?.(assessment.cloud);
            setStatus("idle", { localOk: lastLocalOk, cloudOk: false });
            inFlight = false;
            return;
          }
          inFlight = false;
          scheduleRetry();
          return;
        } catch {
          inFlight = false;
          scheduleRetry();
          return;
        }
      }

      inFlight = false;
      scheduleRetry();
      return;
    }

    if (cloudState) {
      const archive = await archiveCloudStateBeforeReplace(cloudState);
      logUpload?.({
        phase: archive.ok ? "archived" : "archive-failed",
        ok: archive.ok,
        path: archive.path,
        skipped: archive.skipped,
      });
    }

    setStatus("saving", { localOk: lastLocalOk, cloudOk: false });
    const payloadWithRevision = {
      ...payload,
      cloudRevision: assessment.nextRevision,
    };
    const body = JSON.stringify(payloadWithRevision);

    try {
      const result = await putStorageJson(STATE_PATH, body);
      logUpload?.({
        phase: result.ok ? "success" : "failed",
        ok: result.ok,
        httpStatus: result.status,
        bytes: body.length,
        savedAt: payload.savedAt,
        cloudRevision: payloadWithRevision.cloudRevision,
        responseBody: result.body,
      });

      if (result.ok) {
        retryCount = 0;
        clearTimeout(retryTimer);
        setLoadedRevision?.(payloadWithRevision.cloudRevision);
        let cacheSlimmed = false;
        if (onRefreshLocalCache) {
          const cache = onRefreshLocalCache(payloadWithRevision);
          if (cache) {
            lastLocalOk = cache.ok !== false;
            cacheSlimmed = !!cache.slimmed;
          }
        }
        if (immediateWaiter) {
          immediateWaiter.resolve({
            ok: true,
            savedAt: payload.savedAt,
            localOk: lastLocalOk,
            cacheSlimmed,
          });
          immediateWaiter = null;
        }
        if (pendingPayload === payload) {
          pendingPayload = null;
          setStatus("saved", {
            localOk: lastLocalOk,
            cloudOk: true,
            cacheSlimmed,
            savedAt: payload.savedAt,
          });
          setTimeout(
            () => setStatus("idle", { localOk: lastLocalOk, cloudOk: false }),
            3000,
          );
        } else {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => flush(), 100);
        }
      } else {
        const cloudError = result.body || `HTTP ${result.status}`;
        if (immediateWaiter) {
          immediateWaiter.reject(new Error(cloudError));
          immediateWaiter = null;
        }
        setStatus("error", {
          localOk: lastLocalOk,
          cloudOk: false,
          cloudStatus: result.status,
          cloudError,
        });
        scheduleRetry();
      }
    } catch (err) {
      logUpload?.({
        phase: "error",
        ok: false,
        error: err?.message || String(err),
        savedAt: payload.savedAt,
      });
      if (immediateWaiter) {
        immediateWaiter.reject(err);
        immediateWaiter = null;
      }
      setStatus("error", {
        localOk: lastLocalOk,
        cloudOk: false,
        cloudError: err?.message || String(err),
      });
      scheduleRetry();
    } finally {
      inFlight = false;
      if (pendingPayload && !inFlight) scheduleRetry();
    }
  };

  const enqueue = (appState, localWriteFn) => {
    const snapshot = packStateSnapshot(prepareCloudSnapshot(appState));
    const localResult = localWriteFn(snapshot);
    lastLocalOk = localResult?.ok !== false;

    pendingPayload = snapshot;

    if (!cloudReady) {
      setStatus("loading", { localOk: lastLocalOk, cloudOk: false });
      return snapshot;
    }

    if (!online) {
      setStatus("offline", { localOk: lastLocalOk, cloudOk: false });
      scheduleRetry();
      return snapshot;
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => flush(), UPLOAD_DEBOUNCE_MS);
    setStatus("pending", { localOk: lastLocalOk, cloudOk: false });
    return snapshot;
  };

  const setCloudReady = (ready) => {
    cloudReady = ready;
    if (ready && pendingPayload) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => flush(), 100);
    }
  };

  const forceUpload = () => {
    clearTimeout(debounceTimer);
    return flush();
  };

  /** Upload now and resolve only after Supabase PUT succeeds (for document saves). */
  const enqueueImmediate = (appState, localWriteFn) => {
    if (!cloudReady) {
      return Promise.reject(new Error("Cloud not ready"));
    }
    if (!online) {
      return Promise.reject(new Error("Offline"));
    }
    const snapshot = packStateSnapshot(prepareCloudSnapshot(appState));
    const localResult = localWriteFn(snapshot);
    lastLocalOk = localResult?.ok !== false;
    pendingPayload = snapshot;
    clearTimeout(debounceTimer);
    clearTimeout(retryTimer);

    return new Promise((resolve, reject) => {
      immediateWaiter = { resolve, reject };
      flush().catch(reject);
    });
  };

  const onOnline = () => {
    online = true;
    if (pendingPayload) flush();
  };
  const onOffline = () => {
    online = false;
    if (pendingPayload) {
      setStatus("offline", { localOk: lastLocalOk, cloudOk: false });
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }

  return {
    enqueue,
    enqueueImmediate,
    setCloudReady,
    flush,
    forceUpload,
    destroy: () => {
      clearTimeout(debounceTimer);
      clearTimeout(retryTimer);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }
    },
  };
}
