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
    lifecycleStatus: rack.lifecycleStatus,
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
// record has been identified. A clean match writes immediately, since
// there's no more decision-making left once that happens. Everything else
// — a mismatch, or a rack whose lifecycle status isn't Active — writes
// NOTHING here. Both wait for the agent to actually decide something via
// /report, so a run of wrong-guess scans (or scanning a rack that just
// happens to have a stale lifecycle status) never spams Salesforce with
// attempts that never turned into anything.
//
// Checked in this order — earlier checks win over later ones:
//   1. already_flagged     — an open Issue/Inactive flag; only Salesforce can clear it
//   2. lifecycle_mismatch  — code matched, but Status__c isn't Active (checked
//                            BEFORE already_verified/already_resolved — see note below)
//   3. already_verified    — this rack was already checked off, and no lifecycle
//                            problem was found above
//   4. already_resolved    — this rack's issue was already closed out, and no
//                            lifecycle problem was found above (see note below)
//   5. verified             — the code matched and the rack is Active
//   6. mismatch             — the code did not match what was expected
async function resolveScan(storeId, rack, scannedCode, agentEmail) {
  const expectedCode = String(rack.qrCode).trim();
  const codeThatWasScanned = String(scannedCode).trim();
  // Case- and whitespace-normalized comparison for the match check itself.
  // A strict === here is brittle against real-world QR generation — the
  // sticker's encoded text and Salesforce's Name field only have to differ
  // by case, or pick up incidental whitespace, for a scan that's genuinely
  // the right rack to be silently treated as a "mismatch" and dropped
  // straight into the report flow. Comparing case-insensitively (while
  // still storing/logging the ORIGINAL values below, untouched) fixes that
  // without weakening what actually gets written anywhere.
  const codesMatch = expectedCode.toLowerCase() === codeThatWasScanned.toLowerCase();

  // Log every scan decision — cheap, and the single fastest way to
  // pinpoint exactly why a given scan landed on the outcome it did, without
  // having to reproduce it live. If a "should have matched" scan still
  // shows codesMatch: false here, the two code values printed below are
  // the first place to look — that's the actual root cause, not a status
  // ordering bug.
  console.log(
    "[racks:resolveScan]",
    JSON.stringify({
      rackId: rack.id,
      expectedCode,
      scannedCode: codeThatWasScanned,
      codesMatch,
      lifecycleStatus: rack.lifecycleStatus,
      isActive: rack.isActive,
      verificationStatus: rack.status,
    })
  );

  if (LOCKED_STATUSES.includes(rack.status)) {
    return { outcome: "already_flagged", rack: convertRackForClient(rack) };
  }

  // Lifecycle status takes priority over "already verified" — deliberately
  // checked BEFORE the Verification_Status__c === "Verified" case below.
  // Verification_Status__c can say "Verified" from an earlier visit while
  // Status__c has since moved to Retired/Pending/New Request (or the two
  // simply drifted out of sync some other way) — either way, a matching
  // code means the agent is looking at a rack that is physically here but
  // not marked Active in Salesforce right now, and that discrepancy is
  // worth a human decision every time it's scanned. Letting "already
  // verified" run first (the old order) silently swallowed that warning
  // any time a rack had ever been verified before, which is exactly
  // backwards: the rarer, more important signal should win, not the more
  // common one.
  if (codesMatch && rack.isActive === false) {
    return { outcome: "lifecycle_mismatch", rack: convertRackForClient(rack) };
  }

  if (rack.status === "Verified") {
    return { outcome: "already_verified", rack: convertRackForClient(rack) };
  }

  // Same reasoning as already_verified just above: a "Resolved" rack was
  // already closed out (an earlier Issue got fixed and signed off), and
  // scanning it again should not silently flip it back to "Verified" as
  // if nothing had ever happened. Without this check, resolveScan falls
  // straight through to the codesMatch branch below and calls
  // updateRackStatus(..., "Verified") on it — which is exactly the bug:
  // it doesn't just fail to prompt the agent, it actively overwrites
  // Verification_Status__c and erases the "Resolved" history. This is
  // reachable from BOTH scan endpoints, but in practice only shows up via
  // "Scan Any" — the checklist's own tap targets already block a
  // "resolved" row client-side (see renderChecklist()'s isLocked check in
  // app.js) before a scan attempt is even made, but "Scan Any" has no
  // specific rack to block against ahead of time, so a resolved rack's
  // code can still be scanned there and reach this far.
  if (rack.status === "Resolved") {
    return { outcome: "already_resolved", rack: convertRackForClient(rack) };
  }

  if (codesMatch) {
    await salesforce.updateRackStatus(storeId, rack.id, "Verified", { verifiedByEmail: agentEmail });
    return { outcome: "verified", rack: convertRackForClient(rack) };
  }

  // Codes don't match — deliberately NOT writing to Salesforce here. The
  // agent might scan a different rack next, or realize their own mistake,
  // before ever deciding this is worth reporting. Only /report (below)
  // actually writes anything, once the agent has made a real decision —
  // that's what keeps this from spamming your Salesforce automation on
  // every in-between attempt.
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

// POST /api/racks/report — the agent's FINAL decision after a mismatch, a
// rack whose lifecycle status they want to comment on, or a rack they
// scanned via Quick Scan that didn't match anything at all. This is the
// only place any of those actually gets written to Salesforce (see
// resolveScan above).
//
// visitId here is the Agent_Visit__c Id directly (see routes/stores.js) —
// there's no Mongo document to look it up through anymore, so it's passed
// straight to salesforce.submitRackReport() below.
//
// Body: { storeId, visitId, rackId (nullable), scannedCode, reason, notes,
//         photo (dataURL, required), resolved, escalateStatus }
// escalateStatus lets the frontend pick WHICH locked status gets written
// when the agent escalates rather than resolves — normally "Issue", but
// "Inactive Rack Flagged" when this report came from a lifecycle-status
// warning rather than a plain mismatch, so Salesforce can tell those two
// situations apart.
router.post("/report", requireAuth, async (req, res) => {
  const storeId = req.body.storeId;
  const agentVisitId = req.body.visitId || null;
  const rackId = req.body.rackId || null;
  const scannedCode = req.body.scannedCode || null;
  const reason = req.body.reason;
  const notes = req.body.notes;
  const photo = req.body.photo;
  const resolved = req.body.resolved;
  let escalateStatus = req.body.escalateStatus;
  if (!escalateStatus) {
    escalateStatus = "Issue";
  }

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

    // When rackId is present, this is ONE Salesforce API call (a composite
    // request updating Account_Rack__c's status AND creating the
    // Rack_Report__c together, atomically) instead of the two separate
    // calls it would otherwise take — see submitRackReport() for why.
    const result = await salesforce.submitRackReport({
      storeId: storeId,
      rackId: rackId,
      agentVisitId: agentVisitId,
      scannedCode: scannedCode,
      reason: reason,
      notes: notes,
      photoUrl: photoUrl,
      resolved: !!resolved,
      escalateStatus: escalateStatus,
      reportedByName: req.agent.fullName,
      reportedByEmail: req.agent.email,
      verifiedByEmail: req.agent.email,
    });

    res.json({
      ok: true,
      linkedToRack: !!rackId,
      rackReportId: result.rackReportId,
      rackStatus: result.rackStatus,
      photoUrl: photoUrl,
      reason: reason,
      notes: notes,
    });
  } catch (err) {
    console.error("[racks:report] storeId=" + storeId + " rackId=" + rackId + " —", err.message);
    res.status(502).json({ error: "Could not sync with Salesforce", detail: err.message });
  }
});

export default router;
