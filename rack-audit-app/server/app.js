import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import morgan from "morgan";

import connectDB from "./config/db.js";
import authRoutes from "./routes/auth.js";
import storeRoutes from "./routes/stores.js";
import rackRoutes from "./routes/racks.js";
import visitRoutes from "./routes/visits.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(morgan("dev"));
// Selfies/signatures arrive as base64 data URLs. Kept under Vercel's ~4.5MB
// serverless request body cap — if you hit a 413, lower the JPEG quality in
// public/js/camera.js rather than raising this.
app.use(express.json({ limit: "4mb" }));

// connectDB() is cached (config/db.js), so after the first call this is a
// no-op — safe to run on every request in both serverless and traditional modes.
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch {
    res.status(503).json({ error: "Database unavailable" });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, mock: String(process.env.SF_MOCK) === "true" }));

app.use("/api/auth", authRoutes);
app.use("/api/stores", storeRoutes);
app.use("/api/racks", rackRoutes);
app.use("/api/visits", visitRoutes);

// Static frontend — only exercised when running as a traditional server
// (Render/Railway/local `npm run dev`). On Vercel, /public is served
// directly by Vercel's static hosting and never reaches this app.
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

export default app;
