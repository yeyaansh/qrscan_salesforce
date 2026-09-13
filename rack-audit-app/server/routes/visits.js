import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { uploadDataUrl } from "../services/uploadService.js";
import * as salesforce from "../services/salesforceService.js";

const router = express.Router();

// POST /api/visits/:id/complete
// :id is the Agent_Visit__c Id returned from /stores/start-visit — there is
// no Mongo document behind it anymore, so this route talks to Salesforce
// directly instead of looking anything up first.
// Body: { signature (dataURL), signedBy }
router.post("/:id/complete", requireAuth, async (req, res) => {
  const agentVisitId = req.params.id;
  const signature = req.body.signature;
  const signedBy = req.body.signedBy || req.agent.fullName;

  if (!agentVisitId) {
    res.status(400).json({ error: "Visit id is required" });
    return;
  }

  // Split into two try/catch blocks (upload, then Salesforce) instead of
  // one — a single catch around both couldn't tell you which step actually
  // failed, and the two have completely different causes and fixes (a slow
  // in-store connection to Cloudinary vs. a Salesforce-side rejection).
  let signaturePhotoUrl = null;
  if (signature) {
    try {
      signaturePhotoUrl = await uploadDataUrl(signature, "signatures");
    } catch (err) {
      console.error(
        "[visits:complete] visitId=" + agentVisitId + " — signature upload failed —",
        err && err.message ? err.message : err,
        err && err.cause ? { cause: err.cause } : ""
      );
      res.status(502).json({ error: "Could not upload the signature image", detail: err.message });
      return;
    }
  }

  try {
    await salesforce.completeAgentVisit(agentVisitId, {
      signaturePhotoUrl: signaturePhotoUrl,
      signedBy: signedBy,
    });

    res.json({ ok: true, visitId: agentVisitId });
  } catch (err) {
    // Log the full error, not just .message — some failure shapes (see
    // uploadDataUrl for the same issue on the Cloudinary side) leave
    // .message undefined, and a bare "undefined" in the logs gives you
    // nothing to act on when this happens again.
    console.error(
      "[visits:complete] visitId=" + agentVisitId + " — Salesforce update failed —",
      err && err.message ? err.message : err,
      err && err.stack ? "\n" + err.stack : ""
    );
    res.status(502).json({
      error: "Could not complete the visit in Salesforce",
      detail: (err && err.message) || "Unknown error",
    });
  }
});

export default router;
