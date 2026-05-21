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

This creates three conda environments (`aligner`, `whisperx`, `nemo`), downloads the MFA English models, and installs the frontend Node dependencies. Takes ~10–20 min on first run depending on internet speed.

---

## Step 1 — Run ASR to generate a TextGrid

Run from the `code/asr/` directory. Pick whichever model you have set up:

```bash
# WhisperX (large-v3-turbo)
conda run -n whisperx python transcribe.py \
    --model whisper_asr \
    --audio  /path/to/your_audio.wav \
    --output /path/to/output.TextGrid

# NVIDIA Parakeet TDT 0.6B v3
conda run -n nemo python transcribe.py \
    --model parakeet \
    --audio  /path/to/your_audio.wav \
    --output /path/to/output.TextGrid
```

Output is a TextGrid with two tiers:
- **Words** — one interval per word with a confidence score
- **Phonemes** — one interval per phone from MFA forced alignment

### Useful flags

| Flag | Default | Description |
|---|---|---|
| `--no-mfa` | off | Skip MFA; Phonemes tier will be empty |
| `--json` | off | Also save the raw ASR result as `<output>.json` |
| `--dictionary` | `english_mfa` | MFA dictionary name or path |
| `--acoustic-model` | `english_mfa` | MFA acoustic model name or path |
| `--checkpoint` | model default | Override model checkpoint (Whisper only) |

Both models handle arbitrary-length audio natively — no chunking needed.

---

## Step 2 — Load files into the annotation tool

Copy your audio and the generated TextGrid into the frontend's `public/` folder:

```
frontend-reactjs/public/your_audio.wav
frontend-reactjs/public/output.TextGrid
```

Then start the dev server:

```bash
cd frontend-reactjs
npm run dev
```

Open **http://localhost:5173** — the audio and TextGrid load automatically.

You can also load a TextGrid at any time without restarting:
- Click **📄 Load TextGrid** in the toolbar
- Or **drag and drop** a `.TextGrid` file onto the page

---

## Step 3 — Annotate

### Navigating

| Action | How |
|---|---|
| Play / Pause | `Space` or ▶ button |
| Loop selection | `L` |
| Zoom | Scroll wheel, or `Ctrl+scroll` to zoom at cursor |
| Pan | Horizontal scroll, or drag the minimap |
| Fit all | `F` |

### Editing

Press **`F1`** (or click **✎ Edit**) to enter edit mode:

- **Drag a boundary** — hover near a tile edge (yellow highlight), then drag
- **Drag a tile body** — drag the centre of a tile to shift it in time
- **Double-click empty space** — create a new annotation tile
- **Double-click a tile** — rename it inline; phoneme tiles show an IPA keyboard
- **Right-click a tile** — Rename / Merge with next / Delete
- **Overlapping tiles** automatically stack into rows
- **Undo** — `Ctrl+Z` / `Cmd+Z`

### Exporting

Click **↓ Export** to download the annotations. Two format options:
- **Full** — includes all tiers and confidence scores (for re-loading into this tool)
- **Praat-compatible** — standard TextGrid format, loadable in Praat

---

## In-browser MFA re-alignment

The **⚙ Run MFA** button lets you re-run forced alignment on any selected region without leaving the browser. It requires a small Flask server running alongside the frontend.

Start the server in a separate terminal before using this feature:

```bash
conda activate aligner
python mfa_server.py
```

You should see:
```
09:00:00  INFO     MFA server starting on http://localhost:5050
09:00:00  INFO       Acoustic model : english_mfa
09:00:00  INFO       Dictionary     : english_mfa
```

**To use it:**
1. Enter Edit mode (`F1`) and select a time region covering one or more words in the Words tier
2. Click **⚙ Run MFA** — you'll be asked to confirm which words to align if multiple overlap
3. When the job completes, phone boundaries are merged into the Phonemes tier

**Common errors:**

| Error | Fix |
|---|---|
| Server not reachable | Start `mfa_server.py` and confirm the startup message appears |
| Word not in dictionary | Word is out-of-vocabulary — edit the label to a known spelling |
| Audio too short | Selected region is under ~50 ms |
| MFA alignment failed | Check the terminal running `mfa_server.py` for details |

To use a different language:
```bash
MFA_ACOUSTIC_MODEL=french_mfa MFA_DICTIONARY=french_mfa python mfa_server.py
```

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
