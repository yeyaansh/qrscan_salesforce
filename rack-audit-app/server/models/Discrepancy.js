const mongoose = require("mongoose");

const discrepancySchema = new mongoose.Schema(
  {
    rackScan: { type: mongoose.Schema.Types.ObjectId, ref: "RackScan", required: true },
    visit: { type: mongoose.Schema.Types.ObjectId, ref: "Visit", required: true },

    resolved: { type: Boolean, default: false },
    resolutionNotes: String,
    resolvedAt: Date,

    managerEmail: String,
    managerNotifiedAt: Date,
    emailStatus: { type: String, enum: ["pending", "sent", "failed"], default: "pending" },

    salesforceTaskId: String,
    taskStatus: { type: String, enum: ["not_created", "created", "failed"], default: "not_created" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Discrepancy", discrepancySchema);
