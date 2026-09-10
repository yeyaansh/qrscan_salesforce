import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Agent from "../models/Agent.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// No POST /register route on purpose — accounts are only ever created by an
// admin (see scripts/seedAgent.js).
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
    agent: { id: agent._id, fullName: agent.fullName, username: agent.username, position: agent.position },
  });
});

router.get("/me", requireAuth, (req, res) => {
  const { _id, fullName, username, position, email } = req.agent;
  res.json({ id: _id, fullName, username, position, email });
});

export default router;
