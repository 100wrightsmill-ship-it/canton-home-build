import { PRODUCTION_API_BASE } from "./isProductionMode.js";

const PRODUCTION_CACHE_KEY = "cc_production_readonly_v1";

async function api(path, options = {}) {
  const res = await fetch(`${PRODUCTION_API_BASE}${path}`, {
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

export async function productionFetchState() {
  try {
    const data = await api("/state");
    if (data.state) {
      localStorage.setItem(PRODUCTION_CACHE_KEY, JSON.stringify({ state: data.state, savedAt: Date.now() }));
    }
    return { ok: true, offline: false, state: data.state, counts: data.counts };
  } catch (e) {
    const cached = localStorage.getItem(PRODUCTION_CACHE_KEY);
    if (cached) {
      const { state, savedAt } = JSON.parse(cached);
      return { ok: true, offline: true, state, savedAt, error: e.message };
    }
    return { ok: false, offline: true, error: e.message, state: null };
  }
}

export async function productionApplyDelta(before, after) {
  return api("/delta", {
    method: "POST",
    body: JSON.stringify({ before, after }),
  });
}

export function productionSnapshot(state) {
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
