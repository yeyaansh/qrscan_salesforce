(() => {
  const $ = (id) => document.getElementById(id);
  let toastTimer = null;

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $(id).classList.add("active");
    $("statusStrip").style.display = id === "screen-login" ? "none" : "flex";
  }

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.display = "none"), 3200);
  }

  function showStamp(text, alert) {
    const overlay = $("stampOverlay");
    const mark = $("stampMark");
    mark.textContent = text;
    overlay.classList.toggle("alert", !!alert);
    overlay.classList.remove("show");
    void overlay.offsetWidth; // restart animation
    overlay.classList.add("show");
    setTimeout(() => overlay.classList.remove("show"), 900);
  }

  function updateStatusStrip() {
    const storeNumber = State.get("storeNumber");
    const racks = State.get("racks") || [];
    const verified = racks.filter((r) => r.scanStatus === "verified").length;
    $("statusStoreLabel").textContent = storeNumber ? `Store ${storeNumber}` : "—";
    $("statusProgress").textContent = racks.length ? `${verified}/${racks.length} done` : "";
  }

  // ── LOGIN ──────────────────────────────────────────────────────
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginError").textContent = "";
    $("loginBtn").disabled = true;
    try {
      const { token, agent } = await Api.login($("username").value.trim(), $("password").value);
      State.patch({ token, agent });
      goToSelfie();
    } catch (err) {
      $("loginError").textContent = err.message;
    } finally {
      $("loginBtn").disabled = false;
    }
  });

  // ── SELFIE ─────────────────────────────────────────────────────
  async function goToSelfie() {
    showScreen("screen-selfie");
    $("selfiePreview").style.display = "none";
    $("selfieVideo").style.display = "block";
    $("selfieShootBtn").style.display = "block";
    $("selfieConfirmRow").style.display = "none";
    $("selfieError").textContent = "";
    try {
      await Camera.start($("selfieVideo"), "user");
    } catch (err) {
      $("selfieError").textContent = "Camera access is required to continue: " + err.message;
    }
  }

  $("selfieShootBtn").addEventListener("click", () => {
    const dataUrl = Camera.capture($("selfieVideo"));
    State.set("selfie", dataUrl);
    $("selfiePreview").src = dataUrl;
    $("selfiePreview").style.display = "block";
    $("selfieVideo").style.display = "none";
    $("selfieShootBtn").style.display = "none";
    $("selfieConfirmRow").style.display = "flex";
    Camera.stop();
  });

  $("selfieRetakeBtn").addEventListener("click", goToSelfie);

  $("selfieContinueBtn").addEventListener("click", () => {
    Camera.stop();
    showScreen("screen-store");
    $("storeQuery").focus();
  });

  // ── STORE LOOKUP ───────────────────────────────────────────────
  $("storeFindBtn").addEventListener("click", async () => {
    $("storeError").textContent = "";
    const query = $("storeQuery").value.trim();
    if (!query) return;
    try {
      const store = await Api.lookupStore(query);
      State.patch({ storeId: store.storeId, storeNumber: store.storeNumber, storeName: store.storeName });
      $("storeResultName").textContent = store.storeName;
      $("storeResultNumber").textContent = "Store #" + store.storeNumber;
      $("storeResult").style.display = "block";
      $("storeStartBtn").disabled = false;
    } catch (err) {
      $("storeResult").style.display = "none";
      $("storeStartBtn").disabled = true;
      $("storeError").textContent = err.message;
    }
  });

  $("storeStartBtn").addEventListener("click", async () => {
    $("storeStartBtn").disabled = true;
    try {
      const geo = await Geo.capture();
      const { visit, racks } = await Api.startVisit({
        storeId: State.get("storeId"),
        storeNumber: State.get("storeNumber"),
        storeName: State.get("storeName"),
        selfie: State.get("selfie"),
        geo,
        deviceInfo: getDeviceInfo(),
      });
      State.patch({
        visitId: visit._id,
        racks: racks.map((r) => ({ ...r, scanStatus: "pending" })),
      });
      renderChecklist();
      showScreen("screen-checklist");
    } catch (err) {
      $("storeError").textContent = err.message;
      $("storeStartBtn").disabled = false;
    }
  });

  // ── CHECKLIST ──────────────────────────────────────────────────
  function renderChecklist() {
    const racks = State.get("racks") || [];
    $("checklistStoreName").textContent = `${State.get("storeName")} · #${State.get("storeNumber")}`;
    const list = $("rackList");
    list.innerHTML = "";
    racks.forEach((r) => {
      const li = document.createElement("li");
      li.className = "rack-tag " + (r.scanStatus === "pending" ? "" : r.scanStatus);
      li.innerHTML = `
        <div>
          <div class="rack-id">${r.qrCode}</div>
          <div class="rack-label">${r.label}${r.isActive === false ? " · inactive" : ""}</div>
        </div>
        <span class="tag-state ${r.scanStatus}">${labelFor(r.scanStatus)}</span>`;
      li.addEventListener("click", () => goToScan(r.id));
      list.appendChild(li);
    });
    updateStatusStrip();
  }

  function labelFor(status) {
    return { pending: "Pending", verified: "Verified", discrepancy: "Discrepancy", resolved: "Resolved" }[status] || status;
  }

  $("scanNextBtn").addEventListener("click", () => {
    const racks = State.get("racks") || [];
    const next = racks.find((r) => r.scanStatus === "pending");
    if (!next) return toast("Every rack has already been scanned.");
    goToScan(next.id);
  });

  $("finishVisitBtn").addEventListener("click", () => {
    const racks = State.get("racks") || [];
    const pending = racks.filter((r) => r.scanStatus === "pending").length;
    if (pending > 0 && !confirm(`${pending} rack(s) still pending. Finish the visit anyway?`)) return;
    goToSignature();
  });

  // ── SCAN ───────────────────────────────────────────────────────
  async function goToScan(rackId) {
    const racks = State.get("racks") || [];
    const rack = racks.find((r) => r.id === rackId);
    if (!rack) return;
    State.set("currentRackId", rackId);

    $("scanRackLabel").textContent = rack.label;
    $("scanExpectedCode").textContent = rack.qrCode;
    $("scanError").textContent = "";
    $("manualEntryRow").style.display = "none";
    $("manualCodeInput").value = "";
    showScreen("screen-scan");

    try {
      await QrScanner.start("qr-reader", handleDecodedCode, (msg) => ($("scanError").textContent = msg));
    } catch (err) {
      $("scanError").textContent = "Camera unavailable — use manual entry below. (" + err.message + ")";
    }
  }

  async function handleDecodedCode(scannedCode) {
    await QrScanner.stop();
    const racks = State.get("racks") || [];
    const rack = racks.find((r) => r.id === State.get("currentRackId"));
    if (!rack) return;

    let geo = null;
    try {
      geo = await Geo.capture();
    } catch {
      /* proceed without geo if denied */
    }

    try {
      const { matched, rackScan } = await Api.scanRack({
        visitId: State.get("visitId"),
        storeId: State.get("storeId"),
        rackId: rack.id,
        expectedCode: rack.qrCode,
        scannedCode,
        geo,
      });

      rack.scanStatus = matched ? "verified" : "discrepancy";
      rack.lastScanId = rackScan._id;
      rack.lastScannedCode = scannedCode;
      State.set("racks", racks);

      showStamp(matched ? "VERIFIED" : "MISMATCH", !matched);

      setTimeout(() => {
        if (matched) {
          renderChecklist();
          showScreen("screen-checklist");
        } else {
          goToDiscrepancy(rack, scannedCode, rackScan._id);
        }
      }, 950);
    } catch (err) {
      $("scanError").textContent = err.message;
    }
  }

  $("manualEntryToggle").addEventListener("click", () => {
    const row = $("manualEntryRow");
    row.style.display = row.style.display === "none" ? "flex" : "none";
  });
  $("manualEntrySubmit").addEventListener("click", () => {
    const code = $("manualCodeInput").value.trim();
    if (!code) return;
    handleDecodedCode(code);
  });

  $("scanCancelBtn").addEventListener("click", async () => {
    await QrScanner.stop();
    showScreen("screen-checklist");
  });

  // ── DISCREPANCY ────────────────────────────────────────────────
  function goToDiscrepancy(rack, scannedCode, rackScanId) {
    State.patch({ discRackId: rack.id, discRackScanId: rackScanId, discPhoto: null });
    $("discExpected").textContent = rack.qrCode;
    $("discScanned").textContent = scannedCode;
    $("discNotes").value = "";
    $("discCameraWrap").style.display = "none";
    $("discPreview").style.display = "none";
    $("discPhotoBtn").textContent = "Attach a photo";
    showScreen("screen-discrepancy");
  }

  $("discPhotoBtn").addEventListener("click", async () => {
    if (State.get("discPhoto")) {
      // already taken — tapping again lets them retake
      State.set("discPhoto", null);
      $("discPreview").style.display = "none";
      $("discCameraWrap").style.display = "block";
      $("discVideo").style.display = "block";
      await Camera.start($("discVideo"), "environment");
      $("discPhotoBtn").textContent = "Capture";
      return;
    }
    if ($("discCameraWrap").style.display === "none") {
      $("discCameraWrap").style.display = "block";
      await Camera.start($("discVideo"), "environment");
      $("discPhotoBtn").textContent = "Capture";
    } else {
      const dataUrl = Camera.capture($("discVideo"));
      Camera.stop();
      State.set("discPhoto", dataUrl);
      $("discPreview").src = dataUrl;
      $("discPreview").style.display = "block";
      $("discVideo").style.display = "none";
      $("discPhotoBtn").textContent = "Retake photo";
    }
  });

  async function submitDiscrepancy(resolved) {
    const racks = State.get("racks") || [];
    const rack = racks.find((r) => r.id === State.get("discRackId"));
    try {
      await Api.reportDiscrepancy({
        rackScanId: State.get("discRackScanId"),
        visitId: State.get("visitId"),
        notes: $("discNotes").value.trim(),
        photo: State.get("discPhoto"),
        rackLabel: rack ? rack.label : undefined,
        storeName: State.get("storeName"),
        storeNumber: State.get("storeNumber"),
        managerEmail: undefined, // falls back to the agent's default manager on the server
        resolved,
      });
      if (rack) rack.scanStatus = resolved ? "resolved" : "discrepancy";
      State.set("racks", racks);
      Camera.stop();
      toast(resolved ? "Marked resolved." : "Manager notified — a task was created in Salesforce.");
      renderChecklist();
      showScreen("screen-checklist");
    } catch (err) {
      toast("Could not save: " + err.message);
    }
  }

  $("discResolveBtn").addEventListener("click", () => submitDiscrepancy(true));
  $("discEscalateBtn").addEventListener("click", () => submitDiscrepancy(false));

  // ── SIGNATURE ──────────────────────────────────────────────────
  function goToSignature() {
    showScreen("screen-signature");
    SignaturePad.init($("signatureCanvas"));
  }
  $("signatureClearBtn").addEventListener("click", () => SignaturePad.clear());

  $("signatureSubmitBtn").addEventListener("click", async () => {
    if (!SignaturePad.isSigned()) return toast("Please sign before completing the visit.");
    $("signatureSubmitBtn").disabled = true;
    try {
      await Api.completeVisit(State.get("visitId"), {
        signature: SignaturePad.toDataUrl(),
        signedBy: State.get("agent").fullName,
      });
      renderSummary();
      showScreen("screen-summary");
    } catch (err) {
      toast("Could not complete visit: " + err.message);
    } finally {
      $("signatureSubmitBtn").disabled = false;
    }
  });

  // ── SUMMARY ────────────────────────────────────────────────────
  function renderSummary() {
    const racks = State.get("racks") || [];
    const verified = racks.filter((r) => r.scanStatus === "verified").length;
    const discrepancy = racks.filter((r) => r.scanStatus === "discrepancy").length;
    const resolved = racks.filter((r) => r.scanStatus === "resolved").length;

    $("summaryBody").innerHTML = `
      <div class="summary-row"><span>Store</span><span>${State.get("storeName")} · #${State.get("storeNumber")}</span></div>
      <div class="summary-row"><span>Agent</span><span>${State.get("agent").fullName}</span></div>
      <div class="summary-row"><span>Racks verified</span><span>${verified} / ${racks.length}</span></div>
      <div class="summary-row"><span>Resolved on the spot</span><span>${resolved}</span></div>
      <div class="summary-row"><span>Escalated to manager</span><span>${discrepancy}</span></div>
    `;
  }

  $("summaryNewVisitBtn").addEventListener("click", () => {
    const { token, agent } = State.all();
    State.clear();
    State.patch({ token, agent });
    goToSelfie();
  });

  $("logoutBtn").addEventListener("click", () => {
    State.clear();
    showScreen("screen-login");
  });
})();
