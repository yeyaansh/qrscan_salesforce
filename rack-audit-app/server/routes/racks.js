import express from "express";
import { requireAuth } from "../middleware/auth.js";
import * as salesforce from "../services/salesforceService.js";
import { uploadDataUrl } from "../services/uploadService.js";

const router = express.Router();

function convertRackForClient(rack) {
  return {
    id: rack.id,
    label: rack.label,
    isActive: rack.isActive,
    status: rack.status,
    dimensions: rack.dimensions,
  };
}

// Statuses that mean "a human in Salesforce needs to clear this" — once a
// rack is in one of these states, the app itself must never silently
// change it again just because a later scan happens to match. Only an
// admin/manager changing it directly in Salesforce moves it out of here.
const LOCKED_STATUSES = ["Issue", "Inactive Rack Flagged"];

// Shared by both scan endpoints below, once a specific Salesforce rack
// record has been identified. This only WRITES to Salesforce for the two
// cases that are already final the moment they happen (a clean match, or
// an inactive-rack anomaly, which is system-detected, not a judgment call).
// A mismatch does NOT write anything yet — see the comment on that branch —
// so scanning past several wrong codes on the way to the right one never
// spams Salesforce with attempts that never mattered.
//
// Returns one of five outcomes:
//   "already_verified" — this rack was checked off earlier in the visit
//   "already_flagged"    — this rack has an open Issue/Inactive flag; only Salesforce can clear it
//   "inactive_blocked"     — the code matched, but Salesforce marks this rack inactive
//   "verified"               — the code matched and the rack is active
//   "mismatch"                 — the code did not match what was expected (nothing written yet)
async function resolveScan(storeId, rack, scannedCode, agentEmail) {
  if (rack.status === "Verified") {
    return { outcome: "already_verified", rack: convertRackForClient(rack) };
  }
  if (LOCKED_STATUSES.includes(rack.status)) {
    return { outcome: "already_flagged", rack: convertRackForClient(rack) };
  }

  const expectedCode = String(rack.qrCode).trim();
  const codeThatWasScanned = String(scannedCode).trim();
  const codesMatch = expectedCode === codeThatWasScanned;

  if (codesMatch && rack.isActive === false) {
    // Data-integrity anomaly, not something the field agent should have to
    // resolve — flag it and let Salesforce's own automation take it from
    // there. This one writes immediately: it's a system-detected condition
    // (the rack simply shouldn't be active), not a judgment call the agent
    // is still deciding on the way to.
    await salesforce.updateRackStatus(storeId, rack.id, "Inactive Rack Flagged");
    return { outcome: "inactive_blocked", rack: convertRackForClient(rack) };
  }

  if (codesMatch) {
    await salesforce.updateRackStatus(storeId, rack.id, "Verified", { verifiedByEmail: agentEmail });
    return { outcome: "verified", rack: convertRackForClient(rack) };
  }

  // Codes don't match — deliberately NOT writing to Salesforce here. The
  // agent might scan a different rack next, or realize their own mistake,
  // before ever deciding this is worth reporting. Only /report (below)
  // actually writes "Issue" or "Resolved", once the agent has made a real
  // decision — that's what keeps this from spamming your Salesforce
  // automation on every in-between attempt.
  return { outcome: "mismatch", rack: convertRackForClient(rack) };
}

// GET /api/racks?storeId=...
router.get("/", requireAuth, async (req, res) => {
  const storeId = req.query.storeId;

  if (!storeId) {
    res.status(400).json({ error: "storeId is required" });
    return;
  }

  try {
    const racks = await salesforce.getRacksForStore(storeId);
    const racksForClient = racks.map(convertRackForClient);
    res.json(racksForClient);
  } catch (err) {
    console.error("[racks:list] storeId=" + storeId + " —", err.message);
    res.status(502).json({ error: "Could not reach Salesforce", detail: err.message });
  }
});

// POST /api/racks/scan — "tap a rack, then scan" mode.
// Body: { storeId, rackId, scannedCode, geo }
router.post("/scan", requireAuth, async (req, res) => {
  const storeId = req.body.storeId;
  const rackId = req.body.rackId;
  const scannedCode = req.body.scannedCode;

  if (!storeId || !rackId || !scannedCode) {
    res.status(400).json({ error: "storeId, rackId and scannedCode are required" });
    return;
  }

  try {
    const rack = await salesforce.getRackById(storeId, rackId);
    if (!rack) {
      res.status(404).json({ error: "Rack not found" });
      return;
    }

    const result = await resolveScan(storeId, rack, scannedCode, req.agent.email);
    res.json(result);
  } catch (err) {
    console.error("[racks:scan] storeId=" + storeId + " rackId=" + rackId + " —", err.message);
    res.status(502).json({ error: "Could not sync with Salesforce", detail: err.message });
  }
});

// POST /api/racks/scan-any — "open the camera, scan whatever's in front of
// you" mode. The server figures out which rack (if any) the code belongs to.
// Body: { storeId, scannedCode, geo }
router.post("/scan-any", requireAuth, async (req, res) => {
  const storeId = req.body.storeId;
  const scannedCode = req.body.scannedCode;

  if (!storeId || !scannedCode) {
    res.status(400).json({ error: "storeId and scannedCode are required" });
    return;
  }

  try {
    const rack = await salesforce.findRackByQrCode(storeId, scannedCode);

    if (!rack) {
      // A code that doesn't belong to any rack on this store's list at
      // all. Nothing to update in Salesforce — there's no record to point at.
      res.json({ outcome: "unknown" });
      return;
    }

    const result = await resolveScan(storeId, rack, scannedCode, req.agent.email);
    res.json(result);
  } catch (err) {
    console.error("[racks:scan-any] storeId=" + storeId + " —", err.message);
    res.status(502).json({ error: "Could not sync with Salesforce", detail: err.message });
  }
});

// POST /api/racks/report — the agent's FINAL decision after a mismatch, an
// inactive-rack flag they want to comment on, or a rack they scanned via
// Quick Scan that didn't match anything at all. This is the only place a
// mismatch actually gets written to Salesforce (see resolveScan above).
//
// Body: { storeId, rackId (nullable), reason, notes, photo (dataURL, required), resolved }
router.post("/report", requireAuth, async (req, res) => {
  const storeId = req.body.storeId;
  const rackId = req.body.rackId || null;
  const reason = req.body.reason;
  const notes = req.body.notes;
  const photo = req.body.photo;
  const resolved = req.body.resolved;

  if (!storeId) {
    res.status(400).json({ error: "storeId is required" });
    return;
  }
  if (!photo) {
    res.status(400).json({ error: "A photo is required to submit this report." });
    return;
  }
  if (!notes || !notes.trim()) {
    res.status(400).json({ error: "A description is required to submit this report." });
    return;
  }

  try {
    const photoUrl = await uploadDataUrl(photo, "reports");

    if (!rackId) {
      // No matching Account_Rack__c record to update — this was a code
      // that didn't match anything at this store. The photo is still kept
      // (see photoUrl above) but there's nowhere in Salesforce to attach
      // it or the notes yet. Flagging this clearly rather than guessing at
      // a Task/Case to create — tell me the object you'd like used here
      // (e.g. a Case on the Account) and I'll wire it in.
      res.json({ ok: true, linkedToSalesforce: false, photoUrl: photoUrl, reason: reason, notes: notes });
      return;
    }

    if (resolved) {
      await salesforce.updateRackStatus(storeId, rackId, "Resolved", { verifiedByEmail: req.agent.email });
    } else {
      await salesforce.updateRackStatus(storeId, rackId, "Issue", { verifiedByEmail: req.agent.email });
    }

    res.json({ ok: true, linkedToSalesforce: true, photoUrl: photoUrl, reason: reason, notes: notes });
  } catch (err) {
    console.error("[racks:report] storeId=" + storeId + " rackId=" + rackId + " —", err.message);
    res.status(502).json({ error: "Could not sync with Salesforce", detail: err.message });
  }
});

export default router;
