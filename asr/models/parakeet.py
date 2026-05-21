"""
models/parakeet.py
~~~~~~~~~~~~~~~~~~
NVIDIA Parakeet TDT 0.6B v3 via NeMo.

Returns the standard result schema with word-level confidence scores.
Long files (> 600 s) are automatically split into overlapping chunks.

Conda env: nemo
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Dict, List

import torch


_CHECKPOINT  = "nvidia/parakeet-tdt-0.6b-v3"
_CHUNK_LEN   = 60.0
_OVERLAP     = 10.0
_LONG_THRESH = 600.0


class ParakeetASR:
    def __init__(self, checkpoint: str = _CHECKPOINT):
        self._checkpoint = checkpoint
        self._model = None
        self.device = "cuda" if torch.cuda.is_available() else "cpu"

    def setup(self) -> None:
        try:
            import nemo.collections.asr as nemo_asr  # type: ignore
        except ImportError as exc:
            raise ImportError("nemo_toolkit not installed — activate the 'nemo' conda env.") from exc
        self._load_model()

    def _load_model(self) -> None:
        import nemo.collections.asr as nemo_asr  # type: ignore

        print(f"[ParakeetASR] Loading {self._checkpoint} on {self.device}…")
        model = nemo_asr.models.ASRModel.from_pretrained(model_name=self._checkpoint)

        if hasattr(model, "change_attention_model"):
            try:
                model.change_attention_model(
                    self_attention_model="rel_pos_local_attn",
                    att_context_size=[64, 64],
                )
                print("[ParakeetASR] Local attention enabled.")
            except Exception as e:
                print(f"[ParakeetASR] Could not set local attention: {e}")

        if hasattr(model, "change_decoding_strategy"):
            from omegaconf import OmegaConf  # type: ignore
            cfg = OmegaConf.to_container(model.cfg.decoding, resolve=True)
            cfg.setdefault("confidence_cfg", {})
            cfg["confidence_cfg"]["preserve_word_confidence"] = True
            cfg["confidence_cfg"]["tdt_include_duration"]      = True
            cfg["confidence_cfg"]["method_cfg"]                = {"name": "max_prob"}
            cfg["confidence_cfg"]["aggregation"]               = "mean"
            cfg["compute_word_confidence"]                     = True
            model.change_decoding_strategy(cfg)
            print("[ParakeetASR] Word confidence enabled.")

        model.to(self.device)
        model.eval()
        self._model = model

    # ------------------------------------------------------------------

    def transcribe(self, audio_path: Path) -> Dict[str, Any]:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        duration = _audio_duration(audio_path)
        if duration > _LONG_THRESH:
            print(f"[ParakeetASR] Long file ({duration:.1f}s) — chunked mode.")
            return self._transcribe_chunked(audio_path)

        try:
            return self._transcribe_full(audio_path)
        except (RuntimeError,) as e:
            print(f"[ParakeetASR] Error: {e}. Retrying in chunked mode…")
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            self._load_model()
            return self._transcribe_chunked(audio_path)

    # ------------------------------------------------------------------

    def _transcribe_full(self, audio_path: Path) -> Dict[str, Any]:
        output = self._model.transcribe(
            [str(audio_path)],
            return_hypotheses=True,
            timestamps=True,
        )
        hyp = output[0]
        return {"segments": self._build_segments(hyp, time_offset=0.0)}

    def _transcribe_chunked(self, audio_path: Path) -> Dict[str, Any]:
        import librosa      # type: ignore
        import soundfile as sf  # type: ignore

        audio, sr = librosa.load(str(audio_path), sr=16000)
        duration  = len(audio) / sr
        all_segs: List[Dict] = []

        start = 0.0
        while start < duration:
            end         = min(start + _CHUNK_LEN, duration)
            chunk_audio = audio[int(start * sr): int(end * sr)]

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
                sf.write(tmp.name, chunk_audio, sr)
                try:
                    output = self._model.transcribe(
                        [tmp.name],
                        return_hypotheses=True,
                        timestamps=True,
                    )
                    hyp  = output[0]
                    segs = self._build_segments(hyp, time_offset=start)

                    half_ov = _OVERLAP / 2
                    for seg in segs:
                        rel = seg["start"] - start
                        if (start > 0) and rel < half_ov:
                            continue
                        if (end < duration) and rel > _CHUNK_LEN - half_ov:
                            continue
                        all_segs.append(seg)
                except Exception as e:
                    print(f"[ParakeetASR] Chunk at {start:.0f}s failed: {e}")

            if end >= duration:
                break
            start += _CHUNK_LEN - _OVERLAP

        return {"segments": all_segs}

    # ------------------------------------------------------------------

    def _build_segments(self, hyp, time_offset: float) -> List[Dict[str, Any]]:
        word_ts = hyp.timestamp.get("word",    [])
        seg_ts  = hyp.timestamp.get("segment", [])
        char_ts = hyp.timestamp.get("char",    [])
        confs   = list(getattr(hyp, "word_confidence", []) or [])

        segments: List[Dict[str, Any]] = []
        word_idx = 0
        for seg in seg_ts:
            s   = float(seg["start"])
            e   = float(seg["end"])
            txt = seg["segment"]

            seg_words: List[Dict] = []
            for w in word_ts:
                if float(w["start"]) >= s and float(w["end"]) <= e:
                    entry: Dict[str, Any] = {
                        "word":  w["word"],
                        "start": w["start"] + time_offset,
                        "end":   w["end"]   + time_offset,
                    }
                    if confs and word_idx < len(confs):
                        entry["probability"] = float(confs[word_idx])
                        word_idx += 1
                    elif "confidence" in w:
                        entry["probability"] = float(w["confidence"])
                    seg_words.append(entry)

            seg_chars: List[Dict] = [
                {"char": c["char"], "start": c["start"] + time_offset, "end": c["end"] + time_offset}
                for c in char_ts
                if float(c["start"]) >= s and float(c["end"]) <= e
            ]

            segments.append({
                "start":     s   + time_offset,
                "end":       e   + time_offset,
                "output":    txt,
                "word_text": txt,
                "words":     seg_words,
                "chars":     seg_chars,
            })
        return segments


# ------------------------------------------------------------------

def _audio_duration(path: Path) -> float:
    try:
        import librosa  # type: ignore
        return float(librosa.get_duration(path=str(path)))
    except Exception:
        import subprocess
        out = subprocess.check_output(
            f"ffprobe -v error -show_entries format=duration "
            f"-of default=noprint_wrappers=1:nokey=1 {path}",
            shell=True,
        )
        return float(out.decode().strip())
