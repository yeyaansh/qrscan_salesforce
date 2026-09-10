// Small helper around sessionStorage so an accidental refresh mid-audit
// doesn't wipe the agent's progress, without needing a framework.
const KEY = "rackAudit.state";

function load() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

let state = load();

function save() {
  sessionStorage.setItem(KEY, JSON.stringify(state));
}

export const State = {
  get: (key) => state[key],
  set(key, value) {
    state[key] = value;
    save();
  },
  patch(obj) {
    state = { ...state, ...obj };
    save();
  },
  clear() {
    state = {};
    sessionStorage.removeItem(KEY);
  },
  all: () => state,
};

// A stable per-device identifier, persisted across sessions, so repeat
// visits from the same phone are traceable (not tied to browser tab).
export function getDeviceId() {
  let id = localStorage.getItem("rackAudit.deviceId");
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("rackAudit.deviceId", id);
  }
  return id;
}
