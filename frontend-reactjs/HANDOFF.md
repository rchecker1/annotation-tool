# Annotation Tool — Developer Handoff

A browser-based audio annotation viewer and editor for Praat TextGrid files. Built with React + Vite. No backend except an optional MFA Flask server (`mfa_server.py`) on port 5050. All computation runs on the main thread or in Web Workers.

---

## Quick Start

```bash
# One-time setup (from code/ directory)
bash setup.sh

# Then start the annotation tool
cd code/frontend-reactjs
npm run dev        # http://localhost:5173
npm run build      # production output → dist/
```

`setup.sh` creates three conda environments (`aligner`, `whisperx`, `nemo`), downloads the MFA English US ARPAbet models, and installs frontend Node dependencies.

On startup the app scans `public/` via a Vite dev-server middleware (`/api/public-files`) and auto-loads the first `.wav` + `.TextGrid` pair it finds. Drop your own files onto the page, or use the Load buttons in the toolbar.

Place files in `public/` — the app enforces exactly one `.wav` and one `.TextGrid` at startup and warns if the folder is empty or mismatched.

IPA key layout is read from `public/ipa_keys.json` — a JSON object mapping IPA symbol strings to example-word strings (with `**bold**` markup for the key sound). Edit that file to add/remove keys from the virtual keyboard.

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
  mfaWorker.js        Web Worker: encodes WAV + POSTs to MFA server + returns phones/words
  canvasUtils.js      setupCanvas() (HiDPI), fmtTime()
  index.css           All styles (uses CSS custom properties — see :root block at top)

public/
  *.wav               Audio file (exactly one expected)
  *.TextGrid          Annotation file (exactly one expected)
  ipa_keys.json       IPA virtual keyboard keys: { "symbol": "example with **bold**" }
```

---

## Architecture

### State pattern: dual state + ref

Every hot-path value has **both** a `useState` and a `useRef`. The state drives React re-renders for the toolbar UI; the ref is read inside callbacks without stale-closure issues.

| State | Ref | Purpose |
|---|---|---|
| `words` | `wordsRef` | Word tier items |
| `phones` | `phonesRef` | Phoneme tier items |
| `customTiers` | `customTiersRef` | User-created custom tiers (array of `{id, name, visible, items}`) |
| `duration` | `durationRef` | Audio duration in seconds |
| `editMode` | `editModeRef` | Edit vs select mode |
| `loopMode` | `loopModeRef` | Loop playback |
| `colormapName` | `colormapNameRef` | Spectrogram colormap |
| `showFormants` | `showFormantsRef` | Formant overlay toggle |
| `playbackRate` | `playbackRateRef` | Playback speed multiplier |
| `editShortcut` | `editShortcutRef` | Edit mode keyboard shortcut (default `1`) |

**Rule:** always update both together — `ref.current = n; setState(n)`.

### Canvas rendering

All visuals are drawn on `<canvas>` elements via the Canvas 2D API. There is no SVG or DOM-based rendering. Every canvas is managed by `setupCanvas()` which handles HiDPI scaling — always call it at the start of a draw function and use the returned `{ ctx, w, h }` (CSS pixels, not device pixels).

| Function | Canvas | What it draws |
|---|---|---|
| `drawWave` | `waveCanvasRef` | Waveform (3 LOD modes) + RMS overlay |
| `drawSpec` | `specCanvasRef` | Blits cached spectrogram strip + formant lines + frequency labels |
| `drawRuler` | `rulerCanvasRef` | Time axis with adaptive tick spacing |
| `drawTier` | `wordsCanvasRef` / `phonesCanvasRef` / custom canvas refs | Annotation tiles with multi-row stacking, confidence color coding, selection highlight |
| `drawMinimap` | `minimapCanvasRef` | Full-duration overview with viewport box |
| `drawOverlay` | `overlayCanvasRef` | Playhead line only (separate overlay canvas) |

`redraw()` calls all draws except the overlay. During playback, the RAF loop calls `drawOverlay()` and only calls `redraw()` when the view scrolls.

**Important:** whenever selection changes (tile selected/deselected), always call `redraw()` — not `drawTier(canvas, ...)`. Calling only `drawTier` on the clicked canvas leaves stale highlights on other tier canvases.

### View coordinates

`viewRef.current = { t0, t1 }` — visible time window in seconds.

- `tX(t, w)` — time → x pixel
- `xT(x, w)` — x pixel → time

---

## Data Model

### Annotation items

Each item in any tier's items array is a plain object:

```js
{
  id: number,       // stable unique id (module-level counter, never reused)
  t0: number,       // start time in seconds
  t1: number,       // end time in seconds
  text: string,     // label
  row: number,      // stacking row (0 = top), assigned by assignRows()
  score?: number,   // confidence 0–1, present on word items from Whisper TextGrid
}
```

`assignRows(items)` sorts by `t0` and greedily assigns rows with a 1ms tolerance.

### Custom tiers

Stored in `customTiersRef.current` as:

```js
{
  id: string,       // unique tier id (e.g. 't_1716000000000')
  name: string,     // display name (user-provided)
  visible: boolean, // whether the tier div is shown
  items: [...],     // same item shape as words/phones
}
```

Custom tiers are read from TextGrid on load (any tier that isn't `words`/`phones`), and written back on export.

Canvas refs for custom tiers: `customCanvasRefs.current[tierId]`  
DOM div refs for custom tiers: `customTierDivRefs.current[tierId]`

### Shared helpers

```js
// Module-level (top of App.jsx)
const getTierType = (tierId) =>
  tierId === 'phones' ? 'phone' : tierId === 'words' ? 'word' : 'custom';

// Inside App component (useCallback)
const commitTierItems = useCallback((tierId, updated) => {
  if (tierId === 'words') {
    wordsRef.current = updated; setWords([...updated]);
  } else if (tierId === 'phones') {
    phonesRef.current = updated; setPhones([...updated]);
  } else {
    const ct = customTiersRef.current.map(t =>
      t.id === tierId ? { ...t, items: updated } : t
    );
    customTiersRef.current = ct; setCustomTiers([...ct]);
  }
}, []);
```

Use `commitTierItems` for every tier write operation — it handles all three cases uniformly.

### TextGrid parsing and serialisation

`parseTextGrid(text)` returns `{ duration, tiers }`. `loadTextGrid` lowercases keys before lookup, so `"Words"` / `"words"` / `"WORDS"` all work. Any tier that isn't `words` or `phones` becomes a custom tier.

`serializeTextGrid(duration, wordItems, phoneItems, customTiers)` fills gaps with empty intervals for valid Praat output. Used by both the ↓ Export button and the Ctrl/Cmd+S save-to-disk path.

---

## Tier Visibility

There is an always-visible bar at the top of the `.tiers` section with checkboxes for WRD, PHN, and each custom tier. The tier div itself is `display: none` when hidden — the checkbox stays visible because it lives in the bar above the tier divs, not inside them.

`wordsVisible` / `phonesVisible` state controls the WRD/PHN divs. Each custom tier has a `visible` field on its object.

---

## Tier Resize Dividers

`makeDragDivider(getContainer, onMove)` attaches `mousedown`/`mousemove`/`mouseup` to a divider element and calls `onMove(ev)` on each drag tick.

**WRD/PHN divider** measures actual `getBoundingClientRect()` heights of `wrdTierRef` and `phnTierRef` to compute the fraction — do not use the parent container rect, as the visibility bar above the tiers throws off the math.

**Custom tier dividers** are wired in the `useEffect([customTiers])` — each divider measures the tier above (`phnTierRef` for the first, or the previous custom tier's div ref) and the tier below.

---

## Tile Rendering — Font Scaling

`drawTier` scales annotation text with tier height so tiles remain readable at any zoom level:

```js
const fontSize = Math.round(Math.max(11, Math.min(24, rowH * 0.45)));
const font = isWord
  ? `500 ${fontSize}px Inter,sans-serif`
  : `${Math.max(10, fontSize - 1)}px 'JetBrains Mono',monospace`;
// text baseline:
ctx.fillText(item.text, (x0 + x1) / 2, ry + rowH / 2 + fontSize * 0.35);
```

Word tiles use a slightly heavier weight (`500`); phoneme tiles use a monospace font one pixel smaller for density.

---

## Edit Mode

Toggled by the **split Edit button** in the toolbar or the configurable keyboard shortcut (default `1`).

### Split Edit Button

The Edit button is a single unified control split into two clickable zones:

```
┌─────────────────┬──────┐
│   ✎ Edit        │  1   │
└─────────────────┴──────┘
        ↑ toggles       ↑ click to rebind
      edit mode         shortcut
```

- **Left half** (`.btn-edit-split__main`) — toggles edit mode
- **Divider** — 1px separator
- **Right half** (`.btn-edit-split__badge`) — shows current hotkey; click to enter shortcut-capture mode
- **Capture input** (`.btn-edit-split__capture`) — replaces the badge while waiting for a keypress; `onBlur` cancels
- When active, the entire button inverts (`.btn-edit-split.active`)

Default shortcut is `1`. The keyboard handler matches against `e.code`, `e.key`, and numpad aliases (so numpad `1` also fires edit mode regardless of NumLock state).

### Waveform interaction in edit mode

The waveform canvas uses `addInteraction(canvas, seekable=true)` for scroll/zoom/seek. Previously its `onDown` handler had an early return when edit mode was active, which prevented the user from dragging a loop selection region on the waveform while in edit mode.

That guard has been removed. The waveform's `onDown` now runs in both modes. If the user clicks/drags on the waveform while in edit mode, it creates or updates the loop selection region (same as non-edit mode). Tile editing is handled by `addTierEditInteraction` on the separate tier canvases, so there is no conflict.

```js
// addInteraction — onDown (waveform):
onDown = (e) => {
  // No early-return for editModeRef.current — waveform drag works in edit mode too.
  const rect = canvas.getBoundingClientRect();
  ...
```

The tier canvases in edit mode (`addTierEditInteraction`) also support dragging on empty space to set a loop selection region, mirroring the same behaviour.

### Edit interactions

`addTierEditInteraction(canvas, itemsRef, isWord, tierId)` registers listeners on each tier canvas:

| Event | Behaviour |
|---|---|
| `mousemove` | Cursor feedback, yellow edge highlight |
| `mouseleave` | Reset cursor and hover state |
| `mousedown` | `if (e.button === 2) return` first — then seek/select (non-edit) or drag/select (edit) |
| `contextmenu` | Rename / Merge with next / Delete |

**Committing edits**: use `commitTierItems(tierId, updated)` inside this function.

**Undo**: `pushUndo()` snapshots words + phones + customTiers (max 100). Ctrl/Cmd+Z fires `popUndo()` + `redraw()`.

**Double-click empty** → creates tile, opens label editor.  
**Double-click tile** → opens inline label editor.  
**Drag edge** → updates item + any adjacent item sharing that exact edge.  
**Drag body** → moves tile (single or group), re-runs `assignRows`.

### Edit mode hint bar

A 24px bar appears between the tiers and the minimap **only when edit mode is on**, showing all available shortcuts as `<kbd>` chips:

```
Click select  |  ⌫ delete  |  dbl-click rename  |  right-click more…
```

CSS classes: `.edit-hint-bar`, `.edit-hint-bar__item`, `.edit-hint-bar__sep`.

---

## Tile Selection & Multi-Select

### Selection state

```js
const selectedTilesRef = useRef(new Map()); // id → { id, tierId }
const [selectedTileIds, setSelectedTileIds] = useState(new Set()); // drives rerender
const [selectedTierIds, setSelectedTierIds] = useState(new Set()); // drives tier border
```

Two helpers keep the ref and state in sync:

```js
syncSelectionState() // ref → setState for both sets
clearSelection()     // clears ref + both states
```

**Always call `redraw()` after any selection change** — not just `drawTier(canvas, ...)` — so all tier canvases update simultaneously.

### Selection behaviour

| Action | Result |
|---|---|
| **Plain click** a tile (not in a group) | Selects just that tile immediately |
| **Ctrl/Cmd+click** a tile | Toggles it into/out of the multi-selection; no drag starts |
| **Plain click** a tile in a multi-selection | Keeps group, starts group drag |
| **Plain click + no drag** on grouped tile | Collapses to single selection on mouseup (detected via `didDrag` flag) |
| **Plain click** empty space | Clears entire selection |
| **Leave edit mode** | Clears entire selection |

### Visual feedback

- Selected tiles draw with a brighter fill + coloured stroke at 2px:
  - Words: `#7aacf0` (blue)
  - Phones / custom: `#60e8a0` (green)
- The `.tier` div for any tier containing a selected tile gets an `outline`:
  - Words: `rgba(58,123,213,0.7)`
  - Phones / custom: `rgba(60,200,130,0.7)`
  - Multiple tier borders can show at once for cross-tier selection

### Group drag

When dragging a tile that is part of a multi-selection (≥2 tiles):

1. Snapshots all selected tiles' `origT0/origT1` grouped by tier at drag start
2. Computes `minDt` / `maxDt` clamps so no tile crosses `0` or `duration`
3. On each `mousemove`, applies the same `dt` to all selected tiles across all tiers
4. Each affected tier canvas is redrawn independently during the drag
5. On `mouseup` without drag (`didDrag === false`): collapses selection to just the clicked tile

Edge dragging is always single-tile only.

### Keyboard operations in edit mode

| Key | Action |
|---|---|
| `⌫` / `Delete` | Delete all selected tiles across all tiers (undoable) |

---

## Save to Disk (Ctrl/Cmd+S)

**Dev only** — requires the Vite dev server (`npm run dev`).

`Ctrl/Cmd+S` serializes the full current state (WRD + PHN + all custom tiers, with scores) and POSTs it to `/api/save-textgrid`, which the Vite dev server middleware writes directly to `public/<filename>.TextGrid`, overwriting the loaded file.

### Vite middleware (`vite.config.js`)

```js
server.middlewares.use('/api/save-textgrid', (req, res) => {
  // POST body: { filename: string, content: string }
  // Safety: only .TextGrid filenames are accepted; path.basename() strips any traversal
  fs.writeFileSync(dest, content, 'utf8');
  res.end(JSON.stringify({ ok: true, saved: safe }));
});
```

### Frontend (`saveTextGrid` callback)

```js
const saveTextGrid = useCallback(async () => {
  const filename = tgFileNameRef.current + '.TextGrid';
  const content  = serializeTextGrid(duration, words, phones, customTiers);
  setSaveState('saving');
  const res = await fetch('/api/save-textgrid', { method: 'POST', body: JSON.stringify({ filename, content }) });
  setSaveState(json.ok ? 'saved' : 'error');
  // auto-clears after 2s
}, []);
```

### Save indicator

Appears inline in the logo bar:
- `⟳ Saving…` — blue, request in flight
- `✓ Saved` — green, fades after 2s
- `✕ Save failed` — red, fades after 2s

CSS classes: `.save-indicator`, `.save-indicator--saving`, `.save-indicator--saved`, `.save-indicator--error`.

**Note:** this endpoint does not exist in a production build. The ↓ Export button (browser download) works in both dev and production.

---

## IPA Virtual Keyboard

### Data format

`public/ipa_keys.json` is a JSON **object** (not an array) mapping each IPA symbol to an example word string:

```json
{
  "p": "**p**at",
  "b": "**b**at",
  "θ": "**th**igh",
  "ʃ": "**sh**ip",
  "tʃ": "**ch**oke",
  "i": "sh**ee**p",
  "oʊ": "b**oa**t",
  "spn": "spn"
}
```

`**…**` markup renders bold in the tooltip. JSON must have no trailing comma after the last entry (strict parser).

### Components

**`IpaExample({ text })`** — inline component that parses `**bold**` markdown into `<strong>` spans. Used inside the tooltip.

**`IpaTooltip({ symbol, example, anchorRect })`** — `position: fixed` tooltip that:
- Initialises off-screen at `{ top: -9999, left: -9999, visible: false }` to avoid a top-left flash before measurement.
- Uses `React.useLayoutEffect` to measure its own bounding rect, then positions itself above the key, clamped to viewport edges.
- Does **not** add `window.scrollY` — fixed positioning is relative to the viewport, not the document.
- Shows `/{symbol}/` on one line and `as in "<IpaExample />"` on the next.

**`IpaKeyboard({ inputRef })`** — renders one button per key:
- Fetches `/ipa_keys.json` on first render.
- `onMouseDown: e.preventDefault()` prevents the label editor input from blurring.
- Inserts at cursor using the native input setter trick (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(...)`).
- Only shown when `labelEditor.tierType === 'phone'` (i.e. the PHN tier).
- Shows `IpaTooltip` on hover, passing `anchorRect` from the hovered button's `getBoundingClientRect()`.

**`LabelEditorPopover({ editor, onCommit, onClose })`** — extracted component (was an inline IIFE previously). Owns `inputRef` and `wrapRef` as `React.useRef(null)`:
- This is critical: the old inline IIFE created a plain `{ current: null }` object literal on every render, which is not a stable React ref. The IPA keyboard could not insert text reliably. Extracting to a component with `React.useRef` fixed this.
- Uses `React.useLayoutEffect` to nudge itself upward if it overflows the viewport bottom.
- Renders `<IpaKeyboard inputRef={inputRef} />` when `editor.tierType === 'phone'`.
- The `onBlur` handler has a 150ms delay to allow IPA key click to fire first.

To change the key set: edit `public/ipa_keys.json`.

---

## MFA Queue System

MFA (Montreal Forced Aligner) runs via `mfa_server.py` on `http://localhost:5050`. The frontend communicates through `mfaWorker.js` (Web Worker).

### State

```js
const [mfaQueue, setMfaQueue] = useState([]);  // {id,label,segT0,segT1,targetWords,status,error}
const mfaQueueRef = useRef([]);
const mfaProcessingRef = useRef(false);
const [mfaWarning, setMfaWarning] = useState(null);  // OOV substitution warning string
```

- Max 4 items in queue (pending + running combined). Attempting to add a 5th shows an error toast.
- `enqueueRunMfa(targetWords, sel)` adds a job and calls `processNextMfaJob()`.
- `processNextMfaJob()` picks the next `'pending'` job, marks it `'running'`, runs it, then recursively calls itself.
- The MFA button label shows `⟳ <word> <t0>–<t1>s` when a job is active. A badge shows queue depth with a dropdown listing all pending/running/errored jobs.
- Errors appear as a red fixed pill (bottom-right, max 380px wide).
- OOV substitution warnings appear as an **orange** fixed pill above the error pill:
  ```js
  background: '#221a08', border: '1px solid #a07020', color: '#f0b840'
  ```

### mfaWorker.js

Encodes a `Float32Array` to a 16-bit PCM WAV blob (no external lib), POSTs to `/align`, and passes the result back including the optional `warning` field:

```js
self.postMessage({
  ok: true, phones: json.phones, words: json.words,
  t0: json.t0, t1: json.t1,
  warning: json.warning || null
});
```

---

## MFA Server (`mfa_server.py`)

### Model and dictionary

Uses `english_us_arpa` acoustic model and dictionary (~200 000 words). Configured via environment variables:

```bash
MFA_ACOUSTIC_MODEL=english_us_arpa  # default
MFA_DICTIONARY=english_us_arpa      # default

# Override for other languages:
MFA_ACOUSTIC_MODEL=french_mfa MFA_DICTIONARY=french_mfa python mfa_server.py
```

### Persistent aligner (key performance detail)

The aligner is loaded **once at startup** (~16 s) and reused for every request (~1–4 s per alignment). Do **not** use subprocess (`mfa align …`) — that cold-starts the full FST every call (~60 s).

### ARPAbet → IPA conversion

MFA outputs ARPAbet phones (e.g. `AH0`, `SH`, `T`). The server converts them to IPA before returning. Stress digits (`0`, `1`, `2`) are stripped before lookup in `_ARPABET_TO_IPA`.

### Silence filtering

`sil`, `sp`, and `spn` phones are stripped from the output before the response is built.

### OOV word substitution

Words not in the dictionary are automatically substituted with the nearest Levenshtein match (length-filtered for speed). A `warning` field is included in the response and shown as an orange toast in the UI.

---

## Spectrogram System

Two-level cache:

| Cache | Ref | Coverage | Resolution |
|---|---|---|---|
| Base | `baseSpecCacheRef` | Full audio duration | Low-res (N_FFT=2048, hop=512) |
| Local | `spectroCacheRef` | Current view ± 1× padding | High-res (adaptive N_FFT) |

**Adaptive N_FFT** in `calcSpecForView`:

| Samples in view | N_FFT |
|---|---|
| < 4 000 | 128 |
| < 10 000 | 256 |
| < 30 000 | 512 |
| < 80 000 | 1 024 |
| ≥ 80 000 | 2 048 |

---

## Formant Tracking

`formantWorker.js` runs LPC (order 12, 1024-sample frames, 256-sample hop).

---

## Playback

Web Audio API. `loadAudio` decodes using a temporary, immediately-closed `AudioContext` — the real context is created lazily inside `startPlay` (always called from a user gesture).

### Clock and timing

`ctx.currentTime` advances in 128-sample quanta (~2.9 ms at 44.1 kHz). `src.start(0)` fires at the **next** quantum boundary after `ctx.currentTime`, not at the exact call instant. Using `ctx.currentTime` directly for the display clock therefore introduces sub-quantum jitter (up to ~3 ms) that compounds across loop iterations.

The fix uses `performance.now()` for the display clock, anchored to the next quantum boundary:

```js
const sr = ctx.sampleRate;
const QUANTUM = 128 / sr;
const nextQuantumCtx = Math.ceil(ctxNow / QUANTUM) * QUANTUM;  // when audio actually starts
const perfOffset = (nextQuantumCtx - ctxNow) * 1000;           // ms until that quantum
playStartPerfRef.current = performance.now() + perfOffset;      // perf anchor
playStartCtxRef.current  = nextQuantumCtx;

src.start(0, from);
src.stop(nextQuantumCtx + audioDur);
```

In `tick(gen)` the display position is computed as:
```js
const elapsed = (performance.now() - playStartPerfRef.current) / 1000;
const t = playStartAtRef.current + elapsed * playbackRateRef.current;
```

### Stale-RAF guard (`playGenRef`)

Each `startPlay` call increments `playGenRef.current` and passes the new generation value to `tick(gen)`. Every tick frame checks `gen !== playGenRef.current` and returns immediately if stale. This ensures only one RAF chain is active at a time even during rapid loop restarts.

### End-pinning

`onended` fires at the exact audio sample boundary — always before the next 16.7 ms RAF frame. The last tick therefore leaves the playhead a few ms short of the end. Two places pin it:

1. **`tick`**: if `t >= playEndAtRef.current`, sets `playheadRef.current = playEndAtRef.current` and keeps looping the RAF until `onended` fires (does not let the position exceed the end).
2. **`onended`**: unconditionally sets `playheadRef.current = playEndAtRef.current` and calls `drawOverlay()` before doing anything else (loop restart or stop).

### Loop restart

```js
src.onended = () => {
  playheadRef.current = playEndAtRef.current;  // pin first
  updateTimeDisplay();
  drawOverlay();
  if (loopModeRef.current && sel && playingRef.current) {
    startPlay(sel.t0);   // increments playGenRef → kills current RAF chain
    return;
  }
  stopAudio();
  setPlaying(false);
  clearOverlay();
  updateTimeDisplay();
  redraw();
};
```

**Do not** divide `audioDur` by `playbackRate` when passing to `src.stop()` — the Web Audio API applies rate internally, so `src.stop(startCtx + (to - from) / rate)` is the correct call.

---

## Confidence Score Coloring

Word tiles colored by `item.score` via `scoreColor(score, alpha)`:
- 0.0 → red `rgb(255, 0, 50)`
- 0.5 → yellow `rgb(255, 200, 50)`
- 1.0 → green `rgb(0, 200, 50)`

Items without a score fall back to blue (words) or green (phonemes).

**◎ Scores** button toggles `ConfidenceDashboard` — stat grid, 10-bin histogram, color legend, 5 lowest-confidence words.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| L | Toggle loop |
| F | Fit full duration |
| Home | Reset to first 20s |
| `1` (configurable) | Toggle edit mode |
| Ctrl/Cmd+S | Save TextGrid to `public/` (dev only) |
| Ctrl/Cmd+Z | Undo |
| Arrow Left/Right | Pan by 20% of view |

The edit mode shortcut is configurable via the right half of the split Edit button. The default is `1`. The keyboard handler checks `e.code`, `e.key`, and numpad aliases so numpad keys work regardless of NumLock state.

---

## CSS

`index.css` uses CSS custom properties defined in `:root` at the top of the file:

```css
:root {
  --bg, --bg-panel, --bg-ui, --bg-item  /* background layers */
  --border, --border-ui, --border-ui2   /* border colors */
  --text, --text-dim, --text-mute, --text-dark  /* text tones */
  --accent                              /* #3a7bd5 blue */
  --mono                                /* "JetBrains Mono", monospace */
}
```

Notable component classes:

| Class | Purpose |
|---|---|
| `.btn-edit-split` | Split edit+hotkey button wrapper |
| `.btn-edit-split__main` | Left half — toggles edit mode |
| `.btn-edit-split__badge` | Right half — shows/rebinds hotkey |
| `.btn-edit-split__capture` | Key-capture input (shown during rebind) |
| `.edit-hint-bar` | Shortcut hint bar shown in edit mode |
| `.save-indicator` | Inline save status in logo bar |
| `.save-indicator--saving/saved/error` | State variants |

`.panel-divider` and `.tier-divider` share one rule. `.panel-gutter` and `.tier-gutter` share a base rule; `.tier-gutter` adds `flex-direction: column; gap: 3px`.

---

## Key Invariants and Non-Obvious Constraints

- **`setupCanvas` must be called at the start of every draw function.** It resets the transform.

- **`src.stop(nextQuantumCtx + audioDur)` — compute `audioDur = (to - from) / rate`.** `src.start` is scheduled at `nextQuantumCtx`, so stop must be relative to that same anchor, not `ctx.currentTime`.

- **Do not use `ctx.currentTime` for the visual playhead clock.** It advances in 128-sample quanta (~2.9 ms), causing jitter that compounds across loop iterations. Use `performance.now()` anchored to the next quantum boundary (`playStartPerfRef`).

- **`playGenRef` must be incremented before setting timing refs.** Any in-flight `tick(gen)` frame checks its generation against `playGenRef.current` on the next RAF fire — incrementing first guarantees the old chain self-cancels before the new timing refs are written.

- **`onended` pins the playhead before calling `startPlay` or `stopAudio`.** `onended` fires at the exact audio sample; the last RAF frame left the bar a few ms short. Pinning in `onended` (and in `tick` when `t >= playEndAtRef`) ensures the displayed stop position is always the exact selection end.

- **Waveform `onDown` has no early-return for `editModeRef.current`.** Edit mode is handled by the tier canvases' own interaction handlers; the waveform handler runs identically in both modes.

- **`assignRows` uses a 1ms tolerance** (`end - 0.001`) for floating-point TextGrid artifacts.

- **Tier canvases use `addInteraction(canvas, false)`** (wheel only). Their mousedown is handled by `addTierEditInteraction`. This avoids two conflicting mousedown handlers.

- **`drawOverlay` does not call `drawMinimap`.** The minimap is repainted by `redraw()` on scroll ticks.

- **The `useEffect([redraw])` dep array is intentionally `[redraw]` only.** Draw functions read from refs. Adding state to the dep array causes double-draws on every edit drag.

- **`addHover` takes a getter `() => items[]`**, not a snapshot — so it never goes stale without re-registration.

- **`commitTierItems(tierId, updated)`** is the single place to write any tier update. Do not write refs/state manually for tier items outside of this helper.

- **Tier name lookup is case-insensitive.** `loadTextGrid` lowercases all keys before lookup.

- **AudioContext must only be created inside a user gesture handler.** Creating it during `useEffect` auto-load leaves it permanently `'suspended'`. The decode step uses a separate temporary context that is closed immediately after decode.

- **`LabelEditorPopover` must be a proper React component** (not an inline IIFE) so that `React.useRef` creates a stable ref across renders. An inline `{ current: null }` object literal is recreated every render and breaks IPA key insertion.

- **`IpaTooltip` initialises at `top: -9999, left: -9999`**, not `0, 0`. Initialising at `0` causes a visible flash at the top-left corner before the layout effect measures and repositions.

- **`ipa_keys.json` must have no trailing comma** after the last entry. The browser's `JSON.parse` is strict; a trailing comma produces an empty keyboard silently.

- **Right-click check `if (e.button === 2) return` must be the first statement** in `onMouseDown`. Any hit-testing before this check causes unwanted tier selection on right-click.

- **MFA uses `english_us_arpa`** (200k-word ARPAbet dictionary), not `english_mfa` (42k words).

- **Never use `mfa align` subprocess for per-request alignment.** Cold-starting the FST takes ~60 s. Use the persistent `KalpyAligner` loaded at server startup.

- **Selection changes must call `redraw()`**, not `drawTier(canvas, ...)`. Only `redraw()` repaints all tier canvases; calling `drawTier` on just the clicked canvas leaves stale highlights on other tiers.

- **`selectedTilesRef` is a `Map<id, {id, tierId}>`**, not a single object. `syncSelectionState()` and `clearSelection()` are the only two helpers that should touch both the ref and the state sets together.

- **Group drag defers selection collapse to `mouseup`** via a `didDrag` boolean. On `mousedown` the group is kept intact so dragging works; if no movement occurred, `onUp` collapses to single selection.

- **`/api/save-textgrid` only exists in dev.** The Vite middleware writes directly to `public/`. In production builds there is no such endpoint — use the ↓ Export download instead.

---

## Known Gaps

- No cross-tier boundary snapping (phoneme edges to word edges)
- No waveform-level edit (only tier tiles)
- No multi-file batch processing
- `buildMelSpectrogram` in `dsp.js` result is only used as a presence check; actual rendering goes through the worker cache
- `Ctrl/Cmd+S` save does not work in production builds (no server-side endpoint)
