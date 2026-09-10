// Wraps the browser's camera (getUserMedia) for three uses in this app:
// the selfie at the start of a visit, and photos attached to a
// discrepancy. Both uses call the same start()/capture()/stop() functions
// below; the only difference is which "facingMode" they ask for.
//
// A NOTE ON MIRRORING:
// A phone's FRONT camera (facingMode "user") is what people use for
// selfies. Browsers do NOT mirror this feed by default, but people expect
// a mirror image — that is what every phone's camera app and every video
// call app shows, and it is what a real mirror would show. If we don't
// mirror it, the preview feels "backwards": moving your hand to the right
// appears to move left on screen. So for the front camera only, we flip
// the live preview horizontally, and we also flip the captured photo the
// same way, so the saved photo matches exactly what the person saw while
// taking it.
//
// The REAR camera (facingMode "environment", used for QR codes and
// discrepancy photos) is never mirrored — that camera is pointed at the
// world, not at the person, so a mirror image would be confusing there.

let activeStream = null;
let activeFacingMode = null;

export const Camera = {
  // Starts the camera and attaches it to the given <video> element.
  // facingMode is either "user" (front/selfie camera) or "environment"
  // (rear camera).
  async start(videoElement, facingMode) {
    Camera.stop(); // always release any previous camera stream first

    const constraints = {
      video: {
        facingMode: facingMode,
        width: { ideal: 720 },
        height: { ideal: 960 },
      },
      audio: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    activeStream = stream;
    activeFacingMode = facingMode;

    videoElement.srcObject = stream;

    if (facingMode === "user") {
      videoElement.classList.add("mirrored");
    } else {
      videoElement.classList.remove("mirrored");
    }

    await videoElement.play();
  },

  // Captures the current video frame as a JPEG data URL. If the camera
  // that's running is the front/selfie camera, the captured image is
  // flipped to match the mirrored preview the person actually saw.
  capture(videoElement, quality = 0.85) {
    const canvas = document.createElement("canvas");
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const context = canvas.getContext("2d");

    if (activeFacingMode === "user") {
      // Flip the drawing horizontally before drawing the frame, so the
      // saved image matches the mirrored preview.
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }

    context.drawImage(videoElement, 0, 0);
    return canvas.toDataURL("image/jpeg", quality);
  },

  // Stops the camera and releases it, so the browser turns the camera
  // light off and other parts of the app can use it.
  stop() {
    if (activeStream !== null) {
      const tracks = activeStream.getTracks();
      for (const track of tracks) {
        track.stop();
      }
      activeStream = null;
      activeFacingMode = null;
    }
  },
};
