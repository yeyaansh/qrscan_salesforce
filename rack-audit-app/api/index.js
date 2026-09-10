// Vercel convention: any file under /api becomes a serverless function.
// Exporting the Express app directly works because an Express app is just
// a (req, res) request handler — Vercel's Node runtime calls it exactly
// like that. vercel.json rewrites every /api/* request to this file while
// keeping the original path/query intact, so app.js's own internal
// routing (app.use("/api/auth", ...) etc.) still works unmodified.
import app from "../server/app.js";
export default app;
