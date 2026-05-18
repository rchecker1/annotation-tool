# Annotation Tool — Developer Handoff

A browser-based audio annotation viewer and editor for Praat TextGrid files. Built with React + Vite. No backend except an optional MFA Flask server (`mfa_server.py`) on port 5050. All computation runs on the main thread or in Web Workers.

---

## Quick Start

```bash
cd code/frontend-reactjs
npm install
npm run dev        # http://localhost:5173
npm run build      # production output → dist/
```

On startup the app scans `public/` via a Vite dev-server middleware (`/api/public-files`) and auto-loads the first `.wav` + `.TextGrid` pair it finds. Drop your own files onto the page, or use the Load buttons in the toolbar.

Place files in `public/` — the app enforces exactly one `.wav` and one `.TextGrid` at startup and warns if the folder is empty or mismatched.

IPA key layout is read from `public/ipa_keys.json` — a flat JSON array, one string per entry. Edit that file to add/remove keys from the virtual keyboard.

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
  index.css           All styles (uses CSS custom properties — see :root block at top)

public/
  *.wav               Audio file (exactly one expected)
  *.TextGrid          Annotation file (exactly one expected)
  ipa_keys.json       IPA virtual keyboard keys, one per array entry
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
| `editShortcut` | `editShortcutRef` | Edit mode keyboard shortcut |

**Rule:** always update both together — `ref.current = n; setState(n)`.

### Canvas rendering

All visuals are drawn on `<canvas>` elements via the Canvas 2D API. There is no SVG or DOM-based rendering. Every canvas is managed by `setupCanvas()` which handles HiDPI scaling — always call it at the start of a draw function and use the returned `{ ctx, w, h }` (CSS pixels, not device pixels).

| Function | Canvas | What it draws |
|---|---|---|
| `drawWave` | `waveCanvasRef` | Waveform (3 LOD modes) + RMS overlay |
| `drawSpec` | `specCanvasRef` | Blits cached spectrogram strip + formant lines + frequency labels |
| `drawRuler` | `rulerCanvasRef` | Time axis with adaptive tick spacing |
| `drawTier` | `wordsCanvasRef` / `phonesCanvasRef` / custom canvas refs | Annotation tiles with multi-row stacking, confidence color coding |
| `drawMinimap` | `minimapCanvasRef` | Full-duration overview with viewport box |
| `drawOverlay` | `overlayCanvasRef` | Playhead line only (separate overlay canvas) |

`redraw()` calls all draws except the overlay. During playback, the RAF loop calls `drawOverlay()` and only calls `redraw()` when the view scrolls.

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

`serializeTextGrid(duration, wordItems, phoneItems, customTiers)` fills gaps with empty intervals for valid Praat output. Export via the ↓ Export button.

---

## Tier Visibility

There is always-visible bar at the top of the `.tiers` section with checkboxes for WRD, PHN, and each custom tier. The tier div itself is `display: none` when hidden — the checkbox stays visible because it lives in the bar above the tier divs, not inside them.

`wordsVisible` / `phonesVisible` state controls the WRD/PHN divs. Each custom tier has a `visible` field on its object.

---

## Tier Resize Dividers

`makeDragDivider(getContainer, onMove)` attaches `mousedown`/`mousemove`/`mouseup` to a divider element and calls `onMove(ev)` on each drag tick.

**WRD/PHN divider** measures actual `getBoundingClientRect()` heights of `wrdTierRef` and `phnTierRef` to compute the fraction — do not use the parent container rect, as the visibility bar above the tiers throws off the math.

**Custom tier dividers** are wired in the `useEffect([customTiers])` — each divider measures the tier above (`phnTierRef` for the first, or the previous custom tier's div ref) and the tier below.

---

## IPA Virtual Keyboard

`IpaKeyboard({ inputRef })` component:
- Fetches `/ipa_keys.json` on first render, renders one button per key.
- `onMouseDown: e.preventDefault()` prevents the label editor input from blurring when a key is clicked.
- Inserts at cursor using the native input setter trick (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(...)`).
- Only shown when `labelEditor.tierType === 'phone'` (i.e. the PHN tier).
- The label editor `onBlur` has a 150ms delay to allow IPA key click to fire first.

To change the key set: edit `public/ipa_keys.json`. Format: flat JSON array, one string per entry.

---

## MFA Queue System

MFA (Montreal Forced Aligner) runs via `mfa_server.py` on `http://localhost:5050`.

State:
```js
const [mfaQueue, setMfaQueue] = useState([]);  // {id,label,segT0,segT1,targetWords,status,error}
const mfaQueueRef = useRef([]);
const mfaProcessingRef = useRef(false);
```

- Max 4 items in queue (pending + running combined). Attempting to add a 5th shows an error toast.
- `enqueueRunMfa(targetWords, sel)` adds a job and calls `processNextMfaJob()`.
- `processNextMfaJob()` picks the next `'pending'` job, marks it `'running'`, runs it, then recursively calls itself.
- The MFA button label shows `⟳ <word> <t0>–<t1>s` when a job is active. A badge shows queue depth with a dropdown listing all pending/running/errored jobs.
- Errors appear as a small fixed pill (bottom-right, max 380px wide), not a large centered banner.

---

## Spectrogram System

Two-level cache:

| Cache | Ref | Coverage | Resolution |
|---|---|---|---|
| Base | `baseSpecCacheRef` | Full audio duration | Low-res (N_FFT=2048, hop=512) |
| Local | `spectroCacheRef` | Current view ± 1× padding | High-res (adaptive N_FFT) |

**Worker protocol** (`specWorker.js`):
- Input: `{ ch, sr, t0, t1, hop, N_FFT, pw, ph, colormapName, regionT0, id }`
- Output: `{ pixels, pw, ph, stripT0, stripT1, regionT0, id }` — transferred zero-copy

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

**Worker protocol**:
- Input: `{ ch, sr, regionT0, id }`
- Output: `{ f1, f2, f3, frames, hop, sr, regionT0, id }` — transferred zero-copy

---

## Playback

Web Audio API. AudioContext autoplay policy: `ctx.state` may be `'suspended'` on first play. `startPlay` calls `ctx.resume().then(doStart)` when suspended.

`getAudioCtx()` recreates the context if `ctx.state === 'closed'`.

**Playback rate**: 0.25×–2× via dropdown. Changing rate while playing restarts from current playhead.

`src.start(0, from, duration)` — the duration arg is source content time. Do **not** divide by `playbackRate`; the browser handles rate internally.

---

## Edit Mode

Toggled by **✎ Edit** button or the configurable keyboard shortcut (default F1).

`addTierEditInteraction(canvas, itemsRef, isWord, tierId)` registers listeners on each tier canvas:

| Event | Behaviour |
|---|---|
| `mousemove` | Cursor feedback, yellow edge highlight |
| `mouseleave` | Reset cursor and hover state |
| `mousedown` | Seek/select (non-edit) or drag boundary/body/create (edit) |
| `contextmenu` | Rename / Merge with next / Delete |

**Committing edits**: use `commitTierItems(tierId, updated)` inside this function.

**Undo**: `pushUndo()` snapshots words + phones + customTiers (max 100). Ctrl/Cmd+Z fires `popUndo()` + `redraw()`.

**Double-click empty** → creates tile, opens label editor.  
**Double-click tile** → opens inline label editor.  
**Drag edge** → updates item + any adjacent item sharing that exact edge.  
**Drag body** → moves tile, re-runs `assignRows`.

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
| F1 (configurable) | Toggle edit mode |
| Ctrl/Cmd+Z | Undo |
| Arrow Left/Right | Pan by 20% of view |

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

`.panel-divider` and `.tier-divider` share one rule. `.panel-gutter` and `.tier-gutter` share a base rule; `.tier-gutter` adds `flex-direction: column; gap: 3px`.

---

## Key Invariants and Non-Obvious Constraints

- **`setupCanvas` must be called at the start of every draw function.** It resets the transform.

- **`src.start(0, from, duration)` — do not divide duration by `playbackRate`.** The Web Audio API applies rate internally.

- **`assignRows` uses a 1ms tolerance** (`end - 0.001`) for floating-point TextGrid artifacts.

- **Tier canvases use `addInteraction(canvas, false)`** (wheel only). Their mousedown is handled by `addTierEditInteraction`. This avoids two conflicting mousedown handlers.

- **`drawOverlay` does not call `drawMinimap`.** The minimap is repainted by `redraw()` on scroll ticks.

- **The `useEffect([redraw])` dep array is intentionally `[redraw]` only.** Draw functions read from refs. Adding state to the dep array causes double-draws on every edit drag.

- **`addHover` takes a getter `() => items[]`**, not a snapshot — so it never goes stale without re-registration.

- **`commitTierItems(tierId, updated)`** is the single place to write any tier update. Do not write refs/state manually for tier items outside of this helper.

- **Tier name lookup is case-insensitive.** `loadTextGrid` lowercases all keys before lookup.

- **AudioContext may be `'suspended'` or `'closed'`.** Always go through `getAudioCtx()` which recreates if closed, and always resume before starting a source node.

---

## Known Gaps

- No cross-tier boundary snapping (phoneme edges to word edges)
- No waveform-level edit (only tier tiles)
- No multi-file batch processing
- `serializeTextGrid` does not preserve `score` fields on export
- `buildMelSpectrogram` in `dsp.js` is called on load but its result is only used as a presence check in `drawSpec` — actual pixel rendering goes through the worker cache
