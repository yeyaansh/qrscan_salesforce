const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Agent = require("../models/Agent");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// NOTE: there is intentionally no POST /register route. Accounts are only
// ever created by an admin — see scripts/seedAgent.js — which is exactly
// the "admin gives out the username/password" requirement.
router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const agent = await Agent.findOne({ username: username.trim().toLowerCase() });
  if (!agent || !agent.active) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const ok = await bcrypt.compare(password, agent.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = jwt.sign({ sub: agent._id.toString(), position: agent.position }, process.env.SESSION_JWT_SECRET, {
    expiresIn: "12h",
  });

  res.json({
    token,
    agent: {
      id: agent._id,
      fullName: agent.fullName,
      username: agent.username,
      position: agent.position,
    },
  });
});

router.get("/me", requireAuth, (req, res) => {
  const { _id, fullName, username, position, email } = req.agent;
  res.json({ id: _id, fullName, username, position, email });
});

module.exports = router;
