const SignaturePad = (() => {
  let canvas, ctx, drawing = false, hasStrokes = false;

  function init(canvasEl) {
    canvas = canvasEl;
    // Match backing resolution to displayed size for crisp lines.
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.strokeStyle = "#1c1b17";
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    hasStrokes = false;

    const pos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const point = e.touches ? e.touches[0] : e;
      return { x: point.clientX - rect.left, y: point.clientY - rect.top };
    };

    const down = (e) => {
      drawing = true;
      hasStrokes = true;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      e.preventDefault();
    };
    const move = (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      e.preventDefault();
    };
    const up = () => (drawing = false);

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function clear() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasStrokes = false;
  }

  function isSigned() {
    return hasStrokes;
  }

  function toDataUrl() {
    return canvas.toDataURL("image/png");
  }

  return { init, clear, isSigned, toDataUrl };
})();
