#!/usr/bin/env python3
"""
glistener/transcribe.py
~~~~~~~~~~~~~~~~~~~~~~~
Audio → TextGrid pipeline using ASR (Whisper or Parakeet) + MFA alignment.

Usage
-----
# Whisper ASR + MFA (whisperx conda env)
    conda run -n whisperx python /home/alisartazkhan/glistener/transcribe.py \\
        --model whisper_asr \\
        --audio  /path/to/audio.wav \\
        --output /path/to/output.TextGrid

# Parakeet ASR + MFA (nemo conda env)
    conda run -n nemo python /home/alisartazkhan/glistener/transcribe.py \\
        --model parakeet \\
        --audio  /path/to/audio.wav \\
        --output /path/to/output.TextGrid

Optional flags
--------------
  --no-mfa          Skip MFA; TextGrid will have a Words tier but empty Phonemes tier.
  --dictionary      MFA dictionary name or path   (default: english_us_arpa)
  --acoustic-model  MFA acoustic model name/path  (default: english_us_arpa)
  --json            Also save the raw result dict as <output>.json
  --checkpoint      Override model checkpoint (Whisper only)

Output TextGrid tiers
---------------------
  Words     — word intervals with label  "word [conf=0.9512]"
  Phonemes  — MFA phone intervals (IPA / ARPAbet symbols)

Notes on long audio
-------------------
Both models handle arbitrary-length audio:
  • Whisper uses the Transformers pipeline with chunk_length_s=30 + stride.
  • Parakeet uses NeMo's local-attention mode and falls back to explicit
    60-second overlapping chunks for files > 600 s.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Make the glistener package importable when run as a script from any cwd.
# _HERE  = .../glistener/
# _REPO  = .../           (parent of the glistener package dir)
_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
for _p in (_REPO, _HERE):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


def _load_model(name: str, checkpoint: str | None):
    if name == "whisper_asr":
        try:
            from glistener.models.whisper_asr import WhisperASR
        except ImportError:
            from models.whisper_asr import WhisperASR
        m = WhisperASR(checkpoint=checkpoint) if checkpoint else WhisperASR()
        m.setup()
        return m
    elif name == "parakeet":
        try:
            from glistener.models.parakeet import ParakeetASR
        except ImportError:
            from models.parakeet import ParakeetASR
        m = ParakeetASR(checkpoint=checkpoint) if checkpoint else ParakeetASR()
        m.setup()
        return m
    else:
        raise ValueError(f"Unknown model '{name}'. Choose: whisper_asr | parakeet")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--model", required=True,
                    choices=["whisper_asr", "parakeet"],
                    help="ASR model to use.")
    ap.add_argument("--audio", required=True, type=Path,
                    help="Input audio file (any format supported by ffmpeg/librosa).")
    ap.add_argument("--output", required=True, type=Path,
                    help="Output TextGrid path (e.g. result.TextGrid).")
    ap.add_argument("--no-mfa", action="store_true",
                    help="Skip MFA forced alignment (Phonemes tier will be empty).")
    ap.add_argument("--dictionary", default="english_us_arpa",
                    help="MFA dictionary name or path (default: english_us_arpa).")
    ap.add_argument("--acoustic-model", default="english_us_arpa", dest="acoustic_model",
                    help="MFA acoustic model name or path (default: english_us_arpa).")
    ap.add_argument("--json", action="store_true",
                    help="Also save raw ASR result as <output>.json.")
    ap.add_argument("--checkpoint", default=None,
                    help="Override the default model checkpoint (Whisper only).")
    args = ap.parse_args()

    audio = args.audio.expanduser().resolve()
    if not audio.is_file():
        ap.error(f"Audio file not found: {audio}")

    out_path = args.output.expanduser().resolve()

    # ------------------------------------------------------------------ #
    #  Stage 1 — ASR                                                       #
    # ------------------------------------------------------------------ #
    print(f"\n[glistener] Model  : {args.model}")
    print(f"[glistener] Audio  : {audio}")
    print(f"[glistener] Output : {out_path}\n")

    model = _load_model(args.model, args.checkpoint)
    print(f"[glistener] Transcribing…")
    result = model.transcribe(audio)
    result["source_file"] = str(audio)
    result["model"] = args.model

    n_words = sum(len(seg.get("words", [])) for seg in result.get("segments", []))
    n_segs  = len(result.get("segments", []))
    print(f"[glistener] ASR done: {n_segs} segment(s), {n_words} word(s).")

    # ------------------------------------------------------------------ #
    #  Stage 2 — MFA phoneme alignment                                     #
    # ------------------------------------------------------------------ #
    if not args.no_mfa:
        print("[glistener] Running MFA alignment…")
        try:
            from glistener.aligner import run_mfa
        except ImportError:
            from aligner import run_mfa
        result = run_mfa(
            result,
            audio,
            dictionary=args.dictionary,
            acoustic_model=args.acoustic_model,
        )
        n_phones = len(result.get("phoneme_chars_mfa_flat", []))
        print(f"[glistener] MFA done: {n_phones} phone interval(s).")
    else:
        print("[glistener] Skipping MFA (--no-mfa).")

    # ------------------------------------------------------------------ #
    #  Stage 3 — TextGrid                                                  #
    # ------------------------------------------------------------------ #
    print("[glistener] Writing TextGrid…")
    try:
        from glistener.textgrid_writer import write_textgrid
    except ImportError:
        from textgrid_writer import write_textgrid
    write_textgrid(result, out_path)

    if args.json:
        json_path = out_path.with_suffix(".json")
        json_path.parent.mkdir(parents=True, exist_ok=True)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"[glistener] JSON saved → {json_path}")

    print("\n[glistener] Done.")


if __name__ == "__main__":
    main()
