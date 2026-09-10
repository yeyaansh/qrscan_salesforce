import cloudinary from "../config/cloudinary.js";

/**
 * Uploads a base64 data-URL image (as produced by <canvas>.toDataURL() on
 * the frontend) to Cloudinary and returns the public HTTPS URL.
 */
export async function uploadDataUrl(dataUrl, folder) {
  if (!dataUrl) return null;
  const result = await cloudinary.uploader.upload(dataUrl, {
    folder: `rack-audit/${folder}`,
    resource_type: "image",
  });
  return result.secure_url;
}
