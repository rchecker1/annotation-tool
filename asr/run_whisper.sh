#!/bin/bash
# Run from the annotation-tool/ directory.
# Usage: bash asr/run_whisper.sh /path/to/audio.wav [output_name]
#
# output_name defaults to "output_whisper" — the TextGrid and JSON are written
# to frontend-reactjs/public/<output_name>.TextGrid / .json

set -euo pipefail

AUDIO="${1:?Usage: bash asr/run_whisper.sh /path/to/audio.wav [output_name]}"
NAME="${2:-output_whisper}"
OUTPUT="frontend-reactjs/public/${NAME}.TextGrid"
JSON="frontend-reactjs/public/${NAME}.json"

echo "[run_whisper] Step 1: transcribing with WhisperX…"
conda run -n whisperx python asr/transcribe.py \
    --model whisper_asr \
    --audio "$AUDIO" \
    --json  "$JSON"

echo "[run_whisper] Step 2: MFA alignment + TextGrid…"
conda run -n aligner python asr/transcribe.py \
    --from-json "$JSON" \
    --audio     "$AUDIO" \
    --output    "$OUTPUT"

echo "[run_whisper] Done → $OUTPUT"
