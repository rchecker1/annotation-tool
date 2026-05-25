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

## Edit Mode — Right-Click Fix

`onMouseDown` in `addTierEditInteraction` now returns early on right-click:

```js
if (e.button === 2) return;
```

This must be the very first check in the handler. Without it, a right-click triggered selection of the full tier before the `contextmenu` event fired.

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
  // toast style:
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

The aligner is loaded **once at startup** (~16 s) and reused for every request (~1–4 s per alignment):

```python
from montreal_forced_aligner.models import AcousticModel
from montreal_forced_aligner.alignment.multiprocessing import KalpyAligner
from kalpy.fstext.lexicon import LexiconCompiler

model = AcousticModel(str(acoustic_path))
p = model.parameters
lc = LexiconCompiler(
    silence_probability=p['silence_probability'],
    initial_silence_probability=p['initial_silence_probability'],
    final_silence_correction=p['final_silence_correction'],
    final_non_silence_correction=p['final_non_silence_correction'],
    silence_phone=p['optional_silence_phone'],
    oov_phone=p['oov_phone'],
    position_dependent_phones=p['position_dependent_phones'],
    phones=p['non_silence_phones'],
)
lc.load_pronunciations(dict_path)
lc.create_fsts()
_kalpy_aligner = KalpyAligner(model, lc)
```

Per-request alignment:

```python
from kalpy.utterance import Utterance, Segment
segment = Segment(str(wav_path), 0.0, duration, 0)
utt = Utterance(segment, transcript, None, None)
ctm = _kalpy_aligner.align_utterance(utt)
ctm.update_utterance_boundaries(t_offset, t_offset + duration)
```

Do **not** use subprocess (`mfa align …`) — that cold-starts the full FST every call (~60 s).

### ARPAbet → IPA conversion

MFA outputs ARPAbet phones (e.g. `AH0`, `SH`, `T`). The server converts them to IPA before returning:

```python
_ARPABET_TO_IPA = {
    'AA': 'ɑ', 'AE': 'æ', 'AH': 'ʌ', 'AO': 'ɔ', ...
    'SPN': 'spn', 'SP': 'sp', 'SIL': 'sil',
}

def _arpa_to_ipa(phone: str) -> str:
    key = phone.rstrip('012').upper()   # strip stress digits
    return _ARPABET_TO_IPA.get(key, phone)
```

### Silence filtering

Trailing silence/noise phones are stripped from the output:

```python
ipa = _arpa_to_ipa(label)
if label and label not in ('', '<eps>') and ipa not in ('spn', 'sp', 'sil'):
    phones_tier.append({...})
```

### OOV word substitution

Words not in the dictionary are automatically substituted with the nearest Levenshtein match:

```python
def _closest_dict_word(word: str) -> tuple[str, int] | None:
    vocab = _load_dict_words()
    n = len(word)
    # length-filter for speed: only compare words within max(3, n//2) chars
    candidates = [w for w in vocab if abs(len(w) - n) <= max(3, n // 2)] or list(vocab)
    best = min(candidates, key=lambda w: _edit_distance(word, w))
    return best, _edit_distance(word, best)
```

When a substitution occurs, the response includes a `warning` field:

```json
{
  "warning": "\"yep\" not in dictionary — aligned as \"yes\""
}
```

The frontend shows this as an orange toast.

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

Web Audio API.

### AudioContext lifecycle — critical detail

`loadAudio` decodes audio using a **temporary, immediately-closed** `AudioContext`:

```js
const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
const buffer = await tmpCtx.decodeAudioData((await file.arrayBuffer()).slice(0));
tmpCtx.close();
audioBufferRef.current = buffer;
```

This is intentional: creating the real context before a user gesture leaves it permanently `'suspended'` in most browsers. The real context is created lazily inside `startPlay`, which is always called from a user gesture (Play button or Space key).

`getAudioCtx()` creates a new context on first call or if the existing one is `'closed'`:

```js
const getAudioCtx = () => {
  if (!audioCtxRef.current || audioCtxRef.current.state === 'closed')
    audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtxRef.current;
};
```

`startPlay(from)` flow:
1. `stopAudio()` — kills any existing source/RAF
2. `getAudioCtx()` — get or create context
3. If `ctx.state === 'suspended'`: `ctx.resume().then(doStart)`; else `doStart()` directly
4. `doStart()` creates a `BufferSource`, connects it, calls `src.start(0, from, to - from)`, starts RAF

`src.start(0, from, duration)` — the duration arg is source content time. Do **not** divide by `playbackRate`; the browser handles rate internally.

**Playback rate**: 0.25×–2× via dropdown. Changing rate while playing restarts from current playhead.

---

## Edit Mode

Toggled by **✎ Edit** button or the configurable keyboard shortcut (default F1).

`addTierEditInteraction(canvas, itemsRef, isWord, tierId)` registers listeners on each tier canvas:

| Event | Behaviour |
|---|---|
| `mousemove` | Cursor feedback, yellow edge highlight |
| `mouseleave` | Reset cursor and hover state |
| `mousedown` | `if (e.button === 2) return` first — then seek/select (non-edit) or drag boundary/body/create (edit) |
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

- **AudioContext must only be created inside a user gesture handler** (`startPlay`, which is called from onClick or keydown). Creating it during `useEffect` auto-load leaves it permanently `'suspended'`. The decode step uses a separate temporary context that is closed immediately after decode.

- **`loadAudio` does NOT create the real AudioContext.** It uses `tmpCtx` only for decode. `audioCtxRef` is only populated when `startPlay` runs.

- **`LabelEditorPopover` must be a proper React component** (not an inline IIFE) so that `React.useRef` creates a stable ref across renders. An inline `{ current: null }` object literal is recreated every render and breaks IPA key insertion.

- **`IpaTooltip` initialises at `top: -9999, left: -9999`**, not `0, 0`. Initialising at `0` causes a visible flash at the top-left corner before the layout effect measures and repositions.

- **`ipa_keys.json` must have no trailing comma** after the last entry. The browser's `JSON.parse` is strict; a trailing comma produces an empty keyboard silently.

- **Right-click check `if (e.button === 2) return` must be the first statement** in `onMouseDown`. Any hit-testing before this check causes unwanted tier selection on right-click.

- **MFA uses `english_us_arpa`** (200k-word ARPAbet dictionary), not `english_mfa` (42k words). The larger dictionary handles common words like "yep" and "pineapples" that `english_mfa` marks as OOV.

- **MFA output is ARPAbet** (`AH0`, `SH`, etc.) and must be converted to IPA before storing. Stress digits (`0`, `1`, `2`) are stripped before lookup in `_ARPABET_TO_IPA`.

- **Never use `mfa align` subprocess for per-request alignment.** Cold-starting the FST takes ~60 s. Use the persistent `KalpyAligner` loaded at server startup.

---

## Recent Changes

- **Font scaling in tiles** — `drawTier` now scales font size with `rowH * 0.45`, clamped 11–24px. Word tier uses Inter 500; phoneme tier uses JetBrains Mono at 1px smaller.

- **IPA keyboard format** — `ipa_keys.json` changed from a flat array to an object `{ symbol: "example with **bold**" }`. The keyboard now shows a hover tooltip with the phoneme in slashes and a bolded example word.

- **`IpaExample` component** — parses `**bold**` markdown inline. Used inside `IpaTooltip`.

- **`IpaTooltip` component** — `position: fixed`, initialises off-screen to avoid top-left flash, measures and positions above the hovered key after layout.

- **`LabelEditorPopover` component** — extracted from an inline IIFE into a proper React component with stable `React.useRef`. This fixed IPA key insertion which was silently broken when the keyboard ref was a plain object literal.

- **Right-click tier selection fix** — `if (e.button === 2) return` added as the first check in `onMouseDown`, preventing right-click from triggering tile selection before the context menu fires.

- **MFA server rewrite** — `mfa_server.py` now uses persistent `KalpyAligner` + `LexiconCompiler` from the `kalpy` Python API. First request still waits ~16 s for model init; subsequent requests take 1–4 s instead of ~60 s.

- **ARPAbet → IPA conversion** — MFA returns ARPAbet phones; `_arpa_to_ipa()` converts them (stripping stress digits) before the response is sent to the frontend.

- **Silence phone filtering** — `sil`, `sp`, and `spn` phones are stripped from the extracted phone intervals before the response is built.

- **OOV word substitution** — words not in the `english_us_arpa` dictionary are automatically substituted with the nearest Levenshtein match (length-filtered for speed). A `warning` field is included in the response and shown as an orange toast in the UI.

- **`mfaWarning` state** — new state for OOV substitution warnings, shown as an orange pill toast (separate from the red error toast). Style: `background: '#221a08', border: '1px solid #a07020', color: '#f0b840'`.

- **`setup.sh`** — new one-time setup script in `code/` that creates the `aligner`, `whisperx`, and `nemo` conda environments, downloads `english_us_arpa` acoustic + dictionary models, and runs `npm install` for the frontend.

- **`README.md` rewrite** — full end-to-end guide covering setup, ASR, annotation, export, and in-browser MFA re-alignment.

- **Audio playback resolved** — the debug `console.log('[startPlay] ...')` lines documented in the previous session have been removed; audio plays correctly.

- **Score export resolved** — `serializeTextGrid` now preserves `score` fields on export (was listed as a known gap previously).

---

## Known Gaps

- No cross-tier boundary snapping (phoneme edges to word edges)
- No waveform-level edit (only tier tiles)
- No multi-file batch processing
- `buildMelSpectrogram` in `dsp.js` is called on load but its result is only used as a presence check in `drawSpec` — actual pixel rendering goes through the worker cache
