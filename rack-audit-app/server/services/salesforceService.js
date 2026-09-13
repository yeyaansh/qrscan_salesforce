/**#YEYAANSH
 * Server-to-server Salesforce connection — the ONLY place in this app that
 * knows how to talk to Salesforce, and the ONLY place that ever sees a
 * rack's real QR code. Routes never receive or forward that value to the
 * browser; every comparison happens in here.
 *
 * The app authenticates itself once, as a single integration user, using
 * the OAuth 2.0 JWT Bearer flow — no agent ever enters Salesforce
 * credentials. See README.md §3 for the Connected App setup steps.
 */
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import * as mock from "./mockData.js";

function isMockModeEnabled() {
  const value = String(process.env.SF_MOCK).toLowerCase();
  if (value === "true") {
    return true;
  }
  return false;
}

let cachedToken = null; // { accessToken, instanceUrl, expiresAt }

function loadPrivateKey() {
  if (process.env.SF_PRIVATE_KEY) {
    return process.env.SF_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  const keyPath = path.resolve(process.env.SF_PRIVATE_KEY_PATH || "./config/salesforce.key");
  return fs.readFileSync(keyPath, "utf8");
}

async function authenticate() {
  const tokenIsStillValid = cachedToken !== null && cachedToken.expiresAt > Date.now() + 60_000;
  if (tokenIsStillValid) {
    return cachedToken;
  }

  const loginUrl = process.env.SF_LOGIN_URL || "https://login.salesforce.com";

  const assertion = jwt.sign(
    {
      iss: process.env.SF_CLIENT_ID,
      sub: process.env.SF_USERNAME,
      aud: loginUrl,
      exp: Math.floor(Date.now() / 1000) + 180,
    },
    loadPrivateKey(),
    { algorithm: "RS256" }
  );

  const response = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: assertion,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Salesforce auth failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  cachedToken = {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
    expiresAt: Date.now() + 15 * 60_000,
  };
  return cachedToken;
}

// Makes one authenticated call to the Salesforce REST API. Every other
// function in this file goes through this one instead of calling fetch()
// directly, so authentication and error handling only need to be written
// once. This is also the single spot to look at when counting how many
// real Salesforce API calls a given operation makes — every one goes
// through here, exactly once per call.
async function callSalesforceApi(pathAndQuery, requestOptions = {}) {
  const token = await authenticate();
  const apiVersion = process.env.SF_API_VERSION || "60.0";
  const url = `${token.instanceUrl}/services/data/v${apiVersion}${pathAndQuery}`;

  const headers = {
    Authorization: `Bearer ${token.accessToken}`,
    "Content-Type": "application/json",
  };
  if (requestOptions.headers) {
    Object.assign(headers, requestOptions.headers);
  }

  const response = await fetch(url, {
    method: requestOptions.method,
    body: requestOptions.body,
    headers: headers,
  });

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      errorBody = "(could not read error response)";
    }
    throw new Error(`Salesforce API ${response.status}: ${errorBody}`);
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

// A single Salesforce API call that runs MULTIPLE DML subrequests (across
// different sObject types) atomically. Used by submitRackReport() below to
// turn "update Account_Rack__c" + "create Rack_Report__c" — previously two
// separate authenticated HTTP round trips — into exactly one real call to
// Salesforce, while also gaining transactional safety: with allOrNone
// true, if either subrequest fails, BOTH are rolled back, so you can never
// end up with a rack marked "Issue" with no Rack_Report__c behind it (or a
// report with no matching status change).
//
// Each subrequest's httpStatusCode is checked individually: the OUTER HTTP
// call can come back 200 even when allOrNone rolled everything back, so
// "the composite request succeeded" and "every subrequest succeeded" are
// two different things and only the second one actually matters here.
async function callSalesforceComposite(subrequests, allOrNone = true) {
  const data = await callSalesforceApi(`/composite`, {
    method: "POST",
    body: JSON.stringify({ allOrNone: allOrNone, compositeRequest: subrequests }),
  });

  const results = data.compositeResponse || [];
  for (const result of results) {
    const succeeded = result.httpStatusCode >= 200 && result.httpStatusCode < 300;
    if (!succeeded) {
      throw new Error(
        `Salesforce composite subrequest "${result.referenceId}" failed (${result.httpStatusCode}): ${JSON.stringify(result.body)}`
      );
    }
  }
  return results;
}

function escapeSoql(value) {
  return String(value).replace(/'/g, "\\'");
}

// Generic create/update, shared by Agent Visit and Rack Report below — same
// reasoning as callSalesforceApi itself: written once so every object gets
// the same error handling, instead of each function rolling its own fetch.
async function createSalesforceRecord(objectApiName, fields) {
  const data = await callSalesforceApi(`/sobjects/${objectApiName}`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
  return { id: data.id };
}

async function updateSalesforceRecord(objectApiName, recordId, fields) {
  await callSalesforceApi(`/sobjects/${objectApiName}/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
  return { id: recordId };
}

// The Account_Rack__c field that scan results get written to. Deliberately
// separate from Status__c, which tracks the rack's own lifecycle (New
// Request/Pending/Active/Retired) — writing "Verified"/"Issue" into that
// field would both erase the lifecycle value AND break isActive detection
// (which reads Status__c === "Active"). Hardcoded rather than configurable —
// if you ever rename the field in Salesforce, change it here.
const VERIFICATION_STATUS_FIELD = "Verification_Status__c";

// Converts one Account_Rack__c query result into the shape the rest of
// this app works with. The QR code and active/inactive state live on THIS
// object (not Rack__c, which is just a shape/dimensions spec sheet with no
// per-installation data) — confirmed via the Rack__c field screenshots.
//
// ASSUMPTION FLAGGED: the Rack__c dimension field API names below
// (Rack_Shape__c, Depth__c, Width__c, Height__c, Radius__c) follow your
// org's established naming convention but haven't been confirmed the way
// Account_Rack__c's fields were. If a query errors with an INVALID_FIELD
// for one of these, send me the real API name and I'll swap it in.
function convertSalesforceRecordToRack(record) {
  let label = "Empty Rack Name";
  let shape = null;
  let depth = null;
  let width = null;
  let height = null;
  let radius = null;

  if (record.Rack__r) {
    label = record.Rack__r.Name;
    shape = record.Rack__r.Rack_Shape__c || null;
    depth = record.Rack__r.Depth__c || null;
    width = record.Rack__r.Width__c || null;
    height = record.Rack__r.Height__c || null;
    radius = record.Rack__r.Radius__c || null;
  }

  const qrCode = record.Name;

  let isActive = false;
  if (record.Status__c && record.Status__c === "Active") {
    isActive = true;
  }

  return {
    id: record.Id, // the Account_Rack__c junction record Id
    qrCode: qrCode,
    label: label,
    isActive: isActive,
    lifecycleStatus: record.Status__c || null, // the raw lifecycle value: "New Request" / "Pending" / "Active" / "Retired"
    status: record[VERIFICATION_STATUS_FIELD], // "Not Verified" / "Verified" / "Issue" / "Resolved" / "Inactive Rack Flagged"
    dimensions: { shape: shape, depth: depth, width: width, height: height, radius: radius },
  };
}

const RACK_QUERY_FIELDS =
  `Id, Name, Status__c, ${VERIFICATION_STATUS_FIELD}, Install_Date__c, Rack__c, ` +
  `Rack__r.Name, Rack__r.Rack_Shape__c, Rack__r.Depth__c, Rack__r.Width__c, Rack__r.Height__c, Rack__r.Radius__c`;

/**
 * Searches for stores (Accounts) matching a number or name. Returns an
 * array — could be zero, one, or several matches — so the frontend can
 * show a list for the agent to pick from.
 */
export async function searchStores(query) {
  if (isMockModeEnabled()) {
    return mock.searchStores(query);
  }

  const soql = `SELECT Id, Name, Store_Number__c FROM Account
                WHERE Store_Number__c = '${escapeSoql(query)}' OR Name LIKE '%${escapeSoql(query)}%'
                LIMIT 10`;
  const data = await callSalesforceApi(`/query/?q=${encodeURIComponent(soql)}`);

  const results = [];
  for (const record of data.records || []) {
    results.push({
      storeId: record.Id,
      storeNumber: record.Store_Number__c,
      storeName: record.Name,
    });
  }
  return results;
}

/**
 * Full rack records (codes included) for a store — SERVER-SIDE USE ONLY.
 * Used to build the client-safe checklist and to look up which rack a
 * scanned code belongs to in "scan any rack" mode.
 */
export async function getRacksForStore(storeId) {
  if (isMockModeEnabled()) {
    return mock.getRacksForStore(storeId);
  }

  const soql = `SELECT ${RACK_QUERY_FIELDS} FROM Account_Rack__c WHERE Account__c = '${escapeSoql(storeId)}'`;
  const data = await callSalesforceApi(`/query/?q=${encodeURIComponent(soql)}`);

  const results = [];
  for (const record of data.records || []) {
    results.push(convertSalesforceRecordToRack(record));
  }
  return results;
}

/** A single Account_Rack__c, fetched fresh — the source of truth for one scan. */
export async function getRackById(storeId, rackId) {
  if (isMockModeEnabled()) {
    return mock.getRackById(storeId, rackId);
  }

  const soql = `SELECT ${RACK_QUERY_FIELDS} FROM Account_Rack__c WHERE Id = '${escapeSoql(rackId)}' LIMIT 1`;
  const data = await callSalesforceApi(`/query/?q=${encodeURIComponent(soql)}`);

  const records = data.records || [];
  if (records.length === 0) {
    return null;
  }
  return convertSalesforceRecordToRack(records[0]);
}

/** Finds which rack (if any) a scanned code belongs to — powers "scan any rack" mode. */
export async function findRackByQrCode(storeId, qrCode) {
  if (isMockModeEnabled()) {
    return mock.findRackByQrCode(storeId, qrCode);
  }

  const allRacksAtStore = await getRacksForStore(storeId);
  for (const rack of allRacksAtStore) {
    if (rack.qrCode === qrCode) {
      return rack;
    }
  }
  return null;
}

/**
 * Writes a scan result back to the Account_Rack__c junction record.
 * Called only at the moment something should actually be recorded — see
 * routes/racks.js for exactly when that is (immediately on a verified
 * match, but only once the agent makes a final decision for anything else,
 * to avoid writing to Salesforce on every in-between attempt).
 */
export async function updateRackStatus(storeId, rackId, status, options = {}) {
  if (isMockModeEnabled()) {
    return mock.updateRackStatus(storeId, rackId, status);
  }

  const fieldsToUpdate = {
    [VERIFICATION_STATUS_FIELD]: status,
    Last_Verified_Date__c: new Date().toISOString().slice(0, 10), // Date-type field (YYYY-MM-DD)
  };

  if (options.verifiedByEmail) {
    fieldsToUpdate.Last_Verified_By__c = options.verifiedByEmail; // Email-type field
  }

  await callSalesforceApi(`/sobjects/Account_Rack__c/${rackId}`, {
    method: "PATCH",
    body: JSON.stringify(fieldsToUpdate),
  });

  return { id: rackId, status: status };
}

// ── Agent Visit (Agent_Visit__c) ────────────────────────────────────────
// The full record of a visit now lives ENTIRELY in Salesforce — nothing
// about a visit (selfie, geo, device, signature, status) is kept in Mongo
// anymore. Mongo is used only for this app's own login (see models/Agent.js);
// the Id this creates below IS the visitId the frontend holds onto for the
// rest of the visit — there is no separate app-side id to translate between.
const AGENT_VISIT_OBJECT = "Agent_Visit__c";

/**
 * Creates the Agent_Visit__c record for a visit the moment it starts (right
 * after the selfie is captured and geolocated). Returns { id } — that
 * Salesforce Id IS the visitId from here on: it's what the frontend sends
 * back to complete this same record, and what gets written to
 * Rack_Report__c.Agent_Visit__c for anything reported during the visit.
 */
export async function createAgentVisit({ storeId, agentName, agentEmail, geo, deviceInfo, selfiePhotoUrl }) {
  if (isMockModeEnabled()) {
    return mock.createAgentVisit({ storeId, agentName, agentEmail, geo, deviceInfo, selfiePhotoUrl });
  }

  const fields = {
    Store__c: storeId,
    Agent_Name__c: agentName,
    Agent_Email__c: agentEmail,
    Visit_Status__c: "In Progress",
    Visit_Started__c: new Date().toISOString(),
  };
  if (selfiePhotoUrl) {
    fields.Selfie_Photo_URL__c = selfiePhotoUrl;
  }
  if (geo) {
    if (geo.lat !== undefined && geo.lat !== null) fields.Start_Latitude__c = geo.lat;
    if (geo.lng !== undefined && geo.lng !== null) fields.Start_Longitude__c = geo.lng;
    if (geo.accuracyMeters !== undefined && geo.accuracyMeters !== null) {
      fields.Location_Accuracy_Meters__c = geo.accuracyMeters;
    }
  }
  if (deviceInfo) {
    // ASSUMPTION FLAGGED: Device_Info__c reads as a single text field on
    // the layout (example value "XYA Device"), so the full object is
    // JSON-encoded into it rather than split across several fields. If
    // there turn out to be separate fields for platform/userAgent/etc.,
    // tell me the API names and I'll split this out.
    fields.Device_Info__c = JSON.stringify(deviceInfo).slice(0, 255);
  }

  return createSalesforceRecord(AGENT_VISIT_OBJECT, fields);
}

/**
 * Updates an existing Agent_Visit__c to "Completed" once the agent signs
 * off. No-ops (returns null) if there's no id to update — that only
 * happens if the frontend somehow lost the visitId, and silently doing
 * nothing is safer than throwing and blocking the agent from finishing.
 */
export async function completeAgentVisit(agentVisitId, { signaturePhotoUrl, signedBy } = {}) {
  if (!agentVisitId) {
    return null;
  }
  if (isMockModeEnabled()) {
    return mock.completeAgentVisit(agentVisitId, { signaturePhotoUrl, signedBy });
  }

  const fields = {
    Visit_Status__c: "Completed",
    Visit_Completed__c: new Date().toISOString(),
  };
  if (signaturePhotoUrl) {
    fields.Signature_Photo_URL__c = signaturePhotoUrl;
  }
  if (signedBy) {
    fields.Signed_By__c = signedBy;
    fields.Signed_At__c = new Date().toISOString();
  }

  return updateSalesforceRecord(AGENT_VISIT_OBJECT, agentVisitId, fields);
}

// ── Rack Report (Rack_Report__c) ────────────────────────────────────────
// The record created every time an agent submits /api/racks/report — a
// mismatch, a lifecycle-status flag, a resolved issue, or a scanned code
// that didn't match any rack at all.
const RACK_REPORT_OBJECT = "Rack_Report__c";

function buildRackReportFields({ storeId, rackId, agentVisitId, scannedCode, reason, notes, photoUrl, resolved, reportedByName, reportedByEmail }) {
  const fields = {
    Store__c: storeId,
    Reason__c: reason,
    Description__c: notes,
    Reported_By_Name__c: reportedByName,
    Reported_By_Email__c: reportedByEmail,
    Reported_At__c: new Date().toISOString(),
    // ASSUMPTION FLAGGED: the screenshot's only visible value was
    // "Escalated", so "Resolved" for the resolved=true path is a
    // reasonable mirror but hasn't been confirmed against the actual
    // picklist. If Resolution__c rejects either value with an
    // INVALID_FIELD_FOR_INSERT_UPDATE / picklist error, send me the exact
    // picklist values and I'll fix the mapping.
    Resolution__c: resolved ? "Resolved On The Spot" : "Escalated",
  };
  if (photoUrl) fields.Photo_URL__c = photoUrl;
  if (rackId) fields.Related_Account_Rack__c = rackId;
  if (scannedCode) fields.Scanned_Code__c = scannedCode;
  if (agentVisitId) fields.Agent_Visit__c = agentVisitId;
  return fields;
}

/**
 * The single entry point for /api/racks/report. Two different shapes
 * happen underneath, both ending in exactly one real Salesforce API call:
 *
 *  - rackId present  → one COMPOSITE call containing two subrequests
 *    (PATCH Account_Rack__c status + POST Rack_Report__c), atomic via
 *    allOrNone. This replaces what used to be two separate sequential
 *    calls (updateRackStatus then createRackReport) — same two DML
 *    operations, half the API calls, and no more risk of one succeeding
 *    without the other.
 *  - rackId absent (an unrecognized scanned code) → there is nothing on
 *    Account_Rack__c to update, so a composite would just be one
 *    subrequest wrapped in overhead for no reason. A single plain create
 *    is used instead.
 *
 * Returns { rackReportId, rackStatus } — rackStatus is null in the
 * no-rackId case, since nothing was written to Account_Rack__c.
 */
export async function submitRackReport({
  storeId,
  rackId,
  agentVisitId,
  scannedCode,
  reason,
  notes,
  photoUrl,
  resolved,
  escalateStatus,
  reportedByName,
  reportedByEmail,
  verifiedByEmail,
}) {
  if (isMockModeEnabled()) {
    return mock.submitRackReport({
      storeId, rackId, agentVisitId, scannedCode, reason, notes, photoUrl, resolved, escalateStatus, reportedByName, reportedByEmail, verifiedByEmail,
    });
  }

  const reportFields = buildRackReportFields({
    storeId, rackId, agentVisitId, scannedCode, reason, notes, photoUrl, resolved, reportedByName, reportedByEmail,
  });

  if (!rackId) {
    const created = await createSalesforceRecord(RACK_REPORT_OBJECT, reportFields);
    return { rackReportId: created.id, rackStatus: null };
  }

  const rackStatus = resolved ? "Resolved" : escalateStatus || "Issue";
  const rackFields = {
    [VERIFICATION_STATUS_FIELD]: rackStatus,
    Last_Verified_Date__c: new Date().toISOString().slice(0, 10),
  };
  if (verifiedByEmail) {
    rackFields.Last_Verified_By__c = verifiedByEmail;
  }

  const apiVersion = process.env.SF_API_VERSION || "60.0";
  const subrequests = [
    {
      method: "PATCH",
      url: `/services/data/v${apiVersion}/sobjects/Account_Rack__c/${rackId}`,
      referenceId: "rackStatusUpdate",
      body: rackFields,
    },
    {
      method: "POST",
      url: `/services/data/v${apiVersion}/sobjects/${RACK_REPORT_OBJECT}`,
      referenceId: "newRackReport",
      body: reportFields,
    },
  ];

  const results = await callSalesforceComposite(subrequests, true);
  const reportResult = results.find((r) => r.referenceId === "newRackReport");
  const rackReportId = reportResult && reportResult.body ? reportResult.body.id : null;

  return { rackReportId: rackReportId, rackStatus: rackStatus };
}
