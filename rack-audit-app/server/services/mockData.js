// Stand-in for Salesforce responses so the app is fully click-through-able
// with SF_MOCK=true and no org connected. Shaped like the real
// salesforceService return values — only salesforceService.js ever imports
// this file, so nothing else needs to know mock mode exists.
//
// IMPORTANT: qrCode is only ever read *inside* salesforceService.js for
// server-side comparison. It must never be included in what a route sends
// back to the browser — that's what makes verification "blind."

export const stores = [
  { storeId: "001MOCK0000STORE1", storeNumber: "4021", storeName: "Riverside Plaza" },
  { storeId: "001MOCK0000STORE2", storeNumber: "4088", storeName: "Harbor Point Center" },
  // A second "Riverside" store on purpose, so a search for "riverside"
  // returns more than one result — useful for testing the store picker.
  { storeId: "001MOCK0000STORE3", storeNumber: "4099", storeName: "Riverside Commons" },
];

const racks = {
  "001MOCK0000STORE1": [
    { id: "a01MOCK000RACK001", qrCode: "RACK-4021-01", label: "Frozen Aisle · Bay 1", isActive: true, lifecycleStatus: "Active", status: "Not Verified", dimensions: { shape: "Rectangular", depth: 31, width: 120, height: 92, radius: null } },
    { id: "a01MOCK000RACK002", qrCode: "RACK-4021-02", label: "Frozen Aisle · Bay 2", isActive: true, lifecycleStatus: "Active", status: "Not Verified", dimensions: { shape: "Rectangular", depth: 31, width: 120, height: 92, radius: null } },
    { id: "a01MOCK000RACK003", qrCode: "RACK-4021-03", label: "Dairy · Bay 1", isActive: true, lifecycleStatus: "Active", status: "Not Verified", dimensions: { shape: "Circular", depth: null, width: null, height: 92, radius: 45 } },
    // Pre-set to "Issue" — simulates a rack a PREVIOUS visit already flagged.
    // Use this one to confirm the checklist shows "Issue Raised" from the
    // start, not "Pending" until re-scanned.
    { id: "a01MOCK000RACK004", qrCode: "RACK-4021-04", label: "Checkout Endcap · Bay 4", isActive: true, lifecycleStatus: "Active", status: "Issue", dimensions: { shape: "Rectangular", depth: 24, width: 80, height: 60, radius: null } },
    // Retired — use this to test the checklist showing the specific
    // lifecycle label (not a generic "Inactive") and being non-tappable.
    { id: "a01MOCK000RACK005", qrCode: "RACK-4021-05", label: "Bakery · Bay 2", isActive: false, lifecycleStatus: "Retired", status: "Not Verified", dimensions: { shape: "Rectangular", depth: 31, width: 100, height: 88, radius: null } },
    // Pending — same idea, different lifecycle value. Also only reachable
    // via Quick Scan, since it won't appear as tappable in the checklist.
    { id: "a01MOCK000RACK006", qrCode: "RACK-4021-06", label: "Deli Counter · Bay 1", isActive: false, lifecycleStatus: "Pending", status: "Not Verified", dimensions: { shape: "Rectangular", depth: 28, width: 95, height: 90, radius: null } },
  ],
  "001MOCK0000STORE2": [
    { id: "a01MOCK000RACK101", qrCode: "RACK-4088-01", label: "Produce · Bay 1", isActive: true, lifecycleStatus: "Active", status: "Not Verified", dimensions: { shape: "Circular", depth: null, width: null, height: 90, radius: 50 } },
    { id: "a01MOCK000RACK102", qrCode: "RACK-4088-02", label: "Beverage Aisle · Bay 3", isActive: true, lifecycleStatus: "Active", status: "Not Verified", dimensions: { shape: "Rectangular", depth: 28, width: 110, height: 95, radius: null } },
    { id: "a01MOCK000RACK103", qrCode: "RACK-4088-03", label: "Snacks · Bay 2", isActive: true, lifecycleStatus: "Active", status: "Not Verified", dimensions: { shape: "Rectangular", depth: 26, width: 90, height: 85, radius: null } },
    // New Request — the third lifecycle value, kept on the second store so
    // each mock store demonstrates a different case.
    { id: "a01MOCK000RACK104", qrCode: "RACK-4088-04", label: "Bakery · Bay 4", isActive: false, lifecycleStatus: "New Request", status: "Not Verified", dimensions: { shape: "Rectangular", depth: 30, width: 100, height: 92, radius: null } },
  ],
  "001MOCK0000STORE3": [
    { id: "a01MOCK000RACK201", qrCode: "RACK-4099-01", label: "Deli · Bay 1", isActive: true, lifecycleStatus: "Active", status: "Not Verified", dimensions: { shape: "Rectangular", depth: 30, width: 100, height: 90, radius: null } },
    { id: "a01MOCK000RACK202", qrCode: "RACK-4099-02", label: "Bread Aisle · Bay 2", isActive: true, lifecycleStatus: "Active", status: "Not Verified", dimensions: { shape: "Circular", depth: null, width: null, height: 88, radius: 40 } },
  ],
};

// Returns true if the given store matches the search text, either by an
// exact store number match or a partial, case-insensitive name match.
function storeMatchesQuery(store, normalizedQuery) {
  const normalizedNumber = store.storeNumber.toLowerCase();
  const normalizedName = store.storeName.toLowerCase();

  if (normalizedNumber === normalizedQuery) {
    return true;
  }
  if (normalizedName.includes(normalizedQuery)) {
    return true;
  }
  return false;
}

// Returns every store that matches the search text (could be zero, one, or
// several) so the frontend can show a list to pick from.
export function searchStores(query) {
  const normalizedQuery = String(query).trim().toLowerCase();
  const matches = [];

  for (const store of stores) {
    if (storeMatchesQuery(store, normalizedQuery)) {
      matches.push(store);
    }
  }

  return matches;
}

// Full records, codes included — server-side use only.
export function getRacksForStore(storeId) {
  return racks[storeId] || [];
}

export function getRackById(storeId, rackId) {
  const storeRacks = racks[storeId] || [];
  for (const rack of storeRacks) {
    if (rack.id === rackId) {
      return rack;
    }
  }
  return null;
}

export function findRackByQrCode(storeId, qrCode) {
  const storeRacks = racks[storeId] || [];
  for (const rack of storeRacks) {
    if (rack.qrCode === qrCode) {
      return rack;
    }
  }
  return null;
}

export function updateRackStatus(storeId, rackId, status) {
  const rack = getRackById(storeId, rackId);
  if (rack !== null) {
    rack.status = status;
  }
  return rack;
}

// ── Mock Agent Visit / Rack Report ──────────────────────────────────────
// In-memory stand-ins so SF_MOCK=true still exercises the "create in
// Salesforce" code paths end-to-end (and something visible shows up if you
// log these) without a real org connected.
let mockAgentVisitCounter = 0;
const mockAgentVisits = {};

export function createAgentVisit({ storeId, agentName, agentEmail, geo, deviceInfo, selfiePhotoUrl }) {
  mockAgentVisitCounter += 1;
  const id = "mock-av-" + mockAgentVisitCounter;
  mockAgentVisits[id] = {
    id,
    storeId,
    agentName,
    agentEmail,
    geo,
    deviceInfo,
    selfiePhotoUrl,
    status: "In Progress",
    startedAt: new Date().toISOString(),
  };
  return { id };
}

export function completeAgentVisit(agentVisitId, { signaturePhotoUrl, signedBy } = {}) {
  if (!agentVisitId) {
    return null;
  }
  const visit = mockAgentVisits[agentVisitId];
  if (visit) {
    visit.status = "Completed";
    visit.completedAt = new Date().toISOString();
    visit.signaturePhotoUrl = signaturePhotoUrl;
    visit.signedBy = signedBy;
  }
  return { id: agentVisitId };
}

let mockRackReportCounter = 0;
const mockRackReports = {};

// Mirrors submitRackReport's real-mode behavior (rackId present → update
// rack status + create report "together"; rackId absent → create only) so
// mock mode exercises the same two code paths, just without a real
// composite call underneath.
export function submitRackReport({
  storeId, rackId, agentVisitId, scannedCode, reason, notes, photoUrl, resolved, escalateStatus, reportedByName, reportedByEmail, verifiedByEmail,
}) {
  let rackStatus = null;
  if (rackId) {
    rackStatus = resolved ? "Resolved" : escalateStatus || "Issue";
    updateRackStatus(storeId, rackId, rackStatus);
  }

  mockRackReportCounter += 1;
  const id = "mock-rr-" + mockRackReportCounter;
  mockRackReports[id] = {
    id, storeId, rackId, agentVisitId, scannedCode, reason, notes, photoUrl,
    resolution: resolved ? "Resolved" : "Escalated",
    reportedByName, reportedByEmail,
    reportedAt: new Date().toISOString(),
  };

  return { rackReportId: id, rackStatus: rackStatus };
}
