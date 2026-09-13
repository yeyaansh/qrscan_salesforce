// Vercel serverless entry point. Vercel's Node.js runtime treats any
// (req, res) => ... function — or, as here, anything with that shape,
// which an Express app already is — as the handler for this route. The
// actual app (routes, middleware, everything) lives in server/app.js and
// is shared with server/server.js (the traditional-host entry point) so
// there is exactly one Express app definition, not two copies to keep in
// sync.
//
// server/app.js's own static-file middleware and catch-all
// (express.static + the app.get("*", ...) that serves index.html) are
// dead code on Vercel specifically — vercel.json below routes only
// /api/* here, so everything under /public is served directly by
// Vercel's static hosting and this app never sees those requests. That
// middleware still matters for the traditional-host path (server.js),
// which is why it stays in app.js rather than being deleted.
import app from "../server/app.js";

export default app;
