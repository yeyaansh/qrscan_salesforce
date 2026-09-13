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
        // Permission denied / unavailable. NOTE: unlike some other capture
        // failures in this app, this one is NOT tolerated downstream —
        // Start_Latitude__c/Start_Longitude__c are required fields on
        // Salesforce's Agent_Visit__c, so a visit can't be created without
        // a real location. The caller (app.js) checks for null here and
        // blocks starting the visit with a clear message instead.
        () => resolve(null),
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
