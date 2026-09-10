import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { uploadDataUrl } from "../services/uploadService.js";
import Visit from "../models/Visit.js";

const router = express.Router();

// POST /api/visits/:id/complete
// Body: { signature (dataURL), signedBy }
router.post("/:id/complete", requireAuth, async (req, res) => {
  const signature = req.body.signature;
  const signedBy = req.body.signedBy;

  try {
    const visit = await Visit.findById(req.params.id);
    if (!visit) {
      res.status(404).json({ error: "Visit not found" });
      return;
    }

    if (signature) {
      visit.signatureUrl = await uploadDataUrl(signature, "signatures");
      if (signedBy) {
        visit.signedBy = signedBy;
      } else {
        visit.signedBy = req.agent.fullName;
      }
      visit.signedAt = new Date();
    }
    visit.status = "completed";
    visit.completedAt = new Date();
    await visit.save();

    res.json({ visit: visit });
  } catch (err) {
    console.error("[visits:complete] visitId=" + req.params.id + " —", err.message);
    res.status(500).json({ error: "Could not complete the visit", detail: err.message });
  }
});

export default router;
