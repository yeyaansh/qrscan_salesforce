// Main app controller. One responsibility per section below — screens are
// just <section class="screen"> elements toggled with showScreen(); each
// section of this file owns one screen and the API calls it needs.
//
// A note on style: this file deliberately favors explicit if/else blocks
// over ternary expressions, and named intermediate variables over chained
// one-liners. It is longer than it strictly needs to be as a result — that
// trade-off is intentional, so the logic can be read top-to-bottom without
// having to mentally unpack compressed expressions.
import { State } from "./state.js";
import { Api } from "./api.js";
import { Geo, getDeviceInfo } from "./geolocation.js";
import { Camera } from "./camera.js";
import { QrScanner } from "./qrscanner.js";
import { SignaturePad } from "./signature.js";
import { NavGuard } from "./guard.js";
import { InstallPrompt } from "./install.js";

// ── Small shared helpers used by every screen below ─────────────────────

function $(elementId) {
  return document.getElementById(elementId);
}

function showScreen(screenId) {
  const allScreens = document.querySelectorAll(".screen");
  for (const screen of allScreens) {
    screen.classList.remove("active");
  }
  $(screenId).classList.add("active");

  if (screenId === "screen-login") {
    $("statusStrip").style.display = "none";
  } else {
    $("statusStrip").style.display = "flex";
  }
}

let toastHideTimer = null;
function toast(message) {
  const toastElement = $("toast");
  toastElement.textContent = message;
  toastElement.style.display = "block";

  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(function () {
    toastElement.style.display = "none";
  }, 3200);
}

// Puts a button into (or out of) a loading state: disables it, swaps its
// text for a spinner + loading message, and remembers the original text so
// it can be restored afterwards. Used everywhere a button triggers a
// network request, so the person always knows something is happening
// instead of wondering if the app has frozen.
function setButtonLoading(buttonElement, isLoading, loadingText) {
  if (isLoading) {
    buttonElement.dataset.originalText = buttonElement.textContent;
    buttonElement.disabled = true;
    buttonElement.innerHTML = '<span class="spinner"></span>' + loadingText;
  } else {
    buttonElement.disabled = false;
    buttonElement.textContent = buttonElement.dataset.originalText;
  }
}

// A confirmation modal with explicit, situation-specific button labels —
// used instead of the browser's native confirm(), whose generic "OK" /
// "Cancel" don't say what either choice actually does.
function showConfirmModal(options) {
  $("confirmModalMessage").textContent = options.message;

  const confirmButton = $("confirmModalConfirmBtn");
  confirmButton.textContent = options.confirmLabel;
  confirmButton.onclick = function () {
    $("confirmModalOverlay").style.display = "none";
    options.onConfirm();
  };

  const cancelButton = $("confirmModalCancelBtn");
  cancelButton.textContent = options.cancelLabel;
  cancelButton.onclick = function () {
    $("confirmModalOverlay").style.display = "none";
  };

  $("confirmModalOverlay").style.display = "flex";
}

function updateStatusStrip() {
  const storeNumber = State.get("storeNumber");
  const racks = State.get("racks") || [];

  if (storeNumber) {
    $("statusStoreLabel").textContent = "Store " + storeNumber;
  } else {
    $("statusStoreLabel").textContent = "—";
  }

  if (racks.length > 0) {
    let doneCount = 0;
    for (const rack of racks) {
      if (rack.scanStatus !== "pending") {
        doneCount = doneCount + 1;
      }
    }
    $("statusProgress").textContent = doneCount + "/" + racks.length + " done";
  } else {
    $("statusProgress").textContent = "";
  }
}

// There is no JavaScript API to force "precise" location only — Android
// (and some browsers on desktop) let the person choose "Precise" or
// "Approximate" right in the permission prompt itself, as a deliberate
// privacy control. Requesting enableHighAccuracy: true (see geolocation.js)
// is the correct signal to ask for the best available fix, but it can't
// override that choice, and even a genuine "Precise" grant is still
// limited by real-world signal conditions — GPS commonly can't get a fix
// at all deep inside a large retail building, so the browser silently
// falls back to WiFi-based positioning, which can easily be 500m-2000m+
// off indoors no matter what was selected. The threshold below is set high
// enough to only warn about genuinely unusable fixes, not normal indoor
// GPS weakness.
const IMPRECISE_LOCATION_THRESHOLD_METERS = 1000;
let hasWarnedAboutImpreciseLocationThisVisit = false;

function warnIfLocationIsImprecise(geo) {
  if (hasWarnedAboutImpreciseLocationThisVisit) {
    return;
  }
  if (geo === null) {
    return; // location was denied entirely — a different situation, not handled here
  }
  if (geo.accuracyMeters > IMPRECISE_LOCATION_THRESHOLD_METERS) {
    hasWarnedAboutImpreciseLocationThisVisit = true;
    toast("Location accuracy is low (~" + Math.round(geo.accuracyMeters) + "m) — this is common indoors, where GPS often can't get a signal. The visit will still proceed.");
  }
}

// ── LOGIN ────────────────────────────────────────────────────────────────

$("loginForm").addEventListener("submit", async function (event) {
  event.preventDefault();
  $("loginError").textContent = "";

  const loginButton = $("loginBtn");
  setButtonLoading(loginButton, true, "Logging in…");

  try {
    const username = $("username").value.trim();
    const password = $("password").value;
    const result = await Api.login(username, password);
    State.patch({ token: result.token, agent: result.agent });
    goToSelfie();
  } catch (err) {
    $("loginError").textContent = err.message;
  } finally {
    setButtonLoading(loginButton, false, "Log in");
  }
});

// ── SELFIE ───────────────────────────────────────────────────────────────

async function goToSelfie() {
  showScreen("screen-selfie");

  $("selfiePreview").style.display = "none";
  $("selfieVideo").style.display = "block";
  $("selfieShootBtn").style.display = "block";
  $("selfieConfirmRow").style.display = "none";
  $("selfieError").textContent = "";

  // Show the "starting camera" overlay while we wait for the permission
  // prompt and the video stream — without this, that wait just looks like
  // a plain black box.
  $("selfieLoadingOverlay").classList.add("show");

  try {
    await Camera.start($("selfieVideo"), "user");
    $("selfieLoadingOverlay").classList.remove("show");
  } catch (err) {
    $("selfieLoadingOverlay").classList.remove("show");
    $("selfieError").textContent = "Camera access is required to continue: " + err.message;
  }
}

$("selfieShootBtn").addEventListener("click", function () {
  const capturedPhoto = Camera.capture($("selfieVideo"));
  State.set("selfie", capturedPhoto);

  $("selfiePreview").src = capturedPhoto;
  $("selfiePreview").style.display = "block";
  $("selfieVideo").style.display = "none";
  $("selfieShootBtn").style.display = "none";
  $("selfieConfirmRow").style.display = "flex";

  Camera.stop();
});

$("selfieRetakeBtn").addEventListener("click", goToSelfie);

$("selfieContinueBtn").addEventListener("click", function () {
  Camera.stop();
  goToStoreSearch();
});

// ── STORE SEARCH ─────────────────────────────────────────────────────────
// Search returns a LIST of matching stores (there could be more than one
// with a similar name/number). Tapping a store in that list immediately
// starts the visit for it — there is no separate "confirm" button, so the
// action is right where you tapped rather than somewhere else on screen.

// Shows the store screen fresh — clears out anything left over from a
// previous visit (search text, old results, old error), so starting a
// second store doesn't show stale content from the first one.
function goToStoreSearch() {
  $("storeQuery").value = "";
  $("storeError").textContent = "";
  $("storeResultsList").innerHTML = "";
  showScreen("screen-store");
  $("storeQuery").focus();
}

function renderStoreSearchResults(stores) {
  const listElement = $("storeResultsList");
  listElement.innerHTML = "";

  if (stores.length === 0) {
    const emptyRow = document.createElement("li");
    emptyRow.className = "loading-row";
    emptyRow.textContent = "No stores matched that search.";
    listElement.appendChild(emptyRow);
    return;
  }

  for (const store of stores) {
    const row = document.createElement("li");
    row.className = "rack-tag";
    row.innerHTML =
      '<div>' +
      '<div class="rack-label-main">' + store.storeName + "</div>" +
      '<div class="rack-label">Store #' + store.storeNumber + "</div>" +
      "</div>";
    row.addEventListener("click", function () {
      selectStoreAndStartVisit(store, row, listElement);
    });
    listElement.appendChild(row);
  }
}

$("storeFindBtn").addEventListener("click", async function () {
  $("storeError").textContent = "";
  const query = $("storeQuery").value.trim();
  if (!query) {
    return;
  }

  // A fresh search replaces the whole list — that's fine here, since
  // there's no specific row the person is waiting on yet.
  const searchButton = $("storeFindBtn");
  setButtonLoading(searchButton, true, "Searching…");
  $("storeResultsList").innerHTML =
    '<li class="loading-row"><span class="spinner dark"></span><span>Searching…</span></li>';

  try {
    const result = await Api.searchStores(query);
    renderStoreSearchResults(result.stores);
  } catch (err) {
    $("storeError").textContent = err.message;
    renderStoreSearchResults([]);
  } finally {
    setButtonLoading(searchButton, false, "Search");
  }
});

// Called when a specific store row is tapped. The loading state is shown
// directly on THAT row (not by replacing the whole results list), so the
// store the person picked stays visible instead of being swapped out for
// an unrelated loading message — and the other rows are disabled so a
// second tap can't start a second visit while this one is still loading.
async function selectStoreAndStartVisit(store, rowElement, listElement) {
  $("storeError").textContent = "";
  State.patch({ storeId: store.storeId, storeNumber: store.storeNumber, storeName: store.storeName });

  const originalRowContent = rowElement.innerHTML;
  rowElement.innerHTML = '<div><span class="spinner dark"></span>Starting visit…</div>';

  const allRows = listElement.querySelectorAll("li");
  for (const otherRow of allRows) {
    if (otherRow !== rowElement) {
      otherRow.style.pointerEvents = "none";
      otherRow.style.opacity = "0.5";
    }
  }

  try {
    const geo = await Geo.capture();
    warnIfLocationIsImprecise(geo);
    const result = await Api.startVisit({
      storeId: store.storeId,
      storeNumber: store.storeNumber,
      storeName: store.storeName,
      selfie: State.get("selfie"),
      geo: geo,
      deviceInfo: getDeviceInfo(),
    });

    const racksWithScanStatus = [];
    for (const rack of result.racks) {
      const rackWithStatus = { ...rack, scanStatus: "pending" };
      racksWithScanStatus.push(rackWithStatus);
    }
    State.patch({ visitId: result.visit._id, racks: racksWithScanStatus });

    NavGuard.enable(); // a visit is now genuinely in progress — warn before losing it
    renderChecklist();
    showScreen("screen-checklist");
  } catch (err) {
    $("storeError").textContent = err.message;

    // Put this row back the way it was, and re-enable the others, so they
    // can try again without having to search a second time.
    rowElement.innerHTML = originalRowContent;
    for (const otherRow of allRows) {
      otherRow.style.pointerEvents = "";
      otherRow.style.opacity = "";
    }
  }
}

// ── CHECKLIST ────────────────────────────────────────────────────────────

// Works out which CSS class and which label to show for one rack row,
// based on whether it's active and what's happened with it so far this
// visit. Written as explicit if/else steps (rather than a compact lookup
// table) so each case is easy to find and change independently.
function getRackDisplayState(rack) {
  if (rack.isActive === false) {
    return { cssClass: "inactive", label: "Inactive" };
  }
  if (rack.scanStatus === "pending") {
    return { cssClass: "", label: "Pending" };
  }
  if (rack.scanStatus === "verified") {
    return { cssClass: "verified", label: "Verified" };
  }
  if (rack.scanStatus === "issue") {
    return { cssClass: "issue", label: "Issue Raised" };
  }
  if (rack.scanStatus === "resolved") {
    return { cssClass: "resolved", label: "Resolved" };
  }
  return { cssClass: "", label: rack.scanStatus };
}

function renderChecklist() {
  const racks = State.get("racks") || [];
  $("checklistStoreName").textContent = State.get("storeName") + " · #" + State.get("storeNumber");

  const listElement = $("rackList");
  listElement.innerHTML = "";

  for (const rack of racks) {
    const displayState = getRackDisplayState(rack);

    const row = document.createElement("li");
    row.className = "rack-tag " + displayState.cssClass;
    row.innerHTML =
      '<div><div class="rack-label-main">' + rack.label + "</div></div>" +
      '<span class="tag-state ' + displayState.cssClass + '">' + displayState.label + "</span>";

    if (rack.isActive === false) {
      row.addEventListener("click", function () {
        toast("Salesforce marks this rack inactive — it won't be requested for scanning.");
      });
    } else {
      row.addEventListener("click", function () {
        goToScan({ rackId: rack.id });
      });
    }

    listElement.appendChild(row);
  }

  updateStatusStrip();
}

$("scanNextBtn").addEventListener("click", function () {
  const racks = State.get("racks") || [];
  let nextPendingRack = null;
  for (const rack of racks) {
    if (rack.scanStatus === "pending" && rack.isActive !== false) {
      nextPendingRack = rack;
      break;
    }
  }

  if (nextPendingRack === null) {
    toast("Every active rack has already been scanned.");
    return;
  }
  goToScan({ rackId: nextPendingRack.id });
});

$("openScanBtn").addEventListener("click", function () {
  goToScan({ mode: "any" });
});

$("finishVisitBtn").addEventListener("click", function () {
  const racks = State.get("racks") || [];
  let pendingCount = 0;
  for (const rack of racks) {
    if (rack.scanStatus === "pending" && rack.isActive !== false) {
      pendingCount = pendingCount + 1;
    }
  }

  if (pendingCount > 0) {
    showConfirmModal({
      message: pendingCount + " rack(s) haven't been scanned yet. If you finish now, they'll stay unverified until your next visit here.",
      confirmLabel: "Finish visit anyway",
      cancelLabel: "Go back and keep scanning",
      onConfirm: goToSignature,
    });
    return;
  }

  goToSignature();
});

// ── SCAN (both modes share this screen) ─────────────────────────────────
// Verification is "blind" by design: the server never sends a rack's real
// QR code to the browser, so there is nothing here to display or fake.

async function goToScan(options) {
  const targetRackId = options.rackId || null;
  const scanMode = options.mode || "targeted";
  State.patch({ scanTargetRackId: targetRackId, scanMode: scanMode });

  if (scanMode === "any") {
    $("scanRackLabel").textContent = "Scan any rack";
    $("scanSubtitle").textContent = "Point the camera at any rack's QR code — we'll figure out which one it is.";
  } else {
    const racks = State.get("racks") || [];
    let targetRack = null;
    for (const rack of racks) {
      if (rack.id === targetRackId) {
        targetRack = rack;
        break;
      }
    }
    if (targetRack === null) {
      return;
    }
    $("scanRackLabel").textContent = targetRack.label;
    $("scanSubtitle").textContent = "Scan this rack's QR code to verify it.";
  }

  $("scanError").textContent = "";
  $("scanProcessingOverlay").classList.remove("show");
  showScreen("screen-scan");

  function handleScanError(message) {
    $("scanError").textContent = message;
    toast(message);
  }

  try {
    await QrScanner.start("qr-reader", { facingMode: "environment" }, handleDecodedCode, handleScanError);
  } catch (err) {
    $("scanError").textContent = "Camera unavailable: " + err.message;
    toast("Camera unavailable: " + err.message);
  }
}

async function handleDecodedCode(scannedCode) {
  await QrScanner.stop();

  // Replace the (now empty) camera view with a "Checking…" spinner while
  // we wait for the location and the server's response, instead of
  // leaving a blank black box.
  $("scanProcessingOverlay").classList.add("show");

  let geo = null;
  try {
    geo = await Geo.capture();
  } catch {
    geo = null; // proceed without location if it's denied or unavailable
  }

  const scanState = State.all();

  try {
    let result;
    if (scanState.scanMode === "any") {
      result = await Api.scanAnyRack({
        visitId: scanState.visitId,
        storeId: scanState.storeId,
        scannedCode: scannedCode,
        geo: geo,
      });
    } else {
      result = await Api.scanRack({
        visitId: scanState.visitId,
        storeId: scanState.storeId,
        rackId: scanState.scanTargetRackId,
        scannedCode: scannedCode,
        geo: geo,
      });
    }

    $("scanProcessingOverlay").classList.remove("show");
    applyScanOutcome(result, scannedCode);
  } catch (err) {
    // Shown both inline AND as a toast — the toast is what actually gets
    // noticed; the inline text stays as a persistent record of what
    // happened in case the toast is missed or the person looks back later.
    $("scanProcessingOverlay").classList.remove("show");
    $("scanError").textContent = err.message;
    toast(err.message);
  }
}

// Turns a rack's dimension data into the small reference block shown on a
// "Verified" result. Returns an empty string (nothing to show) if there's
// no dimension data at all.
function formatDimensionsHtml(dimensions) {
  if (!dimensions || !dimensions.shape) {
    return "";
  }

  const rows = [];
  rows.push('<div class="dim-row"><span>Shape</span><span>' + dimensions.shape + "</span></div>");

  if (dimensions.shape === "Circular") {
    if (dimensions.radius !== null) {
      rows.push('<div class="dim-row"><span>Radius</span><span>' + dimensions.radius + "</span></div>");
    }
  } else {
    if (dimensions.depth !== null) {
      rows.push('<div class="dim-row"><span>Depth</span><span>' + dimensions.depth + "</span></div>");
    }
    if (dimensions.width !== null) {
      rows.push('<div class="dim-row"><span>Width</span><span>' + dimensions.width + "</span></div>");
    }
  }
  if (dimensions.height !== null) {
    rows.push('<div class="dim-row"><span>Height</span><span>' + dimensions.height + "</span></div>");
  }

  return rows.join("");
}

function applyScanOutcome(result, scannedCode) {
  const outcome = result.outcome;
  const rack = result.rack;

  // Reflect the outcome in our local checklist copy so the UI updates
  // instantly without a re-fetch. Only meaningful when we know which rack.
  if (rack) {
    const racks = State.get("racks") || [];
    let localRack = null;
    for (const candidate of racks) {
      if (candidate.id === rack.id) {
        localRack = candidate;
        break;
      }
    }
    if (localRack !== null) {
      if (outcome === "verified") {
        localRack.scanStatus = "verified";
      } else if (outcome === "inactive_blocked" || outcome === "already_flagged") {
        localRack.scanStatus = "issue";
      }
      State.set("racks", racks);

      // Refresh the top "x/y done" counter right now — not just when the
      // checklist screen next gets rendered. Without this, the count only
      // caught up whenever renderChecklist() happened to run for some other
      // reason (e.g. going back to the checklist, or hitting an "already
      // verified" result), which made it look stuck after a normal
      // verified scan that jumps straight into the next one.
      updateStatusStrip();
    }
  }

  function goToNextPendingRackOrChecklist() {
    const racks = State.get("racks") || [];
    let nextPendingRack = null;
    for (const candidate of racks) {
      if (candidate.scanStatus === "pending" && candidate.isActive !== false) {
        nextPendingRack = candidate;
        break;
      }
    }

    if (nextPendingRack !== null) {
      goToScan({ rackId: nextPendingRack.id });
    } else {
      renderChecklist();
      showScreen("screen-checklist");
    }
  }

  function backToChecklist() {
    renderChecklist();
    showScreen("screen-checklist");
  }

  if (outcome === "verified") {
    const dimensionsHtml = formatDimensionsHtml(rack ? rack.dimensions : null);
    const dimensionsBox = $("resultDimensions");
    if (dimensionsHtml) {
      dimensionsBox.innerHTML = dimensionsHtml;
      dimensionsBox.style.display = "block";
    } else {
      dimensionsBox.style.display = "none";
    }

    showResult({
      tone: "success",
      glyph: "✓",
      title: "Verified",
      subtitle: rack ? rack.label + " — for reference, here's what's on file for it:" : "This rack matches what Salesforce expects.",
      primaryLabel: "Scan next rack",
      onPrimary: goToNextPendingRackOrChecklist,
      // If the dimensions above don't look right for what's physically
      // there, this lets the agent flag it without having to start over.
      secondaryLabel: "Report this rack",
      onSecondary: function () {
        goToReport(rack, scannedCode);
      },
    });
    return;
  }

  // Not a "verified" result, so no dimension box should carry over from a
  // previous result screen.
  $("resultDimensions").style.display = "none";

  if (outcome === "already_verified") {
    let subtitle = "This rack was already checked off.";
    if (rack) {
      subtitle = rack.label + " was already checked off on this visit.";
    }
    showResult({
      tone: "info",
      glyph: "i",
      title: "Already verified",
      subtitle: subtitle,
      primaryLabel: "Back to checklist",
      onPrimary: backToChecklist,
    });
    return;
  }

  if (outcome === "already_flagged") {
    showResult({
      tone: "warning",
      glyph: "!",
      title: "Already flagged",
      subtitle: "This rack has an open issue in Salesforce. Only your manager or admin can clear it there — scanning it again won't change that.",
      primaryLabel: "Back to checklist",
      onPrimary: backToChecklist,
    });
    return;
  }

  if (outcome === "inactive_blocked") {
    showResult({
      tone: "warning",
      glyph: "!",
      title: "Flagged automatically",
      subtitle: "Salesforce marks this rack inactive. It's been flagged there directly — no action needed from you.",
      primaryLabel: "Back to checklist",
      onPrimary: backToChecklist,
    });
    return;
  }

  if (outcome === "unknown") {
    showResult({
      tone: "warning",
      glyph: "?",
      title: "Not on this store's list",
      subtitle: "That code isn't one of the racks expected here.",
      primaryLabel: "Scan again",
      onPrimary: function () {
        goToScan({ mode: "any" });
      },
      secondaryLabel: "Report",
      onSecondary: function () {
        goToReport(null, scannedCode);
      },
    });
    return;
  }

  if (outcome === "mismatch") {
    goToReport(rack, scannedCode);
    return;
  }
}

// ── RESULT (shared success/warning/info screen with real buttons) ──────

function showResult(options) {
  const iconElement = $("resultIcon");
  iconElement.className = "result-icon " + options.tone;
  iconElement.textContent = options.glyph;

  $("resultTitle").textContent = options.title;
  $("resultSubtitle").textContent = options.subtitle;

  const primaryButton = $("resultPrimaryBtn");
  primaryButton.textContent = options.primaryLabel;
  primaryButton.onclick = options.onPrimary;

  const secondaryButton = $("resultSecondaryBtn");
  if (options.secondaryLabel) {
    secondaryButton.style.display = "block";
    secondaryButton.textContent = options.secondaryLabel;
    secondaryButton.onclick = options.onSecondary;
  } else {
    secondaryButton.style.display = "none";
  }

  showScreen("screen-result");
}

$("scanCancelBtn").addEventListener("click", async function () {
  await QrScanner.stop();
  $("scanProcessingOverlay").classList.remove("show");
  showScreen("screen-checklist");
});

// ── REPORT ───────────────────────────────────────────────────────────────
// Used for three situations: a mismatched scan, a verified rack whose
// dimensions the agent wants to flag as wrong, or a code that didn't match
// any rack at all (rack is null in that last case — there's no record to
// mark "resolved", so that button is hidden).

function goToReport(rack, scannedCode) {
  const rackId = rack ? rack.id : null;
  State.patch({ reportRackId: rackId, reportPhoto: null });

  $("reportReason").value = "";
  $("reportCustomReasonField").style.display = "none";
  $("reportCustomReason").value = "";
  $("reportNotes").value = "";
  $("reportError").textContent = "";
  $("reportCameraWrap").style.display = "none";
  $("reportPreview").style.display = "none";
  $("reportPhotoBtn").textContent = "Attach a photo *";

  if (rack) {
    $("reportTitle").textContent = "Report an issue";
    $("reportSubtitle").textContent = rack.label + " — let us know what you found.";
  } else {
    $("reportTitle").textContent = "Report this code";
    $("reportSubtitle").textContent = "This code didn't match any rack expected at this store.";
  }

  // "Resolved" only makes sense when there's an actual rack record to mark
  // resolved — a totally unrecognized code has nothing to attach that to.
  if (rack) {
    $("reportResolveBtn").style.display = "block";
  } else {
    $("reportResolveBtn").style.display = "none";
  }

  showScreen("screen-report");
}

$("reportReason").addEventListener("change", function () {
  if ($("reportReason").value === "other") {
    $("reportCustomReasonField").style.display = "block";
  } else {
    $("reportCustomReasonField").style.display = "none";
  }
});

$("reportPhotoBtn").addEventListener("click", async function () {
  const alreadyHavePhoto = State.get("reportPhoto") !== null && State.get("reportPhoto") !== undefined;
  const cameraIsCurrentlyOpen = $("reportCameraWrap").style.display !== "none";

  if (alreadyHavePhoto) {
    // They want to retake it — clear the old photo and open the camera again.
    State.set("reportPhoto", null);
    $("reportPreview").style.display = "none";
    $("reportCameraWrap").style.display = "block";
    $("reportVideo").style.display = "block";
    await Camera.start($("reportVideo"), "environment");
    $("reportPhotoBtn").textContent = "Capture";
    return;
  }

  if (!cameraIsCurrentlyOpen) {
    // First tap: open the camera so they can frame the shot.
    $("reportCameraWrap").style.display = "block";
    await Camera.start($("reportVideo"), "environment");
    $("reportPhotoBtn").textContent = "Capture";
    return;
  }

  // Second tap: the camera is open and ready — capture the photo now.
  const capturedPhoto = Camera.capture($("reportVideo"));
  Camera.stop();
  State.set("reportPhoto", capturedPhoto);
  $("reportPreview").src = capturedPhoto;
  $("reportPreview").style.display = "block";
  $("reportVideo").style.display = "none";
  $("reportPhotoBtn").textContent = "Retake photo";
});

// Combines the picked reason (or custom text) with the free-form notes
// into one description. Both a reason and notes are required, and so is a
// photo — this is checked here (so the person gets an immediate, specific
// answer about what's missing) and again on the server as a backstop.
function validateReportForm() {
  const reasonSelectValue = $("reportReason").value;
  const customReasonValue = $("reportCustomReason").value.trim();
  const notesValue = $("reportNotes").value.trim();
  const hasPhoto = State.get("reportPhoto") !== null && State.get("reportPhoto") !== undefined;

  if (!reasonSelectValue) {
    return { valid: false, error: "Please choose a reason." };
  }
  if (reasonSelectValue === "other" && !customReasonValue) {
    return { valid: false, error: "Please describe the reason." };
  }
  if (!notesValue) {
    return { valid: false, error: "Please add a short description." };
  }
  if (!hasPhoto) {
    return { valid: false, error: "A photo is required before this can be submitted." };
  }

  let finalReason = reasonSelectValue;
  if (reasonSelectValue === "other") {
    finalReason = customReasonValue;
  }

  return { valid: true, reason: finalReason, notes: notesValue };
}

async function submitReport(isResolved, buttonElement, loadingText) {
  const validation = validateReportForm();
  if (!validation.valid) {
    $("reportError").textContent = validation.error;
    return;
  }
  $("reportError").textContent = "";

  const reportRackId = State.get("reportRackId");
  const racks = State.get("racks") || [];
  let localRack = null;
  for (const candidate of racks) {
    if (candidate.id === reportRackId) {
      localRack = candidate;
      break;
    }
  }

  setButtonLoading(buttonElement, true, loadingText);

  try {
    const response = await Api.reportRack({
      storeId: State.get("storeId"),
      rackId: reportRackId,
      reason: validation.reason,
      notes: validation.notes,
      photo: State.get("reportPhoto"),
      resolved: isResolved,
    });

    if (localRack !== null) {
      if (isResolved) {
        localRack.scanStatus = "resolved";
      } else {
        localRack.scanStatus = "issue";
      }
      State.set("racks", racks);
    }

    Camera.stop();

    if (!response.linkedToSalesforce) {
      toast("Noted — since this code didn't match a rack, it wasn't linked to a Salesforce record.");
    } else if (isResolved) {
      toast("Marked resolved.");
    } else {
      toast("Issue reported in Salesforce.");
    }

    renderChecklist();
    showScreen("screen-checklist");
  } catch (err) {
    $("reportError").textContent = err.message;
    toast(err.message);
  } finally {
    setButtonLoading(buttonElement, false, buttonElement.dataset.originalText);
  }
}

$("reportResolveBtn").addEventListener("click", function () {
  submitReport(true, $("reportResolveBtn"), "Saving…");
});
$("reportEscalateBtn").addEventListener("click", function () {
  submitReport(false, $("reportEscalateBtn"), "Reporting…");
});

// ── SIGNATURE ────────────────────────────────────────────────────────────

function goToSignature() {
  showScreen("screen-signature");
  SignaturePad.init($("signatureCanvas"));
}

$("signatureClearBtn").addEventListener("click", function () {
  SignaturePad.clear();
});

$("signatureSubmitBtn").addEventListener("click", async function () {
  if (!SignaturePad.isSigned()) {
    toast("Please sign before completing the visit.");
    return;
  }

  const submitButton = $("signatureSubmitBtn");
  setButtonLoading(submitButton, true, "Completing…");

  try {
    await Api.completeVisit(State.get("visitId"), {
      signature: SignaturePad.toDataUrl(),
      signedBy: State.get("agent").fullName,
    });
    NavGuard.disable(); // visit is done — safe to navigate freely again
    renderSummary();
    showScreen("screen-summary");
  } catch (err) {
    toast("Could not complete visit: " + err.message);
  } finally {
    setButtonLoading(submitButton, false, "Complete visit");
  }
});

// ── SUMMARY ──────────────────────────────────────────────────────────────

function countRacksByStatus(racks, status) {
  let count = 0;
  for (const rack of racks) {
    if (rack.scanStatus === status) {
      count = count + 1;
    }
  }
  return count;
}

function renderSummary() {
  const racks = State.get("racks") || [];
  const verifiedCount = countRacksByStatus(racks, "verified");
  const resolvedCount = countRacksByStatus(racks, "resolved");
  const issueCount = countRacksByStatus(racks, "issue");

  $("summaryBody").innerHTML =
    '<div class="summary-row"><span>Store</span><span>' + State.get("storeName") + " · #" + State.get("storeNumber") + "</span></div>" +
    '<div class="summary-row"><span>Agent</span><span>' + State.get("agent").fullName + "</span></div>" +
    '<div class="summary-row"><span>Racks verified</span><span>' + verifiedCount + " / " + racks.length + "</span></div>" +
    '<div class="summary-row"><span>Resolved on the spot</span><span>' + resolvedCount + "</span></div>" +
    '<div class="summary-row"><span>Issues reported</span><span>' + issueCount + "</span></div>";
}

$("summaryNewVisitBtn").addEventListener("click", function () {
  const savedToken = State.get("token");
  const savedAgent = State.get("agent");
  State.clear();
  State.patch({ token: savedToken, agent: savedAgent });
  hasWarnedAboutImpreciseLocationThisVisit = false; // fresh visit — allow the warning again if needed
  goToSelfie();
});

$("logoutBtn").addEventListener("click", function () {
  NavGuard.disable();
  State.clear();
  showScreen("screen-login");
});

// ── PWA install prompt ───────────────────────────────────────────────────

InstallPrompt.init({
  banner: $("installBanner"),
  copy: $("installBanner").querySelector(".install-copy"),
  installBtn: $("installBtn"),
  dismissBtn: $("installDismissBtn"),
});
