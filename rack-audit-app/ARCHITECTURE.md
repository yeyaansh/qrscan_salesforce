# Rack Audit — Architecture & Extension Guide

This is the deep-dive companion to `README.md`. README tells you how to run
and deploy the app; this file explains **why every piece exists**, **what
actually happens in mock mode vs. real mode**, and **where to make changes**
when you extend it later.

> **This revision** brings the doc back in sync with the actual codebase —
> the previous version still described a `Visit` MongoDB collection that no
> longer exists, an outcome list missing two statuses the server actually
> returns, and a Vercel deploy path (`api/index.js`, `vercel.json`, a root
> `package.json`) that was referenced but not actually present in the repo.
> See §9 for the full list of what changed and why.

---

## 1. The mental model, in one paragraph

An agent logs in (MongoDB checks their password — **the only thing MongoDB
does anymore**) → takes a selfie (goes to Cloudinary, URL attached to a new
`Agent_Visit__c` record **in Salesforce**) → picks a store (Salesforce is
asked "what racks belong here") → scans racks (every scan is checked **on
the server**, against a **fresh Salesforce read**, and the result is
written straight back to Salesforce) → signs off (signature also goes to
Cloudinary, that same `Agent_Visit__c` marked `Completed`). **MongoDB never
learns anything about racks, statuses, visits, or discrepancies — only
Salesforce does; MongoDB's entire footprint is agent login credentials.**
That split is the single most important design decision in this codebase,
and almost everything else follows from it.

---

## 2. Tech stack — what's used, and where it actually touches the system

| Technology | Role | Where it lives in the code |
|---|---|---|
| **Node.js + Express** | HTTP server, routing, middleware | `server/app.js` builds it; `server/server.js` runs it on a traditional host, `api/index.js` runs it on Vercel |
| **ES Modules** (`import`/`export`) | Module system, front and back | Every `.js` file. `"type": "module"` in `package.json` (root, for Vercel) and `server/package.json` (for traditional hosts) is what makes Node treat `.js` as ESM instead of CommonJS |
| **MongoDB + Mongoose** | Stores `Agent` — **and only `Agent`** | `server/config/db.js` (connection), `server/models/Agent.js` (the one schema) |
| **Cloudinary** | Stores every photo (selfies, report photos, signatures) | `server/config/cloudinary.js` (credentials), `server/services/uploadService.js` (the only function that uploads) |
| **Salesforce REST API** | Source of truth for stores, racks, verification status, visits, and rack reports | `server/services/salesforceService.js` — the *only* file that talks to Salesforce |
| **OAuth 2.0 JWT Bearer flow** | How the backend authenticates to Salesforce (server-to-server, no per-agent Salesforce login) | `authenticate()` inside `salesforceService.js` |
| **bcryptjs + jsonwebtoken** | Agent password hashing + session tokens | `server/routes/auth.js`, `server/middleware/auth.js` |
| **html5-qrcode** (CDN, browser-only) | Reads QR codes from the camera | Loaded via `<script>` in `index.html`, wrapped by `public/js/qrscanner.js` |
| **Vanilla JS, no framework** | The entire frontend | `public/js/*.js` — see §4 |
| **Service Worker + Web App Manifest** | Makes it installable (PWA) | `public/service-worker.js`, `public/manifest.json` |

**Notably absent on purpose:** no React/Vue (unnecessary for this many
screens), no ORM beyond Mongoose for the one collection it manages
(Salesforce isn't a database the app owns — treating it as a REST API it
calls is the correct model, not an object-relational one), no message queue
(scan volume doesn't need one yet — see §7 if that changes), and — as of
this revision — no second Mongo collection for visits. There used to be a
`Visit` model; it's gone (see §9).

---

## 3. Backend, file by file

```
server/
  app.js                 ← builds the Express app: middleware stack, route mounting, static files
  server.js               ← thin wrapper: imports app.js, calls .listen(). Traditional hosts only (Render/Railway/Fly/local).
  config/
    db.js                  ← MongoDB connection, cached across requests (serverless-safe). Only used to look up/verify Agent logins.
    cloudinary.js           ← Cloudinary SDK configuration
  models/
    Agent.js                ← Mongoose schema: username, passwordHash, fullName, email, position, active. The ONLY Mongo collection.
  services/
    salesforceService.js    ← ALL Salesforce logic: auth, queries, writes (stores, racks, Agent_Visit__c, Rack_Report__c). Nothing else touches Salesforce.
    uploadService.js         ← ALL Cloudinary logic. One function: uploadDataUrl().
    emailService.js          ← Nodemailer wrapper. Currently unused — Salesforce automation (Flow/Case) owns discrepancy notifications now (see §5).
    mockData.js               ← Fake stores/racks/visits/reports, used only when SF_MOCK=true
  routes/
    auth.js                  ← POST /login, GET /me
    stores.js                 ← GET /search (returns a list of matches), POST /start-visit (creates Agent_Visit__c directly — no Mongo document behind it)
    racks.js                   ← GET /, POST /scan, POST /scan-any, POST /report — the core business logic
    visits.js                   ← POST /:id/complete (:id is the Agent_Visit__c Id — talks to Salesforce directly, nothing to look up first)
  middleware/
    auth.js                    ← verifies the session JWT, loads the Agent, checks their position is allowed
  scripts/
    seedAgent.js                 ← creates/updates agent logins (the only way an account gets created)
    testSalesforceAuth.js         ← standalone diagnostic, bypasses the whole app to isolate Salesforce auth problems

── repo root (Vercel-only) ──────────────────────────────
package.json              ← root deps, ESM — lets Vercel resolve what api/index.js needs to import
package-lock.json           ← generated from the above; commit it so Vercel's install is reproducible
vercel.json                   ← one rewrite, /api/(.*)  → /api/index, so Vercel's auto-detected api/index.js function handles every /api/* request; everything else falls through to Vercel's automatic static hosting of /public
api/
  index.js                       ← Vercel serverless entry — imports server/app.js and exports it directly (Express apps are already a valid (req,res) handler)
```

### Why this split, specifically

- **`salesforceService.js` is a hard boundary.** Every route imports from it
  as `import * as salesforce from "../services/salesforceService.js"` and
  never queries Salesforce directly. This means: (a) `SF_MOCK` only has to
  be checked in *one* file, (b) if Salesforce's API ever changes, or you
  swap the auth flow, exactly one file changes, (c) it's the only place
  that ever sees a rack's real QR code — routes and the frontend never do.
- **`routes/racks.js`'s `resolveScan()` helper** is shared by both
  `/scan` and `/scan-any` on purpose — the verify/mismatch/lifecycle/
  locked-status decision is identical either way; only *how the target
  rack was found* differs (client picked it vs. server searched for it).
  It resolves to one of six outcomes, checked in this priority order
  (earlier wins): `already_flagged` (an open `Issue`/`Inactive Rack
  Flagged` — only a human in Salesforce can clear it) → `lifecycle_mismatch`
  (code matched, but `Status__c` isn't `Active`) → `already_verified` →
  `already_resolved` → `verified` → `mismatch`. The last two are the only
  ones that write anything (`verified` writes immediately since there's no
  more deciding left to do; everything else writes nothing until the agent
  makes an explicit choice on `/report` — see the comment block above
  `resolveScan()` for the full reasoning on that ordering).
- **`uploadService.js` has exactly one exported function.** If you ever
  swap Cloudinary for S3 or another provider, this is the only file that
  needs to change — every route just calls `uploadDataUrl()` and doesn't
  know or care what's behind it.
- **The Vercel entry point is deliberately a one-line re-export**, not a
  parallel copy of the app. `server.js` and `api/index.js` both import the
  *same* `server/app.js` — one Express app definition, two ways to run it.

---

## 4. Frontend, file by file

```
public/
  index.html               ← all screens live here as <section class="screen"> elements, toggled by JS
  css/style.css              ← the whole visual design system (colors, type, components, layout)
  manifest.json                ← PWA metadata (name, icons, colors)
  service-worker.js             ← caches the app shell so it opens instantly / works offline
  js/
    app.js                       ← ENTRY POINT. Imports everything below. All screen logic and event wiring lives here.
    state.js                      ← sessionStorage-backed state object, shared across the whole visit; also owns getDeviceId() (a stable per-device id in localStorage, survives across sessions/visits)
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
depends on what, read the top of the file — there's no load-order
requirement anymore.

### The screen model

Every screen is a `<section class="screen" id="screen-X">` in `index.html`,
hidden by default. `showScreen(id)` in `app.js` is the only function that
changes which one is visible — it's a simple show/hide, not a router (no
URL changes per screen, which is also why the back-button needs the
explicit guard in `guard.js` rather than "just working").

### Layout: why `#app` needs a real `height`, not `min-height`

Screens with potentially long content (the rack checklist, above all)
pin a header and an action bar in place and let only the middle region
scroll, so "Scan next rack" / "Quick Scan" / "Finish visit" are always
reachable without hunting to the bottom of a long list. That only works
if `#app` has a **capped** height (`height: 100vh` / `100dvh` +
`overflow: hidden`) — a `min-height` lets the whole page grow past one
screen to fit its content instead, which silently defeats every screen's
own internal scroll region and makes the *document* scroll instead. If a
future screen's buttons seem to "float away" at the bottom of a long list
again, this is the first thing to check.

---

## 5. Mock mode vs. real mode — exactly what happens in each

### `SF_MOCK=true`

| Piece | What really happens |
|---|---|
| Login | **Real.** Checks MongoDB, real bcrypt compare, real JWT issued. |
| Selfie / signature / report photos | **Real.** Actually uploaded to your real Cloudinary account. |
| Agent Visit record | **Fake.** An in-memory object in `mockData.js`, standing in for what would otherwise be a real `Agent_Visit__c` create/update — resets on server restart. |
| Store search | **Fake.** Only `"4021"`, `"4088"`, `"4099"` (or their names — try `"riverside"` for two results) resolve — see `server/services/mockData.js`. |
| Rack checklist | **Fake.** Fixed in-memory list per store, including one rack pre-set to `Issue` (to demo a locked/already-flagged row) and inactive racks with different lifecycle values (`Retired`, `Pending`, `New Request`). |
| QR match/mismatch | **Fake data, real logic.** The comparison, the locked-status check, lifecycle-mismatch detection, already-verified/already-resolved detection — all the *code paths* in `salesforceService.js`/`racks.js` run for real; they just compare against `mockData.js`'s in-memory array instead of a live Salesforce query. |
| Status updates (`Verified`, `Issue`, `Resolved`, `Inactive Rack Flagged`) | **Fake and ephemeral.** Written to the same in-memory JS object — resets to whatever `mockData.js` hardcoded every time the server process restarts. Nothing persists between runs. |
| Rack Report record | **Fake.** An in-memory object mirroring what a real `Rack_Report__c` create (or composite create+update) would produce. |
| Email / Salesforce Task creation | **Not triggered either way** — Salesforce's own Flow/automation owns discrepancy notifications now; this app only ever updates `Verification_Status__c` and creates the report record. See `emailService.js`'s header comment if you want app-triggered email back. |

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
| Rack dimensions | `Rack__c` (field names assumed — see README §3.1 for the ASSUMPTION FLAGGED list) | never written |
| Verification result | n/a | `Account_Rack__c.Verification_Status__c` — **not** `Status__c`, which is the rack's own lifecycle field and is only ever read |
| Who verified it / when | n/a | `Account_Rack__c.Last_Verified_By__c` (their email) and `Last_Verified_Date__c` |
| Agent login | MongoDB `Agent` collection | n/a (read-only at login) |
| Visit record (selfie URL, GPS, device info, start/complete timestamps, signature URL, who signed) | n/a — **not MongoDB** | `Agent_Visit__c` in Salesforce — created at `/start-visit`, updated to `Completed` at `/visits/:id/complete`. Its Salesforce Id *is* the `visitId` the frontend holds for the rest of the visit; there is nothing to look up on the app's own side. |
| Rack report (reason, notes, photo URL, resolution, who/when) | n/a | `Rack_Report__c` — created on every `/report` submission. When it's tied to a specific rack, the status write to `Account_Rack__c` and the `Rack_Report__c` create happen as **one atomic composite API call** (`allOrNone: true`), so you can never end up with a rack marked `Issue` and no report behind it, or vice versa. |

**Timing matters as much as the field:** a clean match writes to Salesforce
immediately (nothing left to decide), but a mismatch, a lifecycle
discrepancy, or an already-resolved rack that recurred writes **nothing**
until the agent actually submits the report screen. Also worth knowing:
GPS/device info is captured once, at `/start-visit`, not per scan — the
frontend does attach a fresh `geo` reading to every `/scan`/`/scan-any`
call too, but `resolveScan()` doesn't currently read it (see README §3.3
for the exact detail if you want to change that).

**Two different data-flow patterns, easy to conflate — worth being
precise about:**
- **Photos** (selfie, signature, report photos) never reach Salesforce as
  binary data at all — they go to Cloudinary first, and only the resulting
  URL string is written to a Salesforce field (`Selfie_Photo_URL__c`,
  `Signature_Photo_URL__c`, `Rack_Report__c.Photo_URL__c`).
- **GPS and device info are the opposite** — they go to Salesforce
  *directly*, as their own fields on `Agent_Visit__c`
  (`Start_Latitude__c`/`Start_Longitude__c`/`Location_Accuracy_Meters__c`
  as numbers, `Device_Info__c` as a JSON-encoded text field — see README
  §3.1). There's no Cloudinary step for either.

What both patterns share: **MongoDB never receives rack, visit, or
business data of any kind** — it holds login credentials and nothing
else. If you find yourself wanting to write rack or visit data to Mongo
"just to be safe," that's a sign the Salesforce field for it doesn't exist
yet — the fix is adding the field, not adding a Mongo copy.

---

## 6. Cookbook — where to make common future changes

| You want to... | Touch these files |
|---|---|
| Add a field to the rack checklist display (e.g. last-restocked date) | `salesforceService.js`'s `convertSalesforceRecordToRack()` (map it from the SOQL result and add it to `RACK_QUERY_FIELDS`) → `convertRackForClient()` in **both** `racks.js` and `stores.js` (see the note below — allow it through to the client in both places) → `renderChecklist()`/`getRackDisplayState()` in `app.js` (display it) |
| Add a new agent role/position | `Agent.js` model's `position` enum → `middleware/auth.js`'s `ALLOWED_POSITIONS` → `seedAgent.js` if you want a demo account with it |
| Change what happens when report notes/photos are submitted | Already wired end-to-end: `/report` → `submitRackReport()` in `salesforceService.js` → `Rack_Report__c` (with `Photo_URL__c`, `Description__c`, `Reason__c`, `Resolution__c`, etc.) plus, when a rack is linked, an atomic status update to `Account_Rack__c` in the same composite call. To add a *new* field to what's captured, extend `buildRackReportFields()` there and the form in `index.html`/`app.js`. |
| Re-enable email notifications | `emailService.js` already has `sendDiscrepancyAlert()` — just call it from the `/report` route in `racks.js` again |
| Swap Cloudinary for S3 (or anything else) | Only `uploadService.js` — its exported function signature (`uploadDataUrl(dataUrl, folder) → url`) is the entire contract the rest of the app relies on |
| Swap the custom auth for Clerk | `routes/auth.js` and `middleware/auth.js` — everything downstream just expects `req.agent` to be populated, so as long as your replacement does that, nothing else changes |
| Add a barcode format alongside QR | `html5-qrcode` already supports other 1D/2D formats — change the config passed to `instance.start()` in `qrscanner.js` |
| Add an admin UI for creating agents (instead of the seed script) | New route (e.g. `routes/admin.js`) gated by `position === "admin"` in `middleware/auth.js`, plus a new screen in `index.html`/`app.js` |
| Add offline support for spotty in-store WiFi | `service-worker.js` already caches the app shell; you'd add a request queue (e.g. IndexedDB) in `api.js` that retries failed `POST`s when connectivity returns |
| Add a manager-facing dashboard (see all visits/issues) | This needs to read *from Salesforce* (since that's where visit and issue state both live now) — likely a new backend route that runs a broader SOQL report query across `Agent_Visit__c`/`Rack_Report__c`, plus a new screen |
| Add automated tests | Nothing exists yet. The route-level test pattern used during development (stub the auth middleware, mount the real router, hit it with real HTTP calls) in a `tests/` folder with a runner like `node --test` or Vitest would fit this codebase well without adding heavy tooling |
| Rate-limit or otherwise harden the API | Add middleware in `app.js`'s stack, e.g. `express-rate-limit`, alongside the existing `cors`/`morgan`/`express.json()` middleware |
| Add another terminal `Verification_Status__c` value (locked, like `Issue`) | Add it to `LOCKED_STATUSES` in `racks.js` — everything else (the `already_flagged` outcome, the checklist's tap-blocking, the result screen) already generalizes over that array, nothing else needs to change |

**Known duplication worth cleaning up:** `convertRackForClient()` is
currently defined separately in both `routes/racks.js` (includes
`dimensions`) and `routes/stores.js` (doesn't). They've already drifted
once — if you add a field to one, it's easy to forget the other. Moving it
into a shared helper (e.g. exported from `salesforceService.js` itself, or
a small `server/utils/` module) would remove that risk; left as-is for now
since it works, just flagged so it isn't mistaken for two different
client shapes on purpose.

---

## 7. Future enhancements worth considering

Roughly ordered by how soon you'd likely want them:

1. **`Rack__c` field mapping confirmation** — not really "future," this is
   the one remaining placeholder blocking real Salesforce use (README
   §3.1): the dimension field API names (`Rack_Shape__c`, `Depth__c`,
   `Width__c`, `Height__c`, `Radius__c`) are a best guess, not confirmed
   against your org.
2. **Admin UI for agent management** — right now creating an agent means
   running `seedAgent.js` by hand. Fine for a pilot, not for a rollout
   across many stores.
3. **Retry queue for scans made with poor connectivity** — stores can have
   bad WiFi; a scan that fails to reach the server right now just shows an
   error toast. Queuing and retrying would make the app much more robust
   in the field.
4. **A lightweight reporting view** — even just "visits completed today,"
   "open discrepancies," pulled from Salesforce (`Agent_Visit__c` /
   `Rack_Report__c`) and rendered for `store_manager`/`regional_manager`
   roles.
5. **Push notifications** — e.g. notify a manager's phone directly when an
   issue is flagged, instead of relying solely on Salesforce's own
   Flow/email. Would need a push subscription model — this would be a new,
   small Mongo collection, and arguably the first legitimate reason to add
   one back, since it's about notifying a person, not tracking a rack or
   visit.
6. **Automated tests** — there are none yet; worth adding once the
   Salesforce field mapping stabilizes, so future changes don't silently
   break the scan-result branching logic in `resolveScan()`.
7. **Rotating the Salesforce Connected App certificate periodically** —
   general security hygiene once this is running in production long-term.

*(Report notes/photo persistence and the Vercel deploy path — both listed
here in the previous revision of this doc — are done; see §9.)*

---

## 8. A note on reading this codebase going forward

If you're trying to trace "what happens when an agent scans a rack,"
start at `handleDecodedCode()` in `public/js/app.js`, follow it to
`Api.scanRack()`/`Api.scanAnyRack()` in `public/js/api.js`, which hits
`POST /api/racks/scan` or `/scan-any` in `server/routes/racks.js`, which
calls `resolveScan()`, which calls into `salesforceService.js`, and back
out through `applyScanOutcome()` in `app.js` for how each of the six
outcomes actually renders. That one path touches almost every
architectural decision in this document — it's the best single thread to
pull on if you want to build a mental model of the whole system quickly.

If you're trying to trace "what happens over the course of one visit,"
start at `/start-visit` in `stores.js` (creates `Agent_Visit__c`, returns
its Id as `visitId`), follow `visitId` through `State` on the frontend as
it's threaded into every scan and report call, and end at
`/visits/:id/complete` in `visits.js` (marks that same record
`Completed`). No Mongo document is ever created or touched anywhere in
that path.

---

## 9. Changelog — what changed since the previous revision of this doc

The previous version of this file had drifted from the actual code in a
few concrete ways. For anyone comparing against an old copy:

- **The `Visit` MongoDB collection is gone.** Visit data (selfie URL, GPS,
  device info, signature URL, timestamps) moved entirely to
  `Agent_Visit__c` in Salesforce. `server/models/` now contains only
  `Agent.js`. Any doc, comment, or mental model that still says "MongoDB —
  Agent + Visit" is describing the old design.
- **`resolveScan()`'s outcome list grew from four to six.** `already_flagged`
  (a locked `Issue`/`Inactive Rack Flagged` status) and `already_resolved`
  (a `Resolved` rack, so a matching scan doesn't silently get rewritten
  back to `Verified`) are both real outcomes the server can return, each
  with their own result screen in `app.js`. The `mismatch` outcome used to
  jump straight to the report screen with no way to just try again; it now
  shows a "Scan again / Report" choice, same as `unknown` already did.
- **Report notes and photos are no longer an unpersisted TODO.** They're
  written to `Rack_Report__c` (`Reason__c`, `Description__c`,
  `Photo_URL__c`, `Resolution__c`, etc.) via an atomic composite call
  alongside the `Account_Rack__c` status update.
- **The Vercel deploy path exists now.** `api/index.js` was present as an
  empty file (it would have 500'd on every request); a root
  `package.json`/`package-lock.json` and `vercel.json` — referenced by
  README's deploy instructions but not actually in the repo — have been
  added. `vercel.json` uses a `rewrites` rule (`/api/(.*)` →
  `/api/index`), not the legacy `builds`/`routes` format — the latter
  conflicts with Vercel's zero-config `/api` auto-detection and is what
  caused the first deploy attempt to fail.
- **Checklist layout and copy cleanup:** `#app`'s height bug (see §4) that
  let long rack lists push the action buttons out of reach is fixed; the
  "unscanned racks" confirmation caps how many rack names it lists instead
  of enumerating an arbitrarily long list; the "Quick scan — any rack"
  button is now just "Quick Scan."
- **Two factual corrections, not just missing updates:** README previously
  claimed a lifecycle-inactive rack gets `Inactive Rack Flagged` written
  *immediately* on scan — it doesn't; like every other non-clean-match
  outcome, nothing is written until the agent explicitly reports it (see
  README §3.3). This doc also previously claimed GPS/device info only ever
  reach Salesforce as a photo-URL string, same as photos — they don't;
  they're written directly as their own fields on `Agent_Visit__c` (see
  §5 above and README §3.1). Both are corrected now, not just reworded.
- **README §3.1 now documents `Agent_Visit__c` and `Rack_Report__c`
  field-by-field** — previously only `Account_Rack__c`/`Rack__c` had a
  table, even though the other two objects were already being written to.
