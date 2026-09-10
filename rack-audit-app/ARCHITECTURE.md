# Rack Audit — Architecture & Extension Guide

This is the deep-dive companion to `README.md`. README tells you how to run
and deploy the app; this file explains **why every piece exists**, **what
actually happens in mock mode vs. real mode**, and **where to make changes**
when you extend it later.

---

## 1. The mental model, in one paragraph

An agent logs in (MongoDB checks their password) → takes a selfie (goes to
Cloudinary, URL saved on a `Visit` in MongoDB) → picks a store (Salesforce
is asked "what racks belong here") → scans racks (every scan is checked
**on the server**, against a **fresh Salesforce read**, and the result is
written straight back to Salesforce) → signs off (signature also goes to
Cloudinary, `Visit` marked complete in MongoDB). MongoDB never learns
anything about racks, statuses, or discrepancies — only Salesforce does.
That split is the single most important design decision in this codebase,
and almost everything else follows from it.

---

## 2. Tech stack — what's used, and where it actually touches the system

| Technology | Role | Where it lives in the code |
|---|---|---|
| **Node.js + Express** | HTTP server, routing, middleware | `server/app.js` builds it; `server/server.js` runs it locally, `api/index.js` runs it on Vercel |
| **ES Modules** (`import`/`export`) | Module system, front and back | Every `.js` file. `"type": "module"` in both `package.json` files is what makes Node treat `.js` as ESM instead of CommonJS |
| **MongoDB + Mongoose** | Stores `Agent` and `Visit` only | `server/config/db.js` (connection), `server/models/*.js` (schemas) |
| **Cloudinary** | Stores every photo (selfies, report photos, signatures) | `server/config/cloudinary.js` (credentials), `server/services/uploadService.js` (the only function that uploads) |
| **Salesforce REST API** | Source of truth for stores, racks, and verification status | `server/services/salesforceService.js` — the *only* file that talks to Salesforce |
| **OAuth 2.0 JWT Bearer flow** | How the backend authenticates to Salesforce (server-to-server, no per-agent Salesforce login) | `authenticate()` inside `salesforceService.js` |
| **bcryptjs + jsonwebtoken** | Agent password hashing + session tokens | `server/routes/auth.js`, `server/middleware/auth.js` |
| **html5-qrcode** (CDN, browser-only) | Reads QR codes from the camera | Loaded via `<script>` in `index.html`, wrapped by `public/js/qrscanner.js` |
| **Vanilla JS, no framework** | The entire frontend | `public/js/*.js` — see §4 |
| **Service Worker + Web App Manifest** | Makes it installable (PWA) | `public/service-worker.js`, `public/manifest.json` |

**Notably absent on purpose:** no React/Vue (unnecessary for this many
screens), no ORM beyond Mongoose (Salesforce isn't a database the app
owns — treating it as a REST API it calls is the correct model, not an
object-relational one), no message queue (scan volume doesn't need one
yet — see §7 if that changes).

---

## 3. Backend, file by file

```
server/
  app.js                 ← builds the Express app: middleware stack, route mounting, static files
  server.js               ← thin wrapper: imports app.js, calls .listen(). Only used outside Vercel.
  config/
    db.js                  ← MongoDB connection, cached across requests (serverless-safe)
    cloudinary.js           ← Cloudinary SDK configuration
  models/
    Agent.js                ← Mongoose schema: username, passwordHash, position, etc.
    Visit.js                ← Mongoose schema: one document per store visit
  services/
    salesforceService.js    ← ALL Salesforce logic: auth, queries, writes. Nothing else touches Salesforce.
    uploadService.js         ← ALL Cloudinary logic. One function: uploadDataUrl().
    emailService.js          ← Nodemailer wrapper. Currently unused (see §5).
    mockData.js               ← Fake stores/racks, used only when SF_MOCK=true
  routes/
    auth.js                  ← POST /login, GET /me
    stores.js                 ← GET /search (returns a list of matches), POST /start-visit
    racks.js                   ← GET /, POST /scan, POST /scan-any, POST /report — the core business logic
    visits.js                   ← POST /:id/complete
  middleware/
    auth.js                    ← verifies the session JWT, loads the Agent, checks their position is allowed
  scripts/
    seedAgent.js                 ← creates/updates agent logins (the only way an account gets created)
    testSalesforceAuth.js         ← standalone diagnostic, bypasses the whole app to isolate Salesforce auth problems
```

### Why this split, specifically

- **`salesforceService.js` is a hard boundary.** Every route imports from it
  as `import * as salesforce from "../services/salesforceService.js"` and
  never queries Salesforce directly. This means: (a) `SF_MOCK` only has to
  be checked in *one* file, (b) if Salesforce's API ever changes, or you
  swap the auth flow, exactly one file changes, (c) it's the only place
  that ever sees a rack's real QR code — routes and the frontend never do.
- **`routes/racks.js`'s `resolveScan()` helper** is shared by both
  `/scan` and `/scan-any` on purpose — the verify/mismatch/inactive-flag
  decision is identical either way; only *how the target rack was found*
  differs (client picked it vs. server searched for it).
- **`uploadService.js` has exactly one exported function.** If you ever
  swap Cloudinary for S3 or another provider, this is the only file that
  needs to change — every route just calls `uploadDataUrl()` and doesn't
  know or care what's behind it.

---

## 4. Frontend, file by file

```
public/
  index.html               ← all screens live here as <section class="screen"> elements, toggled by JS
  css/style.css              ← the whole visual design system (colors, type, components)
  manifest.json                ← PWA metadata (name, icons, colors)
  service-worker.js             ← caches the app shell so it opens instantly / works offline
  js/
    app.js                       ← ENTRY POINT. Imports everything below. All screen logic and event wiring lives here.
    state.js                      ← sessionStorage-backed state object, shared across the whole visit
    api.js                         ← every fetch() call to the backend, in one place
    geolocation.js                  ← wraps navigator.geolocation
    camera.js                        ← wraps getUserMedia (selfie + report photos)
    qrscanner.js                      ← wraps the html5-qrcode library
    signature.js                       ← canvas-based signature pad
    guard.js                            ← confirm-before-leaving mid-visit
    install.js                           ← PWA install prompt (Android real prompt / iOS instructions)
```

### Why `app.js` imports everything instead of many `<script>` tags

Before the ES module rewrite, every file attached a global (`window.State`,
`window.Api`, etc.) and `index.html` had to load them in the right order by
hand. Now `index.html` loads exactly one script —
`<script type="module" src="/js/app.js">` — and every dependency is an
explicit `import` line at the top of whichever file needs it. To find what
depends on what, just read the imports; there's no hidden load-order
requirement anymore.

### The screen model

Every screen is a `<section class="screen" id="screen-X">` in `index.html`,
hidden by default. `showScreen(id)` in `app.js` is the only function that
changes which one is visible — it's a simple show/hide, not a router (no
URL changes per screen, which is also why the back-button needs the
explicit guard in `guard.js` rather than "just working").

---

## 5. Mock mode vs. real mode — exactly what happens in each

### `SF_MOCK=true`

| Piece | What really happens |
|---|---|
| Login | **Real.** Checks MongoDB, real bcrypt compare, real JWT issued. |
| Selfie / signature / report photos | **Real.** Actually uploaded to your real Cloudinary account. |
| `Visit` record | **Real.** Actually written to your real MongoDB. |
| Store search | **Fake.** Only `"4021"`, `"4088"`, `"4099"` (or their names — try `"riverside"` for two results) resolve — see `server/services/mockData.js`. |
| Rack checklist | **Fake.** Fixed in-memory list per store (5 racks for 4021, 3 for 4088, including one inactive rack for testing). |
| QR match/mismatch | **Fake, but real logic.** The comparison, inactive-flag detection, "already verified" detection — all the *code paths* in `salesforceService.js`/`racks.js` run for real; they just compare against `mockData.js`'s in-memory array instead of a live Salesforce query. |
| Status updates ("Verified", "Issue", etc.) | **Fake and ephemeral.** Written to the same in-memory JS object — resets to "Not Verified" every time the server process restarts. Nothing persists between runs. |
| Email / Salesforce Task creation | **Not triggered either way** — removed from the app regardless of mock mode (see §1 in README). |

**What mock mode does NOT test:** real Salesforce authentication (the JWT
Bearer handshake), real SOQL syntax against your actual field names, real
picklist value validity, real field-level security/permissions. Those only
get exercised with `SF_MOCK=false` against a real (ideally sandbox) org.

### `SF_MOCK=false`

| Data | Where it's read from | Where it's written to |
|---|---|---|
| Store info | `Account` object (`Store_Number__c`, `Name`) | never written |
| Rack checklist | `Account_Rack__c` filtered by `Account__c`, joined to `Rack__c` | n/a (read-only fetch) |
| A rack's real QR code | `Account_Rack__c.Name` | never written — the app only ever *reads* this to compare |
| Rack dimensions | `Rack__c` (field names assumed — see README §3.1) | never written |
| Verification result | n/a | `Account_Rack__c.Verification_Status__c` — **not** `Status__c`, which is the rack's own lifecycle field and is only ever read |
| Who verified it / when | n/a | `Account_Rack__c.Last_Verified_By__c` (their email) and `Last_Verified_Date__c` |
| Agent login | MongoDB `Agent` collection | n/a (read-only at login) |
| Visit record (selfie URL, GPS, device, signature URL, timestamps) | n/a | MongoDB `Visit` collection |
| Selfie / signature / report photo *files* | n/a | Cloudinary (URL returned in the response either way; only saved server-side on the `Visit` doc for the selfie/signature — a report's photo URL currently isn't persisted anywhere since there's no confirmed Salesforce field for it yet, see README §3.3) |

**Timing matters as much as the field:** a clean match or an inactive-rack
detection writes to Salesforce immediately, but a mismatch writes nothing
until the agent submits the report screen — see README §3.3 for why.

The important asymmetry: **Salesforce never receives photos or GPS
coordinates** — those stay in MongoDB/Cloudinary as the "field-person"
audit trail. **MongoDB never receives rack/business data** — that stays in
Salesforce as the single source of truth. If you find yourself wanting to
write rack data to Mongo "just to be safe," that's a sign the Salesforce
field for it doesn't exist yet — the fix is adding the field, not adding a
Mongo copy.

---

## 6. Cookbook — where to make common future changes

| You want to... | Touch these files |
|---|---|
| Add a field to the rack checklist display (e.g. last-restocked date) | `salesforceService.js`'s `toRack()` (map it from the SOQL result) → `toClientRack()` in `stores.js`/`racks.js` (allow it through to the client) → `renderChecklist()` in `app.js` (display it) |
| Add a new agent role/position | `Agent.js` model's `position` enum → `middleware/auth.js`'s `ALLOWED_POSITIONS` → `seedAgent.js` if you want a demo account with it |
| Let report notes/photos actually save in Salesforce | Add the field(s) to `Account_Rack__c`, then wire them into `updateRackStatus()` in `salesforceService.js` and the `/report` handler in `racks.js` (currently intentionally left as a TODO — see README §3.3) |
| Re-enable email notifications | `emailService.js` already has `sendDiscrepancyAlert()` — just call it from the `/report` route in `racks.js` again |
| Swap Cloudinary for S3 (or anything else) | Only `uploadService.js` — its exported function signature (`uploadDataUrl(dataUrl, folder) → url`) is the entire contract the rest of the app relies on |
| Swap the custom auth for Clerk | `routes/auth.js` and `middleware/auth.js` — everything downstream just expects `req.agent` to be populated, so as long as your replacement does that, nothing else changes |
| Add a barcode format alongside QR | `html5-qrcode` already supports other 1D/2D formats — change the config passed to `instance.start()` in `qrscanner.js` |
| Add an admin UI for creating agents (instead of the seed script) | New route (e.g. `routes/admin.js`) gated by `position === "admin"` in `middleware/auth.js`, plus a new screen in `index.html`/`app.js` |
| Add offline support for spotty in-store WiFi | `service-worker.js` already caches the app shell; you'd add a request queue (e.g. IndexedDB) in `api.js` that retries failed `POST`s when connectivity returns |
| Add a manager-facing dashboard (see all visits/issues) | This needs to read *from Salesforce* (since that's where issue state lives) — likely a new backend route that runs a broader SOQL report query, plus a new screen |
| Add automated tests | Nothing exists yet. The route-level test pattern used during development (stub the auth middleware, mount the real router, hit it with real HTTP calls) in a `tests/` folder with a runner like `node --test` or Vitest would fit this codebase well without adding heavy tooling |
| Rate-limit or otherwise harden the API | Add middleware in `app.js`'s stack, e.g. `express-rate-limit`, alongside the existing `cors`/`morgan`/`express.json()` middleware |

---

## 7. Future enhancements worth considering

Roughly ordered by how soon you'd likely want them:

1. **`Rack__c` field mapping** — not really "future," this is the one
   remaining placeholder blocking real Salesforce use (README §3.1).
2. **Report notes/photo persistence** — add the Salesforce field,
   wire it in (see cookbook above). Right now that data is captured and
   then has nowhere to land.
3. **Admin UI for agent management** — right now creating an agent means
   running `seedAgent.js` by hand. Fine for a pilot, not for a rollout
   across many stores.
4. **Retry queue for scans made with poor connectivity** — stores can have
   bad WiFi; a scan that fails to reach the server right now just shows an
   error toast. Queuing and retrying would make the app much more robust
   in the field.
5. **A lightweight reporting view** — even just "visits completed today,"
   "open discrepancies," pulled from Salesforce and rendered for
   `store_manager`/`regional_manager` roles.
6. **Push notifications** — e.g. notify a manager's phone directly when a
   an issue is flagged, instead of relying solely on Salesforce's own
   Flow/email. Would need a push subscription model (a new, small Mongo
   collection would be the right place — this is arguably "field-person
   data" too, since it's about notifying a person, not tracking a rack).
7. **Automated tests** — there are none yet; worth adding once the
   Salesforce field mapping stabilizes, so future changes don't
   silently break the scan-result branching logic.
8. **Rotating the Salesforce Connected App certificate periodically** —
   general security hygiene once this is running in production long-term.

---

## 8. A note on reading this codebase going forward

If you're trying to trace "what happens when an agent scans a rack,"
start at `handleDecodedCode()` in `public/js/app.js`, follow it to
`Api.scanRack()`/`Api.scanAnyRack()` in `public/js/api.js`, which hits
`POST /api/racks/scan` or `/scan-any` in `server/routes/racks.js`, which
calls `resolveScan()`, which calls into `salesforceService.js`. That one
path touches almost every architectural decision in this document — it's
the best single thread to pull on if you want to build a mental model of
the whole system quickly.
