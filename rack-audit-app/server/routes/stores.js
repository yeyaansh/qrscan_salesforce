import express from "express";
import { requireAuth } from "../middleware/auth.js";
import * as salesforce from "../services/salesforceService.js";
import { uploadDataUrl } from "../services/uploadService.js";
import Visit from "../models/Visit.js";

const router = express.Router();

// Never send a rack's real QR code to the browser — only what's needed to
// display a checklist and target a scan. This is what makes verification
// "blind": the app can't show (or leak via dev tools) the answer.
function convertRackForClient(rack) {
  return {
    id: rack.id,
    label: rack.label,
    isActive: rack.isActive,
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

  try {
    const selfieUrl = await uploadDataUrl(selfie, "selfies");

    const visit = await Visit.create({
      agent: req.agent._id,
      storeId: storeId,
      storeNumber: storeNumber,
      storeName: storeName,
      selfieUrl: selfieUrl,
      selfieGeo: geo,
      deviceInfo: deviceInfo,
    });

    const racks = await salesforce.getRacksForStore(storeId);
    const racksForClient = racks.map(convertRackForClient);

    res.status(201).json({ visit: visit, racks: racksForClient });
  } catch (err) {
    console.error("[stores:start-visit] storeId=" + storeId + " —", err.message);
    res.status(500).json({ error: "Could not start the visit", detail: err.message });
  }
});

export default router;
