# Annotation Tool — Quickstart

A browser-based audio annotation viewer and editor for Praat TextGrid files.

## Requirements

- **Node.js** v18 or later (npm comes bundled with it)

  The easiest way to install is via **nvm**:
  ```bash
  # Mac / Linux
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # restart your terminal, then:
  nvm install 20
  nvm use 20
  ```
  **Windows:** use [nvm-windows](https://github.com/coreybutler/nvm-windows/releases) instead.  
  Or download the LTS installer directly from https://nodejs.org.

  Verify: `node --version` should print `v20.x.x` or higher.

No other installs needed. Everything else is pulled in automatically.

## Setup

```bash
# 1. Enter the project folder
cd frontend-reactjs

# 2. Install dependencies (only needed once)
npm install

# 3. Start the dev server
npm run dev
```

Then open **http://localhost:5173** in your browser.

## Loading your own files

**Audio** must be placed in the `public/` folder before starting the dev server — the app auto-loads it on startup. Exactly one `.wav` file is expected:

```
code/frontend-reactjs/public/your_audio.wav
```

Then reload the page (`Ctrl+R` / `Cmd+R`) and the new file will load automatically.

**TextGrid** annotations can be loaded two ways:
- Place a `.TextGrid` file in `public/` alongside the audio — it auto-loads on startup
- Use the **📄 Load TextGrid** button in the toolbar to load one at any time
- **Drag and drop** a `.TextGrid` file onto the page

## Key features

| Action | How |
|---|---|
| Play / Pause | `Space` or ▶ button |
| Loop selection | `L` |
| Zoom | Scroll wheel, or `Ctrl + scroll` to zoom at cursor |
| Pan | Horizontal scroll, or drag the minimap at the bottom |
| Fit all | `F` |
| Toggle edit mode | `F1` (customisable — click the key badge next to Edit button) |
| Undo | `Ctrl+Z` / `Cmd+Z` |

## Edit mode

Click **✎ Edit** (or press `F1` or change the shortcut key by clicking it and setting it to the key you want) to enable annotation editing:

- **Drag a tile boundary** — hover near the left/right edge (yellow highlight), then drag
- **Drag a tile body** — click and drag the centre of a tile to shift it in time
- **Double-click empty space** — creates a new annotation tile
- **Double-click a tile** — rename it inline
- **Right-click a tile** — Rename / Merge with next / Delete
- **Overlapping tiles** automatically stack into rows

Click **↓ Export** to download the edited annotations as a `.TextGrid` file (not Praat-format).

## MFA (Forced Alignment)

The **⚙ Run MFA** button in the toolbar runs the [Montreal Forced Aligner](https://montreal-forced-aligner.readthedocs.io/) on a selected audio segment and merges the resulting phone boundaries into the phoneme tier. It requires a small Flask server (`mfa_server.py`) running locally alongside the frontend.

### One-time setup

**1. Create the conda environment**

```bash
cd code
conda env create -f environment.yml
```

This creates an environment called `aligner` with MFA 3.3.9 and all dependencies pre-pinned.

**2. Download the acoustic model and dictionary**

```bash
conda activate aligner
mfa model download acoustic english_us_arpa
mfa model download dictionary english_us_arpa
```

Both downloads go to `~/Documents/MFA/pretrained_models/`. This is a one-time step — they persist across sessions.

### Starting the server

Every time you want to use forced alignment, start the server in a separate terminal before opening the app:

```bash
conda activate aligner
python code/mfa_server.py
```

You should see:

```
09:00:00  INFO     MFA server starting on http://localhost:5050
09:00:00  INFO       Acoustic model : english_us_arpa
09:00:00  INFO       Dictionary     : english_us_arpa
```

The server stays running until you close the terminal or press `Ctrl+C`. The frontend auto-detects it — no configuration needed.

### Using forced alignment

1. In the annotation tool, enter **Edit mode** (`F1`) and select a time region on the waveform that covers one or more words in the **WRD tier**.
2. Click **⚙ Run MFA** in the toolbar. If multiple words overlap the selection you'll be asked to confirm which ones to align.
3. The job is queued (max 4 at a time). A status badge on the button shows queue depth. When the job completes, the phone boundaries are merged into the **PHN tier**, replacing any phones that were previously in that region.

**Errors** appear as a pill in the bottom-right corner. Common causes:

| Error | Fix |
|---|---|
| Server not reachable | Start `mfa_server.py` and confirm it prints the startup message |
| Word not in dictionary | The word is out-of-vocabulary for `english_us_arpa` — edit the WRD label to a known spelling |
| Audio too short | The selected region is under ~50 ms |
| MFA alignment failed | Check the terminal running `mfa_server.py` for the full MFA stderr output |

### Using a different language or model

Set environment variables before starting the server:

```bash
MFA_ACOUSTIC_MODEL=french_mfa MFA_DICTIONARY=french_mfa python code/mfa_server.py
```

Run `mfa model download acoustic` and `mfa model download dictionary` with the same model name first.

---

## Building for production

```bash
npm run build
```

Output goes to `frontend-reactjs/dist/`. Serve that folder with any static file server.

## Zipping to share

Exclude `node_modules` and `dist` before zipping — they are large and regenerated by `npm install` / `npm run build`:

```bash
# From the annotation_tool/code directory
zip -r annotation_tool.zip code/frontend-reactjs \
  --exclude "code/frontend-reactjs/node_modules/*" \
  --exclude "code/frontend-reactjs/dist/*"
```

The recipient just needs Node installed, then runs `npm install && npm run dev`.
