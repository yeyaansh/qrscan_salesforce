import express from "express";
import { requireAuth } from "../middleware/auth.js";
import * as salesforce from "../services/salesforceService.js";
import { uploadDataUrl } from "../services/uploadService.js";

const router = express.Router();

// Never send a rack's real QR code to the browser — only what's needed to
// display a checklist and target a scan. This is what makes verification
// "blind": the app can't show (or leak via dev tools) the answer.
function convertRackForClient(rack) {
  return {
    id: rack.id,
    label: rack.label,
    isActive: rack.isActive,
    lifecycleStatus: rack.lifecycleStatus,
    status: rack.status,
  };
}

// GET /api/stores/search?query=river
// Returns an array of matching stores (could be zero, one, or several) so
// the agent can pick the right one from a list.
router.get("/search", requireAuth, async (req, res) => {
  const query = req.query.query;

  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  try {
    const matchingStores = await salesforce.searchStores(query);
    res.json({ stores: matchingStores });
  } catch (err) {
    console.error("[stores:search] query=" + query + " —", err.message);
    res.status(502).json({ error: "Could not reach Salesforce", detail: err.message });
  }
});

// POST /api/stores/start-visit
// Body: { storeId, storeNumber, storeName, selfie (dataURL), geo, deviceInfo }
// Nothing about a visit is kept in Mongo anymore — the Agent_Visit__c
// created here IS the visit record, and its Salesforce Id IS the visitId
// the frontend holds onto for the rest of the visit.
router.post("/start-visit", requireAuth, async (req, res) => {
  const storeId = req.body.storeId;
  const storeNumber = req.body.storeNumber;
  const storeName = req.body.storeName;
  const selfie = req.body.selfie;
  const geo = req.body.geo;
  const deviceInfo = req.body.deviceInfo;

  if (!storeId || !storeNumber || !selfie) {
    res.status(400).json({ error: "storeId, storeNumber and selfie are required" });
    return;
  }
  // Start_Latitude__c / Start_Longitude__c are required fields on
  // Agent_Visit__c in Salesforce — enforced here too (not just client-side
  // in app.js) so this endpoint fails fast with a clear message instead of
  // uploading the selfie and then getting a REQUIRED_FIELD_MISSING back
  // from Salesforce after the fact.
  const hasCoordinates = geo && geo.lat !== undefined && geo.lat !== null && geo.lng !== undefined && geo.lng !== null;
  if (!hasCoordinates) {
    res.status(400).json({ error: "Location (lat/lng) is required to start a visit." });
    return;
  }

  try {
    const selfieUrl = await uploadDataUrl(selfie, "selfies");

    const agentVisit = await salesforce.createAgentVisit({
      storeId: storeId,
      agentName: req.agent.fullName,
      agentEmail: req.agent.email,
      geo: geo,
      deviceInfo: deviceInfo,
      selfiePhotoUrl: selfieUrl,
    });

    const racks = await salesforce.getRacksForStore(storeId);
    const racksForClient = racks.map(convertRackForClient);

    res.status(201).json({ visitId: agentVisit.id, racks: racksForClient });
  } catch (err) {
    console.error("[stores:start-visit] storeId=" + storeId + " —", err.message);
    res.status(500).json({ error: "Could not start the visit", detail: err.message });
  }
});

export default router;
