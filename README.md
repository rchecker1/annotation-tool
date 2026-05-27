# Annotation Tool

A browser-based audio annotation viewer and editor for Praat TextGrid files.

The full workflow is:
1. **ASR + forced alignment** (`asr/`) — transcribe audio and generate an initial TextGrid
2. **Annotation tool** (`frontend-reactjs/`) — review, correct, and export the annotations

---

## Prerequisites

- **conda** — [Miniconda](https://docs.conda.io/en/latest/miniconda.html) or Anaconda
- **Node.js v18+** — easiest via [nvm](https://github.com/nvm-sh/nvm):
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # restart terminal, then:
  nvm install 20 && nvm use 20
  ```

---

## One-time setup

From the `code/` directory, run:

```bash
bash setup.sh
```

This creates the necessary conda environments (`aligner`, `whisperx`, and `nemo` on Linux), downloads the MFA English models, and installs the frontend Node dependencies.

**macOS Note:**
- `setup.sh` automatically detects macOS and installs a Mac-compatible `whisperx` environment.
- `nemo` (Parakeet) is currently only supported on Linux with NVIDIA GPUs and will be skipped on macOS.
- WhisperX on Mac will use CPU or MPS (Apple Silicon) for inference.

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

You can also load files at any time without restarting:
- Click **📄 Load TextGrid** in the toolbar to load a new TextGrid
- Click **🔊 Load Audio** in the toolbar to load a new audio file
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

### Tiers

The annotation area shows stacked tiers below the waveform and spectrogram:

- **WRD** — word-level annotations (blue tiles). Tiles are colored by confidence score if present: red (low) → yellow → green (high).
- **PHN** — phoneme-level annotations (green tiles). Includes an IPA virtual keyboard when renaming.
- **Custom tiers** — any additional tiers loaded from the TextGrid, or created with the **+ Add Tier** button.

Use the **SHOW** checkbox bar at the top of the tier area to hide/show individual tiers. Tiers can be resized by dragging the dividers between them.

### Edit mode

Press **`1`** (default, configurable) or click the **✎ Edit** button to enter edit mode. The button shows the current shortcut key on its right side — click that side to rebind it to any key.

In edit mode, a hint bar appears at the bottom of the tier area showing all available shortcuts.

**Single tile operations:**
- **Click a tile** — select it (highlighted border on the tile and its tier)
- **Drag a boundary** — hover near a tile edge (yellow highlight appears), then drag left/right; the adjacent tile's boundary moves with it
- **Drag a tile body** — drag the centre of a tile to shift it in time
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
- **Praat compatible** — standard TextGrid format with WRD + PHN only, loadable in Praat

---

## Spectrogram & formants

- **⟳ Calc Spec** — compute a high-resolution spectrogram for the current view. Resolution adapts to zoom level automatically.
- **Colormap selector** — switch between `jet`, `inferno`, `viridis`, and `greys`.
- **○ Formants / ⟳ Calc F1·F2·F3** — overlay F1/F2/F3 formant tracks on the spectrogram. Computed via LPC (order 12) in a background worker.

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
1. Enter Edit mode and select a time region covering one or more words in the WRD tier
2. Click **⚙ Run MFA** — if multiple words overlap the selection you'll be asked to confirm which to align
3. When the job completes, phone boundaries are merged into the PHN tier

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
│   ├── environment-parakeet.yml
│   ├── run_whisper.sh        — convenience script for WhisperX
│   └── run_parakeet.sh       — convenience script for Parakeet
└── frontend-reactjs/         — annotation tool (React + Vite)
    ├── public/               — place your .wav and .TextGrid here
    └── src/
        └── App.jsx           — main application
```
