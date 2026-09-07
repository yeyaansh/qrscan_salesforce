// Thin wrapper around the html5-qrcode library (loaded via CDN in index.html:
// https://unpkg.com/html5-qrcode). Swap libraries here only — the rest of the
// app just calls QrScanner.start()/stop().
const QrScanner = (() => {
  let instance = null;

  async function start(elementId, onDecoded, onError) {
    if (typeof Html5Qrcode === "undefined") {
      onError && onError("QR library failed to load — check your internet connection.");
      return;
    }
    instance = new Html5Qrcode(elementId);
    await instance.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      (decodedText) => onDecoded(decodedText),
      () => {} // per-frame "no QR found yet" noise — ignored
    );
  }

  async function stop() {
    if (instance) {
      try {
        await instance.stop();
        instance.clear();
      } catch {
        /* already stopped */
      }
      instance = null;
    }
  }

  return { start, stop };
})();
