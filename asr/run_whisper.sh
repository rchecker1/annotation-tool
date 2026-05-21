#!/bin/bash

conda run -n whisperx python glistener/transcribe.py \
    --model whisper_asr \
    --audio "/home/alisartazkhan/data/test/test1/Bluey_blueyp1aud_region280–350s_original.wav" \
    --output "/home/alisartazkhan/data/test/test1/output_whisper.TextGrid"