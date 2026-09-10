// Thin wrapper around the html5-qrcode library (loaded via a classic
// <script> tag in index.html — it sets a global `Html5Qrcode`, which is
// fine to reference from an ES module). Swap libraries here only — the
// rest of the app just calls QrScanner.start()/stop().
let instance = null;

export const QrScanner = {
  // Laptops (and some phones) can expose more than one camera — e.g. a
  // Windows Hello IR camera alongside the normal one. Exposing the list
  // lets the UI offer a picker instead of guessing with facingMode.
  async listCameras() {
    if (typeof Html5Qrcode === "undefined") return [];
    try {
      return await Html5Qrcode.getCameras(); // [{ id, label }, ...]
    } catch {
      return []; // permission not granted yet, or enumeration unsupported
    }
  },

  // `cameraIdOrConfig` is either a specific camera deviceId (preferred) or
  // a constraint object like { facingMode: "environment" } as a fallback.
  async start(elementId, cameraIdOrConfig, onDecoded, onError) {
    if (typeof Html5Qrcode === "undefined") {
      onError && onError("QR library failed to load — check your internet connection.");
      return;
    }
    instance = new Html5Qrcode(elementId, { verbose: false });
    await instance.start(
      cameraIdOrConfig,
      {
        fps: 10,
        // Sized relative to the actual viewfinder rather than a fixed
        // pixel value, which is more reliable across camera resolutions.
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7);
          return { width: size, height: size };
        },
      },
      (decodedText) => onDecoded(decodedText),
      () => {} // per-frame "no QR found yet" noise — ignored
    );
  },

  async stop() {
    if (instance) {
      try {
        await instance.stop();
        instance.clear();
      } catch {
        /* already stopped */
      }
      instance = null;
    }
  },
};
