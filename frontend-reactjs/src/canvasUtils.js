// Always reset transform — never stack scale() calls
export function setupCanvas(canvas) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function fmtTime(t) {
  const s = (t % 60).toFixed(3).padStart(6, '0');
  return Math.floor(t / 60) > 0 ? `${Math.floor(t / 60)}:${s}` : t.toFixed(3);
}
