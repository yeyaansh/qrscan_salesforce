const mongoose = require("mongoose");

const rackScanSchema = new mongoose.Schema(
  {
    visit: { type: mongoose.Schema.Types.ObjectId, ref: "Visit", required: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", required: true },

    // Account_Rack__c record Id this scan was checked against
    salesforceRackId: { type: String, required: true },
    expectedCode: { type: String, required: true }, // QR value Salesforce expects for this rack
    scannedCode: { type: String, required: true }, // QR value actually read by the camera

    matched: { type: Boolean, required: true },
    status: {
      type: String,
      enum: ["verified", "discrepancy", "resolved"],
      required: true,
    },

    geo: {
      lat: Number,
      lng: Number,
      accuracyMeters: Number,
    },
    scannedAt: { type: Date, default: Date.now },

    // Only present when matched === false
    discrepancyNotes: String,
    discrepancyPhotoUrl: String,

    syncedToSalesforce: { type: Boolean, default: false },
    salesforceSyncError: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("RackScan", rackScanSchema);
