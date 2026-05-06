import React, { useRef, useEffect, useState, useCallback } from 'react';
import { parseTextGrid } from './parseTextGrid.js';
import { setupCanvas, fmtTime } from './canvasUtils.js';
import {
  COLORMAPS, inferno,
  buildMelSpectrogram, buildRmsEnvelope, buildFormantTrack,
} from './dsp.js';


const BUNDLED_WAV = 'Bluey_blueyp1aud_region280-350s.wav';
const BUNDLED_TG  = 'Bluey_blueyp1aud_region280%E2%80%93350s_original.TextGrid';

export default function App() {
  // ── React state (drives toolbar UI only) ──────────────────────────────
  const [words, setWords]               = useState([]);
  const [phones, setPhones]             = useState([]);
  const [duration, setDuration]         = useState(70);
  const [playing, setPlaying]           = useState(false);
  const [loopMode, setLoopMode]         = useState(false);
  const [zoomValue, setZoomValue]       = useState(72);
  const [popup, setPopup]               = useState(null);
  const [dropping, setDropping]         = useState(false);
  const [colormapName, setColormapName] = useState('inferno');
  const [showFormants, setShowFormants] = useState(false);
  const [specComputing, setSpecComputing] = useState(false);
  const [formantComputing, setFormantComputing] = useState(false);
  const panelSplitRef  = useRef(0.45);
  const wavePanelRef   = useRef(null);
  const specPanelRef   = useRef(null);
  const wrdTierRef     = useRef(null);
  const phnTierRef     = useRef(null);
  const panelsDivRef   = useRef(null);
  const tiersDivRef    = useRef(null);

  // ── Refs (hot-path values read inside callbacks without re-render) ─────
  const viewRef          = useRef({ t0: 0, t1: 20 });
  const audioCtxRef      = useRef(null);
  const audioBufferRef   = useRef(null);
  const audioSourceRef   = useRef(null);
  const playStartCtxRef  = useRef(0);
  const playStartAtRef   = useRef(0);
  const playEndAtRef     = useRef(0);
  const rafIdRef         = useRef(null);
  const loopModeRef      = useRef(false);
  const playingRef       = useRef(false);
  const playheadRef      = useRef(0);
  const selectionRef     = useRef(null);
  const waveformDataRef  = useRef(null);
  const spectroRef       = useRef(null);
  const spectroCacheRef  = useRef({ canvas: null });
  const zoomRafRef       = useRef(null);
  const viewPeakRef      = useRef({ t0: -1, t1: -1, peak: 0 });
  const specWorkerRef    = useRef(null);
  const formantWorkerRef = useRef(null);
  const formantViewRef   = useRef(null); // { t0, t1 } of the last computed region
  const wordsRef         = useRef([]);
  const phonesRef        = useRef([]);
  const durationRef      = useRef(70);
  const colormapNameRef  = useRef('inferno');
  const showFormantsRef  = useRef(false);
  const rmsEnvRef        = useRef(null);
  const formantTrackRef  = useRef(null);

  // ── Canvas element refs ───────────────────────────────────────────────
  const waveCanvasRef    = useRef(null);
  const specCanvasRef    = useRef(null);
  const rulerCanvasRef   = useRef(null);
  const wordsCanvasRef   = useRef(null);
  const phonesCanvasRef  = useRef(null);
  const minimapCanvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const timelineRef      = useRef(null);
  const timeDisplayRef   = useRef(null);

  // ── Coordinate helpers ────────────────────────────────────────────────
  const tX = useCallback((t, w) => {
    const { t0, t1 } = viewRef.current;
    return ((t - t0) / (t1 - t0)) * w;
  }, []);

  const xT = useCallback((x, w) => {
    const { t0, t1 } = viewRef.current;
    return t0 + (x / w) * (t1 - t0);
  }, []);

  // ── Draw helpers ──────────────────────────────────────────────────────

  // Draws static playhead — skipped during playback (overlay handles it then)
  const drawPlayheadLine = useCallback((ctx, w, h) => {
    if (playingRef.current) return;
    const px = tX(playheadRef.current, w);
    if (px < 0 || px > w) return;
    ctx.strokeStyle = '#e05a3a'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }, [tX]);

  const drawSelectionRect = useCallback((ctx, w, h, alpha = 0.15) => {
    const sel = selectionRef.current;
    if (!sel) return;
    const sx = tX(sel.t0, w), ex = tX(sel.t1, w);
    ctx.fillStyle = `rgba(58,123,213,${alpha})`;
    ctx.fillRect(sx, 0, ex - sx, h);
    ctx.strokeStyle = 'rgba(58,123,213,0.5)'; ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, 0.5, ex - sx - 1, h - 1);
  }, [tX]);

  const drawWave = useCallback(() => {
    const s = setupCanvas(waveCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    const DUR = durationRef.current;
    ctx.fillStyle = '#0d0d10'; ctx.fillRect(0, 0, w, h);
    drawSelectionRect(ctx, w, h, 0.15);
    const mid = h / 2;

    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    const rawCh = audioBufferRef.current ? audioBufferRef.current.getChannelData(0) : null;
    const data = waveformDataRef.current;
    if (rawCh || data) {
      const rawLen = rawCh ? rawCh.length : 0;
      const samplesPerPx = rawCh ? ((t1 - t0) * rawLen / DUR) / w : Infinity;

      // Cache viewPeak — only recompute when the visible range changes
      const cached = viewPeakRef.current;
      if (cached.t0 !== t0 || cached.t1 !== t1) {
        let peak = 0;
        if (rawCh) {
          const iA = Math.max(0, Math.floor((t0 / DUR) * rawLen));
          const iB = Math.min(rawLen - 1, Math.ceil((t1 / DUR) * rawLen));
          const stride = Math.max(1, Math.floor((iB - iA) / 2000));
          for (let i = iA; i <= iB; i += stride) { const v = Math.abs(rawCh[i]); if (v > peak) peak = v; }
        } else {
          const N = data.length;
          const iA = Math.max(0, Math.floor((t0 / DUR) * N));
          const iB = Math.min(N - 1, Math.ceil((t1 / DUR) * N));
          for (let i = iA; i <= iB; i++) if (data[i] > peak) peak = data[i];
        }
        viewPeakRef.current = { t0, t1, peak };
      }
      const gain = viewPeakRef.current.peak > 0.01 ? 0.46 / viewPeakRef.current.peak : 0.5;

      if (rawCh && samplesPerPx <= 2) {
        // ── Line trace: draw actual sample values (Praat style) ──────────
        ctx.strokeStyle = '#c8c6c1'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        const steps = Math.max(w, Math.ceil((t1 - t0) * rawLen / DUR));
        for (let i = 0; i <= steps; i++) {
          const t = t0 + (i / steps) * (t1 - t0);
          const si = Math.max(0, Math.min(rawLen - 1, Math.round((t / DUR) * rawLen)));
          const x = ((t - t0) / (t1 - t0)) * w;
          const y = mid - rawCh[si] * gain * mid;
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Dot on each sample when very zoomed in
        if (samplesPerPx < 0.25) {
          const iA = Math.max(0, Math.floor((t0 / DUR) * rawLen));
          const iB = Math.min(rawLen - 1, Math.ceil((t1 / DUR) * rawLen));
          ctx.fillStyle = '#4a8be5';
          for (let i = iA; i <= iB; i++) {
            const t = (i / rawLen) * DUR;
            const x = ((t - t0) / (t1 - t0)) * w;
            const y = mid - rawCh[i] * gain * mid;
            ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
          }
        }
      } else if (rawCh && samplesPerPx <= 200) {
        // ── Min/max bars: shows waveform shape with correct peaks ─────────
        ctx.fillStyle = '#3a7bd5';
        for (let cx = 0; cx < w; cx++) {
          const tA = t0 + (cx / w) * (t1 - t0);
          const tB = t0 + ((cx + 1) / w) * (t1 - t0);
          const iA = Math.max(0, Math.floor((tA / DUR) * rawLen));
          const iB = Math.min(rawLen - 1, Math.ceil((tB / DUR) * rawLen));
          let mn = 0, mx = 0;
          for (let i = iA; i <= iB; i++) {
            const v = rawCh[i];
            if (v > mx) mx = v;
            if (v < mn) mn = v;
          }
          const yTop = mid - mx * gain * mid;
          const yBot = mid - mn * gain * mid;
          ctx.fillRect(cx, yTop, 1, Math.max(1, yBot - yTop));
        }
        // RMS envelope overlay
        const rms = rmsEnvRef.current;
        if (rms) {
          ctx.strokeStyle = 'rgba(120,210,255,0.6)'; ctx.lineWidth = 1.2;
          for (const sign of [-1, 1]) {
            ctx.beginPath(); let started = false;
            for (let cx = 0; cx < w; cx++) {
              const t = t0 + (cx / w) * (t1 - t0);
              const fr = Math.max(0, Math.min(rms.frames - 1, Math.floor((t / DUR) * rms.frames)));
              const y = mid + sign * (rms.env[fr] || 0) * gain * mid;
              if (!started) { ctx.moveTo(cx, y); started = true; } else ctx.lineTo(cx, y);
            }
            ctx.stroke();
          }
        }
      } else {
        // ── Peak overview: fast bar render from downsampled peaks ─────────
        const peakData = data || new Float32Array(0);
        const N = peakData.length;
        ctx.fillStyle = '#3a6bb5';
        for (let cx = 0; cx < w; cx++) {
          const tA = t0 + (cx / w) * (t1 - t0);
          const idx = Math.max(0, Math.min(N - 1, Math.floor((tA / DUR) * N)));
          const amp = (peakData[idx] || 0) * gain * mid;
          ctx.fillRect(cx, mid - amp, 1, amp * 2);
        }
      }
    }
    drawPlayheadLine(ctx, w, h);
  }, [tX, drawSelectionRect, drawPlayheadLine]);

  const drawSpec = useCallback(() => {
    const s = setupCanvas(specCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = '#090910'; ctx.fillRect(0, 0, w, h);
    const sp = spectroRef.current;
    if (sp) {
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);

      const cache = spectroCacheRef.current;
      if (cache.canvas && cache.stripT0 <= t0 && cache.stripT1 >= t1 && cache.ph === ph) {
        // Blit from cache
        const { canvas: strip, stripT0, stripT1, stripPw } = cache;
        const totalSpan = stripT1 - stripT0;
        const span = t1 - t0;
        const srcX = Math.round(((t0 - stripT0) / totalSpan) * stripPw);
        const srcW = Math.round((span / totalSpan) * stripPw);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(strip, Math.max(0, srcX), 0, Math.max(1, srcW), ph, 0, 0, pw, ph);
        ctx.restore();
      } else {
        // Fall back to rendering global spec via bilinear interpolation
        const { spec, N_MELS, colormapFn, frames, duration, t0: srcT0 = 0 } = sp;
        const framesM1 = frames - 1;
        const melsM1 = N_MELS - 1;
        const oc = document.createElement('canvas');
        oc.width = pw; oc.height = ph;
        const octx = oc.getContext('2d');
        const img = octx.createImageData(pw, ph);
        const idata = img.data;
        for (let cx = 0; cx < pw; cx++) {
          const t = t0 + (cx / pw) * (t1 - t0);
          const frf = Math.max(0, Math.min(framesM1, ((t - srcT0) / duration) * frames));
          const fr0 = Math.floor(frf), fr1 = Math.min(framesM1, fr0 + 1);
          const ft = frf - fr0;
          for (let cy = 0; cy < ph; cy++) {
            const mf = ((ph - 1 - cy) / (ph - 1)) * melsM1;
            const m0 = Math.floor(mf), m1 = Math.min(melsM1, m0 + 1);
            const mt = mf - m0;
            const v00 = spec[m0 * frames + fr0], v10 = spec[m1 * frames + fr0];
            const v01 = spec[m0 * frames + fr1], v11 = spec[m1 * frames + fr1];
            const val = v00*(1-ft)*(1-mt) + v01*ft*(1-mt) + v10*(1-ft)*mt + v11*ft*mt;
            const [r, g, b] = colormapFn(val);
            const pidx = (cy * pw + cx) * 4;
            idata[pidx] = r; idata[pidx+1] = g; idata[pidx+2] = b; idata[pidx+3] = 255;
          }
        }
        octx.putImageData(img, 0, 0);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(oc, 0, 0, pw, ph, 0, 0, pw, ph);
        ctx.restore();
      }
    }
    drawSelectionRect(ctx, w, h, 0.18);
    if (showFormantsRef.current) {
      const ft = formantTrackRef.current;
      if (ft) {
        const rT0 = ft.regionT0 ?? 0;
        const regionDur = (ft.frames * ft.hop) / ft.sr;
        const FMAX = Math.min(8000, ft.sr / 2);
        const colors = ['rgba(255,80,80,0.85)', 'rgba(80,220,80,0.85)', 'rgba(80,140,255,0.85)'];
        for (const [fi, fdata] of [[0, ft.f1], [1, ft.f2], [2, ft.f3]]) {
          ctx.strokeStyle = colors[fi]; ctx.lineWidth = 1.5;
          ctx.beginPath();
          let started = false;
          for (let cx = 0; cx < w; cx++) {
            const t = t0 + (cx / w) * (t1 - t0);
            const localT = t - rT0;
            if (localT < 0 || localT > regionDur) { started = false; continue; }
            const fr = Math.max(0, Math.min(ft.frames - 1, Math.floor((localT / regionDur) * ft.frames)));
            const hz = fdata[fr];
            if (!hz) { started = false; continue; }
            const y = h - (hz / FMAX) * h;
            if (!started) { ctx.moveTo(cx, y); started = true; } else ctx.lineTo(cx, y);
          }
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = "9px 'JetBrains Mono',monospace"; ctx.textAlign = 'left';
    ctx.fillText('8kHz', 4, 11);
    ctx.fillText('1kHz', 4, h * (1 - 1000/8000) - 1);
    ctx.fillText('100Hz', 4, h - 3);
    drawPlayheadLine(ctx, w, h);
  }, [drawSelectionRect, drawPlayheadLine]);

  const drawRuler = useCallback(() => {
    const s = setupCanvas(rulerCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = '#13131a'; ctx.fillRect(0, 0, w, h);
    const span = t1 - t0, pxPerSec = w / span;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30];
    const step = steps.find(st => st * pxPerSec >= 70) || 30;
    const first = Math.ceil(t0 / step) * step;
    ctx.fillStyle = '#45454d'; ctx.font = "9px 'JetBrains Mono',monospace"; ctx.textAlign = 'center';
    ctx.strokeStyle = '#2a2a30'; ctx.lineWidth = 1;
    for (let t = first; t <= t1 + step; t = +(t + step).toFixed(6)) {
      const x = Math.round(tX(t, w));
      ctx.beginPath(); ctx.moveTo(x, h - 6); ctx.lineTo(x, h); ctx.stroke();
      const label = t >= 60
        ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`
        : `${step < 1 ? t.toFixed(1) : Math.round(t)}s`;
      ctx.fillText(label, x, h - 8);
    }
  }, [tX]);

  const drawTier = useCallback((canvas, items, isWord) => {
    const s = setupCanvas(canvas);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = '#13131a'; ctx.fillRect(0, 0, w, h);
    const sel = selectionRef.current;
    if (sel) {
      const sx = tX(sel.t0, w), ex = tX(sel.t1, w);
      ctx.fillStyle = 'rgba(58,123,213,0.12)';
      ctx.fillRect(sx, 0, ex - sx, h);
    }
    const fillColor   = isWord ? 'rgba(58,123,213,0.18)'  : 'rgba(60,200,130,0.15)';
    const strokeColor = isWord ? 'rgba(58,123,213,0.45)'  : 'rgba(60,200,130,0.4)';
    const font        = isWord ? "500 12px Inter,sans-serif" : "11px 'JetBrains Mono',monospace";
    for (const item of items) {
      if (item.t1 < t0 || item.t0 > t1) continue;
      const x0 = Math.max(0, tX(item.t0, w)), x1 = Math.min(w, tX(item.t1, w));
      const bw = x1 - x0;
      if (bw < 0.5) continue;
      ctx.fillStyle = fillColor; ctx.fillRect(x0, 2, bw, h - 4);
      ctx.strokeStyle = strokeColor; ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, 2.5, bw - 1, h - 5);
      if (bw > 8) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0 + 1, 0, bw - 2, h); ctx.clip();
        ctx.fillStyle = '#c8c6c1'; ctx.font = font; ctx.textAlign = 'center';
        ctx.fillText(item.text, (x0 + x1) / 2, h / 2 + 4);
        ctx.restore();
      }
    }
    drawPlayheadLine(ctx, w, h);
  }, [tX, drawPlayheadLine]);

  const drawMinimap = useCallback(() => {
    const s = setupCanvas(minimapCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const DUR = durationRef.current;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = '#0c0c0f'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(58,123,213,0.3)';
    for (const wd of wordsRef.current) {
      ctx.fillRect((wd.t0 / DUR) * w, 3, Math.max(1, ((wd.t1 - wd.t0) / DUR) * w), h - 6);
    }
    const vx0 = (t0 / DUR) * w, vx1 = (t1 / DUR) * w;
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(vx0, 0, vx1 - vx0, h);
    ctx.strokeStyle = '#45454d'; ctx.lineWidth = 1;
    ctx.strokeRect(vx0 + 0.5, 0.5, vx1 - vx0 - 1, h - 1);
    const px = (playheadRef.current / DUR) * w;
    ctx.strokeStyle = '#e05a3a'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }, []);

  // Moving playhead overlay — only updated during playback via RAF
  const drawOverlay = useCallback(() => {
    const ov = overlayCanvasRef.current;
    const tl = timelineRef.current;
    if (!ov || !tl) return;
    const GUTTER = 56;
    const dpr = window.devicePixelRatio || 1;
    const tw = tl.offsetWidth, th = tl.offsetHeight;
    if (ov.width !== Math.round(tw * dpr) || ov.height !== Math.round(th * dpr)) {
      ov.width = Math.round(tw * dpr);
      ov.height = Math.round(th * dpr);
      ov.style.width = tw + 'px';
      ov.style.height = th + 'px';
    }
    const ctx = ov.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, tw, th);
    const px = GUTTER + tX(playheadRef.current, tw - GUTTER);
    if (px >= GUTTER && px <= tw) {
      ctx.strokeStyle = '#e05a3a'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, th); ctx.stroke();
    }
    drawMinimap();
  }, [tX, drawMinimap]);

  const clearOverlay = useCallback(() => {
    const ov = overlayCanvasRef.current;
    if (ov) ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  }, []);

  const redraw = useCallback(() => {
    drawWave(); drawSpec(); drawRuler();
    drawTier(wordsCanvasRef.current, wordsRef.current, true);
    drawTier(phonesCanvasRef.current, phonesRef.current, false);
    drawMinimap();
  }, [drawWave, drawSpec, drawRuler, drawTier, drawMinimap]);

  const calcSpecForView = useCallback(() => {
    const buf = audioBufferRef.current;
    const sp  = spectroRef.current;
    if (!buf || !sp) return;
    setSpecComputing(true);
    const { t0, t1 } = viewRef.current;
    const span = t1 - t0;
    const canvas = specCanvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const pw = canvas ? Math.round(canvas.offsetWidth * dpr) : 1400;
    const ph = canvas ? Math.round(canvas.offsetHeight * dpr) : 400;

    // Pick hop: finer for zoomed-in views, capped at 512 for overview
    const sr = buf.sampleRate;
    const targetFrames = pw * 2;
    let hop = 512;
    for (const h of [256, 128, 64, 32, 16]) {
      if ((span * sr) / h >= targetFrames) { hop = h; break; }
      hop = h;
    }

    const startSample = Math.max(0, Math.floor(t0 * sr) - 2048);
    const endSample   = Math.min(buf.length, Math.ceil(t1 * sr) + 2048);
    const regionT0    = startSample / sr;
    const region      = buf.getChannelData(0).slice(startSample, endSample);

    if (specWorkerRef.current) specWorkerRef.current.terminate();
    const worker = new Worker(new URL('./specWorker.js', import.meta.url), { type: 'module' });
    specWorkerRef.current = worker;

    worker.onmessage = ({ data: res }) => {
      worker.terminate();
      specWorkerRef.current = null;
      const oc = document.createElement('canvas');
      oc.width = res.pw; oc.height = res.ph;
      oc.getContext('2d').putImageData(new ImageData(res.pixels, res.pw, res.ph), 0, 0);
      spectroCacheRef.current = { canvas: oc, ph, stripT0: t0, stripT1: t1, stripPw: pw };
      setSpecComputing(false);
      drawSpec();
    };

    worker.postMessage(
      { ch: region, sr, t0, t1, hop, N_FFT: 2048, pw, ph, colormapName: colormapNameRef.current, regionT0, id: 1 },
      [region.buffer]
    );
  }, [drawSpec]);

  const calcFormantForView = useCallback(() => {
    const buf = audioBufferRef.current;
    if (!buf) return;
    setFormantComputing(true);
    const { t0, t1 } = viewRef.current;
    const sr = buf.sampleRate;
    const startSample = Math.max(0, Math.floor(t0 * sr) - 1024);
    const endSample   = Math.min(buf.length, Math.ceil(t1 * sr) + 1024);
    const regionT0    = startSample / sr;
    const region      = buf.getChannelData(0).slice(startSample, endSample);

    if (formantWorkerRef.current) formantWorkerRef.current.terminate();
    const worker = new Worker(new URL('./formantWorker.js', import.meta.url), { type: 'module' });
    formantWorkerRef.current = worker;

    worker.onmessage = ({ data }) => {
      worker.terminate();
      formantWorkerRef.current = null;
      formantTrackRef.current = { ...data, regionT0 };
      formantViewRef.current  = { t0, t1 };
      setFormantComputing(false);
      if (!showFormantsRef.current) { showFormantsRef.current = true; setShowFormants(true); }
      drawSpec();
    };

    worker.postMessage({ ch: region, sr, regionT0, id: 1 }, [region.buffer]);
  }, [drawSpec]);

  // ── Audio context ─────────────────────────────────────────────────────
  const getAudioCtx = () => {
    if (!audioCtxRef.current)
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtxRef.current;
  };

  const updateTimeDisplay = useCallback(() => {
    if (timeDisplayRef.current)
      timeDisplayRef.current.textContent = `${fmtTime(playheadRef.current)} / ${fmtTime(durationRef.current)}`;
  }, []);

  // Stops audio + RAF without touching React state — used internally
  const stopAudio = useCallback(() => {
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop(); } catch(_) {}
      audioSourceRef.current = null;
    }
    if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
    playingRef.current = false;
  }, []);

  // Full stop: kills audio, clears overlay, redraws static playhead
  const stopPlay = useCallback(() => {
    stopAudio();
    setPlaying(false);
    clearOverlay();
    updateTimeDisplay();
    redraw();
  }, [stopAudio, clearOverlay, redraw, updateTimeDisplay]);

  // RAF loop — only updates overlay line; full redraw only on view scroll
  const tick = useCallback(() => {
    if (!playingRef.current) return;
    const DUR = durationRef.current;
    const t = playStartAtRef.current + (getAudioCtx().currentTime - playStartCtxRef.current);
    playheadRef.current = Math.min(playEndAtRef.current, t);
    updateTimeDisplay();
    const { t0, t1 } = viewRef.current;
    const span = t1 - t0, pad = span * 0.12;
    if (playheadRef.current > t1 - pad) {
      const newT0 = Math.min(DUR - span, playheadRef.current - pad);
      viewRef.current = { t0: newT0, t1: newT0 + span };
      redraw();
    } else {
      drawOverlay();
    }
    rafIdRef.current = requestAnimationFrame(tick);
  }, [drawOverlay, redraw, updateTimeDisplay]);

  const startPlay = useCallback((from) => {
    if (!audioBufferRef.current) return;
    stopAudio();
    const ctx = getAudioCtx();
    const src = ctx.createBufferSource();
    src.buffer = audioBufferRef.current;
    src.connect(ctx.destination);
    const sel = selectionRef.current;
    const to = sel ? sel.t1 : durationRef.current;
    src.start(0, from, to - from);
    src.onended = () => {
      if (loopModeRef.current && sel && playingRef.current) { startPlay(sel.t0); return; }
      stopAudio();
      setPlaying(false);
      clearOverlay();
      updateTimeDisplay();
      redraw();
    };
    audioSourceRef.current = src;
    playStartCtxRef.current = ctx.currentTime;
    playStartAtRef.current = from;
    playEndAtRef.current = to;
    playingRef.current = true;
    setPlaying(true);
    rafIdRef.current = requestAnimationFrame(tick);
  }, [stopAudio, tick, clearOverlay, redraw, updateTimeDisplay]);

  // ── Data loading ──────────────────────────────────────────────────────

  const loadAudio = useCallback(async (file) => {
    const ctx = getAudioCtx();
    const buffer = await ctx.decodeAudioData((await file.arrayBuffer()).slice(0));
    audioBufferRef.current = buffer;

    // Peak waveform for fast bar rendering
    const ch = buffer.getChannelData(0);
    const N = 4000, step = Math.floor(ch.length / N);
    const peaks = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let mx = 0;
      for (let j = 0; j < step; j++) { const v = Math.abs(ch[i*step+j] || 0); if (v > mx) mx = v; }
      peaks[i] = mx;
    }
    waveformDataRef.current = peaks;
    rmsEnvRef.current = buildRmsEnvelope(buffer);
    redraw();

    // Heavy DSP deferred so the UI stays responsive
    setTimeout(() => {
      spectroRef.current = buildMelSpectrogram(buffer, COLORMAPS[colormapNameRef.current] || inferno);
      redraw();
      setTimeout(() => {
        formantTrackRef.current = buildFormantTrack(buffer);
        redraw();
      }, 50);
    }, 50);
  }, [redraw]);

  const loadTextGrid = useCallback((text) => {
    const { duration: dur, tiers } = parseTextGrid(text);
    const w = tiers['words'] || [];
    const p = tiers['phones'] || tiers['phonemes'] || tiers['phone'] || [];
    durationRef.current = dur; setDuration(dur);
    wordsRef.current = w;      setWords(w);
    phonesRef.current = p;     setPhones(p);
    viewRef.current = { t0: 0, t1: Math.min(dur, 20) };
    redraw();
  }, [redraw]);

  // ── Effects ───────────────────────────────────────────────────────────

  // Auto-load bundled files on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(BUNDLED_TG);
        if (res.ok) loadTextGrid(await res.text());
      } catch(e) { console.warn('TextGrid load failed:', e); }
      try {
        const res = await fetch(BUNDLED_WAV);
        if (!res.ok) throw new Error(res.statusText);
        await loadAudio(new File([await res.blob()], BUNDLED_WAV, { type: 'audio/wav' }));
      } catch(e) { console.warn('Audio auto-load failed:', e); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { redraw(); }, [redraw, words, phones, duration]);

  // Resize observer
  useEffect(() => {
    const el = document.getElementById('root');
    if (!el) return;
    let raf = null;
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = null; redraw(); });
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [redraw]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const DUR = durationRef.current;
      if (e.code === 'Space') {
        e.preventDefault();
        if (playingRef.current) {
          stopPlay();
        } else if (audioBufferRef.current) {
          const sel = selectionRef.current;
          const ph = playheadRef.current;
          startPlay((sel && (ph < sel.t0 || ph > sel.t1)) ? sel.t0 : ph);
        }
      }
      if (e.code === 'KeyL') {
        const n = !loopModeRef.current;
        loopModeRef.current = n; setLoopMode(n);
      }
      if (e.code === 'KeyF') {
        viewRef.current = { t0: 0, t1: DUR };
        redraw();
      }
      if (e.code === 'Home') {
        viewRef.current = { t0: 0, t1: Math.min(DUR, 20) };
        redraw();
      }
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const { t0, t1 } = viewRef.current;
        const span = t1 - t0;
        const delta = span * 0.2 * (e.code === 'ArrowRight' ? 1 : -1);
        const newT0 = Math.max(0, Math.min(DUR - span, t0 + delta));
        viewRef.current = { t0: newT0, t1: newT0 + span };
        redraw();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stopPlay, startPlay, redraw]);

  // ── Zoom ──────────────────────────────────────────────────────────────

  const sliderToSpan = useCallback((v) => {
    const DUR = durationRef.current;
    return Math.exp((1 - v/100) * Math.log(DUR) + (v/100) * Math.log(0.5));
  }, []);

  const spanToSlider = useCallback((span) => {
    const DUR = durationRef.current;
    return Math.round((1 - (Math.log(Math.max(0.5, Math.min(DUR, span))) - Math.log(0.5)) / (Math.log(DUR) - Math.log(0.5))) * 100);
  }, []);

  const applyZoom = useCallback((ns) => {
    const { t0, t1 } = viewRef.current;
    const DUR = durationRef.current;
    const center = (t0 + t1) / 2;
    let newT0 = Math.max(0, center - ns/2);
    let newT1 = Math.min(DUR, newT0 + ns);
    if (newT1 - newT0 < ns) newT0 = newT1 - ns;
    viewRef.current = { t0: newT0, t1: newT1 };
    setZoomValue(spanToSlider(newT1 - newT0));
    redraw();
  }, [spanToSlider, redraw]);

  const handleZoom = useCallback((v) => {
    setZoomValue(v);
    applyZoom(sliderToSpan(v));
  }, [sliderToSpan, applyZoom]);

  // ── Interaction (wheel + mouse seek/select) ───────────────────────────

  const addInteraction = useCallback((canvas, seekable) => {
    if (!canvas) return () => {};
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const { t0, t1 } = viewRef.current;
      const span = t1 - t0;
      const DUR = durationRef.current;
      if (e.ctrlKey || e.metaKey) {
        const ratio = (e.clientX - rect.left) / rect.width;
        const anchor = t0 + ratio * span;
        let ns = Math.max(0.5, Math.min(DUR, span * (e.deltaY > 0 ? 1.18 : 0.85)));
        let newT0 = Math.max(0, anchor - ratio * ns);
        let newT1 = Math.min(DUR, newT0 + ns);
        if (newT1 - newT0 < ns) newT0 = newT1 - ns;
        viewRef.current = { t0: newT0, t1: newT1 };
      } else {
        const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        const newT0 = Math.max(0, Math.min(DUR - span, t0 + (delta / rect.width) * span * 0.8));
        viewRef.current = { t0: newT0, t1: newT0 + span };
      }
      // Defer React state update so it doesn't trigger re-render mid-scroll
      if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current);
      zoomRafRef.current = requestAnimationFrame(() => {
        setZoomValue(spanToSlider(viewRef.current.t1 - viewRef.current.t0));
        zoomRafRef.current = null;
      });
      redraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let onDown = null;
    if (seekable) {
      onDown = (e) => {
        const rect = canvas.getBoundingClientRect();
        const startT = xT(e.clientX - rect.left, rect.width);
        let dragged = false;
        selectionRef.current = { t0: startT, t1: startT };
        redraw();
        const onMove = (ev) => {
          const t = xT(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)), rect.width);
          if (Math.abs(t - startT) > 0.015) dragged = true;
          selectionRef.current = { t0: Math.min(startT, t), t1: Math.max(startT, t) };
          redraw();
        };
        const onUp = (ev) => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          if (!dragged) {
            selectionRef.current = null;
            const t = Math.max(0, Math.min(durationRef.current,
              xT(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)), rect.width)));
            playheadRef.current = t;
            updateTimeDisplay();
            if (playingRef.current) { stopPlay(); startPlay(t); } else redraw();
          }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };
      canvas.addEventListener('mousedown', onDown);
    }
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      if (onDown) canvas.removeEventListener('mousedown', onDown);
    };
  }, [xT, redraw, stopPlay, startPlay, spanToSlider, updateTimeDisplay]);

  useEffect(() => {
    const cleanups = [
      addInteraction(waveCanvasRef.current, true),
      addInteraction(specCanvasRef.current, true),
      addInteraction(wordsCanvasRef.current, true),
      addInteraction(phonesCanvasRef.current, true),
    ];
    return () => cleanups.forEach(c => c && c());
  }, [addInteraction]);

  // Minimap click/drag
  useEffect(() => {
    const cv = minimapCanvasRef.current;
    if (!cv) return;
    const pan = (x) => {
      const rect = cv.getBoundingClientRect();
      const { t0, t1 } = viewRef.current;
      const span = t1 - t0, DUR = durationRef.current;
      const t = (Math.max(0, Math.min(rect.width, x)) / rect.width) * DUR;
      const newT0 = Math.max(0, Math.min(DUR - span, t - span/2));
      viewRef.current = { t0: newT0, t1: newT0 + span };
      redraw();
    };
    const onDown = (e) => {
      pan(e.clientX - cv.getBoundingClientRect().left);
      const onMove = (ev) => pan(ev.clientX - cv.getBoundingClientRect().left);
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    cv.addEventListener('mousedown', onDown);
    return () => cv.removeEventListener('mousedown', onDown);
  }, [redraw]);

  // Token hover popup
  const addHover = useCallback((canvas, items) => {
    if (!canvas) return () => {};
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const t = xT(e.clientX - rect.left, rect.width);
      const item = items.find(it => t >= it.t0 && t <= it.t1);
      if (!item) { setPopup(null); return; }
      let left = e.clientX - 80, top = rect.top - 62;
      if (top < 8) top = rect.bottom + 8;
      setPopup({
        text: item.text, t0: item.t0, t1: item.t1,
        dur: ((item.t1 - item.t0) * 1000).toFixed(0),
        left: Math.max(8, Math.min(window.innerWidth - 168, left)), top,
      });
    };
    const onLeave = () => setPopup(null);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    return () => { canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave); };
  }, [xT]);

  useEffect(() => {
    const c1 = addHover(wordsCanvasRef.current, wordsRef.current);
    const c2 = addHover(phonesCanvasRef.current, phonesRef.current);
    return () => { c1(); c2(); };
  }, [addHover, words, phones]);

  // Drag-and-drop
  useEffect(() => {
    const onOver  = (e) => { e.preventDefault(); setDropping(true); };
    const onLeave = (e) => { if (!e.relatedTarget) setDropping(false); };
    const onDrop  = (e) => {
      e.preventDefault(); setDropping(false);
      const f = e.dataTransfer.files[0]; if (!f) return;
      if (f.name.toLowerCase().endsWith('.textgrid')) {
        const reader = new FileReader();
        reader.onload = (ev) => loadTextGrid(ev.target.result);
        reader.readAsText(f);
      } else {
        loadAudio(f);
      }
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [loadAudio, loadTextGrid]);

  // ── Toolbar handlers ──────────────────────────────────────────────────

  const handleColormapChange = useCallback((name) => {
    colormapNameRef.current = name; setColormapName(name);
    const buf = audioBufferRef.current;
    if (!buf) return;
    spectroRef.current = buildMelSpectrogram(buf, COLORMAPS[name] || inferno);
    spectroCacheRef.current = { canvas: null };
    redraw();
  }, [redraw]);

  const handleAudioFile = (e) => { if (e.target.files[0]) loadAudio(e.target.files[0]); };
  const handleTGFile    = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => loadTextGrid(ev.target.result);
    reader.readAsText(f);
  };

  // ── Drag-to-resize helper ─────────────────────────────────────────────
  const makeDragDivider = (getContainer, onMove) => ({
    onMouseDown: (e) => {
      e.preventDefault();
      const container = getContainer(e.currentTarget);
      const rect = container.getBoundingClientRect();
      const move = (ev) => onMove(ev, rect);
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        redraw();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
  });

  // ── JSX ───────────────────────────────────────────────────────────────
  return (
    <>
      <div className={`drop-overlay${dropping ? ' active' : ''}`}>
        <div style={{ fontSize: 32 }}>🎵</div>
        <div>Drop audio or TextGrid file to load</div>
      </div>

      <div className="toolbar">
        <div className="logo">Annotation Viewer <span>Bluey · 280–350s</span></div>
        <div className="spacer" />
        <div className="transport">
          <button className={`btn${loopMode ? ' active' : ''}`} onClick={() => { loopModeRef.current = !loopMode; setLoopMode(lm => !lm); }} title="Loop selection (L)">
            ⟲ Loop
          </button>
          <button
            className={`btn btn-play${playing ? ' paused' : ''}`}
            onClick={() => {
              if (playing) {
                stopPlay();
              } else if (audioBufferRef.current) {
                const sel = selectionRef.current, ph = playheadRef.current;
                startPlay((sel && (ph < sel.t0 || ph > sel.t1)) ? sel.t0 : ph);
              } else {
                alert('Drop an audio file onto the page, or click Load audio.');
              }
            }}
          >{playing ? '⏸ Pause' : '▶ Play'}</button>
          <button className="btn" onClick={() => { stopPlay(); playheadRef.current = 0; updateTimeDisplay(); redraw(); }}>■</button>
          <div className="time-display" ref={timeDisplayRef}>
            {fmtTime(playheadRef.current)} / {fmtTime(duration)}
          </div>
        </div>
        <div className="zoom-row">
          <span className="zoom-label">ZOOM</span>
          <input type="range" min="0" max="100" value={zoomValue} onChange={e => handleZoom(+e.target.value)} title="Zoom level" />
        </div>
        <label className="load-btn">
          🎵 Load audio
          <input type="file" accept=".wav,.mp3,.flac,.m4a,.ogg" onChange={handleAudioFile} />
        </label>
        <label className="load-btn">
          📄 Load TextGrid
          <input type="file" accept=".TextGrid,.textgrid" onChange={handleTGFile} />
        </label>
        <select className="colormap-select" value={colormapName} onChange={e => handleColormapChange(e.target.value)} title="Spectrogram colormap">
          <option value="inferno">Inferno</option>
          <option value="jet">Jet</option>
          <option value="viridis">Viridis</option>
          <option value="greys">Greys</option>
        </select>
      </div>

      <div className="timeline" ref={timelineRef}>
        <canvas className="playhead-overlay" ref={overlayCanvasRef} />

        <div className="timeline-body">
        <div className="panels" ref={panelsDivRef}>
          <div className="panel" ref={wavePanelRef} style={{ flex: panelSplitRef.current }}>
            <div className="panel-gutter">WV</div>
            <div className="panel-body">
              <div className="panel-tag">Waveform</div>
              <canvas ref={waveCanvasRef} style={{ height: '100%' }} />
            </div>
          </div>
          <div
            className="panel-divider"
            {...makeDragDivider(
              (el) => el.closest('.panels'),
              (ev, rect) => {
                const f = Math.max(0.1, Math.min(0.9, (ev.clientY - rect.top) / rect.height));
                panelSplitRef.current = f;
                wavePanelRef.current.style.flex = f;
                specPanelRef.current.style.flex = 1 - f;
              }
            )}
          />
          <div className="panel" ref={specPanelRef} style={{ flex: 1 - panelSplitRef.current }}>
            <div className="panel-gutter">SP</div>
            <div className="panel-body">
              <div className="panel-tag">Spectrogram</div>
              <canvas ref={specCanvasRef} style={{ height: '100%' }} />
              <div className="spec-overlay-btns">
                <button
                  className={`calc-spec-btn${specComputing ? ' computing' : ''}`}
                  onClick={calcSpecForView}
                  disabled={specComputing}
                  title="Calculate high-res spectrogram for current view"
                >
                  {specComputing ? '⟳ Calc…' : '⟳ Calc Spec'}
                </button>
                <div className="formant-btn-group">
                  <button
                    className={`calc-spec-btn${showFormants ? ' active' : ''}`}
                    onClick={() => { const n = !showFormants; showFormantsRef.current = n; setShowFormants(n); redraw(); }}
                    title="Toggle F1/F2/F3 overlay"
                  >
                    {showFormants ? '● Formants' : '○ Formants'}
                  </button>
                  <button
                    className={`calc-spec-btn${formantComputing ? ' computing' : ''}`}
                    onClick={calcFormantForView}
                    disabled={formantComputing}
                    title="Calculate formants for current view"
                  >
                    {formantComputing ? '⟳ …' : '⟳ Calc F1·F2·F3'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          className="tier-divider"
          {...makeDragDivider(
            (el) => el.parentElement,
            (ev, rect) => {
              const fraction = Math.max(0.1, Math.min(0.9, (ev.clientY - rect.top) / rect.height));
              panelsDivRef.current.style.flex = String(fraction);
              tiersDivRef.current.style.flex  = String(1 - fraction);
            }
          )}
        />
        <div className="ruler">
          <div className="ruler-gutter" />
          <canvas ref={rulerCanvasRef} />
        </div>

        <div className="tiers" ref={tiersDivRef}>
          <div className="tier" ref={wrdTierRef}>
            <div className="tier-gutter">WRD</div>
            <canvas ref={wordsCanvasRef} />
          </div>
          <div
            className="tier-divider"
            {...makeDragDivider(
              (el) => el.closest('.tiers'),
              (ev, rect) => {
                const fraction = Math.max(0.1, Math.min(0.9, (ev.clientY - rect.top) / rect.height));
                wrdTierRef.current.style.flex = String(fraction);
                phnTierRef.current.style.flex = String(1 - fraction);
              }
            )}
          />
          <div className="tier" ref={phnTierRef}>
            <div className="tier-gutter">PHN</div>
            <canvas ref={phonesCanvasRef} />
          </div>
        </div>

        </div>{/* timeline-body */}

        <div className="minimap">
          <div className="minimap-gutter" />
          <canvas ref={minimapCanvasRef} />
        </div>
      </div>

      <div className={`token-popup${popup ? ' show' : ''}`} style={popup ? { left: popup.left, top: popup.top } : {}}>
        {popup && (
          <>
            <div style={{ fontSize: 19, fontWeight: 600, color: '#e8e6e1', letterSpacing: '-0.3px' }}>{popup.text}</div>
            <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: '#6b6a65', marginTop: 4 }}>
              {popup.t0.toFixed(3)}s – {popup.t1.toFixed(3)}s &nbsp;·&nbsp; {popup.dur}ms
            </div>
          </>
        )}
      </div>
    </>
  );
}
