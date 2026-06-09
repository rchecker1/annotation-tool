#!/usr/bin/env python3
"""
glistener/transcribe.py
~~~~~~~~~~~~~~~~~~~~~~~
Audio → TextGrid pipeline using ASR (Whisper or Parakeet) + MFA alignment.

Because ASR and MFA live in different conda environments, the pipeline is
split into two steps:

  Step 1 — ASR only (whisperx or nemo env):
      conda run -n whisperx python asr/transcribe.py \\
          --model whisper_asr \\
          --audio  /path/to/audio.wav \\
          --output /path/to/output.TextGrid \\
          --no-mfa --json

      This writes output.TextGrid (words only) and output.json.

  Step 2 — MFA + final TextGrid (aligner env):
      conda run -n aligner python asr/transcribe.py \\
          --from-json /path/to/output.json \\
          --audio     /path/to/audio.wav \\
          --output    /path/to/output.TextGrid

      This reads the JSON from step 1, runs KalpyAligner, and overwrites
      the TextGrid with both Words and Phonemes tiers.

One-step convenience (if MFA is available in the current env):
      conda run -n whisperx python asr/transcribe.py \\
          --model whisper_asr \\
          --audio  /path/to/audio.wav \\
          --output /path/to/output.TextGrid

Optional flags
--------------
  --no-mfa          Skip MFA; TextGrid will have a Words tier but empty Phonemes tier.
  --from-json PATH  Skip ASR; load a previously saved JSON result and run MFA + TextGrid.
  --dictionary      MFA dictionary name or path   (default: english_us_arpa)
  --acoustic-model  MFA acoustic model name/path  (default: english_us_arpa)
  --json            Also save the raw result dict as <output>.json
  --checkpoint      Override model checkpoint (Whisper only)

Output TextGrid tiers
---------------------
  Words     — one interval per word with a separate score line
  Phonemes  — MFA phone intervals (IPA symbols)

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
    # ASR source — either run a model or load a pre-saved JSON
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--model", choices=["whisper_asr", "parakeet"],
                     help="ASR model to run (step 1).")
    src.add_argument("--from-json", type=Path, metavar="JSON",
                     help="Skip ASR; load this JSON result file and run MFA + TextGrid (step 2).")

    ap.add_argument("--audio", required=True, type=Path,
                    help="Input audio file.")
    ap.add_argument("--output", required=True, type=Path,
                    help="Output TextGrid path.")
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

    if args.model is None and args.from_json is None:
        ap.error("Provide either --model or --from-json.")

    audio = args.audio.expanduser().resolve()
    if not audio.is_file():
        ap.error(f"Audio file not found: {audio}")

    out_path = args.output.expanduser().resolve()

    # ------------------------------------------------------------------ #
    #  Stage 1 — ASR  (skipped when --from-json is given)                 #
    # ------------------------------------------------------------------ #
    if args.from_json:
        json_src = args.from_json.expanduser().resolve()
        if not json_src.is_file():
            ap.error(f"JSON file not found: {json_src}")
        print(f"\n[glistener] Loading ASR result from {json_src}")
        with open(json_src, encoding="utf-8") as f:
            result = json.load(f)
        n_words = sum(len(seg.get("words", [])) for seg in result.get("segments", []))
        print(f"[glistener] Loaded: {len(result.get('segments', []))} segment(s), {n_words} word(s).")
    else:
        print(f"\n[glistener] Model  : {args.model}")
        print(f"[glistener] Audio  : {audio}")
        print(f"[glistener] Output : {out_path}\n")

        model = _load_model(args.model, args.checkpoint)
        print("[glistener] Transcribing…")
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
