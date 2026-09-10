import { getDeviceId } from "./state.js";

export const Geo = {
  capture(options = { enableHighAccuracy: true, timeout: 10000 }) {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyMeters: pos.coords.accuracy,
            capturedAt: new Date().toISOString(),
          }),
        () => resolve(null), // permission denied / unavailable — audit still proceeds, just unflagged
        options
      );
    });
  },
};

export function getDeviceInfo() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform || "",
    deviceId: getDeviceId(),
    screen: `${window.screen.width}x${window.screen.height}`,
  };
}
