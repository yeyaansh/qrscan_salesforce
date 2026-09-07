const express = require("express");
const { requireAuth } = require("../middleware/auth");
const salesforce = require("../services/salesforceService");
const { uploadDataUrl } = require("../services/uploadService");
const Visit = require("../models/Visit");

const router = express.Router();

// GET /api/stores/lookup?query=4021
router.get("/lookup", requireAuth, async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "query is required" });

  try {
    const store = await salesforce.findStore(query);
    if (!store) return res.status(404).json({ error: "No store matches that number or name" });
    res.json(store);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not reach Salesforce", detail: err.message });
  }
});

// POST /api/stores/start-visit
// Body: { storeId, storeNumber, storeName, selfie (dataURL), geo, deviceInfo }
// Creates the Visit record — this is the "took their photo, entered the
// store" step, before any rack scanning starts.
router.post("/start-visit", requireAuth, async (req, res) => {
  const { storeId, storeNumber, storeName, selfie, geo, deviceInfo } = req.body;
  if (!storeId || !storeNumber || !selfie) {
    return res.status(400).json({ error: "storeId, storeNumber and selfie are required" });
  }

  try {
    const selfieUrl = await uploadDataUrl(selfie, "selfies");
    const visit = await Visit.create({
      agent: req.agent._id,
      storeId,
      storeNumber,
      storeName,
      selfieUrl,
      selfieGeo: geo,
      deviceInfo,
    });

    const racks = await salesforce.getRacksForStore(storeId);
    res.status(201).json({ visit, racks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start the visit", detail: err.message });
  }
});

module.exports = router;
