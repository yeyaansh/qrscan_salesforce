const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { uploadDataUrl } = require("../services/uploadService");
const Visit = require("../models/Visit");
const RackScan = require("../models/RackScan");

const router = express.Router();

// POST /api/visits/:id/complete
// Body: { signature (dataURL), signedBy }
router.post("/:id/complete", requireAuth, async (req, res) => {
  const { signature, signedBy } = req.body;
  try {
    const visit = await Visit.findById(req.params.id);
    if (!visit) return res.status(404).json({ error: "Visit not found" });

    if (signature) {
      visit.signatureUrl = await uploadDataUrl(signature, "signatures");
      visit.signedBy = signedBy || req.agent.fullName;
      visit.signedAt = new Date();
    }
    visit.status = "completed";
    visit.completedAt = new Date();
    await visit.save();

    res.json({ visit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not complete the visit", detail: err.message });
  }
});

// GET /api/visits/:id/summary
router.get("/:id/summary", requireAuth, async (req, res) => {
  const visit = await Visit.findById(req.params.id);
  if (!visit) return res.status(404).json({ error: "Visit not found" });
  const scans = await RackScan.find({ visit: visit._id }).sort({ scannedAt: 1 });
  res.json({ visit, scans });
});

module.exports = router;
