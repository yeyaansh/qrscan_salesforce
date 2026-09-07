const Camera = (() => {
  let stream = null;

  async function start(videoEl, facingMode = "user") {
    stop(); // release any previous stream first
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 720 }, height: { ideal: 960 } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
  }

  function capture(videoEl, quality = 0.85) {
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    canvas.getContext("2d").drawImage(videoEl, 0, 0);
    return canvas.toDataURL("image/jpeg", quality);
  }

  function stop() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  return { start, capture, stop };
})();
