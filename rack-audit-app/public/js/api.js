// Every network call the app makes to its own backend lives in this one
// file. Nothing else in the app calls fetch() directly — that keeps the
// "how do I talk to the server" logic in exactly one place.
import { State } from "./state.js";

const API_BASE_PATH = "/api";

// The shared function every API call below is built on top of. It adds
// the login token automatically (if we have one) and turns a non-2xx
// response into a thrown Error with a readable message.
async function sendRequest(path, options) {
  const httpMethod = options && options.method ? options.method : "GET";
  const requestBody = options && options.body ? options.body : null;

  const headers = {
    "Content-Type": "application/json",
  };
  const token = State.get("token");
  if (token) {
    headers["Authorization"] = "Bearer " + token;
  }

  const fetchOptions = {
    method: httpMethod,
    headers: headers,
  };
  if (requestBody !== null) {
    fetchOptions.body = JSON.stringify(requestBody);
  }

  const response = await fetch(API_BASE_PATH + path, fetchOptions);

  // Try to read a JSON body even on error responses, since our backend
  // sends { error: "message" } on failures. Some responses (like a 204)
  // have no body at all, so this can fail — that's fine, we just treat it
  // as "no data" rather than crashing.
  let responseData = null;
  try {
    responseData = await response.json();
  } catch {
    responseData = null;
  }

  if (!response.ok) {
    let errorMessage = "Request failed (" + response.status + ")";
    if (responseData && responseData.error) {
      errorMessage = responseData.error;
    }
    throw new Error(errorMessage);
  }

  return responseData;
}

export const Api = {
  login(username, password) {
    return sendRequest("/auth/login", { method: "POST", body: { username: username, password: password } });
  },

  me() {
    return sendRequest("/auth/me");
  },

  // Returns an array of matching stores — could be zero, one, or several.
  searchStores(query) {
    return sendRequest("/stores/search?query=" + encodeURIComponent(query));
  },

  startVisit(payload) {
    return sendRequest("/stores/start-visit", { method: "POST", body: payload });
  },

  getRacks(storeId) {
    return sendRequest("/racks?storeId=" + encodeURIComponent(storeId));
  },

  scanRack(payload) {
    return sendRequest("/racks/scan", { method: "POST", body: payload });
  },

  scanAnyRack(payload) {
    return sendRequest("/racks/scan-any", { method: "POST", body: payload });
  },

  reportRack(payload) {
    return sendRequest("/racks/report", { method: "POST", body: payload });
  },

  completeVisit(visitId, payload) {
    return sendRequest("/visits/" + visitId + "/complete", { method: "POST", body: payload });
  },
};
