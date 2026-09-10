// Run with: cd server && node scripts/testSalesforceAuth.js
// Isolates the Salesforce connection from the rest of the app so you can
// see exactly what's being sent, without digging through server logs.
import "dotenv/config";
import path from "path";
import fs from "fs";

function mask(v) {
  if (!v) return "(not set)";
  return v.length > 10 ? v.slice(0, 6) + "…" + v.slice(-4) : "(set)";
}

console.log("── Config ─────────────────────────────────────────────");
console.log("SF_LOGIN_URL   :", process.env.SF_LOGIN_URL || "(not set)");
console.log("SF_CLIENT_ID   :", mask(process.env.SF_CLIENT_ID));
console.log("SF_USERNAME    :", process.env.SF_USERNAME || "(not set)");
console.log("SF_API_VERSION :", process.env.SF_API_VERSION || "(not set)");
console.log("SF_MOCK        :", process.env.SF_MOCK);

let keyContent;
if (process.env.SF_PRIVATE_KEY) {
  console.log("Key source     : SF_PRIVATE_KEY (env var)");
  keyContent = process.env.SF_PRIVATE_KEY.replace(/\\n/g, "\n");
} else {
  const keyPath = path.resolve(process.env.SF_PRIVATE_KEY_PATH || "./config/salesforce.key");
  console.log("Key source     : SF_PRIVATE_KEY_PATH →", keyPath);
  try {
    keyContent = fs.readFileSync(keyPath, "utf8");
  } catch (err) {
    console.error("\n❌ Could not read the key file:", err.message);
    process.exit(1);
  }
}

const trimmed = keyContent.trim();
const looksValid = trimmed.startsWith("-----BEGIN PRIVATE KEY-----") && trimmed.endsWith("-----END PRIVATE KEY-----");
console.log("Key looks like a valid PEM block:", looksValid);
console.log("Key line count:", keyContent.split("\n").length, "(a 2048-bit RSA key is usually ~28-30 lines)");
if (!looksValid) {
  console.error("\n❌ The key content doesn't look like a proper PEM file — this alone would cause 'invalid assertion'.");
  process.exit(1);
}

console.log("\n── Attempting JWT Bearer auth against Salesforce ───────");
const salesforce = await import("../services/salesforceService.js");
try {
  await salesforce.findStore("test-diagnostic-query");
  console.log("✅ Auth succeeded (store just doesn't exist, which is fine — that's a separate query issue).");
} catch (err) {
  console.error("❌ Auth/query failed:", err.message);
}
