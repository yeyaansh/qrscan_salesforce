import mongoose from "mongoose";

// Agents are created ONLY by an admin (see scripts/seedAgent.js or a future
// admin panel). There is deliberately no public "sign up" route — that's
// what keeps anyone from creating their own account.
const agentSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    fullName: { type: String, required: true },
    email: { type: String, required: true }, // also written to Salesforce's Last_Verified_By__c (an Email field)
    position: {
      type: String,
      enum: ["field_agent", "store_manager", "regional_manager", "admin"],
      default: "field_agent",
    },
    // Lets an admin deactivate someone instantly without deleting history.
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("Agent", agentSchema);
