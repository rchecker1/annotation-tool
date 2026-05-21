"""
aligner.py
~~~~~~~~~~
MFA (Montreal Forced Aligner) phoneme alignment.

Given an ASR result dict (segments with word-level timestamps) and the
original audio file, runs `mfa align` per segment, then writes phoneme
intervals back into each segment under ``phoneme_chars_mfa``.

Resolution order for the mfa binary:
  1. MFA_EXECUTABLE env var
  2. <conda_root>/envs/<MFA_CONDA_ENV>/bin/mfa   (default env name: aligner)
  3. shutil.which("mfa")

Prerequisites (one-time):
    mfa model download dictionary english_mfa
    mfa model download acoustic english_mfa
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import textgrids
    _TEXTGRIDS_OK = True
except ImportError:
    _TEXTGRIDS_OK = False


# ---------------------------------------------------------------------------
# MFA executable resolution
# ---------------------------------------------------------------------------

def _resolve_mfa() -> Optional[str]:
    override = os.environ.get("MFA_EXECUTABLE", "").strip()
    if override and Path(override).is_file():
        return override

    conda_exe = os.environ.get("CONDA_EXE", "").strip()
    if conda_exe:
        env_name = os.environ.get("MFA_CONDA_ENV", "aligner").strip() or "aligner"
        root = Path(conda_exe).resolve().parent.parent
        candidate = root / "envs" / env_name / "bin" / "mfa"
        if candidate.is_file():
            return str(candidate)

    return shutil.which("mfa")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _segment_text(seg: Dict[str, Any]) -> str:
    words = seg.get("words") or []
    parts = [(w.get("word") or "").strip() for w in words if (w.get("word") or "").strip()]
    if parts:
        return " ".join(parts)
    return (seg.get("word_text") or seg.get("output") or "").strip()


def _safe_id(stem: str, idx: int) -> str:
    base = re.sub(r"[^\w]+", "_", stem, flags=re.ASCII).strip("_")
    return f"{base or 'utt'}_{idx:04d}"


def _ffmpeg_slice(src: Path, dst: Path, t0: float, duration: float) -> bool:
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src),
        "-ss", str(t0), "-t", str(duration),
        "-acodec", "pcm_s16le",
        str(dst),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        return r.returncode == 0 and dst.is_file()
    except (OSError, subprocess.TimeoutExpired):
        return False


# ---------------------------------------------------------------------------
# Main align function
# ---------------------------------------------------------------------------

def run_mfa(
    result: Dict[str, Any],
    audio_path: Path,
    dictionary: str = "english_mfa",
    acoustic_model: str = "english_mfa",
) -> Dict[str, Any]:
    """
    Mutates *result* in-place: adds ``phoneme_chars_mfa`` to each segment
    and ``phoneme_chars_mfa_flat`` at the top level.

    Returns the (possibly mutated) result dict.
    """
    if not _TEXTGRIDS_OK:
        print("[MFA] Skipping: install the 'textgrids' package to parse MFA output.")
        return result

    mfa_exe = _resolve_mfa()
    if mfa_exe is None:
        print(
            "[MFA] Skipping: mfa binary not found.\n"
            "  Install: mamba create -n aligner -c conda-forge montreal-forced-aligner\n"
            "  Then:    mfa model download dictionary english_mfa\n"
            "           mfa model download acoustic english_mfa"
        )
        return result

    if not shutil.which("ffmpeg"):
        print("[MFA] Skipping: ffmpeg not found (needed to slice segments).")
        return result

    segments: List[Dict[str, Any]] = result.get("segments", [])
    if not segments:
        return result

    audio_path = audio_path.resolve()
    stem = audio_path.stem

    with tempfile.TemporaryDirectory() as tmpdir:
        corpus  = Path(tmpdir) / "corpus"
        out_dir = Path(tmpdir) / "out"
        corpus.mkdir()
        out_dir.mkdir()

        plan: List[Tuple[int, float, str]] = []  # (seg_index, global_offset, utt_id)

        for seg_i, seg in enumerate(segments):
            text = _segment_text(seg)
            if not text:
                continue
            t0  = float(seg.get("start") or 0)
            t1  = float(seg.get("end")   or 0)
            dur = t1 - t0
            if dur < 0.05:
                continue

            utt_id  = _safe_id(stem, seg_i)
            wav_out = corpus / f"{utt_id}.wav"
            if not _ffmpeg_slice(audio_path, wav_out, t0, dur):
                print(f"[MFA] ffmpeg failed for segment {seg_i}; skipping.")
                continue
            (corpus / f"{utt_id}.lab").write_text(text + "\n", encoding="utf-8")
            plan.append((seg_i, t0, utt_id))

        if not plan:
            print("[MFA] No usable segments; skipping.")
            return result

        mfa_bin_dir = Path(mfa_exe).resolve().parent
        env = os.environ.copy()
        env["PATH"] = str(mfa_bin_dir) + os.pathsep + env.get("PATH", "")

        cmd = [
            mfa_exe, "align", "--clean",
            "--num_jobs", "1",
            "--single_speaker",
            str(corpus), dictionary, acoustic_model, str(out_dir),
        ]
        print(f"[MFA] Aligning {len(plan)} segment(s): {' '.join(cmd)}")
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=7200, env=env,
            )
        except FileNotFoundError:
            print("[MFA] subprocess failed to start.")
            return result
        except subprocess.TimeoutExpired:
            print("[MFA] Timed out.")
            return result

        if proc.returncode != 0:
            print(f"[MFA] Failed (exit {proc.returncode}).")
            if proc.stderr:
                print(proc.stderr[-4000:])
            return result

        flat_phones: List[Dict[str, Any]] = []

        for seg_i, offset, utt_id in plan:
            tg_path = out_dir / f"{utt_id}.TextGrid"
            if not tg_path.is_file():
                cands = list(out_dir.rglob(f"{utt_id}.TextGrid"))
                tg_path = cands[0] if cands else tg_path
            if not tg_path.is_file():
                print(f"[MFA] Missing TextGrid for {utt_id}")
                continue

            try:
                grid = textgrids.TextGrid(str(tg_path))
            except Exception as e:
                print(f"[MFA] Could not read {tg_path}: {e}")
                continue

            tier_name = next((k for k in grid if "phone" in k.lower()), None)
            if tier_name is None:
                print(f"[MFA] No phones tier for {utt_id}. Tiers: {list(grid.keys())}")
                continue

            local: List[Dict[str, Any]] = []
            for iv in grid[tier_name]:
                txt = getattr(iv, "text", "") or ""
                if isinstance(txt, list):
                    txt = "".join(str(x) for x in txt)
                txt = str(txt).strip()
                if not txt or txt in {"sil", "spn", "sp", "SIL", "<eps>"}:
                    continue
                try:
                    xs, xe = float(iv.xmin), float(iv.xmax)
                except (TypeError, ValueError):
                    continue
                phone = {"char": txt, "start": offset + xs, "end": offset + xe}
                local.append(phone)
                flat_phones.append(phone)

            segments[seg_i]["phoneme_chars_mfa"] = local
            if local and not segments[seg_i].get("phoneme_chars"):
                segments[seg_i]["phoneme_chars"] = local
            if local and not segments[seg_i].get("phoneme_text"):
                segments[seg_i]["phoneme_text"] = " ".join(p["char"] for p in local)

        flat_phones.sort(key=lambda p: (p["start"], p["end"]))
        result["phoneme_chars_mfa_flat"] = flat_phones
        result["aligner"] = "mfa"

    return result
