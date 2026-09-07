/**
 * Server-to-server Salesforce connection.
 *
 * The app authenticates itself to Salesforce ONCE, as a single integration
 * user, using the OAuth 2.0 JWT Bearer flow — no agent ever enters Salesforce
 * credentials. Every agent who is logged into the app (via /api/auth) and
 * has an allowed `position` shares this same backend connection.
 *
 * Setup in Salesforce (Setup → App Manager → New Connected App):
 *  1. Enable OAuth Settings, check "Use digital signatures", upload the
 *     public certificate that pairs with SF_PRIVATE_KEY_PATH below.
 *  2. OAuth scopes: "Manage user data via APIs (api)", "Perform requests at
 *     any time (refresh_token, offline_access)".
 *  3. Under the Connected App's policy, set "Permitted Users" to
 *     "Admin approved users are pre-authorized" and pre-authorize the
 *     integration user (SF_USERNAME).
 *  4. Copy the Consumer Key into SF_CLIENT_ID.
 */
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const mock = require("./mockData");

const isMock = () => String(process.env.SF_MOCK).toLowerCase() === "true";

let cachedToken = null; // { accessToken, instanceUrl, expiresAt }

function loadPrivateKey() {
  const keyPath = path.resolve(process.env.SF_PRIVATE_KEY_PATH || "./config/salesforce.key");
  return fs.readFileSync(keyPath, "utf8");
}

async function authenticate() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
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

  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Salesforce auth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
    expiresAt: Date.now() + 15 * 60_000, // SF access tokens are long-lived; refresh proactively anyway
  };
  return cachedToken;
}

async function sfFetch(pathAndQuery, options = {}) {
  const { accessToken, instanceUrl } = await authenticate();
  const apiVersion = process.env.SF_API_VERSION || "60.0";
  const res = await fetch(`${instanceUrl}/services/data/v${apiVersion}${pathAndQuery}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Salesforce API ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Find a Store (Account) by number or name. */
async function findStore(query) {
  if (isMock()) return mock.findStore(query);

  const soql = `SELECT Id, Name, Store_Number__c FROM Account WHERE Store_Number__c = '${escapeSoql(
    query
  )}' OR Name LIKE '%${escapeSoql(query)}%' LIMIT 1`;
  const data = await sfFetch(`/query/?q=${encodeURIComponent(soql)}`);
  const rec = data.records && data.records[0];
  if (!rec) return null;
  return { storeId: rec.Id, storeNumber: rec.Store_Number__c, storeName: rec.Name };
}

/** All racks (Account_Rack__c) expected at a given store. */
async function getRacksForStore(storeId) {
  if (isMock()) return mock.getRacksForStore(storeId);

  const soql = `SELECT Id, Name, QR_Code__c, Bay_Location__c, Is_Active__c, Status__c
                FROM Account_Rack__c WHERE Store__c = '${escapeSoql(storeId)}'`;
  const data = await sfFetch(`/query/?q=${encodeURIComponent(soql)}`);
  return (data.records || []).map((r) => ({
    id: r.Id,
    qrCode: r.QR_Code__c,
    label: r.Bay_Location__c || r.Name,
    isActive: r.Is_Active__c,
    status: r.Status__c,
  }));
}

/** Write a rack's verification result back to Account_Rack__c. */
async function updateRackStatus(storeId, rackId, status, { verifiedBy, verifiedAt } = {}) {
  if (isMock()) return mock.updateRackStatus(storeId, rackId, status);

  await sfFetch(`/sobjects/Account_Rack__c/${rackId}`, {
    method: "PATCH",
    body: JSON.stringify({
      Status__c: status, // e.g. "Verified" | "Discrepancy" | "Resolved"
      Last_Verified_By__c: verifiedBy,
      Last_Verified_Date__c: verifiedAt || new Date().toISOString(),
    }),
  });
  return { id: rackId, status };
}

/** Create a follow-up Task assigned to the store manager for an unresolved discrepancy. */
async function createManagerTask({ subject, description, rackId, ownerId }) {
  if (isMock()) {
    return { id: `00TMOCK${Date.now()}`, subject, description };
  }

  const data = await sfFetch(`/sobjects/Task`, {
    method: "POST",
    body: JSON.stringify({
      Subject: subject,
      Description: description,
      WhatId: rackId, // links the Task to the Account_Rack__c record
      OwnerId: ownerId, // Salesforce User Id of the manager, if known
      Status: "Not Started",
      Priority: "High",
    }),
  });
  return { id: data.id, subject, description };
}

function escapeSoql(value) {
  return String(value).replace(/'/g, "\\'");
}

module.exports = {
  findStore,
  getRacksForStore,
  updateRackStatus,
  createManagerTask,
  isMock,
};
