const Api = (() => {
  const BASE = "/api";

  async function request(path, { method = "GET", body } = {}) {
    const token = State.get("token");
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }

    if (!res.ok) {
      const message = (data && data.error) || `Request failed (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  return {
    login: (username, password) => request("/auth/login", { method: "POST", body: { username, password } }),
    me: () => request("/auth/me"),
    lookupStore: (query) => request(`/stores/lookup?query=${encodeURIComponent(query)}`),
    startVisit: (payload) => request("/stores/start-visit", { method: "POST", body: payload }),
    getRacks: (storeId) => request(`/racks?storeId=${encodeURIComponent(storeId)}`),
    scanRack: (payload) => request("/racks/scan", { method: "POST", body: payload }),
    reportDiscrepancy: (payload) => request("/racks/discrepancy", { method: "POST", body: payload }),
    completeVisit: (visitId, payload) => request(`/visits/${visitId}/complete`, { method: "POST", body: payload }),
    visitSummary: (visitId) => request(`/visits/${visitId}/summary`),
  };
})();
