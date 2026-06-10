# Automatic Transcription

Generate an initial TextGrid from audio using automatic word and phoneme transcription.

[← Back to README](README.md) · [Usage →](USAGE.md) · [Advanced features →](ADVANCED.md)

## Audio Transcription

To perform automatic transcription on your own audio file, run from the `annotation-tool/` directory:

```bash
bash asr/run_whisper.sh /path/to/your/audio.wav [output_filename] # output_filename is optional
```

This handles everything — word and phoneme transcription and alignment. 

If you specify an output file name, the resulting TextGrid will be saved to `frontend-reactjs/public/output_filename.TextGrid` otherwise the default filename is `output_whisper.TextGrid`.

**Changing the Whisper model size** — by default WhisperX uses `tiny.en` (fast, less accurate). To use a larger model, edit line 32 of `asr/models/whisper_asr.py`:

```python
_CHECKPOINT = "tiny.en"   # change to e.g. "base.en", "small.en", "large-v3-turbo"
```

Larger models are more accurate but slower. See the [WhisperX docs](https://github.com/m-bain/whisperX) for all available checkpoints.

<video src="https://github.com/user-attachments/assets/1f9cb5c7-2829-4bd2-9c47-d2ca2fb4b183" controls width="100%"></video>
