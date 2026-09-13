import cloudinary from "../config/cloudinary.js";

// How long we'll wait on a single upload before giving up. Agents use this
// app from inside stores/warehouses where WiFi and cellular signal are
// often weak, so a slow upload is the normal case, not the exception —
// without an explicit ceiling the request can hang for a very long time
// before Cloudinary's own connection eventually drops it. 20s is generous
// enough for a slow connection but still short enough that the agent
// isn't left staring at a spinner indefinitely.
const UPLOAD_TIMEOUT_MS = 20_000;

/**
 * Uploads a base64 data-URL image (as produced by <canvas>.toDataURL() on
 * the frontend) to Cloudinary and returns the public HTTPS URL.
 */
export async function uploadDataUrl(dataUrl, folder) {
  if (!dataUrl) return null;

  try {
    const result = await cloudinary.uploader.upload(dataUrl, {
      folder: `rack-audit/${folder}`,
      resource_type: "image",
      timeout: UPLOAD_TIMEOUT_MS,
    });
    return result.secure_url;
  } catch (err) {
    // The Cloudinary SDK does not always reject with a real Error object.
    // Network-level failures (timeouts, dropped connections — exactly what
    // a weak in-store signal produces) can come back as a plain object
    // like { message, http_code } or even { error: { message, http_code } },
    // which means err.message is silently undefined and every log line
    // downstream just prints "undefined" with no way to tell what actually
    // went wrong. Normalize it here, once, so every caller always gets a
    // real, readable Error.
    let detail = "unknown upload error";
    if (err && typeof err.message === "string" && err.message) {
      detail = err.message;
    } else if (err && err.error && typeof err.error.message === "string") {
      detail = err.error.message;
    } else if (typeof err === "string") {
      detail = err;
    } else {
      try {
        detail = JSON.stringify(err);
      } catch {
        detail = String(err);
      }
    }

    const normalized = new Error(`Image upload to Cloudinary failed: ${detail}`);
    normalized.cause = err;
    throw normalized;
  }
}
