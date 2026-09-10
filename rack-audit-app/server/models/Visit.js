import mongoose from "mongoose";

// The only "field person" record kept in MongoDB — proof of who visited a
// store, when, and from where. Per-rack scan results are NOT duplicated
// here; they live only in Salesforce (see server/services/salesforceService.js).
const deviceInfoSchema = new mongoose.Schema(
  {
    userAgent: String,
    platform: String,
    deviceId: String, // persisted client-side (localStorage) so repeat visits are traceable to a device
    screen: String,
  },
  { _id: false }
);

const geoSchema = new mongoose.Schema(
  {
    lat: Number,
    lng: Number,
    accuracyMeters: Number,
    capturedAt: Date,
  },
  { _id: false }
);

const visitSchema = new mongoose.Schema(
  {
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", required: true },
    storeId: { type: String, required: true }, // Salesforce Account Id
    storeNumber: { type: String, required: true },
    storeName: { type: String },

    selfieUrl: { type: String, required: true },
    selfieGeo: geoSchema,
    deviceInfo: deviceInfoSchema,

    status: { type: String, enum: ["in_progress", "completed"], default: "in_progress" },

    signatureUrl: String,
    signedBy: String,
    signedAt: Date,

    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
  },
  { timestamps: true }
);

export default mongoose.model("Visit", visitSchema);
