# Rack Audit — store rack verification app

A mobile-first web app (installable PWA — works on iOS and Android home
screens) for field agents to visit a store, scan every rack's QR code, and
verify the result against Salesforce in real time.

**Flow:** login → selfie → enter store → scan every rack (tap-a-rack-then-scan,
or open-camera "scan anything") → mismatches get a note + optional photo and
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
| Database | **MongoDB — Agent + Visit only** | See "Where data lives" below |
| Photo/signature storage | **Cloudinary** | Direct browser upload, CDN URL back, no server-side file handling |
| Salesforce link | OAuth 2.0 **JWT Bearer flow**, server-to-server | No agent ever enters Salesforce credentials |
| Login | Custom username/password (bcrypt + JWT), admin-provisioned only | No public sign-up route exists |

### Where data lives

By design, MongoDB only holds **field-person data** — proof of who visited
a store, when, and from where:
- `Agent` — login credentials (admin-provisioned, see §5).
- `Visit` — one record per store visit: selfie URL, GPS, device info,
  signature, timestamps.

Everything about the racks themselves — verification status, who last
verified a rack, discrepancies — is written **directly to Salesforce** and
never duplicated in Mongo. There's no `RackScan` or `Discrepancy` collection
on purpose. If you ever want a scan-by-scan audit log independent of
Salesforce, that would mean reintroducing a Mongo collection for it — ask
and I'll add it back.

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
(`resolveScan()`): `verified`, `already_verified`, `mismatch`, or
`inactive_blocked`. `scan-any` has one extra possible outcome, `unknown`,
for a code that doesn't belong to any rack on that store's list at all.

### Inactive racks are handled automatically, not via the report form

If a scanned code correctly matches a rack, but Salesforce has that rack
marked `isActive: false`, the app doesn't ask the agent anything — it's a
data-integrity issue, not something a field agent should resolve on the
spot. The server immediately writes a distinct status
(`"Flagged - Inactive Rack"` — confirm this exact value exists in your
`Status__c` picklist, or tell me the one you'd rather use) and shows the
agent a plain "flagged automatically" result screen. Your own Salesforce
Flow/automation is expected to take it from there.

### Confirm-before-leaving

Once a visit starts (`NavGuard.enable()` right after `/start-visit`
succeeds), the back button and tab close/refresh are intercepted with a
confirmation prompt, since navigating away mid-visit could lose progress.
It's released again once the visit is completed or the agent logs out.
See `public/js/guard.js` — this is a best-effort standard SPA pattern, not
a hard guarantee across every browser.

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
  vercel.json              routes /api/* to api/index.js; /public served statically by Vercel
  package.json             root deps (ESM), used by Vercel to build api/index.js
  server/                 Express API — all ES modules
    app.js                  the actual Express app (routes, middleware) — imported by both server.js and api/index.js
    server.js               entry point for traditional hosts (Render/Railway/local) — just calls app.listen()
    config/                db.js (cached Mongo connection), cloudinary.js
    models/                Agent, Visit — the ONLY two Mongo collections (see §1)
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
Tasks itself. It only ever writes `Verification_Status__c` (and the two
`Last_Verified_*` fields); your own Salesforce Flow/automation is expected
to react to that field changing and handle Case creation, emails, and
alerts. `emailService.js` still exists but is unused — nothing calls it.

**When that write actually happens is deliberately not "every scan":**
- A clean match → written immediately (`Verified`).
- A rack Salesforce marks inactive → written immediately (`Inactive Rack
  Flagged`) — this is a system-detected condition, not a judgment call, so
  there's nothing to wait on.
- A mismatch → **nothing is written yet.** The agent might scan a
  different rack next, or realize their own mistake, before ever deciding
  it's worth reporting. Only submitting the report screen (either "Save —
  I resolved this issue" → `Resolved`, or "Report issue" → `Issue`) writes
  anything. This is what keeps a run of failed scan attempts from
  triggering your Salesforce automation on every single one of them.
- Once a rack is `Issue` or `Inactive Rack Flagged`, the app will never
  silently change it again just because a later scan happens to match —
  only clearing it in Salesforce directly (by an admin/manager) does that.
  Scanning a locked rack returns an `already_flagged` result instead.

The report screen requires **both a description and a photo** before it
can be submitted, whichever button is used — this is enforced client-side
(for immediate feedback) and again server-side (as a backstop).

One open gap: the report's **notes and reason** currently have nowhere to
go in Salesforce (no confirmed field for them yet — the "Comments" field
seen in your record screenshots is a candidate, but I don't have its API
name). The photo still uploads to Cloudinary either way (so it's not
lost), and for the one case with no matching rack at all (a scanned code
that doesn't belong to any rack on the store's list), there's no
`Account_Rack__c` to write anything to regardless — that report is
captured (photo + reason) but not linked to any Salesforce record. Tell me
the Comments field's API name, and separately whether you want that
unlinked case to create something in Salesforce (e.g. a Case on the
Account) and which object/fields to use, and I'll wire both in.

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
`4021` or `4088` — those are the two mock stores in
`server/services/mockData.js`. Store 4021 includes one **inactive** rack
(`RACK-4021-05`, Bakery · Bay 2) specifically so you can test the
auto-flag behavior: it shows dimmed and non-tappable in the checklist, but
using **Quick scan — any rack** and scanning its correct code will still
trigger the "flagged automatically" result.

## 6. Deploying to Vercel

The project is already structured for this — `api/index.js` exports the
Express app directly (Vercel treats it as a serverless function), and
`vercel.json` routes only `/api/*` requests to it. Everything under
`/public` is served automatically by Vercel's static hosting and never
touches the function.

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
inactive-rack auto-flagging, the report form (reason picklist + custom
text, mandatory photo + description, resolve/escalate branching), an
already-flagged guard so the app can never silently overwrite an open
Issue, deferred Salesforce writes (a mismatch only gets written once the
agent makes a final decision, not on every attempt), signature capture,
GPS + timestamp + device info before every scan, a custom confirm dialog
with explicit button labels, confirm-before-leaving mid-visit, installable
PWA with a real install prompt, full ES-module codebase front and back.

**Needs your input before going live:**
- `Rack__c`'s dimension field API names (§3.1) — currently assumed, not
  confirmed the way `Account_Rack__c`'s were.
- The "Comments" field's API name, if you want report notes/reason
  persisted in Salesforce (§3.3).
- Whether an unmatched-code report (no rack found at all) should create
  something in Salesforce, and if so, what (§3.3) — right now it's
  captured (photo + reason) but not linked to any record.
- Real app icons (placeholders are in `public/icons/`).
