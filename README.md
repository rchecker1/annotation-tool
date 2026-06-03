# Annotation Tool

A browser-based audio annotation viewer and editor for Praat TextGrid files.

The full workflow is:
1. **ASR + forced alignment** (`asr/`) — transcribe audio and generate an initial TextGrid
2. **Annotation tool** (`frontend-reactjs/`) — review, correct, and export the annotations

---

## Prerequisites

- **conda** — [Miniconda](https://docs.conda.io/en/latest/miniconda.html) or Anaconda
- **Node.js v18+** — on macOS, easiest via [Homebrew](https://brew.sh):
  ```bash
  brew install node
  ```
  Or via [nvm](https://github.com/nvm-sh/nvm) (cross-platform):
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # then in a new terminal:
  nvm install 20 && nvm use 20
  ```

---

## One-time setup

From the `annotation-tool/` directory, run:

```bash
bash setup.sh
```

This creates the necessary conda environments (`aligner`, `whisperx`, and `nemo` on Linux), downloads the MFA English models, and installs the frontend Node dependencies.

**macOS Note:**
- `setup.sh` automatically detects macOS and installs a Mac-compatible `whisperx` environment.
- `nemo` (Parakeet) is currently only supported on Linux with NVIDIA GPUs and will be skipped on macOS.
- WhisperX on Mac will use CPU or MPS (Apple Silicon) for inference.

---

## Transcribing your own audio

To generate a TextGrid from your own audio file, run the ASR pipeline from the `annotation-tool/` directory:

```bash
conda run -n whisperx python asr/transcribe.py \
    --model whisper_asr \
    --audio  /path/to/your/audio.wav \
    --output frontend-reactjs/public/output_whisper.TextGrid
```

This transcribes the audio, runs MFA forced alignment, and writes the TextGrid directly into `public/` ready to load.

**Changing the Whisper model size** — by default WhisperX uses `tiny.en` (fast, less accurate). To use a larger model, edit line 32 of `asr/models/whisper_asr.py`:

```python
_CHECKPOINT = "tiny.en"   # change to e.g. "base.en", "small.en", "large-v3-turbo"
```

Larger models are more accurate but slower. See the [WhisperX docs](https://github.com/m-bain/whisperX) for all available checkpoints.

---

## Loading files

Copy your audio and TextGrid into the frontend's `public/` folder:

```
frontend-reactjs/public/audio.wav
frontend-reactjs/public/output_whisper.TextGrid
```

Then start the dev server:

```bash
cd frontend-reactjs
npm run dev
```

Open **http://localhost:5173** — the audio and TextGrid load automatically.

**Multiple files:** if `public/` contains more than one `.wav` or `.TextGrid`, a picker modal appears on startup letting you choose which pair to open.

You can also load files at any time without restarting:
- Click **📄 Load TextGrid** in the toolbar to load a new TextGrid
- **Drag and drop** a `.wav` or `.TextGrid` file anywhere on the page

---

## Annotating

### Navigation

| Action | How |
|---|---|
| Play / Pause | `Space` or ▶ Play button |
| Loop playback | `L` or ↺ Loop button |
| Playback speed | 0.25×–2× dropdown in toolbar |
| Zoom in/out | Scroll wheel, or zoom slider in toolbar |
| Zoom at cursor | `Ctrl/Cmd + scroll` |
| Pan left/right | Horizontal scroll, Arrow keys (20% of view), or drag the minimap |
| Fit full audio | `F` |
| Reset to start | `Home` |
| Seek | Click anywhere on the waveform, spectrogram, or ruler |
| Select tile | Click any tile (edit mode not required) — moves playhead to onset and sets play region |
| Play tile | After selecting a tile, press `Space` or ▶ Play |
| Auto-play tile | Enable AUTO-PLAY in the SHOW bar — clicking a tile starts playback immediately |

### Tiers

The annotation area shows stacked tiers below the waveform and spectrogram:

- **WRD** — word-level annotations (blue tiles). Tiles are colored by confidence score if present: red (low) → yellow → green (high).
- **PHN** — phoneme-level annotations (green tiles). Includes an IPA virtual keyboard when renaming.
- **Custom tiers** — any additional tiers loaded from the TextGrid, or created with the **+ Add Tier** button.

Use the **SHOW** checkbox bar at the top of the tier area to hide/show individual tiers. Tiers can be resized by dragging the dividers between them. The **AUTO-PLAY** checkbox (right side of the SHOW bar) makes clicking any tile immediately play its audio without needing to press Play.

### Edit mode

Press **`1`** (default, configurable) or click the **✎ Edit** button to enter edit mode. The button shows the current shortcut key on its right side — click that side to rebind it to any key.

In edit mode, a hint bar appears at the bottom of the tier area showing all available shortcuts.

**Single tile operations:**
- **Click a tile** — select it; moves the playhead to its onset and sets the play region to onset→offset
- **Drag a boundary** — hover near a tile edge (yellow highlight appears), then drag left/right; snaps to nearby boundaries in other tiers. Hold **Alt** to disable snapping
- **Drag a tile body** — drag the centre of a tile to shift it in time; snaps to nearby boundaries in other tiers
- **Double-click a tile** — open the inline label editor; phoneme tiles show an IPA virtual keyboard
- **Double-click empty space** — create a new annotation tile at that position
- **Right-click a tile** — context menu: Rename / Merge with next / Delete
- **`⌫` / Delete key** — delete the selected tile(s)

**Multi-tile operations:**
- **`Ctrl/Cmd + click`** tiles — add or remove tiles from a multi-selection (works across WRD, PHN, and custom tiers simultaneously)
- **Drag any tile in the group** — moves all selected tiles together by the same amount; clamped so no tile goes outside the file bounds
- **Click a grouped tile without dragging** — collapses selection back to just that tile
- **`⌫` / Delete key** — deletes all selected tiles across all tiers in one undoable operation

**Undo:** `Ctrl/Cmd+Z` — steps back through all edit operations (max 100 steps).

### Saving

**`Ctrl/Cmd+S`** saves the current state of all tiers directly back to the `.TextGrid` file in `public/`, overwriting it in place. A status indicator appears in the toolbar:
- `⟳ Saving…` — write in progress
- `✓ Saved` — successfully written to disk
- `✕ Save failed` — check that `npm run dev` is running (save requires the dev server)

> Note: `Ctrl/Cmd+S` only works during development (`npm run dev`). For production builds, use the Export button instead.

### Exporting

Click **↓ Export** to download the annotations as a file. Two format options:

- **Full export** — includes all tiers (WRD + PHN + custom) and confidence scores; best for reloading into this tool
- **Praat compatible** — standard TextGrid format with WRD + PHN + any custom tiers, loadable in Praat (confidence score fields are omitted)

---

## Spectrogram & formants

Controls appear stacked on the right side of the spectrogram tier:

- **Colormap selector** — switch between `jet`, `inferno`, `viridis`, and `greys`.
- **Enhance Spectrogram** — recomputes the spectrogram for the current view using Python/librosa at full canvas resolution. Click **⚙** to expand settings:
  - **Mel bands** — 40 / 80 / 128 / 160 (default 128)
  - **FFT size** — 256 / 512 / 1024 / 2048 (default 512)
- **Generate Formants** — overlays F1/F2/F3 formant tracks computed by Praat's Burg algorithm (via `parselmouth`). Includes an on/off pill toggle to show or hide the overlay without recomputing.

> **Note:** Enhance Spectrogram and Generate Formants require the `aligner` conda environment to be present (it is created by `setup.sh`). The Vite dev server (`npm run dev`) shells out to `dsp_server.py` in the `aligner` env for these features. They are not available in production builds.

**Long audio (> 10 min):** the base spectrogram is not computed on load to avoid blocking the browser. The spectrogram area shows a placeholder — click **Enhance Spectrogram** to generate it for the current view. For audio over 30 minutes, a warning banner appears reminding you to save frequently (`Ctrl/Cmd+S`), as the browser holds the full decoded audio in memory.

---

## Confidence scores

Word tiles are color-coded by the confidence score from Whisper:
- **Red** — low confidence (score near 0)
- **Yellow** — medium confidence (score near 0.5)
- **Green** — high confidence (score near 1.0)

Click **◎ Scores** in the toolbar to open the Confidence Dashboard, which shows:
- Mean, median, min, max scores
- 10-bin histogram
- Color legend
- 5 lowest-confidence words

---

## In-browser MFA re-alignment

The **⚙ Run MFA** button re-runs forced phoneme alignment on a selected region without leaving the browser. It requires the MFA Flask server running alongside the frontend.

Start the server **in a separate terminal** before using this feature:

```bash
conda activate aligner
python mfa_server.py
```

You should see:
```
INFO  MFA server starting on http://localhost:5050
INFO    Acoustic model : english_us_arpa
INFO    Dictionary     : english_us_arpa
```

The server loads the alignment model once (~16 s startup), then handles each request in 1–4 s.

**To use it:**
1. Click **⚙ Run MFA** — if multiple words overlap the selection you'll be asked to confirm which to align
2. When the job completes, phone boundaries are merged into the PHN tier

Up to 4 alignment jobs can be queued at once. A dropdown badge on the button shows queue status. If a word is out-of-vocabulary, the server automatically substitutes the closest dictionary match and shows an orange warning toast.

**Common errors:**

| Error | Fix |
|---|---|
| Server not reachable | Start `mfa_server.py` and confirm startup message |
| Word not in dictionary | Edit the label to a known spelling; OOV words are auto-substituted |
| Audio too short | Selected region is under ~50 ms |
| MFA alignment failed | Check the terminal running `mfa_server.py` |

To use a different language:
```bash
MFA_ACOUSTIC_MODEL=french_mfa MFA_DICTIONARY=french_mfa python mfa_server.py
```

---

## Keyboard shortcuts — quick reference

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `L` | Toggle loop |
| `F` | Fit full audio in view |
| `Home` | Reset view to first 20 s |
| `1` *(configurable)* | Toggle edit mode |
| `Ctrl/Cmd+S` | Save TextGrid to disk (dev only) |
| `Ctrl/Cmd+Z` | Undo |
| `⌫` / `Delete` | Delete selected tile(s) (edit mode) |
| `Ctrl/Cmd+click` | Add/remove tile from multi-selection (edit mode) |
| `←` / `→` | Pan view by 20% |

The edit mode shortcut can be changed by clicking the key badge on the right side of the Edit button and pressing any key.

---

## File structure

```
code/
├── setup.sh                  — one-time setup for all environments
├── environment.yml           — conda spec for the aligner env (MFA + Flask server)
├── mfa_server.py             — Flask server for in-browser MFA re-alignment
├── asr/                      — ASR + initial alignment pipeline
│   ├── transcribe.py         — entry point: audio → TextGrid
│   ├── aligner.py            — MFA forced alignment
│   ├── textgrid_writer.py    — writes the output TextGrid
│   ├── models/
│   │   ├── whisper_asr.py    — WhisperX wrapper
│   │   └── parakeet.py       — NVIDIA Parakeet wrapper
│   ├── environment-whisperx.yml
│   ├── environment-whisperx-mac.yml
│   ├── environment-parakeet.yml
│   ├── run_whisper.sh        — convenience script for WhisperX
│   └── run_parakeet.sh       — convenience script for Parakeet
└── frontend-reactjs/         — annotation tool (React + Vite)
    ├── dsp_server.py         — Python DSP: mel spectrogram (librosa) + formants (parselmouth/Praat)
    ├── vite.config.js        — Vite config + dev-server middleware (/api/compute-dsp, /api/save-textgrid)
    ├── public/               — place your .wav and .TextGrid here
    └── src/
        └── App.jsx           — main application
```
