import React, { useRef, useEffect, useState, useCallback } from 'react';
import { parseTextGrid } from './parseTextGrid.js';
import { setupCanvas, fmtTime } from './canvasUtils.js';
import {
  COLORMAPS, inferno,
  buildMelSpectrogram, buildRmsEnvelope,
} from './dsp.js';


let _nextId = 1;
const nextId = () => _nextId++;

const getTierType = (tierId) =>
  tierId === 'phones' ? 'phone' : tierId === 'words' ? 'word' : 'custom';

// ── IPA virtual keyboard ──────────────────────────────────────────────────────

// Loaded once from public/ipa_keys.json — edit that file to change the keys.
// File is an object { symbol: "example with **bold**" } or legacy array.
let _ipaKeys = null;
async function loadIpaKeys() {
  if (_ipaKeys) return _ipaKeys;
  try {
    const res = await fetch('/ipa_keys.json');
    if (!res.ok) { _ipaKeys = {}; return _ipaKeys; }
    const data = await res.json();
    _ipaKeys = Array.isArray(data)
      ? Object.fromEntries(data.map(k => [k, null]))
      : data;
  } catch (_) { _ipaKeys = {}; }
  return _ipaKeys;
}

// Render "example with **bold**" as React spans
function IpaExample({ text }) {
  if (!text) return null;
  const parts = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<strong key={m.index} style={{ fontWeight: 700, color: '#e8e6e1' }}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function IpaKeyboard({ inputRef }) {
  const [keys, setKeys] = useState(_ipaKeys || {});
  const [tooltip, setTooltip] = useState(null); // { symbol, example, x, y }

  useEffect(() => {
    if (!_ipaKeys) loadIpaKeys().then(setKeys);
  }, []);

  const insert = (val) => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end   = el.selectionEnd   ?? el.value.length;
    const next  = el.value.slice(0, start) + val + el.value.slice(end);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    const pos = start + val.length;
    el.setSelectionRange(pos, pos);
  };

  const symbols = Object.keys(keys);
  if (!symbols.length) return null;

  return (
    <div
      onMouseDown={e => e.preventDefault()}
      style={{
        marginTop: 4, padding: '5px 6px',
        background: '#13131a', border: '1px solid #2a2a30', borderRadius: 6,
        display: 'flex', flexWrap: 'wrap', gap: 3, maxWidth: 320,
        position: 'relative',
      }}
    >
      {symbols.map(sym => (
        <button
          key={sym}
          onMouseDown={e => e.preventDefault()}
          onClick={() => insert(sym)}
          onMouseEnter={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            setTooltip({ symbol: sym, example: keys[sym], rect });
          }}
          onMouseLeave={() => setTooltip(null)}
          style={{
            padding: '2px 6px', borderRadius: 4, border: '1px solid #2e2e3a',
            background: '#1e1e26', color: '#c8c6c1', fontSize: 12,
            fontFamily: "'JetBrains Mono',monospace", cursor: 'pointer', lineHeight: 1.4,
          }}
        >
          {sym}
        </button>
      ))}
      {tooltip && (
        <IpaTooltip symbol={tooltip.symbol} example={tooltip.example} anchorRect={tooltip.rect} />
      )}
    </div>
  );
}

function IpaTooltip({ symbol, example, anchorRect }) {
  const ref = React.useRef(null);
  // Start offscreen so the element can be measured before becoming visible
  const [pos, setPos] = React.useState({ top: -9999, left: -9999, visible: false });

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const cx = anchorRect.left + anchorRect.width / 2;
    let left = cx - tw / 2;
    let top  = anchorRect.top - th - 8; // fixed positioning — no scrollY
    left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
    top  = Math.max(6, top);
    setPos({ top, left, visible: true });
  }, [anchorRect]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: pos.top, left: pos.left,
        opacity: pos.visible ? 1 : 0,
        background: '#1a1a24',
        border: '1px solid #3a3a4a',
        borderRadius: 7,
        padding: '6px 10px',
        pointerEvents: 'none',
        zIndex: 9999,
        minWidth: 80,
        boxShadow: '0 4px 16px rgba(0,0,0,0.55)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      }}
    >
      <span style={{
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 18, color: '#e8e6e1', lineHeight: 1.2,
      }}>
        /{symbol}/
      </span>
      {example && (
        <span style={{ fontSize: 11, color: '#9a9896', whiteSpace: 'nowrap' }}>
          as in "<IpaExample text={example} />"
        </span>
      )}
    </div>
  );
}

function LabelEditorPopover({ editor, onCommit, onClose }) {
  const inputRef = React.useRef(null);
  const wrapRef  = React.useRef(null);
  const isPhone  = editor.tierType === 'phone';

  // After mount, nudge upward if the popover overflows the viewport bottom
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
    }
    if (rect.right > window.innerWidth - 8) {
      el.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
    }
  }, [isPhone]);

  const left = editor.x - editor.boxW / 2;
  const top  = editor.y - 18;

  return (
    <div ref={wrapRef} style={{ position: 'fixed', left, top, zIndex: 5000 }}>
      <input
        autoFocus
        ref={inputRef}
        defaultValue={editor.text}
        style={{
          width: editor.boxW,
          background: '#1e1e26', color: '#e8e6e1',
          border: '1.5px solid #3a7bd5', borderRadius: 4,
          padding: '3px 6px', fontSize: 13, fontFamily: 'Inter,sans-serif',
          outline: 'none', textAlign: 'center',
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit(e.target.value);
          if (e.key === 'Escape') onClose();
        }}
        onBlur={(e) => {
          // delay so IPA key clicks register before blur fires
          setTimeout(() => {
            if (document.activeElement !== inputRef.current)
              onCommit(e.target.value);
          }, 150);
        }}
      />
      {isPhone && <IpaKeyboard inputRef={inputRef} />}
    </div>
  );
}

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

function serializeTextGrid(duration, wordItems, phoneItems, customTiers = [], praatCompat = false) {
  const tierData = [
    { name: 'words', items: wordItems },
    { name: 'phones', items: phoneItems },
    ...customTiers.map(t => ({ name: t.name, items: t.items })),
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
      const iv = { t0: it.t0, t1: it.t1, text: it.text };
      if (it.score != null) iv.score = it.score;
      intervals.push(iv);
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
      if (iv.score != null && !praatCompat) lines.push(`            score = ${iv.score}`);
    });
  });

  return lines.join('\n');
}


function ExportPopover({ defaultName, customTiers, onExport, onClose }) {
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState('full'); // 'praat' | 'full'
  const doExport = () => {
    const base = (name.trim() || defaultName).replace(/\.TextGrid$/i, '');
    if (mode === 'praat') onExport(`${base}_praat.TextGrid`, false);
    else                  onExport(`${base}.TextGrid`,       true);
  };
  const rowStyle = (active) => ({
    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px',
    borderRadius: 5, cursor: 'pointer',
    background: active ? '#1a1a24' : 'transparent',
    border: `1px solid ${active ? '#2e2e3a' : 'transparent'}`,
  });
  const base = (name.trim() || defaultName).replace(/\.TextGrid$/i, '');
  return (
    <div style={{
      position: 'absolute', top: '100%', right: 0, marginTop: 4,
      background: '#1e1e26', border: '1px solid #2e2e3a', borderRadius: 8,
      padding: '10px 12px', zIndex: 8000, boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      display: 'flex', flexDirection: 'column', gap: 8, minWidth: 280,
    }}>
      <div style={{ fontSize: 11, color: '#888', fontFamily: 'Inter,sans-serif' }}>Save as</div>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') doExport(); if (e.key === 'Escape') onClose(); }}
        style={{
          background: '#13131a', color: '#e8e6e1',
          border: '1px solid #2e2e3a', borderRadius: 4,
          padding: '5px 8px', fontSize: 12, fontFamily: "'JetBrains Mono',monospace", outline: 'none',
        }}
      />

      <div style={{ fontSize: 11, color: '#888', fontFamily: 'Inter,sans-serif', marginTop: 2 }}>Format</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={rowStyle(mode === 'praat')}>
          <input type="radio" name="export-mode" checked={mode === 'praat'} onChange={() => setMode('praat')}
            style={{ marginTop: 2, accentColor: '#3a7bd5', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12, color: '#e8e6e1', fontFamily: 'Inter,sans-serif', fontWeight: 500 }}>
              Praat compatible
            </div>
            <div style={{ fontSize: 10, color: '#6b6a65', fontFamily: 'Inter,sans-serif', marginTop: 1 }}>
              WRD + PHN only · <em>{base}_praat.TextGrid</em>
            </div>
          </div>
        </label>
        <label style={rowStyle(mode === 'full')}>
          <input type="radio" name="export-mode" checked={mode === 'full'} onChange={() => setMode('full')}
            style={{ marginTop: 2, accentColor: '#3a7bd5', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12, color: '#e8e6e1', fontFamily: 'Inter,sans-serif', fontWeight: 500 }}>
              Full export
            </div>
            <div style={{ fontSize: 10, color: '#6b6a65', fontFamily: 'Inter,sans-serif', marginTop: 1 }}>
              WRD + PHN{customTiers.length > 0 ? ` + ${customTiers.map(t => t.name).join(', ')}` : ''} · <em>{base}.TextGrid</em>
            </div>
          </div>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 2 }}>
        <button className="btn" onClick={onClose}
          style={{ padding: '4px 10px', fontSize: 12, background: 'transparent' }}>Cancel</button>
        <button className="btn" onClick={doExport}
          style={{ padding: '4px 10px', fontSize: 12 }}>↓ Download</button>
      </div>
    </div>
  );
}

function TierNamePopover({ onAdd, onClose }) {
  const [name, setName] = useState('');
  const doAdd = () => {
    const n = name.trim();
    if (!n) return;
    onAdd(n);
  };
  return (
    <div style={{
      position: 'absolute', top: '100%', right: 0, marginTop: 4,
      background: '#1e1e26', border: '1px solid #2e2e3a', borderRadius: 8,
      padding: '10px 12px', zIndex: 8000, boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      display: 'flex', gap: 6, alignItems: 'center', minWidth: 200,
    }}>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') onClose(); }}
        placeholder="Tier name…"
        style={{
          flex: 1, background: '#13131a', color: '#e8e6e1',
          border: '1px solid #2e2e3a', borderRadius: 4,
          padding: '4px 8px', fontSize: 12, fontFamily: 'Inter,sans-serif', outline: 'none',
        }}
      />
      <button
        className="btn"
        onClick={doAdd}
        style={{ padding: '4px 10px', fontSize: 12 }}
      >Add</button>
    </div>
  );
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
  const [audioFileName, setAudioFileName] = useState('');
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
  const [labelEditor, setLabelEditor]   = useState(null); // { id, tierId, tierType, text, x, y, boxW }
  const [editShortcut, setEditShortcut] = useState('F1');
  const [editingShortcut, setEditingShortcut] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [playbackRate, setPlaybackRate]   = useState(1);
  const [mfaQueue, setMfaQueue]           = useState([]);      // {id,label,t0,t1,status,error}
  const [mfaError, setMfaError]           = useState(null);   // string | null
  const [mfaWarning, setMfaWarning]       = useState(null);   // string | null
  const [mfaWordPicker, setMfaWordPicker] = useState(null);   // { words: WordItem[], sel } | null
  const [mfaQueueOpen, setMfaQueueOpen]   = useState(false);  // dropdown visible
  const [setupError, setSetupError]       = useState(null);   // string | null — shown before audio loads
  const [customTiers, setCustomTiers]     = useState([]);     // { id, name, visible, items }
  const [wordsVisible, setWordsVisible]   = useState(true);
  const [phonesVisible, setPhonesVisible] = useState(true);
  const [showTierManager, setShowTierManager] = useState(false);
  const [showExportPopover, setShowExportPopover] = useState(false);
  const MFA_SERVER = 'http://localhost:5050';
  const mfaQueueRef = useRef([]);
  const mfaProcessingRef = useRef(false);
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
  const customTiersRef   = useRef([]);
  const tgFileNameRef    = useRef('annotation');
  const customCanvasRefs = useRef({}); // keyed by tier id
  const customTierDivRefs = useRef({}); // keyed by tier id — the .tier div element
  const durationRef      = useRef(70);
  const colormapNameRef  = useRef('jet');
  const showFormantsRef  = useRef(false);
  const rmsEnvRef        = useRef(null);
  const formantTrackRef  = useRef(null);
  const editModeRef      = useRef(false);
  const undoStackRef     = useRef([]); // snapshots: { words, phones, customTiers }
  const hoverEdgeRef     = useRef(null); // { id, tierId, side: 'left'|'right' } for cursor feedback

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

  // ── Tier item commit (shared across edit interaction and commitLabel) ──
  const commitTierItems = useCallback((tierId, updated) => {
    if (tierId === 'words') {
      wordsRef.current = updated; setWords([...updated]);
    } else if (tierId === 'phones') {
      phonesRef.current = updated; setPhones([...updated]);
    } else {
      const ct = customTiersRef.current.map(t => t.id === tierId ? { ...t, items: updated } : t);
      customTiersRef.current = ct; setCustomTiers([...ct]);
    }
  }, []);

  // ── Undo ──────────────────────────────────────────────────────────────
  const pushUndo = useCallback(() => {
    undoStackRef.current.push({
      words:  wordsRef.current.map(it => ({ ...it })),
      phones: phonesRef.current.map(it => ({ ...it })),
      customTiers: customTiersRef.current.map(t => ({ ...t, items: t.items.map(i => ({ ...i })) })),
    });
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
  }, []);

  const popUndo = useCallback(() => {
    const snap = undoStackRef.current.pop();
    if (!snap) return;
    wordsRef.current  = snap.words;
    phonesRef.current = snap.phones;
    customTiersRef.current = snap.customTiers || [];
    setWords([...snap.words]);
    setPhones([...snap.phones]);
    setCustomTiers([...(snap.customTiers || [])]);
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
        const regionDur = ((ft.frames - 1) * ft.hop + (ft.frameSize ?? 1024)) / ft.sr;
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
    const fontSize    = Math.round(Math.max(11, Math.min(24, rowH * 0.45)));
    const font        = isWord ? `500 ${fontSize}px Inter,sans-serif` : `${Math.max(10, fontSize - 1)}px 'JetBrains Mono',monospace`;
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
        ctx.fillText(item.text, (x0 + x1) / 2, ry + rowH / 2 + fontSize * 0.35);
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
    for (const tier of customTiersRef.current) {
      const cv = customCanvasRefs.current[tier.id];
      if (cv) drawTier(cv, tier.items, false);
    }
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
    console.log('[startPlay] audioBuffer:', !!audioBufferRef.current, 'from:', from);
    if (!audioBufferRef.current) return;
    stopAudio();
    const ctx = getAudioCtx();
    console.log('[startPlay] ctx state:', ctx.state);
    const doStart = () => {
      console.log('[startPlay] doStart, ctx.state:', ctx.state);
      const src = ctx.createBufferSource();
      src.buffer = audioBufferRef.current;
      src.connect(ctx.destination);
      src.playbackRate.value = playbackRateRef.current;
      const sel = selectionRef.current;
      const to = sel ? sel.t1 : durationRef.current;
      console.log('[startPlay] src.start(0,', from, ',', to - from, ')');
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
      console.log('[startPlay] resuming suspended context...');
      ctx.resume().then(doStart).catch(err => console.error('AudioContext resume failed:', err));
    } else {
      doStart();
    }
  }, [stopAudio, tick, clearOverlay, redraw, updateTimeDisplay]);

  // ── Data loading ──────────────────────────────────────────────────────

  const loadAudio = useCallback(async (file) => {
    // Decode using a temporary AudioContext so we never create the real one
    // before a user gesture (which would leave it permanently suspended).
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await tmpCtx.decodeAudioData((await file.arrayBuffer()).slice(0));
    tmpCtx.close();

    // If replacing an existing file, stop playback and clear tiers/undo
    if (audioBufferRef.current) {
      stopAudio();
      wordsRef.current  = []; setWords([]);
      phonesRef.current = []; setPhones([]);
      undoStackRef.current = [];
      spectroRef.current = null;
      spectroCacheRef.current = { canvas: null };
      baseSpecCacheRef.current = { canvas: null };
      formantTrackRef.current = null;
    }

    audioBufferRef.current = buffer;
    durationRef.current = buffer.duration;
    setDuration(buffer.duration);
    viewRef.current = { t0: 0, t1: Math.min(buffer.duration, 20) };
    playheadRef.current = 0;

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
  }, [redraw, stopAudio]);

  const loadTextGrid = useCallback((text) => {
    const { duration: dur, tiers } = parseTextGrid(text);
    const tierLower = Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k.toLowerCase(), v]));
    const w = assignRows(withIds(tierLower['words'] || []));
    const p = assignRows(withIds(tierLower['phones'] || tierLower['phonemes'] || tierLower['phone'] || []));
    durationRef.current = dur; setDuration(dur);
    wordsRef.current = w;      setWords(w);
    phonesRef.current = p;     setPhones(p);

    // Load any extra tiers as custom tiers
    const builtinKeys = new Set(['words', 'phones', 'phonemes', 'phone']);
    const extraTiers = Object.entries(tiers)
      .filter(([k]) => !builtinKeys.has(k.toLowerCase()))
      .map(([name, items]) => ({
        id: nextId(),
        name,
        visible: true,
        items: assignRows(withIds(items || [])),
      }));
    customTiersRef.current = extraTiers;
    setCustomTiers([...extraTiers]);

    viewRef.current = { t0: 0, t1: Math.min(dur, 20) };
    redraw();
  }, [redraw]);

  // ── Export TextGrid ───────────────────────────────────────────────────
  const doExportTextGrid = useCallback((filename, includeCustom) => {
    const praatCompat = !includeCustom;
    const tiers = includeCustom ? customTiersRef.current : [];
    const text = serializeTextGrid(durationRef.current, wordsRef.current, phonesRef.current, tiers, praatCompat);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportPopover(false);
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
          tgFileNameRef.current = tgs[0].replace(/\.TextGrid$/i, '');
          const res = await fetch(`/${encodeURIComponent(tgs[0])}`);
          if (res.ok) loadTextGrid(await res.text());
        } catch(e) { console.warn('TextGrid load failed:', e); }
      }
      try {
        const res = await fetch(`/${encodeURIComponent(wavs[0])}`);
        if (!res.ok) throw new Error(res.statusText);
        await loadAudio(new File([await res.blob()], wavs[0], { type: 'audio/wav' }));
        setAudioFileName(wavs[0].replace(/\.[^.]+$/, ''));
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
  const addHover = useCallback((canvas, getItems) => {
    if (!canvas) return () => {};
    const onMove = (e) => {
      if (editModeRef.current) { setPopup(null); return; }
      const rect = canvas.getBoundingClientRect();
      const t = xT(e.clientX - rect.left, rect.width);
      const items = typeof getItems === 'function' ? getItems() : (getItems ? wordsRef.current : phonesRef.current);
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
    const c1 = addHover(wordsCanvasRef.current, () => wordsRef.current);
    const c2 = addHover(phonesCanvasRef.current, () => phonesRef.current);
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

  const addTierEditInteraction = useCallback((canvas, itemsRef, isWord, tierId) => {
    if (!canvas) return () => {};

    const commitItems = (updated) => {
      itemsRef.current = updated;
      commitTierItems(tierId, updated);
    };

    const onMouseMove = (e) => {
      if (!editModeRef.current) return;
      const items = itemsRef.current;
      const hit = hitTest(canvas, items, e.clientX, e.clientY);
      const prev = hoverEdgeRef.current;
      if (hit && (hit.side === 'left' || hit.side === 'right')) {
        canvas.style.cursor = 'ew-resize';
        if (!prev || prev.id !== hit.item.id || prev.side !== hit.side) {
          hoverEdgeRef.current = { id: hit.item.id, tierId, side: hit.side };
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
      if (e.button === 2) return;
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
          const tierType = getTierType(tierId);
          setLabelEditor({ id: newItem.id, tierId, tierType, text: '', x: (x0 + x1) / 2, y: e.clientY, boxW: Math.max(80, x1 - x0) });
          redraw();
        }
        return;
      }

      const { item, side } = hit;

      if (e.detail === 2) {
        const x0 = tX(item.t0, rect.width) + rect.left;
        const x1 = tX(item.t1, rect.width) + rect.left;
        setLabelEditor({ id: item.id, tierId, tierType: getTierType(tierId), text: item.text, x: (x0 + x1) / 2, y: e.clientY, boxW: Math.max(80, x1 - x0) });
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
        setLabelEditor({ id: item.id, tierId, tierType: getTierType(tierId), text: item.text, x: (x0 + x1) / 2, y: e.clientY, boxW: Math.max(80, x1 - x0) });
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
  }, [hitTest, tX, xT, drawTier, redraw, pushUndo, commitTierItems]);

  useEffect(() => {
    const c1 = addTierEditInteraction(wordsCanvasRef.current,  wordsRef,  true,  'words');
    const c2 = addTierEditInteraction(phonesCanvasRef.current, phonesRef, false, 'phones');
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
        tgFileNameRef.current = f.name.replace(/\.TextGrid$/i, '');
        const reader = new FileReader();
        reader.onload = (ev) => loadTextGrid(ev.target.result);
        reader.readAsText(f);
      } else {
        setAudioFileName(f.name.replace(/\.[^.]+$/, ''));
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

  // ── Custom tier canvas interactions ──────────────────────────────────
  useEffect(() => {
    const cleanups = [];
    for (const tier of customTiersRef.current) {
      const cv = customCanvasRefs.current[tier.id];
      if (!cv) continue;
      // Create a stable per-tier ref-like object
      const tierItemsRef = { current: tier.items };
      // Keep in sync: when customTiersRef changes, this ref stays fresh via closure
      Object.defineProperty(tierItemsRef, 'current', {
        get: () => {
          const t = customTiersRef.current.find(t => t.id === tier.id);
          return t ? t.items : [];
        },
        set: (v) => {
          const ct = customTiersRef.current.map(t => t.id === tier.id ? { ...t, items: v } : t);
          customTiersRef.current = ct;
          setCustomTiers([...ct]);
        },
        configurable: true,
      });
      const c1 = addInteraction(cv, false);
      const c2 = addHover(cv, () => {
        const t = customTiersRef.current.find(t => t.id === tier.id);
        return t ? t.items : [];
      });
      const c3 = addTierEditInteraction(cv, tierItemsRef, false, tier.id);
      cleanups.push(c1, c2, c3);
    }
    return () => cleanups.forEach(c => c && c());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addInteraction, addHover, addTierEditInteraction, customTiers]);

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
    tgFileNameRef.current = f.name.replace(/\.TextGrid$/i, '');
    const reader = new FileReader();
    reader.onload = (ev) => loadTextGrid(ev.target.result);
    reader.readAsText(f);
  };

  // ── Label editor commit ───────────────────────────────────────────────
  const commitLabel = useCallback((newText) => {
    const ed = labelEditor;
    if (!ed) return;
    const src = ed.tierId === 'words' ? wordsRef.current
              : ed.tierId === 'phones' ? phonesRef.current
              : (customTiersRef.current.find(t => t.id === ed.tierId)?.items ?? []);
    const updated = src.map(it => it.id === ed.id ? { ...it, text: newText } : it);
    commitTierItems(ed.tierId, updated);
    setLabelEditor(null);
    redraw();
  }, [labelEditor, commitTierItems, redraw]);

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
  const updateQueue = useCallback((updater) => {
    mfaQueueRef.current = updater(mfaQueueRef.current);
    setMfaQueue([...mfaQueueRef.current]);
  }, []);

  const processNextMfaJob = useCallback(async () => {
    if (mfaProcessingRef.current) return;
    const next = mfaQueueRef.current.find(j => j.status === 'pending');
    if (!next) return;
    mfaProcessingRef.current = true;

    updateQueue(q => q.map(j => j.id === next.id ? { ...j, status: 'running' } : j));

    try {
      const buf = audioBufferRef.current;
      if (!buf) throw new Error('No audio loaded');
      const sr = buf.sampleRate;
      const { segT0, segT1, targetWords } = next;

      if (segT1 - segT0 < 0.05) throw new Error('Selection too short (< 50 ms)');

      const startSample = Math.max(0, Math.floor(segT0 * sr));
      const endSample   = Math.min(buf.length, Math.ceil(segT1 * sr));
      const ch = buf.getChannelData(0).slice(startSample, endSample);
      if (ch.length === 0) throw new Error('No audio samples in region');

      const sorted = [...targetWords].sort((a, b) => a.t0 - b.t0);
      const transcript = sorted.map(w => w.text.trim()).filter(Boolean).join(' ');
      if (!transcript) throw new Error('Words have no text');

      let serverOk = false;
      try {
        const hResp = await fetch(`${MFA_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
        serverOk = hResp.ok;
      } catch(_) {}
      if (!serverOk) throw new Error(`MFA server not reachable at ${MFA_SERVER}\nRun: cd code && python mfa_server.py`);

      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./mfaWorker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data: res }) => { worker.terminate(); resolve(res); };
        worker.onerror   = (err) => { worker.terminate(); reject(new Error(err.message)); };
        worker.postMessage({ ch, sr, t0: segT0, t1: segT1, words: transcript, serverUrl: MFA_SERVER }, [ch.buffer]);
      });

      if (!result.ok) throw new Error(result.error);

      if (result.warning) setMfaWarning(result.warning);

      pushUndo();
      const merged = applyMfaResult(result.phones, segT0, segT1);
      phonesRef.current = merged;
      setPhones([...merged]);
      redraw();

      updateQueue(q => q.filter(j => j.id !== next.id));
    } catch (err) {
      const msg = err.message || String(err);
      updateQueue(q => q.map(j => j.id === next.id ? { ...j, status: 'error', error: msg } : j));
      setMfaError(msg);
    } finally {
      mfaProcessingRef.current = false;
      // process next pending job if any
      const remaining = mfaQueueRef.current.find(j => j.status === 'pending');
      if (remaining) processNextMfaJob();
    }
  }, [applyMfaResult, pushUndo, redraw, updateQueue]);

  const enqueueRunMfa = useCallback((targetWords, sel) => {
    const sorted = [...targetWords].sort((a, b) => a.t0 - b.t0);
    const label = sorted.map(w => w.text.trim()).filter(Boolean).join(' ');
    const pending = mfaQueueRef.current.filter(j => j.status === 'pending' || j.status === 'running');
    if (pending.length >= 4) {
      setMfaError('Queue full (max 4 jobs). Wait for one to finish.');
      return;
    }
    const job = {
      id: nextId(),
      label,
      segT0: sel.t0,
      segT1: sel.t1,
      targetWords,
      status: 'pending',
      error: null,
    };
    updateQueue(q => [...q, job]);
    setMfaQueueOpen(true);
    // kick off processing if nothing is running
    setTimeout(() => processNextMfaJob(), 0);
  }, [updateQueue, processNextMfaJob]);

  const runMfaForWords = useCallback((targetWords) => {
    const sel = selectionRef.current;
    if (!sel) { setMfaError('Make a selection first'); return; }
    if (!audioBufferRef.current) { setMfaError('No audio loaded'); return; }
    if (!targetWords || targetWords.length === 0) { setMfaError('No words in selection'); return; }
    enqueueRunMfa(targetWords, sel);
  }, [enqueueRunMfa]);

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
        <LabelEditorPopover
          editor={labelEditor}
          onCommit={commitLabel}
          onClose={() => setLabelEditor(null)}
        />
      )}

      <div className="toolbar">
        <div className="logo">Gwilliams-Praat Aligner{audioFileName && <span>{audioFileName}</span>}</div>
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
                alert('Place a .wav file in public/ and reload the page.');
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
        {/* ── MFA button + queue dropdown ───────────────────────────── */}
        {(() => {
          const running = mfaQueue.find(j => j.status === 'running');
          const pending = mfaQueue.filter(j => j.status === 'pending');
          const errors  = mfaQueue.filter(j => j.status === 'error');
          const busy    = !!running;
          const queueCount = pending.length + (running ? 1 : 0);
          const label = running
            ? `⟳ ${running.label} ${running.segT0.toFixed(1)}–${running.segT1.toFixed(1)}s`
            : '⚙ Run MFA';
          return (
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex' }}>
                <button
                  className={`btn btn-mfa${busy ? ' computing' : ''}`}
                  onClick={handleRunMfa}
                  title="Run MFA on current selection"
                  style={{ borderRadius: queueCount > 0 ? '6px 0 0 6px' : 6, borderRight: queueCount > 0 ? 'none' : undefined, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {label}
                </button>
                {queueCount > 0 && (
                  <button
                    className={`btn btn-mfa${busy ? ' computing' : ''}`}
                    onClick={() => setMfaQueueOpen(v => !v)}
                    title="Show MFA queue"
                    style={{ borderRadius: '0 6px 6px 0', padding: '5px 8px', borderLeft: '1px solid rgba(80,180,80,0.2)' }}
                  >
                    {queueCount}▾
                  </button>
                )}
              </div>
              {mfaQueueOpen && mfaQueue.length > 0 && (
                <div
                  style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 4,
                    background: '#18181c', border: '1px solid #2a2a30', borderRadius: 8,
                    minWidth: 260, zIndex: 8000, boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                    padding: '6px 0',
                  }}
                  onMouseLeave={() => setMfaQueueOpen(false)}
                >
                  {mfaQueue.map((job, i) => (
                    <div key={job.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 12px',
                      borderBottom: i < mfaQueue.length - 1 ? '1px solid #1e1e24' : 'none',
                    }}>
                      <span style={{ fontSize: 11, color: job.status === 'running' ? '#f0c070' : job.status === 'error' ? '#f08080' : '#6b6a65', flexShrink: 0 }}>
                        {job.status === 'running' ? '⟳' : job.status === 'error' ? '✕' : '○'}
                      </span>
                      <span style={{ flex: 1, fontSize: 11, color: '#c8c6c1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job.label}
                      </span>
                      <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: '#45454d', flexShrink: 0 }}>
                        {job.segT0.toFixed(1)}–{job.segT1.toFixed(1)}s
                      </span>
                      {(job.status === 'pending' || job.status === 'error') && (
                        <button
                          onClick={() => updateQueue(q => q.filter(j => j.id !== job.id))}
                          style={{ background: 'none', border: 'none', color: '#45454d', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1, flexShrink: 0 }}
                          title="Remove"
                        >×</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
        {/* ── Export button + filename popover ─────────────────────── */}
        <div style={{ position: 'relative' }}>
          <button
            className="btn"
            onClick={() => setShowExportPopover(v => !v)}
            title="Export TextGrid"
          >
            ↓ Export
          </button>
          {showExportPopover && (
            <ExportPopover
              defaultName={tgFileNameRef.current}
              customTiers={customTiers}
              onExport={doExportTextGrid}
              onClose={() => setShowExportPopover(false)}
            />
          )}
        </div>
        {/* ── Add Tier button + inline popover ─────────────────────── */}
        <div style={{ position: 'relative' }}>
          <button
            className="btn"
            onClick={() => setShowTierManager(v => !v)}
            title="Add a custom tier"
          >
            + Tier
          </button>
          {showTierManager && (
            <TierNamePopover
              onAdd={(name) => {
                const newTier = { id: nextId(), name, visible: true, items: [] };
                customTiersRef.current = [...customTiersRef.current, newTier];
                setCustomTiers([...customTiersRef.current]);
                setShowTierManager(false);
              }}
              onClose={() => setShowTierManager(false)}
            />
          )}
        </div>
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
          {/* ── Tier visibility bar — always visible ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '2px 8px', background: '#13131a',
            borderBottom: '1px solid #1e1e24', flexShrink: 0, height: 22,
          }}>
            <span style={{ fontSize: 9, color: '#45454d', fontFamily: "'JetBrains Mono',monospace", marginRight: 4 }}>SHOW</span>
            {[
              { label: 'WRD', visible: wordsVisible, toggle: v => setWordsVisible(v) },
              { label: 'PHN', visible: phonesVisible, toggle: v => setPhonesVisible(v) },
              ...customTiers.map(t => ({
                label: t.name.toUpperCase().slice(0, 4),
                visible: t.visible,
                toggle: v => {
                  const ct = customTiersRef.current.map(x => x.id === t.id ? { ...x, visible: v } : x);
                  customTiersRef.current = ct; setCustomTiers([...ct]);
                },
              })),
            ].map(({ label, visible, toggle }) => (
              <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  className="tier-visibility-check"
                  checked={visible}
                  onChange={e => toggle(e.target.checked)}
                />
                <span style={{ fontSize: 9, fontFamily: "'JetBrains Mono',monospace", color: visible ? '#c8c6c1' : '#45454d' }}>{label}</span>
              </label>
            ))}
          </div>

          <div className="tier" ref={wrdTierRef} style={wordsVisible ? {} : { display: 'none' }}>
            <div className="tier-gutter"><span>WRD</span></div>
            <canvas ref={wordsCanvasRef} />
          </div>
          <div
            className="tier-divider"
            {...makeDragDivider(
              (el) => el.parentElement,
              (ev, rect) => {
                const wrdH = wrdTierRef.current?.getBoundingClientRect().height ?? 0;
                const phnH = phnTierRef.current?.getBoundingClientRect().height ?? 0;
                const total = wrdH + phnH;
                if (total < 1) return;
                const wrdRect = wrdTierRef.current.getBoundingClientRect();
                const newWrdH = ev.clientY - wrdRect.top;
                const fraction = Math.max(0.1, Math.min(0.9, newWrdH / total));
                wrdTierRef.current.style.flex = String(fraction);
                phnTierRef.current.style.flex = String(1 - fraction);
              }
            )}
          />
          <div className="tier" ref={phnTierRef} style={phonesVisible ? {} : { display: 'none' }}>
            <div className="tier-gutter"><span>PHN</span></div>
            <canvas ref={phonesCanvasRef} />
          </div>
          {customTiers.map((tier, idx) => {
            // The tier immediately above this divider
            const aboveRef = idx === 0 ? phnTierRef : { current: customTierDivRefs.current[customTiers[idx - 1].id] };
            const belowId = tier.id;
            return (
              <React.Fragment key={tier.id}>
                <div
                  className="tier-divider"
                  {...makeDragDivider(
                    (el) => el.parentElement,
                    (ev) => {
                      const aboveEl = aboveRef.current;
                      const belowEl = customTierDivRefs.current[belowId];
                      if (!aboveEl || !belowEl) return;
                      const aboveRect = aboveEl.getBoundingClientRect();
                      const belowRect = belowEl.getBoundingClientRect();
                      const total = aboveRect.height + belowRect.height;
                      if (total < 1) return;
                      const newAboveH = ev.clientY - aboveRect.top;
                      const fraction = Math.max(0.1, Math.min(0.9, newAboveH / total));
                      aboveEl.style.flex = String(fraction);
                      belowEl.style.flex = String(1 - fraction);
                    }
                  )}
                />
                <div
                  className="tier"
                  ref={el => {
                    if (el) customTierDivRefs.current[tier.id] = el;
                    else delete customTierDivRefs.current[tier.id];
                  }}
                  style={tier.visible ? {} : { display: 'none' }}
                >
                  <div className="tier-gutter" style={{ flexDirection: 'column', gap: 2 }}>
                    <span style={{ maxWidth: 44, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9 }} title={tier.name}>
                      {tier.name.toUpperCase().slice(0, 4)}
                    </span>
                    <button
                      className="tier-delete-btn"
                      onClick={() => {
                        const ct = customTiersRef.current.filter(t => t.id !== tier.id);
                        customTiersRef.current = ct;
                        setCustomTiers([...ct]);
                      }}
                      title={`Delete tier "${tier.name}"`}
                    >×</button>
                  </div>
                  <canvas
                    ref={el => {
                      if (el) customCanvasRefs.current[tier.id] = el;
                      else delete customCanvasRefs.current[tier.id];
                    }}
                  />
                </div>
              </React.Fragment>
            );
          })}
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

      {/* ── MFA error toast ──────────────────────────────────────────────── */}
      {mfaError && (
        <div style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 8000,
          background: '#2a1010', border: '1px solid #a03030', borderRadius: 7,
          padding: '7px 10px 7px 12px', maxWidth: 380,
          fontFamily: 'Inter,system-ui,sans-serif', fontSize: 11, color: '#f08080',
          display: 'flex', alignItems: 'flex-start', gap: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          <span style={{ flexShrink: 0 }}>⚠</span>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
            {mfaError}
          </span>
          <button
            onClick={() => setMfaError(null)}
            style={{ background: 'none', border: 'none', color: '#f08080', cursor: 'pointer', fontSize: 14, padding: '0 0 0 4px', flexShrink: 0, lineHeight: 1, alignSelf: 'flex-start' }}
            title="Dismiss"
          >×</button>
        </div>
      )}

      {/* ── MFA OOV warning toast ────────────────────────────────────────── */}
      {mfaWarning && (
        <div style={{
          position: 'fixed', bottom: mfaError ? 72 : 16, right: 16, zIndex: 8000,
          background: '#221a08', border: '1px solid #a07020', borderRadius: 7,
          padding: '7px 10px 7px 12px', maxWidth: 380,
          fontFamily: 'Inter,system-ui,sans-serif', fontSize: 11, color: '#f0b840',
          display: 'flex', alignItems: 'flex-start', gap: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          <span style={{ flexShrink: 0 }}>⚠</span>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
            {mfaWarning}
          </span>
          <button
            onClick={() => setMfaWarning(null)}
            style={{ background: 'none', border: 'none', color: '#f0b840', cursor: 'pointer', fontSize: 14, padding: '0 0 0 4px', flexShrink: 0, lineHeight: 1, alignSelf: 'flex-start' }}
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
