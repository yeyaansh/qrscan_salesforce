const jwt = require("jsonwebtoken");
const Agent = require("../models/Agent");

// Positions allowed to run store audits / hit Salesforce through this app.
const ALLOWED_POSITIONS = ["field_agent", "store_manager", "regional_manager", "admin"];

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not authenticated" });

    const payload = jwt.verify(token, process.env.SESSION_JWT_SECRET);
    const agent = await Agent.findById(payload.sub);

    if (!agent || !agent.active) {
      return res.status(401).json({ error: "Account not active" });
    }
    if (!ALLOWED_POSITIONS.includes(agent.position)) {
      return res.status(403).json({ error: "Your role is not permitted to run audits" });
    }

    req.agent = agent;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

module.exports = { requireAuth, ALLOWED_POSITIONS };
