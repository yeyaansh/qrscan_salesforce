// Entry point for a traditional, always-on Node process (Render, Railway,
// Fly.io, or plain `npm run dev` locally). Not used by Vercel — see
// /api/index.js, which imports app.js directly as a serverless function.
import app from "./app.js";

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Rack Audit server running on http://localhost:${PORT}`));
