const express = require("express");
const { requireAuth } = require("../middleware/auth");
const salesforce = require("../services/salesforceService");
const { uploadDataUrl } = require("../services/uploadService");
const RackScan = require("../models/RackScan");
const Discrepancy = require("../models/Discrepancy");
const Visit = require("../models/Visit");
const { sendDiscrepancyAlert } = require("../services/emailService");

const router = express.Router();

// GET /api/racks?storeId=...
router.get("/", requireAuth, async (req, res) => {
  const { storeId } = req.query;
  if (!storeId) return res.status(400).json({ error: "storeId is required" });
  try {
    const racks = await salesforce.getRacksForStore(storeId);
    res.json(racks);
  } catch (err) {
    res.status(502).json({ error: "Could not reach Salesforce", detail: err.message });
  }
});

// POST /api/racks/scan
// Body: { visitId, storeId, rackId, expectedCode, scannedCode, geo }
// This is the moment a QR code has just been read by the camera and is
// checked against the rack the agent selected/expected.
router.post("/scan", requireAuth, async (req, res) => {
  const { visitId, storeId, rackId, expectedCode, scannedCode, geo } = req.body;
  if (!visitId || !storeId || !rackId || !expectedCode || !scannedCode) {
    return res.status(400).json({ error: "visitId, storeId, rackId, expectedCode and scannedCode are required" });
  }

  const matched = String(expectedCode).trim() === String(scannedCode).trim();

  try {
    const rackScan = await RackScan.create({
      visit: visitId,
      agent: req.agent._id,
      salesforceRackId: rackId,
      expectedCode,
      scannedCode,
      matched,
      status: matched ? "verified" : "discrepancy",
      geo,
    });

    // Push the result straight back to Account_Rack__c either way, so
    // Salesforce always reflects the latest scan attempt.
    try {
      await salesforce.updateRackStatus(storeId, rackId, matched ? "Verified" : "Discrepancy", {
        verifiedBy: req.agent.fullName,
      });
      rackScan.syncedToSalesforce = true;
    } catch (sfErr) {
      rackScan.salesforceSyncError = sfErr.message;
    }
    await rackScan.save();

    res.status(201).json({ matched, rackScan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not record the scan", detail: err.message });
  }
});

// POST /api/racks/discrepancy
// Body: { rackScanId, visitId, notes, photo (dataURL), rackLabel, storeName, storeNumber, managerEmail }
// Called when the agent fills in the "what did you actually find" form
// after a mismatch. If still unresolved, notifies the manager by email
// AND creates a Salesforce Task.
router.post("/discrepancy", requireAuth, async (req, res) => {
  const { rackScanId, visitId, notes, photo, rackLabel, storeName, storeNumber, managerEmail, resolved } = req.body;
  if (!rackScanId || !visitId) {
    return res.status(400).json({ error: "rackScanId and visitId are required" });
  }

  try {
    const rackScan = await RackScan.findById(rackScanId);
    if (!rackScan) return res.status(404).json({ error: "Scan not found" });

    const photoUrl = photo ? await uploadDataUrl(photo, "discrepancies") : undefined;
    rackScan.discrepancyNotes = notes;
    if (photoUrl) rackScan.discrepancyPhotoUrl = photoUrl;
    if (resolved) rackScan.status = "resolved";
    await rackScan.save();

    const discrepancy = await Discrepancy.create({
      rackScan: rackScan._id,
      visit: visitId,
      resolved: !!resolved,
      resolutionNotes: resolved ? notes : undefined,
      resolvedAt: resolved ? new Date() : undefined,
      managerEmail,
    });

    if (!resolved) {
      const toEmail = managerEmail || req.agent.defaultManagerEmail;

      let taskId;
      try {
        const task = await salesforce.createManagerTask({
          subject: `Rack discrepancy — Store ${storeNumber || ""} (${rackLabel || rackScan.salesforceRackId})`,
          description: `Expected QR ${rackScan.expectedCode}, scanned ${rackScan.scannedCode}.\nAgent notes: ${notes || "(none)"}`,
          rackId: rackScan.salesforceRackId,
        });
        taskId = task.id;
        discrepancy.salesforceTaskId = taskId;
        discrepancy.taskStatus = "created";
      } catch (taskErr) {
        discrepancy.taskStatus = "failed";
        console.error("Salesforce Task creation failed:", taskErr.message);
      }

      if (toEmail) {
        try {
          await sendDiscrepancyAlert({
            to: toEmail,
            storeName,
            storeNumber,
            rackLabel: rackLabel || rackScan.salesforceRackId,
            scannedCode: rackScan.scannedCode,
            expectedCode: rackScan.expectedCode,
            notes,
            agentName: req.agent.fullName,
            taskId,
          });
          discrepancy.managerNotifiedAt = new Date();
          discrepancy.emailStatus = "sent";
        } catch (mailErr) {
          discrepancy.emailStatus = "failed";
          console.error("Manager email failed:", mailErr.message);
        }
      }
      await discrepancy.save();
    }

    res.status(201).json({ rackScan, discrepancy });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not record the discrepancy", detail: err.message });
  }
});

module.exports = router;
