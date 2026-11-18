import { STAGING_API_BASE } from "./isStagingMode.js";

const STAGING_CACHE_KEY = "cc_staging_readonly_v1";

async function api(path, options = {}) {
  const res = await fetch(`${STAGING_API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || res.statusText);
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function stagingHealth() {
  return api("/api/health");
}

export async function stagingFetchState() {
  try {
    const data = await api("/api/state");
    if (data.state) {
      localStorage.setItem(STAGING_CACHE_KEY, JSON.stringify({ state: data.state, savedAt: Date.now() }));
    }
    return { ok: true, offline: false, state: data.state, counts: data.counts };
  } catch (e) {
    const cached = localStorage.getItem(STAGING_CACHE_KEY);
    if (cached) {
      const { state, savedAt } = JSON.parse(cached);
      return { ok: true, offline: true, state, savedAt, error: e.message };
    }
    return { ok: false, offline: true, error: e.message, state: null };
  }
}

export async function stagingApplyDelta(before, after) {
  return api("/api/delta", {
    method: "POST",
    body: JSON.stringify({ before, after }),
  });
}

export async function stagingApplyOps(ops) {
  return api("/api/ops", { method: "POST", body: JSON.stringify({ ops }) });
}

export async function stagingGetAudit(since = 0) {
  return api(`/api/audit?since=${since}`);
}

export async function stagingClearAudit() {
  return api("/api/audit/clear", { method: "POST" });
}

export async function stagingSimulateOffline(offline) {
  return api("/api/simulate-offline", { method: "POST", body: JSON.stringify({ offline }) });
}

export async function stagingEnsureStorageBucket() {
  return api("/api/storage/ensure-bucket", { method: "POST" });
}

export function stagingSnapshot(state) {
  return {
    projs: state.projs,
    phases: state.phases,
    tasks: state.tasks,
    pays: state.pays,
    contacts: state.contacts,
    docs: state.docs,
    folders: state.folders,
    orders: state.orders,
    msgs: state.msgs,
    notifs: state.notifs,
    cp: state.cp,
  };
}
