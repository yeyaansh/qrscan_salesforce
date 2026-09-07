/**
 * Run with: npm run seed:agent
 * Creates (or updates) a demo agent so you can log into the app.
 * In production, an admin would run a version of this (or an internal
 * admin panel) to provision each field agent's username/password.
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const connectDB = require("../config/db");
const Agent = require("../models/Agent");

async function run() {
  await connectDB();

  const demoAgents = [
    {
      username: "jsmith",
      password: "ChangeMe123!",
      fullName: "Jordan Smith",
      email: "jordan.smith@example.com",
      position: "field_agent",
      defaultManagerEmail: "manager@example.com",
    },
    {
      username: "manager1",
      password: "ChangeMe123!",
      fullName: "Casey Rivera",
      email: "casey.rivera@example.com",
      position: "store_manager",
    },
  ];

  for (const a of demoAgents) {
    const passwordHash = await bcrypt.hash(a.password, 10);
    await Agent.findOneAndUpdate(
      { username: a.username },
      { ...a, passwordHash, active: true },
      { upsert: true, new: true }
    );
    console.log(`✔ Agent ready → username: ${a.username} / password: ${a.password}`);
  }

  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
