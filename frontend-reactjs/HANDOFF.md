# Annotation Tool — Developer Handoff

A browser-based audio annotation viewer and editor for Praat TextGrid files. Built with React + Vite. No backend. All computation runs either on the main thread or in Web Workers.

---

## Quick Start

```bash
cd code/frontend-reactjs
npm install
npm run dev        # http://localhost:5173
npm run build      # production output → dist/
```

On startup the app auto-loads two bundled files from `public/`:
- `Bluey_blueyp1aud_region280-350s.wav` — demo audio
- `Bluey_blueyp1aud_region280–350s_original.TextGrid` — demo annotations

Drop your own `.wav`/`.mp3`/`.flac` or `.TextGrid` onto the page, or use the Load buttons.

---

## File Map

```
src/
  main.jsx            React entry point, mounts <App />
  App.jsx             Everything — all state, all canvas drawing, all interaction
  parseTextGrid.js    Praat TextGrid parser
  dsp.js              DSP helpers used on main thread (mel spec, RMS, LPC formants, colormaps)
  specWorker.js       Web Worker: mel spectrogram → RGBA pixels
  formantWorker.js    Web Worker: LPC formant tracking → F1/F2/F3 arrays
  canvasUtils.js      setupCanvas() (HiDPI), fmtTime()
  index.css           All styles
```

---

## Architecture

### State pattern: dual state + ref

Every hot-path value has **both** a `useState` and a `useRef`. The state drives React re-renders for the toolbar UI; the ref is read inside callbacks without stale-closure issues.

| State | Ref | Purpose |
|---|---|---|
| `words` | `wordsRef` | Word tier items |
| `phones` | `phonesRef` | Phoneme tier items |
| `duration` | `durationRef` | Audio duration in seconds |
| `editMode` | `editModeRef` | Edit vs select mode |
| `loopMode` | `loopModeRef` | Loop playback |
| `colormapName` | `colormapNameRef` | Spectrogram colormap |
| `showFormants` | `showFormantsRef` | Formant overlay toggle |
| `playbackRate` | `playbackRateRef` | Playback speed multiplier |
| `editShortcut` | `editShortcutRef` | Edit mode keyboard shortcut |

**Rule:** always update both together — `ref.current = n; setState(n)`.

### Canvas rendering

All visuals are drawn on `<canvas>` elements via the Canvas 2D API. There is no SVG or DOM-based rendering. Every canvas is managed by `setupCanvas()` which handles HiDPI scaling — always call it at the start of a draw function and use the returned `{ ctx, w, h }` (CSS pixels, not device pixels).

The draw functions:

| Function | Canvas | What it draws |
|---|---|---|
| `drawWave` | `waveCanvasRef` | Waveform (3 LOD modes: line, min/max bars, peak envelope) + RMS overlay |
| `drawSpec` | `specCanvasRef` | Blits a cached spectrogram strip + formant lines + frequency labels |
| `drawRuler` | `rulerCanvasRef` | Time axis with adaptive tick spacing |
| `drawTier` | `wordsCanvasRef` / `phonesCanvasRef` | Annotation tiles with multi-row stacking, confidence color coding |
| `drawMinimap` | `minimapCanvasRef` | Full-duration overview with confidence-colored word tiles + viewport box |
| `drawOverlay` | `overlayCanvasRef` | Playhead line drawn on a full-timeline overlay canvas during playback |

`redraw()` calls all five non-overlay draws. During playback the RAF loop calls `drawOverlay()` for the playhead, and `redraw()` only when the view scrolls.

### View coordinates

`viewRef.current = { t0, t1 }` defines the visible time window in seconds.

Two helpers convert between time and pixel space:
- `tX(t, w)` — time → x pixel (given canvas CSS width `w`)
- `xT(x, w)` — x pixel → time

---

## Data Model

### Annotation items

Each item in `wordsRef.current` / `phonesRef.current` is a plain object:

```js
{
  id: number,       // stable unique id (module-level counter, never reused)
  t0: number,       // start time in seconds
  t1: number,       // end time in seconds
  text: string,     // label
  row: number,      // stacking row (0 = top), assigned by assignRows()
  score?: number,   // confidence 0–1, present on word items parsed from Whisper TextGrid
}
```

`assignRows(items)` sorts by `t0` and greedily assigns rows with a 1ms tolerance for floating-point artifacts from TextGrid files. It mutates `item.row` in-place and returns the sorted array.

`withIds(items)` stamps items with stable ids on load (preserves existing ids on re-load).

### TextGrid parsing

`parseTextGrid(text)` returns `{ duration, tiers }` where `tiers` is an object keyed by tier name (original capitalisation). `loadTextGrid` normalises keys to lowercase before lookup, so `"Words"`, `"words"`, `"WORDS"` all work.

Supported non-standard field: `score = 0.6540` on word intervals (Whisper output format).

### TextGrid serialisation

`serializeTextGrid(duration, wordItems, phoneItems)` fills gaps between items with empty intervals so the output is a valid Praat TextGrid. Export via the ↓ Export button.

---

## Spectrogram System

Two-level cache:

| Cache | Ref | Coverage | Resolution |
|---|---|---|---|
| Base | `baseSpecCacheRef` | Full audio duration | Low-res (N_FFT=2048, hop=512) |
| Local | `spectroCacheRef` | Current view ± 1× padding | High-res (adaptive N_FFT) |

On audio load, `calcBaseSpec()` fires automatically and populates the base cache. The user clicks **⟳ Calc Spec** to compute a high-res strip for the current view via `calcSpecForView()`.

`drawSpec()` checks local cache first, falls back to base. Both are stored as offscreen `<canvas>` elements; drawing is a single `ctx.drawImage()` blit.

**Adaptive N_FFT** in `calcSpecForView` (smaller = sharper time resolution when zoomed in):

| Samples in view | N_FFT |
|---|---|
| < 4 000 | 128 |
| < 10 000 | 256 |
| < 30 000 | 512 |
| < 80 000 | 1 024 |
| ≥ 80 000 | 2 048 |

The strip computed is 3× the view width (1 view-width padding on each side) so normal panning doesn't immediately miss cache.

**Worker protocol** (`specWorker.js`):
- Input: `{ ch: Float32Array, sr, t0, t1, hop, N_FFT, pw, ph, colormapName, regionT0, id }`
- Output: `{ pixels: Uint8ClampedArray, pw, ph, stripT0, stripT1, regionT0, id }` — transferred zero-copy
- Result is rendered into an offscreen canvas by `pixelsToCanvas(res)` and stored in the cache.

---

## Formant Tracking

`calcFormantForView()` sends the current view's audio to `formantWorker.js` which runs LPC (order 12, 1024-sample frames, 256-sample hop) and returns F1/F2/F3 arrays. `drawSpec()` overlays these as coloured polylines when `showFormantsRef.current` is true.

**Worker protocol** (`formantWorker.js`):
- Input: `{ ch: Float32Array, sr, regionT0, id }`
- Output: `{ f1, f2, f3, frames, hop, sr, regionT0, id }` — f1/f2/f3 transferred zero-copy

---

## Playback

Web Audio API. `startPlay(from)`:
1. Calls `stopAudio()` to kill any existing source
2. Creates an `AudioBufferSourceNode`, sets `playbackRate.value`
3. `src.start(0, from, to - from)` — the duration argument is always source content time, never divided by rate (the browser handles rate internally)
4. RAF loop (`tick`) advances `playheadRef` by `(ctx.currentTime - startCtxTime) * playbackRate`
5. On `src.onended`, stops cleanly; loops if loop mode is on and a selection exists

**Playback rate**: 0.25×, 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2× via dropdown. Changing rate while playing restarts from current playhead.

**Selection**: drawn by `drawSelectionRect`. Pressing Play (button or Space) always starts from `sel.t0` when a selection exists — after a region finishes, re-pressing Play restarts from the region start.

---

## Edit Mode

Toggled by the **✎ Edit** button or the configurable keyboard shortcut (default F1). `editModeRef.current` is the authoritative source; `editMode` state drives the button label.

All editing is handled by `addTierEditInteraction(canvas, itemsRef, isWord)` which registers four event listeners on each tier canvas:

| Event | Behaviour |
|---|---|
| `mousemove` | Cursor feedback (ew-resize / grab / crosshair), yellow edge highlight |
| `mouseleave` | Reset cursor and hover state |
| `mousedown` | Seek/select (non-edit mode) or drag boundary / drag body / create item (edit mode) |
| `contextmenu` | Rename / Merge with next / Delete menu |

**Hit testing** (`hitTest`): checks each item's row band (y), then within 6px of `t0`/`t1` edges returns `side: 'left'|'right'`; otherwise interior returns `side: 'body'`.

**Committing edits**: the inner helper `commitItems(updated)` handles the three-way update:
```js
itemsRef.current = updated;
if (isWord) { wordsRef.current = updated; setWords([...updated]); }
else        { phonesRef.current = updated; setPhones([...updated]); }
```

**Undo**: `pushUndo()` snapshots both tiers (max 100). `popUndo()` restores. Ctrl/Cmd+Z fires `popUndo()` + `redraw()`.

**Double-click empty space** → creates a new tile centred on cursor, immediately opens label editor.  
**Double-click tile** → opens inline label editor (floating `<input>`).  
**Drag edge** → updates the dragged item plus any adjacent item sharing that exact edge (so adjacent tiles stay gapless).  
**Drag body** → moves the tile, re-runs `assignRows` to update stacking.

---

## Confidence Score Coloring

Word tiles and the minimap are colored by `item.score` using `scoreColor(score, alpha)` (module-level in `App.jsx`):

- 0.0 → red `rgb(255, 0, 50)`
- 0.5 → yellow `rgb(255, 200, 50)`
- 1.0 → green `rgb(0, 200, 50)`

Items without a score fall back to blue (words) or green (phonemes).

The **◎ Scores** button toggles `ConfidenceDashboard` — a 200px side panel showing: stat grid (mean/median/min/max), 10-bin histogram, color legend, and 5 lowest-confidence words.

---

## Interaction System

### Wheel / zoom / pan

`addInteraction(canvas, seekable)` registers a `wheel` handler on every canvas (waveform, spectrogram, both tiers). Ctrl+scroll zooms anchored to cursor; plain scroll pans. The zoom slider syncs via `spanToSlider` / `sliderToSpan` (logarithmic mapping).

Tier canvases pass `seekable: false` — their mousedown is handled exclusively by `addTierEditInteraction`.

### Minimap

Click or drag on the minimap to pan the view. `getBoundingClientRect` is cached in `onDown` and reused for the whole drag.

### Hover popup

`addHover(canvas, isWord)` shows a floating tooltip with token text, timestamps, and duration. It reads `wordsRef.current`/`phonesRef.current` live inside the handler (not a snapshot), so it never goes stale and does not need re-registration on annotation edits.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| L | Toggle loop |
| F | Fit full duration |
| Home | Reset to first 20s |
| F1 (configurable) | Toggle edit mode |
| Ctrl/Cmd+Z | Undo |
| Arrow Left/Right | Pan by 20% of view |

---

## Colormaps

Four options: **jet** (default), **inferno**, **viridis**, **greys**. Defined in both `dsp.js` (main thread, used only by `buildMelSpectrogram`) and `specWorker.js` (worker, used for all pixel rendering). Changing colormap recomputes the base spec via `calcBaseSpec`.

---

## Key Invariants and Non-Obvious Constraints

- **`setupCanvas` must be called at the start of every draw function.** It resets the transform. Never call `ctx.scale()` or `ctx.transform()` without also calling `ctx.setTransform()` to reset — transforms stack and corrupt all subsequent drawing.

- **`src.start(0, from, duration)` — the duration argument is source content time.** Do NOT divide it by `playbackRate`. The Web Audio API applies rate internally. Dividing would play a longer/shorter region than selected.

- **`assignRows` uses a 1ms tolerance (`end - 0.001`)** to handle floating-point TextGrid artifacts where adjacent items have `t0 == prev.t1` but fail exact equality.

- **Tier canvases do NOT register `addInteraction` with `seekable: true`.** They use `addInteraction(canvas, false)` for wheel only. Their mousedown is handled inside `addTierEditInteraction` (select mode branch for seek, edit mode branch for editing). This avoids two conflicting mousedown handlers.

- **`drawOverlay` does NOT call `drawMinimap`.** The minimap is repainted by `redraw()` on view-scroll ticks. `drawOverlay` only updates the thin playhead line on the overlay canvas (a separate DOM element).

- **The `useEffect([redraw])` dep array is intentionally `[redraw]` only**, not `[redraw, words, phones, duration]`. React state for words/phones/duration exists only to trigger toolbar re-renders. All draw functions read from refs. Adding state to the dep array causes double-draws on every edit drag.

- **`addHover` does not take an `items` parameter** — it takes `isWord: boolean` and reads the live ref inside the handler. This avoids listener re-registration on every annotation state change.

- **`commitItems(updated)` inside `addTierEditInteraction`** handles all three-way ref+state updates for that tier. Use it for every edit operation inside that function.

- **Tier name lookup is case-insensitive.** `loadTextGrid` lowercases all keys before lookup, so `"Words"`, `"words"`, `"WORDS"` all resolve correctly.

---

## Things That Do Not Exist Yet (Known Gaps)

- No cross-tier boundary snapping (phoneme edges to word edges)
- No waveform-level edit (only tier tiles)
- No multi-file batch processing
- `serializeTextGrid` does not preserve `score` fields on export (they are dropped)
- `buildMelSpectrogram` in `dsp.js` is called on load but its result (`spectroRef`) is only used as a presence check in `drawSpec` — the actual pixel rendering goes through the worker cache
