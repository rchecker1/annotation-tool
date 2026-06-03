# asr

Audio → TextGrid pipeline. Takes any audio file, runs ASR to get word-level timestamps and confidence scores, then runs Montreal Forced Aligner (MFA) to get phoneme-level intervals, and writes a Praat TextGrid.

## Output format

Two tiers:

**Words** — one interval per word, no silence intervals:
```
intervals [5]:
    xmin = 2.72
    xmax = 3.28
    text = "supreme"
    score = 0.9201
```

**Phonemes** — one interval per phone from MFA, no silence intervals:
```
intervals [3]:
    xmin = 2.72
    xmax = 2.75
    text = "s"
```

## Supported models

| Model | Conda env | Flag |
|---|---|---|
| WhisperX (large-v3-turbo) | `whisperx` | `--model whisper_asr` |
| NVIDIA Parakeet TDT 0.6B v3 | `nemo` | `--model parakeet` |

WhisperX word scores come from its wav2vec2 forced aligner. Parakeet word scores come from NeMo's `max_prob` confidence strategy.

## Prerequisites

### MFA (one-time setup)
MFA runs in the `aligner` conda env. Download the English models once:
```bash
conda run -n aligner mfa model download dictionary english_mfa
conda run -n aligner mfa model download acoustic english_mfa
```

### Conda environments

Create the ASR envs from the exported specs in this repo:

```bash
conda env create -f asr/environment-whisperx.yml   # env name: whisperx
conda env create -f asr/environment-parakeet.yml   # env name: nemo (Parakeet)
```

Key packages:
- **whisperx**: `whisperx`, `transformers`, `torch`, `librosa`
- **nemo** (Parakeet): `nemo-toolkit`, `torch`, `librosa`, `soundfile`, `omegaconf`

The `aligner` env (MFA) is separate — install `montreal-forced-aligner` and `textgrids` there.

## Usage

Run from the repo root (the `annotation-tool/` directory after cloning):

```bash
# WhisperX
conda run -n whisperx python asr/transcribe.py \
    --model whisper_asr \
    --audio  /path/to/audio.wav \
    --output frontend-reactjs/public/output_whisper.TextGrid

# Parakeet (Linux + NVIDIA GPU only)
conda run -n nemo python asr/transcribe.py \
    --model parakeet \
    --audio  /path/to/audio.wav \
    --output frontend-reactjs/public/output_whisper.TextGrid
```

Setting `--output` directly to `frontend-reactjs/public/` means the TextGrid is ready to load as soon as transcription finishes.

### Changing the Whisper model size

The default checkpoint is `tiny.en` (fast, less accurate). To use a more accurate model, edit line 32 of `asr/models/whisper_asr.py`:

```python
_CHECKPOINT = "tiny.en"   # change to e.g. "base.en", "small.en", "large-v3-turbo"
```

### All flags

| Flag | Default | Description |
|---|---|---|
| `--model` | required | `whisper_asr` or `parakeet` |
| `--audio` | required | Input audio file (any format ffmpeg supports) |
| `--output` | required | Output `.TextGrid` path |
| `--no-mfa` | off | Skip MFA; Phonemes tier will be empty |
| `--dictionary` | `english_mfa` | MFA dictionary name or path |
| `--acoustic-model` | `english_mfa` | MFA acoustic model name or path |
| `--json` | off | Also save the raw ASR result as `<output>.json` |
| `--checkpoint` | model default | Override model checkpoint (Whisper only) |

### Long audio
Both models handle arbitrary-length audio without any extra flags:
- **WhisperX** uses its built-in batched VAD + chunked transcription
- **Parakeet** uses NeMo local-attention mode; auto-chunks into 60 s windows with 10 s overlap for files over 600 s

---

## Adding a new ASR model

### 1. Create `asr/models/your_model.py`

Implement a class with two methods — `setup()` and `transcribe()`:

```python
from pathlib import Path
from typing import Any, Dict, List


class YourModel:
    def __init__(self):
        self._model = None

    def setup(self) -> None:
        # Load model weights here (called once before transcribe).
        # Raise ImportError if required packages are missing.
        import your_asr_library
        self._model = your_asr_library.load(...)

    def transcribe(self, audio_path: Path) -> Dict[str, Any]:
        # Run inference and return a result dict in the standard schema below.
        raw = self._model.transcribe(str(audio_path))
        return {"segments": self._build_segments(raw)}

    def _build_segments(self, raw) -> List[Dict[str, Any]]:
        segments = []
        for seg in raw:
            words = []
            for w in seg["words"]:
                words.append({
                    "word":        w["text"],
                    "start":       float(w["start"]),
                    "end":         float(w["end"]),
                    # confidence 0–1, or None if your model doesn't provide it
                    "probability": float(w["confidence"]),
                })
            segments.append({
                "start":     float(seg["start"]),
                "end":       float(seg["end"]),
                "output":    seg["text"],
                "word_text": seg["text"],
                "words":     words,
            })
        return segments
```

**Required schema** for each segment:

| Field | Type | Notes |
|---|---|---|
| `start` | float | Segment start time in seconds |
| `end` | float | Segment end time in seconds |
| `output` | str | Segment transcript text |
| `word_text` | str | Same as `output` |
| `words` | list | Word-level entries (see below) |

**Required schema** for each word:

| Field | Type | Notes |
|---|---|---|
| `word` | str | Word text |
| `start` | float | Word start time in seconds |
| `end` | float | Word end time in seconds |
| `probability` | float or None | Confidence score 0–1; `None` if unavailable — no `score` line will be written |

### 2. Register the model in `transcribe.py`

Add an `elif` branch in `_load_model()`:

```python
elif name == "your_model":
    try:
        from asr.models.your_model import YourModel
    except ImportError:
        from models.your_model import YourModel
    m = YourModel()
    m.setup()
    return m
```

Then add it to the `choices` list on the `--model` argument:

```python
ap.add_argument("--model", required=True,
                choices=["whisper_asr", "parakeet", "your_model"],
                ...)
```

### 3. Run it

```bash
conda run -n your_env python asr/transcribe.py \
    --model your_model \
    --audio  /path/to/audio.wav \
    --output /path/to/output.TextGrid
```

MFA alignment and TextGrid writing happen automatically — no changes needed to `aligner.py` or `textgrid_writer.py`.

---

## File structure

```
asr/
├── environment-whisperx.yml  — conda spec for WhisperX (env: whisperx)
├── environment-parakeet.yml  — conda spec for Parakeet (env: nemo)
├── transcribe.py        — entry point: parses args, calls model → aligner → writer
├── aligner.py           — MFA forced alignment (segments audio, runs mfa align, parses output)
├── textgrid_writer.py   — writes Words + Phonemes tiers to a .TextGrid file
└── models/
    ├── whisper_asr.py   — WhisperX wrapper
    └── parakeet.py      — NVIDIA Parakeet NeMo wrapper
```
