// Web Worker: computes LPC formant track for an audio region off the main thread.
// Receives: { ch: Float32Array, sr, id }
// Sends back: { f1, f2, f3, frames, hop, sr, regionT0, id }

function computeLpcCoeffs(frame, order) {
  const N = frame.length;
  const r = new Float64Array(order + 1);
  for (let i = 0; i <= order; i++) {
    let s = 0;
    for (let j = 0; j < N - i; j++) s += frame[j] * frame[j + i];
    r[i] = s;
  }
  const a = new Float64Array(order + 1);
  const e = new Float64Array(order + 1);
  a[0] = 1; e[0] = r[0];
  for (let m = 1; m <= order; m++) {
    let lam = 0;
    for (let j = 1; j <= m; j++) lam += a[j - 1] * r[m - j + 1];
    const k = -lam / e[m - 1];
    const aCopy = a.slice();
    for (let j = 1; j <= m; j++) a[j] = aCopy[j] + k * aCopy[m - j];
    a[m] = k;
    e[m] = (1 - k * k) * e[m - 1];
  }
  return a.slice(1);
}

function lpcToFormants(coeffs, sr) {
  const order = coeffs.length;
  const nfft = 4096;
  const mag = new Float64Array(nfft / 2);
  for (let k = 0; k < nfft / 2; k++) {
    const w = (2 * Math.PI * k) / nfft;
    let ar = 1, ai = 0;
    for (let i = 0; i < order; i++) {
      ar += coeffs[i] * Math.cos(-(i + 1) * w);
      ai += coeffs[i] * Math.sin(-(i + 1) * w);
    }
    mag[k] = ar * ar + ai * ai;
  }
  const formants = [];
  for (let k = 1; k < nfft / 2 - 1; k++) {
    if (mag[k] < mag[k - 1] && mag[k] < mag[k + 1]) {
      const hz = (k / nfft) * sr;
      if (hz > 50 && hz < sr / 2 - 50) formants.push(hz);
    }
  }
  return formants.sort((a, b) => a - b).slice(0, 3);
}

self.onmessage = ({ data }) => {
  const { ch, sr, regionT0, id } = data;
  const FRAME = 1024, HOP = 256, ORDER = 12;
  const hann = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1));
  const frames = Math.max(1, Math.floor((ch.length - FRAME) / HOP) + 1);
  const f1 = new Float32Array(frames);
  const f2 = new Float32Array(frames);
  const f3 = new Float32Array(frames);
  const frame = new Float64Array(FRAME);

  for (let fr = 0; fr < frames; fr++) {
    const off = fr * HOP;
    for (let i = 0; i < FRAME; i++) {
      const s = ch[off + i] || 0;
      const prev = i > 0 ? (ch[off + i - 1] || 0) : 0;
      frame[i] = (s - 0.97 * prev) * hann[i];
    }
    let energy = 0;
    for (let i = 0; i < FRAME; i++) energy += frame[i] * frame[i];
    if (energy < 1e-8) continue;
    const fmts = lpcToFormants(computeLpcCoeffs(frame, ORDER), sr);
    f1[fr] = fmts[0] || 0;
    f2[fr] = fmts[1] || 0;
    f3[fr] = fmts[2] || 0;
  }

  self.postMessage(
    { f1, f2, f3, frames, hop: HOP, frameSize: FRAME, sr, regionT0, id },
    [f1.buffer, f2.buffer, f3.buffer]
  );
};
