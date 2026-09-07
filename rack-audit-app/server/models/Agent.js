const mongoose = require("mongoose");

// Agents are created ONLY by an admin (see scripts/seedAgent.js or a future
// admin panel). There is deliberately no public "sign up" route — this is
// what "prevents anyone from creating an account" per the spec.
const agentSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    fullName: { type: String, required: true },
    email: { type: String, required: true },
    position: {
      type: String,
      enum: ["field_agent", "store_manager", "regional_manager", "admin"],
      default: "field_agent",
    },
    // Whether this position is allowed to authenticate the app against Salesforce
    // and pull/push rack data. Lets an admin deactivate someone instantly.
    active: { type: Boolean, default: true },
    // The manager who should be notified about unresolved discrepancies this
    // agent raises, if not routed by store.
    defaultManagerEmail: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Agent", agentSchema);
