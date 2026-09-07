# Rack Audit — store rack verification app

A mobile-first web app (installable PWA — works on iOS and Android home screens)
for field agents to visit a store, scan every rack's QR code, and verify the
result against Salesforce in real time.

**Flow:** login → selfie → enter store → scan every rack → mismatches get a
note + photo, and are either resolved on the spot or escalated (manager
email + a Salesforce Task) → signature → visit summary.

This is a **working prototype**: `SF_MOCK=true` lets you click through the
entire flow with realistic fake data and no Salesforce org connected yet.
Flip it to `false` once your org is set up.

---

## 1. Stack, and why

| Piece | Choice | Why |
|---|---|---|
| Frontend | Plain HTML/CSS/JS, installable PWA | No build step, small footprint, works identically in Safari (iOS) and Chrome (Android) |
| QR scanning | [html5-qrcode](https://github.com/mebjas/html5-qrcode) (CDN) | Uses the phone camera directly in the browser, no native app needed |
| Backend | Node.js + Express | Single process serves both the API and the frontend |
| Database | MongoDB | Stores visits, scan results, GPS/timestamp/device audit trail — data Salesforce doesn't need to hold |
| Photo/signature storage | **Cloudinary** | See note below |
| Salesforce link | OAuth 2.0 **JWT Bearer flow**, server‑to‑server | See note below |
| Login | Custom username/password (bcrypt + JWT), admin-provisioned only | See note below |

**Cloudinary vs. Google Drive:** Cloudinary is purpose-built for this —
direct upload from the browser, automatic image optimization, and a fast CDN
URL back for each photo/signature. Google Drive's API is built for document
collaboration (folders, sharing permissions) and is a worse fit for
programmatic, high-volume image storage. Cloudinary's free tier easily
covers a pilot.

**Salesforce OAuth — server-to-server:** Per your answer, agents never enter
Salesforce credentials. The backend authenticates itself to Salesforce once
as a single integration user (JWT Bearer flow), and any logged-in agent with
an allowed `position` shares that connection. See §3 for the exact
Connected App setup.

**On Clerk vs. the built-in auth:** you asked for admin-provisioned
username/password logins with no public sign-up — nobody but an admin can
create an account. That's implemented directly with MongoDB + bcrypt + a
signed session token (see `server/routes/auth.js` — there is deliberately no
`/register` route, only `scripts/seedAgent.js`, which is what an admin would
run to create each agent). This fully satisfies the requirement without
extra setup. If you'd still like Clerk specifically (e.g. for its
admin dashboard UI to manage agents), it drops in as a replacement for
`routes/auth.js` + `middleware/auth.js` — ask and I'll wire it in.

---

## 2. Project layout

```
rack-audit-app/
  server/                 Express API
    config/                db.js, cloudinary.js
    models/                Agent, Visit, RackScan, Discrepancy (Mongoose)
    services/               salesforceService.js, uploadService.js, emailService.js, mockData.js
    routes/                 auth.js, stores.js, racks.js, visits.js
    middleware/auth.js      session verification + role check
    scripts/seedAgent.js    creates the first agent logins
    server.js               entry point — also serves /public
  public/                  the PWA frontend (served by the same server)
    index.html, manifest.json, service-worker.js
    css/style.css
    js/  api.js, state.js, camera.js, qrscanner.js, signature.js, geolocation.js, app.js
    icons/                 placeholder app icons — swap for your real logo
```

---

## 3. Salesforce setup

### 3.1 Custom object

You mentioned `Account_Rack__c` already exists with an active/inactive
field. The code in `server/services/salesforceService.js` assumes these
fields — check them against what you have and adjust the field names in
that file to match your org exactly:

| Field API name | Type | Purpose |
|---|---|---|
| `Store__c` | Lookup/Text to Account | which store the rack belongs to |
| `QR_Code__c` | Text | the value printed in the rack's QR code |
| `Bay_Location__c` | Text | human label shown in the app's checklist |
| `Is_Active__c` | Checkbox | *(you already have this)* |
| `Status__c` | Picklist: Not Verified / Verified / Discrepancy / Resolved | written back after every scan |
| `Last_Verified_By__c` | Text | agent's name |
| `Last_Verified_Date__c` | Date/Time | when it was last scanned |

Also confirm the **Store** object — the code queries `Account` with a
`Store_Number__c` field; change `findStore()` in `salesforceService.js` if
stores live on a different object.

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
   profile/permission set.
4. Copy the **Consumer Key** into `SF_CLIENT_ID` in `.env`.
5. Set `SF_USERNAME` to the integration user's Salesforce username.

### 3.3 Task / email routing

`racks.js` creates a Salesforce **Task** on the rack record and can email a
manager. Point `defaultManagerEmail` on each `Agent` (see
`scripts/seedAgent.js`) at the right person, or pass a specific
`managerEmail` per store if you want per-store routing instead — that's a
one-line change in `app.js`'s `submitDiscrepancy()`.

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
computer's LAN IP instead of localhost) or in a desktop browser's device
emulator — camera/geolocation need HTTPS or `localhost` to work, so for
real-phone testing over LAN you'll need a tunnel (e.g. `ngrok http 4000`)
or a deployed HTTPS URL.

Log in with `jsmith` / `ChangeMe123!`, take a selfie, and search store
`4021` or `4088` — those are the two mock stores in
`server/services/mockData.js`, each with a handful of racks. The QR codes
they expect are things like `RACK-4021-01` — use the **"Enter code
manually"** link on the scan screen to type that exact value and see a
match, or type anything else to see the mismatch → discrepancy flow.

## 6. Going live with real data

1. Print QR codes containing each rack's `QR_Code__c` value.
2. Set `SF_MOCK=false` and fill in the Salesforce env vars from §3.
3. Configure SMTP vars for real manager emails.
4. Deploy `server/` (Render, Railway, Heroku, EC2, etc. all work — it's a
   single Node process). Since it also serves `/public`, there's nothing
   separate to deploy for the frontend.
5. On a phone, open the deployed HTTPS URL and use "Add to Home Screen" —
   it installs like an app.

---

## 7. What's already covered vs. what needs your input

**Already implemented:** login (admin-provisioned only), selfie capture,
store lookup, rack checklist pulled live from Salesforce (or mock),
QR scan with match/mismatch, discrepancy form with photo, resolved vs.
escalate branching, manager email, Salesforce Task creation, signature
capture, GPS + timestamp + device info captured before every scan, full
visit summary, installable PWA shell.

**Needs your input before going live:**
- Confirm/adjust the Salesforce field API names in §3.1.
- Decide manager routing (per-agent default vs. per-store).
- Real app icon (placeholder icons are in `public/icons/`).
- Whether you want Clerk swapped in for admin user management (see note
  in §1) — the current auth already meets the stated requirement, so this
  is optional polish, not a gap.
