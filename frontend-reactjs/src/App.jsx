import React, { useRef, useEffect, useState, useCallback } from 'react';
import { parseTextGrid } from './parseTextGrid.js';
import { setupCanvas, fmtTime } from './canvasUtils.js';
import {
  COLORMAPS, inferno,
  buildMelSpectrogram, buildRmsEnvelope, buildFormantTrack,
} from './dsp.js';


let _nextId = 1;
const nextId = () => _nextId++;

function scoreColor(score, alpha = 1) {
  const r = score < 0.5 ? 255 : Math.round(255 * (1 - (score - 0.5) * 2));
  const g = score > 0.5 ? 200 : Math.round(200 * score * 2);
  return alpha < 1 ? `rgba(${r},${g},50,${alpha})` : `rgb(${r},${g},50)`;
}

function pixelsToCanvas(res) {
  const oc = document.createElement('canvas');
  oc.width = res.pw; oc.height = res.ph;
  oc.getContext('2d').putImageData(new ImageData(res.pixels, res.pw, res.ph), 0, 0);
  return oc;
}

function assignRows(items) {
  const sorted = [...items].sort((a, b) => a.t0 - b.t0);
  const rows = []; // rows[r] = end time of last item in row r
  for (const item of sorted) {
    let r = rows.findIndex(end => item.t0 >= end - 0.001);
    if (r === -1) r = rows.length;
    rows[r] = item.t1;
    item.row = r;
  }
  return sorted;
}

function withIds(items) {
  return items.map(it => ({ ...it, id: it.id ?? nextId(), row: 0 }));
}

function serializeTextGrid(duration, wordItems, phoneItems) {
  const tierData = [
    { name: 'words', items: wordItems },
    { name: 'phones', items: phoneItems },
  ];

  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    '',
    'xmin = 0',
    `xmax = ${duration.toFixed(6)}`,
    'tiers? <exists>',
    `size = ${tierData.length}`,
    'item []:',
  ];

  tierData.forEach(({ name, items }, ti) => {
    const sorted = [...items].sort((a, b) => a.t0 - b.t0);
    const intervals = [];
    let cursor = 0;
    for (const it of sorted) {
      if (it.t0 > cursor + 1e-9) intervals.push({ t0: cursor, t1: it.t0, text: '' });
      intervals.push({ t0: it.t0, t1: it.t1, text: it.text });
      cursor = it.t1;
    }
    if (cursor < duration - 1e-9) intervals.push({ t0: cursor, t1: duration, text: '' });

    lines.push(`    item [${ti + 1}]:`);
    lines.push('        class = "IntervalTier"');
    lines.push(`        name = "${name}"`);
    lines.push('        xmin = 0');
    lines.push(`        xmax = ${duration.toFixed(6)}`);
    lines.push(`        intervals: size = ${intervals.length}`);
    intervals.forEach((iv, i) => {
      lines.push(`        intervals [${i + 1}]:`);
      lines.push(`            xmin = ${iv.t0.toFixed(6)}`);
      lines.push(`            xmax = ${iv.t1.toFixed(6)}`);
      lines.push(`            text = "${iv.text}"`);
    });
  });

  return lines.join('\n');
}

function ConfidenceDashboard({ words }) {
  const scored = words.filter(w => w.score != null).sort((a, b) => a.score - b.score);
  if (scored.length === 0) {
    return (
      <div style={dashStyle}>
        <div style={{ color: '#6b6a65', fontSize: 12, padding: 16, textAlign: 'center' }}>
          No score data in this TextGrid
        </div>
      </div>
    );
  }

  const scores = scored.map(w => w.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const median = scores[Math.floor(scores.length / 2)];
  const min = scores[0];
  const max = scores[scores.length - 1];

  // Build 10-bin histogram
  const bins = Array(10).fill(0);
  for (const s of scores) bins[Math.min(9, Math.floor(s * 10))]++;
  const maxBin = Math.max(...bins);
  const low = scored.slice(0, 5);

  return (
    <div style={dashStyle}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#e8e6e1', marginBottom: 10, letterSpacing: 0.5 }}>
        CONFIDENCE SCORES
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px', marginBottom: 12 }}>
        {[['Mean', mean], ['Median', median], ['Min', min], ['Max', max]].map(([label, val]) => (
          <div key={label} style={{ background: '#1e1e26', borderRadius: 4, padding: '4px 6px' }}>
            <div style={{ fontSize: 9, color: '#6b6a65', fontFamily: "'JetBrains Mono',monospace" }}>{label}</div>
            <div style={{ fontSize: 13, color: scoreColor(val), fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>
              {val.toFixed(3)}
            </div>
          </div>
        ))}
      </div>

      {/* Histogram */}
      <div style={{ fontSize: 9, color: '#6b6a65', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>
        DISTRIBUTION ({scored.length} words)
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 60, marginBottom: 4 }}>
        {bins.map((count, i) => {
          const pct = maxBin > 0 ? count / maxBin : 0;
          const midScore = (i + 0.5) / 10;
          return (
            <div key={i} style={{
              flex: 1, height: Math.max(2, pct * 52),
              background: scoreColor(midScore), borderRadius: '2px 2px 0 0', opacity: 0.85,
            }} title={`${(i * 0.1).toFixed(1)}–${((i+1)*0.1).toFixed(1)}: ${count}`} />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#45454d', fontFamily: "'JetBrains Mono',monospace", marginBottom: 12 }}>
        <span>0.0</span><span>0.5</span><span>1.0</span>
      </div>

      {/* Color legend */}
      <div style={{ fontSize: 9, color: '#6b6a65', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>LEGEND</div>
      <div style={{
        height: 8, borderRadius: 4, marginBottom: 4,
        background: 'linear-gradient(to right, rgb(255,0,50), rgb(255,200,50), rgb(0,200,50))',
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#45454d', fontFamily: "'JetBrains Mono',monospace", marginBottom: 14 }}>
        <span>Low</span><span>High</span>
      </div>

      {/* Low confidence words */}
      <div style={{ fontSize: 9, color: '#6b6a65', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>
        LOWEST CONFIDENCE
      </div>
      {low.map(w => (
        <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', borderBottom: '1px solid #1e1e24' }}>
          <span style={{ fontSize: 12, color: '#c8c6c1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
            {w.text || '<empty>'}
          </span>
          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: scoreColor(w.score), flexShrink: 0, marginLeft: 6 }}>
            {w.score.toFixed(3)}
          </span>
        </div>
      ))}
    </div>
  );
}

const dashStyle = {
  width: 200, flexShrink: 0,
  background: '#13131a', borderLeft: '1px solid #1e1e24',
  overflowY: 'auto', padding: '14px 12px',
  fontFamily: 'Inter,system-ui,sans-serif',
};

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
  const [colormapName, setColormapName] = useState('jet');
  const [showFormants, setShowFormants] = useState(false);
  const [specComputing, setSpecComputing] = useState(false);
  const [formantComputing, setFormantComputing] = useState(false);
  const [editMode, setEditMode]         = useState(false);
  const [labelEditor, setLabelEditor]   = useState(null); // { id, isWord, text, x, y, w }
  const [editShortcut, setEditShortcut] = useState('F1');
  const [editingShortcut, setEditingShortcut] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [playbackRate, setPlaybackRate]   = useState(1);
  const [mfaRunning, setMfaRunning]       = useState(false);
  const [mfaError, setMfaError]           = useState(null);   // string | null
  const [mfaWordPicker, setMfaWordPicker] = useState(null);   // { words: WordItem[], sel } | null
  const [setupError, setSetupError]       = useState(null);   // string | null — shown before audio loads
  const MFA_SERVER = 'http://localhost:5050';
  const playbackRateRef = useRef(1);
  const editShortcutRef = useRef('F1');

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
  const spectroCacheRef  = useRef({ canvas: null }); // high-res local view cache
  const baseSpecCacheRef = useRef({ canvas: null }); // full-duration low-res cache
  const baseSpecWorkerRef = useRef(null);
  const zoomRafRef       = useRef(null);
  const viewPeakRef      = useRef({ t0: -1, t1: -1, peak: 0 });
  const specWorkerRef    = useRef(null);
  const formantWorkerRef = useRef(null);
  const formantViewRef   = useRef(null);
  const wordsRef         = useRef([]);
  const phonesRef        = useRef([]);
  const durationRef      = useRef(70);
  const colormapNameRef  = useRef('jet');
  const showFormantsRef  = useRef(false);
  const rmsEnvRef        = useRef(null);
  const formantTrackRef  = useRef(null);
  const editModeRef      = useRef(false);
  const undoStackRef     = useRef([]); // snapshots: { words, phones }
  const hoverEdgeRef     = useRef(null); // { id, isWord, side: 'left'|'right' } for cursor feedback

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

  // ── Undo ──────────────────────────────────────────────────────────────
  const pushUndo = useCallback(() => {
    undoStackRef.current.push({
      words:  wordsRef.current.map(it => ({ ...it })),
      phones: phonesRef.current.map(it => ({ ...it })),
    });
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
  }, []);

  const popUndo = useCallback(() => {
    const snap = undoStackRef.current.pop();
    if (!snap) return;
    wordsRef.current  = snap.words;
    phonesRef.current = snap.phones;
    setWords([...snap.words]);
    setPhones([...snap.phones]);
  }, []);

  // ── Draw helpers ──────────────────────────────────────────────────────

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

      const blitStrip = (cache) => {
        const { canvas: strip, stripT0, stripT1, stripPw } = cache;
        const totalSpan = stripT1 - stripT0;
        const span = t1 - t0;
        const srcX = Math.round(((t0 - stripT0) / totalSpan) * stripPw);
        const srcW = Math.round((span / totalSpan) * stripPw);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(strip, Math.max(0, srcX), 0, Math.max(1, srcW), ph, 0, 0, pw, ph);
        ctx.restore();
      };

      const local = spectroCacheRef.current;
      const base  = baseSpecCacheRef.current;
      if (local.canvas && local.stripT0 <= t0 && local.stripT1 >= t1 && local.ph === ph) {
        blitStrip(local);
      } else if (base.canvas && base.stripT0 <= t0 && base.stripT1 >= t1) {
        blitStrip(base);
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

    const numRows = Math.max(1, ...items.map(it => (it.row ?? 0) + 1));
    const rowH = h / numRows;
    const inEdit = editModeRef.current;
    const fillColor   = isWord ? 'rgba(58,123,213,0.18)'  : 'rgba(60,200,130,0.15)';
    const strokeColor = isWord ? 'rgba(58,123,213,0.45)'  : 'rgba(60,200,130,0.4)';
    const editFill    = isWord ? 'rgba(58,123,213,0.30)'  : 'rgba(60,200,130,0.28)';
    const font        = isWord ? "500 12px Inter,sans-serif" : "11px 'JetBrains Mono',monospace";
    const hoverEdge   = hoverEdgeRef.current;

    for (const item of items) {
      if (item.t1 < t0 || item.t0 > t1) continue;
      const x0 = Math.max(0, tX(item.t0, w));
      const x1 = Math.min(w, tX(item.t1, w));
      const bw = x1 - x0;
      if (bw < 0.5) continue;
      const row = item.row ?? 0;
      const ry = row * rowH;

      const hasScore = isWord && item.score != null;
      const fill   = hasScore ? scoreColor(item.score, inEdit ? 0.40 : 0.28) : (inEdit ? editFill : fillColor);
      const stroke = hasScore ? scoreColor(item.score, 0.75)                  : strokeColor;

      ctx.fillStyle = fill;
      ctx.fillRect(x0, ry + 2, bw, rowH - 4);
      ctx.strokeStyle = stroke; ctx.lineWidth = inEdit ? 1.5 : 1;
      ctx.strokeRect(x0 + 0.5, ry + 2.5, bw - 1, rowH - 5);

      if (inEdit) {
        const isHovered = hoverEdge && hoverEdge.id === item.id;
        if (isHovered) {
          const hx = hoverEdge.side === 'left' ? x0 : x1;
          ctx.strokeStyle = '#f0c040'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(hx, ry + 2); ctx.lineTo(hx, ry + rowH - 2); ctx.stroke();
          ctx.strokeStyle = strokeColor; ctx.lineWidth = 1.5;
        }
      }

      if (bw > 8) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0 + 1, ry, bw - 2, rowH); ctx.clip();
        ctx.fillStyle = '#c8c6c1'; ctx.font = font; ctx.textAlign = 'center';
        ctx.fillText(item.text, (x0 + x1) / 2, ry + rowH / 2 + 4);
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
    for (const wd of wordsRef.current) {
      ctx.fillStyle = wd.score != null ? scoreColor(wd.score, 0.55) : 'rgba(58,123,213,0.3)';
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
  }, [tX]);

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

  // ── Spectrogram computation ───────────────────────────────────────────

  const calcBaseSpec = useCallback((buf) => {
    if (!buf) return;
    const DUR = buf.duration;
    const canvas = specCanvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const pw = canvas ? Math.round(canvas.offsetWidth * dpr) : 1400;
    const ph = canvas ? Math.round(canvas.offsetHeight * dpr) : 400;
    const sr = buf.sampleRate;
    const hop = 512;
    const N_FFT = 2048;
    const region = buf.getChannelData(0).slice(0);

    if (baseSpecWorkerRef.current) baseSpecWorkerRef.current.terminate();
    const worker = new Worker(new URL('./specWorker.js', import.meta.url), { type: 'module' });
    baseSpecWorkerRef.current = worker;

    worker.onmessage = ({ data: res }) => {
      worker.terminate();
      baseSpecWorkerRef.current = null;
      baseSpecCacheRef.current = { canvas: pixelsToCanvas(res), stripT0: 0, stripT1: DUR, stripPw: res.pw };
      drawSpec();
    };

    worker.postMessage(
      { ch: region, sr, t0: 0, t1: DUR, hop, N_FFT, pw, ph, colormapName: colormapNameRef.current, regionT0: 0, id: 0 },
      [region.buffer]
    );
  }, [drawSpec]);

  const calcSpecForView = useCallback(() => {
    const buf = audioBufferRef.current;
    if (!buf) return;
    setSpecComputing(true);
    const { t0, t1 } = viewRef.current;
    const span = t1 - t0;
    const DUR = durationRef.current;
    const canvas = specCanvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const pw = canvas ? Math.round(canvas.offsetWidth * dpr) : 1400;
    const ph = canvas ? Math.round(canvas.offsetHeight * dpr) : 400;
    const sr = buf.sampleRate;

    const pad = span;
    const stripT0 = Math.max(0, t0 - pad);
    const stripT1 = Math.min(DUR, t1 + pad);
    const stripSpan = stripT1 - stripT0;
    const stripPw = Math.round(pw * (stripSpan / span));

    const samplesInView = span * sr;
    let N_FFT = 2048;
    if (samplesInView < 4000)       N_FFT = 128;
    else if (samplesInView < 10000) N_FFT = 256;
    else if (samplesInView < 30000) N_FFT = 512;
    else if (samplesInView < 80000) N_FFT = 1024;

    const targetFrames = stripPw * 2;
    let hop = N_FFT / 4;
    for (const h of [N_FFT/8, N_FFT/4, N_FFT/2, 64, 128, 256, 512]) {
      const hInt = Math.max(1, Math.round(h));
      if ((stripSpan * sr) / hInt >= targetFrames) { hop = hInt; break; }
      hop = hInt;
    }

    const startSample = Math.max(0, Math.floor(stripT0 * sr) - N_FFT);
    const endSample   = Math.min(buf.length, Math.ceil(stripT1 * sr) + N_FFT);
    const regionT0    = startSample / sr;
    const region      = buf.getChannelData(0).slice(startSample, endSample);

    if (specWorkerRef.current) specWorkerRef.current.terminate();
    const worker = new Worker(new URL('./specWorker.js', import.meta.url), { type: 'module' });
    specWorkerRef.current = worker;

    worker.onmessage = ({ data: res }) => {
      worker.terminate();
      specWorkerRef.current = null;
      spectroCacheRef.current = { canvas: pixelsToCanvas(res), ph, stripT0, stripT1, stripPw };
      setSpecComputing(false);
      drawSpec();
    };

    worker.postMessage(
      { ch: region, sr, t0: stripT0, t1: stripT1, hop, N_FFT, pw: stripPw, ph, colormapName: colormapNameRef.current, regionT0, id: 1 },
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
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed')
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtxRef.current;
  };

  const updateTimeDisplay = useCallback(() => {
    if (timeDisplayRef.current)
      timeDisplayRef.current.textContent = `${fmtTime(playheadRef.current)} / ${fmtTime(durationRef.current)}`;
  }, []);

  const stopAudio = useCallback(() => {
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop(); } catch(_) {}
      audioSourceRef.current = null;
    }
    if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
    playingRef.current = false;
  }, []);

  const stopPlay = useCallback(() => {
    stopAudio();
    setPlaying(false);
    clearOverlay();
    updateTimeDisplay();
    redraw();
  }, [stopAudio, clearOverlay, redraw, updateTimeDisplay]);

  const tick = useCallback(() => {
    if (!playingRef.current) return;
    const DUR = durationRef.current;
    const t = playStartAtRef.current + (getAudioCtx().currentTime - playStartCtxRef.current) * playbackRateRef.current;
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
    const doStart = () => {
      const src = ctx.createBufferSource();
      src.buffer = audioBufferRef.current;
      src.connect(ctx.destination);
      src.playbackRate.value = playbackRateRef.current;
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
    };
    if (ctx.state === 'suspended') {
      ctx.resume().then(doStart).catch(err => console.error('AudioContext resume failed:', err));
    } else {
      doStart();
    }
  }, [stopAudio, tick, clearOverlay, redraw, updateTimeDisplay]);

  // ── Data loading ──────────────────────────────────────────────────────

  const loadAudio = useCallback(async (file) => {
    const ctx = getAudioCtx();
    const buffer = await ctx.decodeAudioData((await file.arrayBuffer()).slice(0));
    audioBufferRef.current = buffer;

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

    setTimeout(() => {
      spectroRef.current = buildMelSpectrogram(buffer, COLORMAPS[colormapNameRef.current] || inferno);
      spectroCacheRef.current = { canvas: null };
      baseSpecCacheRef.current = { canvas: null };
      calcBaseSpec(buffer);
    }, 50);
    setTimeout(() => {
      formantTrackRef.current = buildFormantTrack(buffer);
      redraw();
    }, 50);
  }, [redraw]);

  const loadTextGrid = useCallback((text) => {
    const { duration: dur, tiers } = parseTextGrid(text);
    const tierLower = Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k.toLowerCase(), v]));
    const w = assignRows(withIds(tierLower['words'] || []));
    const p = assignRows(withIds(tierLower['phones'] || tierLower['phonemes'] || tierLower['phone'] || []));
    durationRef.current = dur; setDuration(dur);
    wordsRef.current = w;      setWords(w);
    phonesRef.current = p;     setPhones(p);
    viewRef.current = { t0: 0, t1: Math.min(dur, 20) };
    redraw();
  }, [redraw]);

  // ── Export TextGrid ───────────────────────────────────────────────────
  const exportTextGrid = useCallback(() => {
    const text = serializeTextGrid(durationRef.current, wordsRef.current, phonesRef.current);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'annotation.TextGrid';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // ── Effects ───────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      let manifest;
      try {
        const res = await fetch('/api/public-files');
        manifest = res.ok ? await res.json() : null;
      } catch(_) { manifest = null; }

      if (!manifest) {
        // Running as a built/static app — skip auto-load silently
        return;
      }

      const { wavs, tgs } = manifest;

      if (wavs.length === 0) {
        setSetupError(
          'No WAV file found in public/.\n' +
          'Add exactly one .wav and one .TextGrid file to the public/ folder, then reload.'
        );
        return;
      }
      if (wavs.length > 1) {
        setSetupError(
          `Found ${wavs.length} WAV files in public/: ${wavs.join(', ')}\n` +
          'Keep exactly one .wav file in public/, then reload.'
        );
        return;
      }
      if (tgs.length > 1) {
        setSetupError(
          `Found ${tgs.length} TextGrid files in public/: ${tgs.join(', ')}\n` +
          'Keep exactly one .TextGrid file in public/, then reload.'
        );
        return;
      }

      // Exactly one WAV (and zero or one TextGrid) — auto-load
      if (tgs.length === 1) {
        try {
          const res = await fetch(`/${encodeURIComponent(tgs[0])}`);
          if (res.ok) loadTextGrid(await res.text());
        } catch(e) { console.warn('TextGrid load failed:', e); }
      }
      try {
        const res = await fetch(`/${encodeURIComponent(wavs[0])}`);
        if (!res.ok) throw new Error(res.statusText);
        await loadAudio(new File([await res.blob()], wavs[0], { type: 'audio/wav' }));
        setSetupError(null);
      } catch(e) { console.warn('Audio auto-load failed:', e); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { redraw(); }, [redraw]);

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
          startPlay(sel ? sel.t0 : playheadRef.current);
        }
      }
      if (e.code === 'KeyL') { const n = !loopModeRef.current; loopModeRef.current = n; setLoopMode(n); }
      if (e.code === 'KeyF') { viewRef.current = { t0: 0, t1: DUR }; redraw(); }
      if (e.code === 'Home') { viewRef.current = { t0: 0, t1: Math.min(DUR, 20) }; redraw(); }
      if (e.code === editShortcutRef.current || e.key === editShortcutRef.current) {
        e.preventDefault();
        const n = !editModeRef.current; editModeRef.current = n; setEditMode(n);
        redraw();
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        popUndo();
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
  }, [stopPlay, startPlay, redraw, popUndo]);

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

  // ── Interaction ───────────────────────────────────────────────────────

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
        if (editModeRef.current) return; // edit mode handles its own mousedown
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
      // Tier canvases: wheel only (no seek — edit mode handles mousedown separately)
      addInteraction(wordsCanvasRef.current, false),
      addInteraction(phonesCanvasRef.current, false),
    ];
    return () => cleanups.forEach(c => c && c());
  }, [addInteraction]);

  // Minimap click/drag
  useEffect(() => {
    const cv = minimapCanvasRef.current;
    if (!cv) return;
    const pan = (x, rectWidth) => {
      const { t0, t1 } = viewRef.current;
      const span = t1 - t0, DUR = durationRef.current;
      const t = (Math.max(0, Math.min(rectWidth, x)) / rectWidth) * DUR;
      const newT0 = Math.max(0, Math.min(DUR - span, t - span/2));
      viewRef.current = { t0: newT0, t1: newT0 + span };
      redraw();
    };
    const onDown = (e) => {
      const rect = cv.getBoundingClientRect();
      pan(e.clientX - rect.left, rect.width);
      const onMove = (ev) => pan(ev.clientX - rect.left, rect.width);
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    cv.addEventListener('mousedown', onDown);
    return () => cv.removeEventListener('mousedown', onDown);
  }, [redraw]);

  // Token hover popup (only in select mode)
  const addHover = useCallback((canvas, isWord) => {
    if (!canvas) return () => {};
    const onMove = (e) => {
      if (editModeRef.current) { setPopup(null); return; }
      const rect = canvas.getBoundingClientRect();
      const t = xT(e.clientX - rect.left, rect.width);
      const items = isWord ? wordsRef.current : phonesRef.current;
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
    const c1 = addHover(wordsCanvasRef.current, true);
    const c2 = addHover(phonesCanvasRef.current, false);
    return () => { c1(); c2(); };
  }, [addHover]);

  // ── Edit mode interactions ─────────────────────────────────────────────
  // Returns hit info: { item, side: 'left'|'right'|'body'|null, isWord }
  const hitTest = useCallback((canvas, items, clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const t = xT(x, w);
    const EDGE_PX = 6; // px within which we detect edge hover
    const edgeT = (EDGE_PX / w) * (viewRef.current.t1 - viewRef.current.t0);

    const numRows = Math.max(1, ...items.map(it => (it.row ?? 0) + 1));
    const rowH = h / numRows;

    for (const item of items) {
      const row = item.row ?? 0;
      const ry = row * rowH;
      if (y < ry || y > ry + rowH) continue;
      if (t < item.t0 - edgeT || t > item.t1 + edgeT) continue;
      if (Math.abs(t - item.t0) < edgeT) return { item, side: 'left' };
      if (Math.abs(t - item.t1) < edgeT) return { item, side: 'right' };
      if (t >= item.t0 && t <= item.t1) return { item, side: 'body' };
    }
    return null;
  }, [xT]);

  const addTierEditInteraction = useCallback((canvas, itemsRef, isWord) => {
    if (!canvas) return () => {};

    const commitItems = (updated) => {
      itemsRef.current = updated;
      if (isWord) { wordsRef.current = updated; setWords([...updated]); }
      else        { phonesRef.current = updated; setPhones([...updated]); }
    };

    const onMouseMove = (e) => {
      if (!editModeRef.current) return;
      const items = itemsRef.current;
      const hit = hitTest(canvas, items, e.clientX, e.clientY);
      const prev = hoverEdgeRef.current;
      if (hit && (hit.side === 'left' || hit.side === 'right')) {
        canvas.style.cursor = 'ew-resize';
        if (!prev || prev.id !== hit.item.id || prev.side !== hit.side) {
          hoverEdgeRef.current = { id: hit.item.id, isWord, side: hit.side };
          drawTier(canvas, items, isWord);
        }
      } else if (hit && hit.side === 'body') {
        canvas.style.cursor = 'grab';
        if (prev) { hoverEdgeRef.current = null; drawTier(canvas, items, isWord); }
      } else {
        canvas.style.cursor = 'crosshair';
        if (prev) { hoverEdgeRef.current = null; drawTier(canvas, items, isWord); }
      }
    };

    const onMouseLeaveFixed = () => {
      canvas.style.cursor = '';
      if (hoverEdgeRef.current) { hoverEdgeRef.current = null; drawTier(canvas, itemsRef.current, isWord); }
    };

    const onMouseDown = (e) => {
      if (!editModeRef.current) {
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
        return;
      }

      e.preventDefault();

      const items = itemsRef.current;
      const rect = canvas.getBoundingClientRect();
      const hit = hitTest(canvas, items, e.clientX, e.clientY);
      const DUR = durationRef.current;

      if (!hit) {
        // Double-click on empty space: create new annotation
        if (e.detail === 2) {
          const t = xT(e.clientX - rect.left, rect.width);
          const span = (viewRef.current.t1 - viewRef.current.t0) * 0.05;
          const newItem = { id: nextId(), t0: Math.max(0, t - span), t1: Math.min(DUR, t + span), text: '', row: 0 };
          pushUndo();
          const updated = assignRows([...items, newItem]);
          commitItems(updated);
          const x0 = tX(newItem.t0, rect.width) + rect.left;
          const x1 = tX(newItem.t1, rect.width) + rect.left;
          setLabelEditor({ id: newItem.id, isWord, text: '', x: (x0 + x1) / 2, y: e.clientY, boxW: Math.max(80, x1 - x0) });
          redraw();
        }
        return;
      }

      const { item, side } = hit;

      if (e.detail === 2) {
        const x0 = tX(item.t0, rect.width) + rect.left;
        const x1 = tX(item.t1, rect.width) + rect.left;
        setLabelEditor({ id: item.id, isWord, text: item.text, x: (x0 + x1) / 2, y: e.clientY, boxW: Math.max(80, x1 - x0) });
        return;
      }

      if (e.button === 2) return;

      pushUndo();

      if (side === 'left' || side === 'right') {
        const startX = e.clientX;
        const startT = side === 'left' ? item.t0 : item.t1;
        const neighbour = items.find(it =>
          it.id !== item.id && it.row === item.row &&
          Math.abs((side === 'left' ? it.t1 : it.t0) - startT) < 1e-6
        );
        const minT = side === 'left'
          ? (neighbour ? neighbour.t0 + 0.01 : 0)
          : item.t0 + 0.01;
        const maxT = side === 'right'
          ? (neighbour ? neighbour.t1 - 0.01 : DUR)
          : item.t1 - 0.01;

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dt = (dx / rect.width) * (viewRef.current.t1 - viewRef.current.t0);
          const newT = Math.max(minT, Math.min(maxT, startT + dt));
          const updated = itemsRef.current.map(it => {
            if (it.id === item.id) return { ...it, [side === 'left' ? 't0' : 't1']: newT };
            if (neighbour && it.id === neighbour.id) return { ...it, [side === 'left' ? 't1' : 't0']: newT };
            return it;
          });
          commitItems(updated);
          drawTier(canvas, updated, isWord);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          canvas.style.cursor = 'ew-resize';
        };
        canvas.style.cursor = 'ew-resize';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);

      } else if (side === 'body') {
        const startX = e.clientX;
        const origT0 = item.t0, origT1 = item.t1;
        const width = origT1 - origT0;

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dt = (dx / rect.width) * (viewRef.current.t1 - viewRef.current.t0);
          const newT0 = Math.max(0, Math.min(DUR - width, origT0 + dt));
          const updated = itemsRef.current.map(it =>
            it.id === item.id ? { ...it, t0: newT0, t1: newT0 + width } : it
          );
          const withRows = assignRows(updated);
          commitItems(withRows);
          drawTier(canvas, withRows, isWord);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          canvas.style.cursor = 'grab';
        };
        canvas.style.cursor = 'grabbing';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }
    };

    const onContextMenu = (e) => {
      if (!editModeRef.current) return;
      e.preventDefault();
      const items = itemsRef.current;
      const hit = hitTest(canvas, items, e.clientX, e.clientY);
      if (!hit) return;
      const { item } = hit;

      const existing = document.getElementById('tier-ctx-menu');
      if (existing) existing.remove();

      const menu = document.createElement('div');
      menu.id = 'tier-ctx-menu';
      Object.assign(menu.style, {
        position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px',
        background: '#1e1e26', border: '1px solid #2e2e3a', borderRadius: '6px',
        padding: '4px 0', zIndex: 9999, minWidth: '160px', boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        fontFamily: 'Inter,system-ui,sans-serif', fontSize: '12px', color: '#c8c6c1',
      });

      const menuItem = (label, action) => {
        const el = document.createElement('div');
        el.textContent = label;
        Object.assign(el.style, { padding: '6px 14px', cursor: 'pointer' });
        el.addEventListener('mouseenter', () => { el.style.background = '#2e2e3a'; });
        el.addEventListener('mouseleave', () => { el.style.background = ''; });
        el.addEventListener('mousedown', (ev) => { ev.preventDefault(); menu.remove(); action(); });
        menu.appendChild(el);
      };

      menuItem('Rename…', () => {
        const rect = canvas.getBoundingClientRect();
        const x0 = tX(item.t0, rect.width) + rect.left;
        const x1 = tX(item.t1, rect.width) + rect.left;
        setLabelEditor({ id: item.id, isWord, text: item.text, x: (x0 + x1) / 2, y: e.clientY, boxW: Math.max(80, x1 - x0) });
      });

      menuItem('Merge with next', () => {
        const sorted = [...itemsRef.current].sort((a, b) => a.t0 - b.t0);
        const idx = sorted.findIndex(it => it.id === item.id);
        const next = sorted[idx + 1];
        if (!next) return;
        pushUndo();
        const merged = { ...item, t1: next.t1, text: item.text + ' ' + next.text };
        commitItems(assignRows(itemsRef.current.filter(it => it.id !== next.id).map(it => it.id === item.id ? merged : it)));
        redraw();
      });

      const sep = document.createElement('div');
      Object.assign(sep.style, { height: '1px', background: '#2e2e3a', margin: '4px 0' });
      menu.appendChild(sep);

      menuItem('Delete', () => {
        pushUndo();
        commitItems(assignRows(itemsRef.current.filter(it => it.id !== item.id)));
        redraw();
      });

      document.body.appendChild(menu);
      const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); } };
      document.addEventListener('mousedown', dismiss);
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeaveFixed);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('contextmenu', onContextMenu);

    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeaveFixed);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
  }, [hitTest, tX, xT, drawTier, redraw, pushUndo]);

  useEffect(() => {
    const c1 = addTierEditInteraction(wordsCanvasRef.current,  wordsRef,  true);
    const c2 = addTierEditInteraction(phonesCanvasRef.current, phonesRef, false);
    return () => { c1(); c2(); };
  }, [addTierEditInteraction, words, phones]);

  // Drag-and-drop files
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
    baseSpecCacheRef.current = { canvas: null };
    calcBaseSpec(buf);
  }, [calcBaseSpec]);

  const handleAudioFile = (e) => { if (e.target.files[0]) loadAudio(e.target.files[0]); };
  const handleTGFile    = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => loadTextGrid(ev.target.result);
    reader.readAsText(f);
  };

  // ── Label editor commit ───────────────────────────────────────────────
  const commitLabel = useCallback((newText) => {
    const ed = labelEditor;
    if (!ed) return;
    const itemsRef2 = ed.isWord ? wordsRef : phonesRef;
    const updated = itemsRef2.current.map(it => it.id === ed.id ? { ...it, text: newText } : it);
    itemsRef2.current = updated;
    if (ed.isWord) { wordsRef.current = updated; setWords([...updated]); }
    else           { phonesRef.current = updated; setPhones([...updated]); }
    setLabelEditor(null);
    redraw();
  }, [labelEditor, redraw]);

  // ── MFA alignment ─────────────────────────────────────────────────────────

  /**
   * Merge MFA phone intervals into the phoneme tier.
   *
   * Strategy:
   *   - Remove every existing phone that is fully contained within [segT0, segT1].
   *   - Clamp phones that partially overlap the segment boundary so they don't
   *     extend outside the segment (shouldn't happen after server validation,
   *     but belt-and-suspenders).
   *   - Filter out empty-label MFA silences unless they are the only interval.
   *   - Assign fresh ids and re-run assignRows.
   *
   * Returns the merged, row-assigned phone array.
   */
  const applyMfaResult = useCallback((mfaPhones, segT0, segT1) => {
    // ── Input assertions ────────────────────────────────────────────────────
    if (!Array.isArray(mfaPhones))
      throw new Error('applyMfaResult: mfaPhones must be an array');
    if (segT1 <= segT0)
      throw new Error(`applyMfaResult: invalid segment [${segT0}, ${segT1}]`);

    const DUR = durationRef.current;
    if (segT0 < 0 || segT1 > DUR + 1e-6)
      throw new Error(`applyMfaResult: segment [${segT0}, ${segT1}] outside file duration ${DUR}`);

    // Validate each phone coming in
    for (const ph of mfaPhones) {
      if (typeof ph.t0 !== 'number' || typeof ph.t1 !== 'number')
        throw new Error(`applyMfaResult: phone has non-numeric timestamps: ${JSON.stringify(ph)}`);
      if (ph.t1 - ph.t0 < -1e-6)
        throw new Error(`applyMfaResult: negative-duration phone [${ph.t0}, ${ph.t1}] '${ph.text}'`);
    }

    // ── Remove existing phones fully inside the segment ─────────────────────
    const kept = phonesRef.current.filter(p => {
      const fullyInside = p.t0 >= segT0 - 1e-6 && p.t1 <= segT1 + 1e-6;
      return !fullyInside;
    });

    // ── Build new phone items from MFA output ───────────────────────────────
    const newPhones = mfaPhones
      .filter(ph => ph.text && ph.text.trim() !== '')   // drop silence intervals
      .filter(ph => ph.t1 - ph.t0 > 1e-4)              // drop zero-duration
      .map(ph => ({
        id:   nextId(),
        t0:   Math.max(segT0, ph.t0),
        t1:   Math.min(segT1, ph.t1),
        text: ph.text.trim(),
        row:  0,
      }));

    if (newPhones.length === 0)
      throw new Error('MFA returned no non-silent phones for this segment — alignment may have failed');

    // ── Overlap guard: if any new phone overlaps a kept phone, warn ─────────
    for (const np of newPhones) {
      for (const kp of kept) {
        const overlaps = np.t0 < kp.t1 - 1e-6 && np.t1 > kp.t0 + 1e-6;
        if (overlaps) {
          // Clamp kept phone to not overlap with MFA result
          // (MFA result takes priority within the selected segment)
          console.warn(
            `MFA phone [${np.t0.toFixed(3)}, ${np.t1.toFixed(3)}] '${np.text}' ` +
            `overlaps existing phone [${kp.t0.toFixed(3)}, ${kp.t1.toFixed(3)}] '${kp.text}' — ` +
            `existing phone will be trimmed`
          );
        }
      }
    }

    // Trim kept phones that partially overlap the segment boundary
    const trimmed = kept.map(p => {
      if (p.t1 > segT0 && p.t0 < segT0) return { ...p, t1: segT0 };  // overlaps left edge
      if (p.t0 < segT1 && p.t1 > segT1) return { ...p, t0: segT1 };  // overlaps right edge
      return p;
    }).filter(p => p.t1 - p.t0 > 1e-4); // drop now-zero-width items

    const merged = assignRows([...trimmed, ...newPhones]);
    return merged;
  }, []);

  /**
   * Check the current selection, find overlapping words, and either:
   *   - Run MFA directly if exactly one non-overlapping word covers the selection, OR
   *   - Show a word-picker modal if multiple words overlap (user chooses which one).
   *
   * The selected segment is used as the audio region AND as the time bounds passed
   * to the server.  The word labels inside that segment become the transcript.
   */
  const runMfaForWords = useCallback(async (targetWords) => {
    const sel = selectionRef.current;
    if (!sel) { setMfaError('Make a selection first'); return; }
    if (!audioBufferRef.current) { setMfaError('No audio loaded'); return; }
    if (!targetWords || targetWords.length === 0) { setMfaError('No words in selection'); return; }

    setMfaRunning(true);
    setMfaError(null);

    try {
      const buf  = audioBufferRef.current;
      const sr   = buf.sampleRate;
      const segT0 = sel.t0;
      const segT1 = sel.t1;

      if (segT1 - segT0 < 0.05)
        throw new Error('Selection is too short (< 50 ms) to align');

      // Slice the channel data for this segment
      const startSample = Math.max(0, Math.floor(segT0 * sr));
      const endSample   = Math.min(buf.length, Math.ceil(segT1 * sr));
      const ch = buf.getChannelData(0).slice(startSample, endSample);

      if (ch.length === 0)
        throw new Error('No audio samples in the selected region');

      // Build transcript string from the target words (preserving order)
      const sorted = [...targetWords].sort((a, b) => a.t0 - b.t0);
      const transcript = sorted.map(w => w.text.trim()).filter(Boolean).join(' ');

      if (!transcript)
        throw new Error('Selected words have no text — cannot align empty transcript');

      // Health-check the server first so the error is clear
      let serverOk = false;
      try {
        const hResp = await fetch(`${MFA_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
        serverOk = hResp.ok;
      } catch(_) { /* fall through */ }

      if (!serverOk)
        throw new Error(
          `Cannot reach MFA server at ${MFA_SERVER}.\n` +
          `Start it with:\n  cd code && python mfa_server.py`
        );

      // Spin up the worker
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./mfaWorker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data: res }) => { worker.terminate(); resolve(res); };
        worker.onerror   = (err) => { worker.terminate(); reject(new Error(err.message)); };
        worker.postMessage(
          { ch, sr, t0: segT0, t1: segT1, words: transcript, serverUrl: MFA_SERVER },
          [ch.buffer]
        );
      });

      if (!result.ok)
        throw new Error(result.error);

      // Apply — this also validates
      pushUndo();
      const merged = applyMfaResult(result.phones, segT0, segT1);
      phonesRef.current = merged;
      setPhones([...merged]);
      redraw();

    } catch (err) {
      setMfaError(err.message || String(err));
    } finally {
      setMfaRunning(false);
    }
  }, [applyMfaResult, pushUndo, redraw]);

  /**
   * Entry point called by the "Run MFA" button.
   * Finds words overlapping the selection, handles the overlap case.
   */
  const handleRunMfa = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) { setMfaError('Make a time selection first, then click Run MFA'); return; }

    const overlapping = wordsRef.current.filter(
      w => w.text && w.text.trim() && w.t0 < sel.t1 - 1e-6 && w.t1 > sel.t0 + 1e-6
    );

    if (overlapping.length === 0) {
      setMfaError('No labeled words overlap the selection — add word annotations first');
      return;
    }

    // If there are overlapping rows (stacked words covering the same time), ask the user
    // which word they want to process. Otherwise, use all overlapping words directly.
    const hasOverlappingRows = overlapping.some((w, _, arr) =>
      arr.some(other => other.id !== w.id && other.t0 < w.t1 - 1e-6 && other.t1 > w.t0 + 1e-6)
    );

    if (hasOverlappingRows) {
      setMfaWordPicker({ words: overlapping, sel });
    } else {
      runMfaForWords(overlapping);
    }
  }, [runMfaForWords]);

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

      {setupError && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: '#0f0f11', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <div style={{ fontSize: 36 }}>📂</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#e8e6e1' }}>Setup required</div>
          {setupError.split('\n').map((line, i) => (
            <div key={i} style={{ fontSize: 13, color: '#9a9890', maxWidth: 480, textAlign: 'center' }}>{line}</div>
          ))}
          <div style={{
            marginTop: 8, padding: '10px 18px', borderRadius: 8,
            background: '#18181c', border: '1px solid #2a2a30',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#7aacf0',
          }}>
            annotation_tool/code/frontend-reactjs/public/
          </div>
        </div>
      )}

      {/* Floating label editor input */}
      {labelEditor && (
        <div style={{
          position: 'fixed',
          left: labelEditor.x - labelEditor.boxW / 2,
          top: labelEditor.y - 18,
          zIndex: 5000,
        }}>
          <input
            autoFocus
            defaultValue={labelEditor.text}
            style={{
              width: labelEditor.boxW,
              background: '#1e1e26', color: '#e8e6e1',
              border: '1.5px solid #3a7bd5', borderRadius: 4,
              padding: '3px 6px', fontSize: 13, fontFamily: 'Inter,sans-serif',
              outline: 'none', textAlign: 'center',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLabel(e.target.value);
              if (e.key === 'Escape') setLabelEditor(null);
            }}
            onBlur={(e) => commitLabel(e.target.value)}
          />
        </div>
      )}

      <div className="toolbar">
        <div className="logo">Annotation Viewer <span>Bluey · 280–350s</span></div>
        <div className="spacer" />
        <div className="transport">
          <button className={`btn${loopMode ? ' active' : ''}`} onClick={() => { const n = !loopModeRef.current; loopModeRef.current = n; setLoopMode(n); }} title="Loop selection (L)">
            ⟲ Loop
          </button>
          <button
            className={`btn btn-play${playing ? ' paused' : ''}`}
            onClick={() => {
              if (playing) {
                stopPlay();
              } else if (audioBufferRef.current) {
                const sel = selectionRef.current;
                startPlay(sel ? sel.t0 : playheadRef.current);
              } else {
                alert('Drop an audio file onto the page, or click Load audio.');
              }
            }}
          >{playing ? '⏸ Pause' : '▶ Play'}</button>
          <button className="btn" onClick={() => { stopPlay(); playheadRef.current = 0; updateTimeDisplay(); redraw(); }}>■</button>
          <div className="time-display" ref={timeDisplayRef}>
            {fmtTime(playheadRef.current)} / {fmtTime(duration)}
          </div>
          <select
            className="colormap-select"
            value={playbackRate}
            onChange={e => {
              const r = parseFloat(e.target.value);
              playbackRateRef.current = r;
              setPlaybackRate(r);
              if (playingRef.current) {
                const ph = playheadRef.current;
                stopPlay();
                startPlay(ph);
              }
            }}
            title="Playback speed"
          >
            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(r => (
              <option key={r} value={r}>Playback speed: {r}×</option>
            ))}
          </select>
        </div>
        <div className="zoom-row">
          <span className="zoom-label">ZOOM</span>
          <input type="range" min="0" max="100" value={zoomValue} onChange={e => handleZoom(+e.target.value)} title="Zoom level" />
        </div>
        <button
          className={`btn${editMode ? ' active' : ''}`}
          onClick={() => { const n = !editModeRef.current; editModeRef.current = n; setEditMode(n); redraw(); }}
          title={`Toggle edit mode (${editShortcut})`}
        >
          {editMode ? '✎ Editing' : '✎ Edit'}
        </button>
        {editingShortcut ? (
          <input
            autoFocus
            className="shortcut-input"
            placeholder="press a key…"
            readOnly
            onKeyDown={(e) => {
              e.preventDefault();
              // Ignore bare modifiers
              if (['Control','Alt','Shift','Meta'].includes(e.key)) return;
              const label = e.code.startsWith('Key') ? e.key.toUpperCase()
                : e.code.startsWith('Digit') ? e.key
                : e.key; // F1–F12, etc.
              editShortcutRef.current = e.code.startsWith('Key') ? e.code : e.key;
              setEditShortcut(label);
              setEditingShortcut(false);
            }}
            onBlur={() => setEditingShortcut(false)}
            title="Press any key to set as the edit mode shortcut"
          />
        ) : (
          <button
            className="btn"
            onClick={() => setEditingShortcut(true)}
            title="Click to change edit mode shortcut key"
            style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, minWidth: 36 }}
          >
            {editShortcut}
          </button>
        )}
        <button
          className={`btn${showDashboard ? ' active' : ''}`}
          onClick={() => setShowDashboard(v => !v)}
          title="Toggle confidence score distribution panel"
        >
          ◎ Scores
        </button>
        <button
          className={`btn btn-mfa${mfaRunning ? ' computing' : ''}`}
          onClick={handleRunMfa}
          disabled={mfaRunning}
          title="Run Montreal Forced Aligner on the current selection"
        >
          {mfaRunning ? '⟳ MFA…' : '⚙ Run MFA'}
        </button>
        <button className="btn" onClick={exportTextGrid} title="Export TextGrid">
          ↓ Export
        </button>
        <label className="load-btn">
          🎵 Load audio
          <input type="file" accept=".wav,.mp3,.flac,.m4a,.ogg" onChange={handleAudioFile} />
        </label>
        <label className="load-btn">
          📄 Load TextGrid
          <input type="file" accept=".TextGrid,.textgrid" onChange={handleTGFile} />
        </label>
        <select className="colormap-select" value={colormapName} onChange={e => handleColormapChange(e.target.value)} title="Spectrogram colormap">
          <option value="jet">Jet</option>
          <option value="inferno">Inferno</option>
          <option value="viridis">Viridis</option>
          <option value="greys">Greys</option>
        </select>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
      <div className="timeline" ref={timelineRef} style={{ flex: 1, minWidth: 0 }}>
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

      {/* Confidence dashboard side panel */}
      {showDashboard && <ConfidenceDashboard words={words} />}

      </div>{/* flex wrapper */}

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

      {/* ── MFA error banner ─────────────────────────────────────────────── */}
      {mfaError && (
        <div
          style={{
            position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
            background: '#2a1010', border: '1px solid #a03030', borderRadius: 8,
            padding: '10px 16px', zIndex: 8000, maxWidth: 560, minWidth: 280,
            fontFamily: 'Inter,system-ui,sans-serif', fontSize: 12, color: '#f08080',
            display: 'flex', alignItems: 'flex-start', gap: 10,
            boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
          }}
        >
          <span style={{ flexShrink: 0, fontSize: 16 }}>⚠</span>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1, fontSize: 11 }}>
            {mfaError}
          </pre>
          <button
            onClick={() => setMfaError(null)}
            style={{
              background: 'none', border: 'none', color: '#f08080', cursor: 'pointer',
              fontSize: 16, padding: '0 0 0 8px', flexShrink: 0, lineHeight: 1,
            }}
            title="Dismiss"
          >×</button>
        </div>
      )}

      {/* ── MFA word-picker modal (shown when words overlap in the selection) */}
      {mfaWordPicker && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9000,
            background: 'rgba(0,0,0,0.65)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setMfaWordPicker(null); }}
        >
          <div style={{
            background: '#1e1e26', border: '1px solid #2e2e3a', borderRadius: 10,
            padding: '20px 24px', minWidth: 340, maxWidth: 500,
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
            fontFamily: 'Inter,system-ui,sans-serif',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e8e6e1', marginBottom: 6 }}>
              Overlapping words in selection
            </div>
            <div style={{ fontSize: 11, color: '#6b6a65', marginBottom: 16, lineHeight: 1.5 }}>
              Multiple words overlap in this region. Select which word(s) to align with MFA,
              or click "All" to align them together.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {mfaWordPicker.words.map(w => (
                <button
                  key={w.id}
                  onClick={() => {
                    setMfaWordPicker(null);
                    runMfaForWords([w]);
                  }}
                  style={{
                    background: '#13131a', border: '1px solid #2e2e3a', borderRadius: 6,
                    padding: '8px 12px', color: '#c8c6c1', fontSize: 12,
                    fontFamily: 'Inter,system-ui,sans-serif', cursor: 'pointer',
                    textAlign: 'left', display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#2e2e3a'}
                  onMouseLeave={e => e.currentTarget.style.background = '#13131a'}
                >
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{w.text || '<empty>'}</span>
                  <span style={{
                    fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: '#6b6a65',
                  }}>
                    {w.t0.toFixed(3)}s – {w.t1.toFixed(3)}s
                  </span>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn"
                onClick={() => setMfaWordPicker(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-mfa"
                onClick={() => {
                  const words = mfaWordPicker.words;
                  setMfaWordPicker(null);
                  runMfaForWords(words);
                }}
              >
                Align all
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
