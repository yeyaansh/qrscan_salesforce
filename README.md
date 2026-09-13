# Rack Audit — store rack verification app

A mobile-first web app (installable PWA — works on iOS and Android home
screens) for field agents to visit a store, scan every rack's QR code, and
verify the result against Salesforce in real time.

**Flow:** login → selfie → enter store → scan every rack (tap-a-rack-then-scan,
or open-camera "scan anything") → mismatches get a required note + photo and
are either resolved on the spot or flagged for follow-up → signature → visit
summary.

This is a **working prototype**: `SF_MOCK=true` lets you click through the
entire flow with realistic fake data and no Salesforce org connected yet.
Flip it to `false` once your org is set up.

---

## 1. Architecture

Both the frontend and backend are plain **ES modules** (`import`/`export`)
end to end — no bundler, no transpile step, no framework. The goal is that
you can open any single file, see exactly what it imports at the top, and
know its full dependency graph without hunting through global `<script>`
tags or `require()` calls scattered through the code.

| Piece | Choice | Why |
|---|---|---|
| Frontend | Plain HTML/CSS/JS (ES modules), installable PWA | No build step, small footprint, works identically in Safari (iOS) and Chrome (Android) |
| QR scanning | [html5-qrcode](https://github.com/mebjas/html5-qrcode) (CDN) | Uses the phone camera directly in the browser, no native app needed |
| Backend | Node.js + Express (ES modules) | Single process serves both the API and the frontend |
| Database | **MongoDB — Agent only** | See "Where data lives" below |
| Photo/signature storage | **Cloudinary** | Direct browser upload, CDN URL back, no server-side file handling |
| Salesforce link | OAuth 2.0 **JWT Bearer flow**, server-to-server | No agent ever enters Salesforce credentials |
| Login | Custom username/password (bcrypt + JWT), admin-provisioned only | No public sign-up route exists |

### Where data lives

By design, MongoDB holds **exactly one thing**: `Agent` login credentials
(admin-provisioned, see §5). That's the entire collection list.

Visit data (selfie URL, GPS, device info, signature URL, timestamps) used
to live in a Mongo `Visit` collection; it's since moved to `Agent_Visit__c`
**in Salesforce** — created the moment a visit starts, updated to
`Completed` when the agent signs off. Its Salesforce Id *is* the `visitId`
the frontend carries for the rest of the visit; there's no Mongo document
behind it to keep in sync.

Everything about the racks themselves — verification status, who last
verified a rack, discrepancies — is also written **directly to Salesforce**
(`Account_Rack__c` and `Rack_Report__c`) and never duplicated in Mongo.
There's no `RackScan` or `Discrepancy` collection on purpose. If you ever
want a scan-by-scan audit log independent of Salesforce, that would mean
reintroducing a Mongo collection for it — ask and I'll add it back.

### Blind verification

The QR code a rack is *supposed* to have never leaves the server. The
`/api/racks` (checklist) response only ever includes a rack's `id`, `label`,
`isActive`, and `status` — never its code. Every comparison happens
server-side in `salesforceService.js`, using a fresh read of the rack's
real code at scan time, not anything the browser sends. There's also no
manual code-entry fallback in the UI — camera only.

### Two ways to scan

- **Tap a rack, then scan** (`POST /api/racks/scan`) — the agent picks a
  specific rack from the checklist first; the server checks the scanned
  code against that one rack.
- **Scan anything** (`POST /api/racks/scan-any`) — the agent just opens the
  camera; the server searches the store's whole rack list server-side to
  figure out which rack (if any) the code belongs to.

Both share the same outcome handling in `routes/racks.js`
(`resolveScan()`): `already_flagged` (a locked `Issue`/`Inactive Rack
Flagged` status — only Salesforce can clear it), `lifecycle_mismatch`,
`already_verified`, `already_resolved` (a `Resolved` rack scanned again —
shown as "already resolved" rather than silently rewritten back to
`Verified`), `verified`, or `mismatch` (scanned a code that belongs to a
different real rack — the agent gets a "Scan again / Report" choice, not
an automatic report). `scan-any` has one extra possible outcome, `unknown`,
for a code that doesn't belong to any rack on that store's list at all.

### A rack whose lifecycle status isn't Active — the agent decides, nothing writes automatically

If a scanned code correctly matches a rack, but that rack's `Status__c`
(lifecycle) isn't `Active` — it's `Retired`, `Pending`, or `New Request` —
the app does **not** silently write anything or silently accept it as
verified either. The agent scanned it correctly and it's physically there,
so this is presented as a heads-up ("Salesforce shows this rack's status as
'Retired', not Active — would you like to report this?"), not an error.
They can tap **Report this rack** (opens the report screen, pre-filled
with a sensible reason/description they can still edit, and submitting it
writes `Inactive Rack Flagged` specifically — distinct from a plain
`Issue` — if they escalate) or **Scan again** (does nothing, no write at
all, same as any other skipped mismatch).

Separately, checklist rows for racks that aren't `Active` are shown
dimmed and non-tappable, labeled with their actual lifecycle value
(`Retired`/`Pending`/`New Request`) rather than a generic "Inactive" — so
the agent can see at a glance why a rack isn't expected to be scanned via
the normal tap-a-rack flow. They're still reachable through **Quick Scan**, which is what triggers the flow above.

### Confirm-before-leaving

Once a visit starts (`NavGuard.enable()` right after `/start-visit`
succeeds), the back button and tab close/refresh are intercepted with a
confirmation prompt, since navigating away mid-visit could lose progress.
It's released again once the visit is completed or the agent logs out.
See `public/js/guard.js` — this is a best-effort standard SPA pattern, not
a hard guarantee across every browser. Within the app itself, the
signature screen also has a plain "Go back and keep scanning" button, in
case "Finish visit anyway" was tapped by mistake — nothing about the
racks already scanned is affected either way, since that's tracked
independently of which screen is showing.

### Install prompt

`public/js/install.js` shows a real "Install" button on Android/Chrome
(via the `beforeinstallprompt` event). iOS Safari never fires that event at
all — there's no programmatic install API on iOS — so it instead shows
"tap Share → Add to Home Screen" instructions.

---

## 2. Project layout

```
rack-audit-app/
  api/index.js            Vercel serverless entry — imports server/app.js
  vercel.json              one rewrite: /api/* → /api/index (see §6 for why not the legacy builds/routes format)
  package.json             root deps (ESM), used by Vercel to build api/index.js
  server/                 Express API — all ES modules
    app.js                  the actual Express app (routes, middleware) — imported by both server.js and api/index.js
    server.js               entry point for traditional hosts (Render/Railway/local) — just calls app.listen()
    config/                db.js (cached Mongo connection), cloudinary.js
    models/                Agent — the ONLY Mongo collection (see §1)
    services/
      salesforceService.js  the only file that talks to Salesforce / knows a rack's real QR code
      uploadService.js      Cloudinary uploads
      emailService.js       NOT currently used — kept in case you want app-triggered email again
      mockData.js           fake stores/racks for SF_MOCK=true
    routes/                 auth.js, stores.js, racks.js (scan / scan-any / discrepancy), visits.js
    middleware/auth.js      session verification + role check
    scripts/
      seedAgent.js           creates the first agent logins
      testSalesforceAuth.js  standalone diagnostic for the JWT Bearer connection
  public/                  the PWA frontend — all ES modules, single entry point (js/app.js)
    index.html, manifest.json, service-worker.js
    css/style.css
    js/
      app.js                 entry point — imports everything else
      state.js, api.js, geolocation.js, camera.js, qrscanner.js, signature.js
      guard.js                confirm-before-leaving mid-visit
      install.js              PWA install prompt (Android real prompt / iOS instructions)
    icons/                  placeholder app icons — swap for your real logo
```

---

## 3. Salesforce setup

### 3.1 Object model

`Account_Rack__c` is a **junction object** between `Account` (store) and a
separate `Rack__c` object — confirmed fields on `Account_Rack__c`:

| Field API name | Type | Used for |
|---|---|---|
| `Account__c` | Lookup(Account) | which store — `getRacksForStore()` filters on this |
| `Rack__c` | Lookup(Rack) | the related rack master record |
| `Status__c` | Picklist (`New Request`/`Pending`/`Active`/`Retired`) | the rack's own **lifecycle** — the app only ever reads this (to derive `isActive`), never writes it |
| `Verification_Status__c` | Picklist (`Not Verified`/`Verified`/`Issue`/`Resolved`/`Inactive Rack Flagged`) | the app's own field — every scan result is written here instead, so it never collides with the lifecycle field above |
| `Install_Date__c` | Date | not written by the app |
| `Last_Verified_By__c` | **Email** | the agent's email, written whenever `Verification_Status__c` is written |
| `Last_Verified_Date__c` | Date | written alongside it |

And on the related `Rack__c` (confirmed via its own field screenshots — a
pure spec sheet, no per-installation data):

| Field API name (assumed — flag if wrong) | Used for |
|---|---|
| `Rack_Shape__c` | Shown on a "Verified" result for a quick sanity check |
| `Depth__c` / `Width__c` (Rectangular) or `Radius__c` (Circular) | Same |
| `Height__c` | Same |

The dimension field API names above follow your org's established
convention but, unlike `Account_Rack__c`'s fields, haven't been confirmed
the way those were — if a query errors with `INVALID_FIELD` for one of
these, send me the real name and I'll swap it in.

Also confirm the **Store** object — `searchStores()` queries `Account` with a
`Store_Number__c` field; adjust it if stores live elsewhere.

Two more custom objects hold everything about a visit itself — neither
exists in MongoDB (see §1):

**`Agent_Visit__c`** — one record per visit, created at `/start-visit` and
updated to `Completed` at sign-off:

| Field API name | Written | When |
|---|---|---|
| `Store__c` | Lookup(Account) | at creation |
| `Agent_Name__c` / `Agent_Email__c` | Text/Email | at creation |
| `Visit_Status__c` | Picklist (`In Progress` → `Completed`) | at creation, then again at completion |
| `Visit_Started__c` / `Visit_Completed__c` | DateTime | at creation / at completion |
| `Selfie_Photo_URL__c` | URL (Cloudinary) | at creation, if a selfie was captured |
| `Start_Latitude__c` / `Start_Longitude__c` / `Location_Accuracy_Meters__c` | Number | at creation, if geolocation succeeded |
| `Device_Info__c` | Text | at creation, if device info was captured — **ASSUMPTION FLAGGED**: this reads as a single text field on the layout, so the device object is JSON-encoded into it (truncated to 255 chars) rather than split across several fields. If there are actually separate fields for platform/browser/etc., tell me their API names and this gets split out properly. |
| `Signature_Photo_URL__c` | URL (Cloudinary) | at completion |
| `Signed_By__c` / `Signed_At__c` | Text/DateTime | at completion |

**`Rack_Report__c`** — one record per `/report` submission (a mismatch, a
lifecycle flag, a resolved issue, or a code that didn't match any rack at
all):

| Field API name | Written | Notes |
|---|---|---|
| `Store__c` | Lookup(Account) | always |
| `Reason__c` | Text | free text the agent types (e.g. "Rack is missing," "wrong location") — the form's `reportReason` field is a plain text input, not a dropdown |
| `Description__c` | Text | the agent's free-text notes |
| `Photo_URL__c` | URL (Cloudinary) | if a photo was attached (required by the form — see below) |
| `Reported_By_Name__c` / `Reported_By_Email__c` | Text/Email | the logged-in agent |
| `Reported_At__c` | DateTime | always |
| `Related_Account_Rack__c` | Lookup(Account_Rack__c) | only when the report is tied to a specific rack (absent for an unmatched-code report) |
| `Scanned_Code__c` | Text | the code actually scanned, if any |
| `Agent_Visit__c` | Lookup(Agent_Visit__c) | ties the report back to the visit it happened during |
| `Resolution__c` | Picklist | **ASSUMPTION FLAGGED**: the only confirmed value seen so far is `"Escalated"`. `"Resolved On The Spot"` (used when the agent picks "I resolved this issue") is a reasonable mirror but hasn't been confirmed against the real picklist — if it rejects with an `INVALID_FIELD_FOR_INSERT_UPDATE`/picklist error, send me the exact accepted values. |

When a report is tied to a rack, the `Account_Rack__c` status write and the
`Rack_Report__c` create happen as **one atomic Salesforce composite API
call** (`allOrNone: true`) — you can never end up with a rack marked
`Issue` with no report behind it, or a report with no status change, one
succeeding without the other.

### 3.2 Connected App (JWT Bearer flow)

1. Generate a private key + self-signed certificate:
   ```
   openssl req -x509 -sha256 -nodes -days 365 -newkey rsa:2048 \
     -keyout salesforce.key -out salesforce.crt
   ```
   Put `salesforce.key` in `server/config/` (already gitignored).
2. Salesforce Setup → **App Manager → New Connected App**.
   - Enable OAuth Settings.
   - Check **Use digital signatures**, upload `salesforce.crt`.
   - OAuth scopes: `Manage user data via APIs (api)` and
     `Perform requests at any time (refresh_token, offline_access)`.
3. Save, then edit the app's **policies**: set "Permitted Users" to
   *Admin approved users are pre-authorized*, and add your integration user
   (a dedicated Salesforce user, not a real agent) to the pre-authorized
   profile/permission set. Relax IP restrictions too.
4. Copy the **Consumer Key** into `SF_CLIENT_ID` in `.env`.
5. Set `SF_USERNAME` to the integration user's exact Salesforce username.
6. Give it a few minutes to propagate before testing.

Use `npm run diagnose:sf` (or `node scripts/testSalesforceAuth.js` from
`server/`) to isolate connection problems without digging through app logs.

### 3.3 Notifications — Salesforce owns this, not the app

Per your direction, the app does **not** send email or create Salesforce
Tasks itself. Every write goes to `Account_Rack__c`'s `Verification_Status__c`
(plus the two `Last_Verified_*` fields) and/or a new `Rack_Report__c`
record (§3.1) — your own Salesforce Flow/automation is expected to react to
those and handle Case creation, emails, and alerts. `emailService.js` still
exists but is unused — nothing calls it.

**When each write actually happens is deliberately not "every scan":**
- A clean match → `Account_Rack__c.Verification_Status__c` written
  immediately as `Verified`. Nothing left to decide, so there's nothing to
  wait on.
- A rack Salesforce shows as not `Active` (`Retired`/`Pending`/`New
  Request`), scanned with a matching code → **nothing is written yet.**
  This is presented to the agent as a heads-up, not an error — only if
  they tap "Report this rack" and submit does it write
  `Inactive Rack Flagged` (plus a `Rack_Report__c`); tapping "Scan again"
  writes nothing at all.
- A mismatch (wrong rack scanned) → **nothing is written yet** either. The
  agent might scan a different rack next, or realize their own mistake,
  before ever deciding it's worth reporting. Only submitting the report
  screen (either "Save — I resolved this issue" → `Resolved`, or "Report
  issue" → `Issue`) writes anything. This is what keeps a run of failed
  scan attempts from triggering your Salesforce automation on every single
  one of them.
- A scanned code that doesn't belong to any rack on the store's list at
  all → there's no `Account_Rack__c` to write a status to regardless; if
  the agent reports it, a standalone `Rack_Report__c` is still created
  (photo, reason, notes, who/when), just with no `Related_Account_Rack__c`
  lookup populated.
- Once a rack is `Issue` or `Inactive Rack Flagged`, the app will never
  silently change it again just because a later scan happens to match —
  only clearing it in Salesforce directly (by an admin/manager) does that.
  Scanning a locked rack returns an `already_flagged` result instead, with
  no write at all.
- A rack that's `Resolved`, scanned again with a matching code → also
  **no write** — it's shown as "already resolved" instead of being
  silently flipped back to `Verified` (with a "Report this rack" option in
  case the same problem has actually recurred).

The report screen requires a reason, a description, **and** a photo
before it can be submitted, whichever button is used. Client-side
(`validateReportForm()` in `app.js`) checks all three, for immediate
feedback. The server-side backstop (`POST /api/racks/report` in
`racks.js`) only re-checks the description and photo — it doesn't require
`reason` to be non-empty. That's a real gap if `/report` is ever called
directly rather than through this UI (the frontend always sends a reason,
so it doesn't surface in normal use), worth closing if you build a second
client against this API.

**One more timing detail, since it's easy to assume otherwise:** GPS and
device info are captured once, at `/start-visit`, and written to
`Agent_Visit__c` — not re-captured on every scan. The frontend *does*
attach a fresh `geo` reading to every `/scan` and `/scan-any` request too
(see `Api.scanRack()`/`Api.scanAnyRack()` in `public/js/api.js`), but
`resolveScan()` currently never reads `req.body.geo` — it's accepted and
silently ignored server-side. If you want a per-scan location trail later,
that's a small server-side change (nothing needs to change on the
frontend, since it's already sending the data).

---

## 4. MongoDB & Cloudinary

- **MongoDB Atlas**: create a free cluster → get the connection string →
  put it in `MONGODB_URI`.
- **Cloudinary**: sign up (free tier) → dashboard shows Cloud name, API
  key, API secret → put them in `.env`.

---

## 5. Run it locally

```bash
cd server
npm install
cp .env.example .env      # fill in Mongo + Cloudinary; leave SF_MOCK=true to start
npm run seed:agent        # creates demo logins: jsmith / ChangeMe123!
npm run dev
```

Open **http://localhost:4000** on your phone (same Wi-Fi, use your
computer's LAN IP instead of localhost) or in a desktop browser — camera/
geolocation need HTTPS or `localhost` to work, so for real-phone testing
over LAN you'll need a tunnel (e.g. `ngrok http 4000`) or a deployed URL.

Log in with `jsmith` / `ChangeMe123!`, take a selfie, and search store
`4021`, `4088`, or `4099` (try `"riverside"` to see the multi-result store
list) — see `server/services/mockData.js` for the full mock catalog. Store
4021 in particular is built for testing every status case at once:
- `RACK-4021-04` starts pre-flagged `Issue` — confirms the checklist shows
  "Issue Raised" immediately, not "Pending" until rescanned.
- `RACK-4021-05` is `Retired` and `RACK-4021-06` is `Pending` — both show
  dimmed and non-tappable in the checklist with their specific lifecycle
  label, but scanning either one's correct code via **Quick Scan**
  triggers the "Report this rack?" prompt.
- Store 4088 also has one `New Request` rack (`RACK-4088-04`) for the
  third lifecycle value.

## 6. Deploying to Vercel

The project is already structured for this — `api/index.js` exports the
Express app directly (Vercel's Node.js runtime treats it as a serverless
function automatically, with no config needed to make Vercel *find* it),
and `vercel.json` adds one **rewrite** so a request to `/api/anything`
resolves to that function:

```json
{
  "version": 2,
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/index" }
  ]
}
```

Everything under `/public` is served automatically by Vercel's static
hosting and never touches the function at all.

> **If you hand-write a different `vercel.json`, avoid the legacy
> `builds`/`routes` keys** (`{ "builds": [...], "routes": [...] }`) —
> that format predates Vercel's zero-config `/api` detection and the two
> can conflict, which is what caused this project's deploy to fail before
> it was switched to `rewrites`. `rewrites` (shown above) works *with*
> the auto-detected function instead of trying to redefine it.

1. Push the repo (as-is, including the root `package.json`, `api/`, and
   `vercel.json`) to GitHub and import it in Vercel, or run `vercel` from
   the project root with the Vercel CLI.
2. In the Vercel project's **Environment Variables**, add everything from
   `server/.env.example` *except* `PORT` (Vercel manages that).
3. For the Salesforce private key: **don't** use `SF_PRIVATE_KEY_PATH` —
   Vercel functions have no persistent filesystem. Paste the key's
   contents (real newlines replaced with literal `\n`) into `SF_PRIVATE_KEY`
   instead — `salesforceService.js` unescapes it automatically.
4. Deploy. Test with `SF_MOCK=true` first, then flip it once your
   Salesforce env vars are confirmed.

**Two Vercel-specific limits to know about:**
- **Request body size** — Vercel's Hobby plan caps serverless function
  request bodies around 4.5MB. Selfies/signatures are base64 (which
  inflates size ~33%), so a large photo could get close. The app's own
  `express.json()` limit is set to 4MB to fail with a clear error first —
  if you see `413`s, lower the JPEG quality/resolution in `public/js/camera.js`.
- **Function duration** — Hobby plan times out around 10s; a Salesforce
  token fetch + query comfortably fits.

## 7. Going live with real data (any host)

1. Get `Rack__c`'s dimension field names confirmed (§3.1) — currently
   assumed based on your org's naming convention.
2. Print QR codes containing each rack's real code value.
3. Set `SF_MOCK=false` and fill in the Salesforce env vars from §3.
4. Confirm your `Verification_Status__c` picklist has exactly these five
   values: `Not Verified`, `Verified`, `Issue`, `Resolved`, `Inactive Rack
   Flagged`.
5. Deploy `server/` (Render, Railway, Heroku, EC2, etc.) or Vercel (§6) —
   either way it's a single Node process; nothing separate to deploy for
   the frontend.
6. On a phone, open the deployed HTTPS URL and use "Add to Home Screen" —
   or just tap the in-app install banner.

---

## 8. What's already covered vs. what needs your input

**Already implemented:** admin-provisioned login, selfie capture (mirrored
preview for the front camera), store search with a real list of matches,
rack checklist from Salesforce (or mock) with no codes ever sent to the
browser, both scan modes, rack dimensions shown on a "Verified" result,
lifecycle-mismatch detection that asks the agent rather than writing
anything automatically, the report form (free-text reason field, mandatory
description and photo, resolve/escalate branching) writing a full
`Rack_Report__c` record — including for a scanned code that doesn't match
any rack at all — atomically alongside the `Account_Rack__c` status update
when one applies, an already-flagged guard so the app can never silently
overwrite an open Issue, an already-resolved guard so a `Resolved` rack
can't get silently flipped back to `Verified` either, deferred Salesforce
writes (a mismatch only gets written once the agent makes a final
decision, not on every attempt), signature capture, GPS + timestamp +
device info captured once per visit and written to `Agent_Visit__c`
(see the note at the end of §3.3), a custom confirm dialog with
explicit button labels, confirm-before-leaving mid-visit, installable PWA
with a real install prompt, full ES-module codebase front and back
including the Vercel deploy path.

**Needs your input before going live:**
- `Rack__c`'s dimension field API names (§3.1) — currently assumed, not
  confirmed the way `Account_Rack__c`'s were.
- `Agent_Visit__c.Device_Info__c`'s exact shape (§3.1) — assumed to be one
  JSON-encoded text field; confirm if it's actually several separate
  fields.
- `Rack_Report__c.Resolution__c`'s exact accepted picklist values (§3.1) —
  only `"Escalated"` has been confirmed so far.
- Real app icons (placeholders are in `public/icons/`).
