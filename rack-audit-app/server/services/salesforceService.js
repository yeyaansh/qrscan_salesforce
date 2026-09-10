/**
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

function escapeSoql(value) {
  return String(value).replace(/'/g, "\\'");
}

// The Account_Rack__c field that scan results get written to. Deliberately
// separate from Status__c, which tracks the rack's own lifecycle (New
// Request/Pending/Active/Retired) — writing "Verified"/"Issue" into that
// field would both erase the lifecycle value AND break isActive detection
// (which reads Status__c === "Active"). Override with
// SF_VERIFICATION_STATUS_FIELD if you ever rename the field in Salesforce.
const VERIFICATION_STATUS_FIELD = process.env.SF_VERIFICATION_STATUS_FIELD || "Verification_Status__c";

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
