// Web Worker: computes a mel spectrogram slice off the main thread.
// Receives: { ch: Float32Array, sr, t0, t1, hop, N_FFT, id }
// Sends back: { spec: Float32Array, N_MELS, frames, hop, t0: sliceT0, duration, id }

function fft(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i+j], ui = im[i+j];
        const vr = re[i+j+len/2]*cr - im[i+j+len/2]*ci;
        const vi = re[i+j+len/2]*ci + im[i+j+len/2]*cr;
        re[i+j] = ur+vr; im[i+j] = ui+vi;
        re[i+j+len/2] = ur-vr; im[i+j+len/2] = ui-vi;
        const nr = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = nr;
      }
    }
  }
}

function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (10 ** (mel / 2595) - 1); }

function buildMelFilters(N_FFT, sr) {
  const fMax = Math.min(8000, sr / 2);
  const N_MELS = Math.round(128 * (fMax / (sr / 2)));
  const mMin = hzToMel(0), mMax = hzToMel(fMax);
  const melPoints = Array.from({ length: N_MELS + 2 }, (_, i) =>
    melToHz(mMin + (mMax - mMin) * i / (N_MELS + 1))
  );
  const binPoints = melPoints.map(hz => Math.floor((N_FFT / 2 + 1) * hz / (sr / 2)));
  const filters = Array.from({ length: N_MELS }, (_, m) => {
    const lo = binPoints[m], center = binPoints[m + 1], hi = binPoints[m + 2];
    const f = new Float32Array(N_FFT / 2 + 1);
    for (let k = lo; k < center; k++) if (center > lo) f[k] = (k - lo) / (center - lo);
    for (let k = center; k < hi; k++) if (hi > center) f[k] = (hi - k) / (hi - center);
    return f;
  });
  return { filters, N_MELS };
}

self.onmessage = ({ data }) => {
  const { ch, sr, t0, t1, hop, N_FFT, id, regionT0 } = data;
  // ch is already a pre-sliced region starting at floor(t0*sr)-N_FFT
  // so startSample within ch is 0; use full ch length as regionLen
  const regionLen = ch.length;
  const frames    = Math.max(1, Math.floor((regionLen - N_FFT) / hop) + 1);
  const startSample = 0;

  const { filters, N_MELS } = buildMelFilters(N_FFT, sr);

  const hann = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N_FFT - 1));

  const spec = new Float32Array(N_MELS * frames);
  const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);

  for (let fr = 0; fr < frames; fr++) {
    const off = startSample + fr * hop;
    re.fill(0); im.fill(0);
    for (let i = 0; i < N_FFT; i++) re[i] = (ch[off + i] || 0) * hann[i];
    fft(re, im);
    const power = new Float32Array(N_FFT / 2 + 1);
    for (let i = 0; i <= N_FFT / 2; i++) power[i] = re[i]*re[i] + im[i]*im[i];
    for (let m = 0; m < N_MELS; m++) {
      let val = 0;
      const filt = filters[m];
      for (let k = 0; k < filt.length; k++) val += filt[k] * power[k];
      spec[m * frames + fr] = Math.max(1e-10, val);
    }
  }

  // Log-normalize
  for (let i = 0; i < spec.length; i++) spec[i] = Math.log(spec[i]);
  let maxV = -Infinity, minV = Infinity;
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] > maxV) maxV = spec[i];
    if (spec[i] < minV) minV = spec[i];
  }
  const range = maxV - minV || 1;
  for (let i = 0; i < spec.length; i++) spec[i] = (spec[i] - minV) / range;

  // t0 and duration describe what region of the original audio this slice covers.
  // The caller already knows regionStart from its own slice calculation.
  self.postMessage(
    { spec, N_MELS, frames, hop, duration: regionLen / sr, regionT0, id },
    [spec.buffer]
  );
};
