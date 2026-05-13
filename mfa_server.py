"""
Minimal Flask server that runs Montreal Forced Aligner on an audio segment
and returns phone/word alignment as JSON.

Usage:
    conda activate aligner
    python mfa_server.py

Endpoints:
    POST /align
        multipart/form-data:
            audio    : WAV file (any sample rate — resampled to 16 kHz internally)
            words    : space-separated transcript  (e.g. "hello world")
            t_offset : float — segment start in the original file (seconds)

    GET  /health  →  {"status": "ok"}

Requirements:
    pip install flask flask-cors soundfile numpy
    mfa model download acoustic english_us_arpa
    mfa model download dictionary english_us_arpa
"""

import logging
import os
import re
import shutil
import string
import subprocess
import tempfile
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from flask import Flask, request, jsonify
from flask_cors import CORS

# ── Logging setup ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-7s  %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('mfa_server')

app = Flask(__name__)
CORS(app)
# Suppress Flask's own request logger so our log is the only output
logging.getLogger('werkzeug').setLevel(logging.WARNING)

MFA_ACOUSTIC_MODEL = os.environ.get('MFA_ACOUSTIC_MODEL', 'english_us_arpa')
MFA_DICTIONARY     = os.environ.get('MFA_DICTIONARY',     'english_us_arpa')
MFA_CMD            = os.environ.get('MFA_CMD', 'mfa').split()

TARGET_SR = 16000

# ── Audio helpers ─────────────────────────────────────────────────────────────

def _read_and_resample(path: Path) -> tuple[np.ndarray, float]:
    """Read any WAV, mix to mono, resample to TARGET_SR. Returns (samples, duration_s)."""
    data, sr = sf.read(str(path), dtype='float32', always_2d=True)
    mono = data.mean(axis=1)
    log.info('  audio loaded: sr=%d Hz, channels=%d, %.3f s', sr, data.shape[1], len(mono)/sr)

    if sr != TARGET_SR:
        log.info('  resampling %d → %d Hz …', sr, TARGET_SR)
        try:
            import soxr
            mono = soxr.resample(mono, sr, TARGET_SR, quality='HQ')
        except ImportError:
            n_out = int(len(mono) * TARGET_SR / sr)
            mono = np.interp(
                np.linspace(0, len(mono) - 1, n_out),
                np.arange(len(mono)),
                mono,
            ).astype(np.float32)

    duration = len(mono) / TARGET_SR
    log.info('  resampled duration: %.3f s (%d samples @ %d Hz)',
             duration, len(mono), TARGET_SR)
    return mono, duration


def _write_wav(path: Path, samples: np.ndarray):
    sf.write(str(path), samples, TARGET_SR, subtype='PCM_16')
    log.info('  wrote WAV: %s (%.1f KB)', path.name, path.stat().st_size / 1024)


# ── TextGrid parsers ──────────────────────────────────────────────────────────

def _parse_textgrid(text: str) -> dict[str, list]:
    lines = [l.rstrip() for l in text.splitlines()]
    is_short = bool(lines) and 'short' in lines[0].lower()
    log.info('  parsing MFA TextGrid (format=%s)', 'short' if is_short else 'long')
    return _parse_short_textgrid(lines) if is_short else _parse_long_textgrid(lines)


def _parse_long_textgrid(lines: list[str]) -> dict[str, list]:
    tiers: dict[str, list] = {}
    i = 0
    while i < len(lines):
        if re.match(r'^\s*item\s*\[\d+\]\s*:', lines[i]):
            i += 1
            tier_name = None
            items: list = []
            while i < len(lines) and not re.match(r'^\s*item\s*\[\d+\]\s*:', lines[i]):
                nm = re.match(r'^\s*name\s*=\s*"(.*)"', lines[i])
                if nm:
                    tier_name = nm.group(1)
                im = re.match(r'^\s*intervals\s*\[\d+\]\s*:', lines[i])
                if im:
                    i += 1
                    t0 = t1 = 0.0
                    text_val = ''
                    while i < len(lines) and not re.match(
                            r'^\s*(intervals|item|points)\s*\[', lines[i]):
                        m = re.match(r'^\s*xmin\s*=\s*([\d.eE+\-]+)', lines[i])
                        if m: t0 = float(m.group(1))
                        m = re.match(r'^\s*xmax\s*=\s*([\d.eE+\-]+)', lines[i])
                        if m: t1 = float(m.group(1))
                        m = re.match(r'^\s*text\s*=\s*"(.*)"', lines[i])
                        if m: text_val = m.group(1)
                        i += 1
                    items.append({'t0': t0, 't1': t1, 'text': text_val.strip()})
                    continue
                i += 1
            if tier_name:
                tiers[tier_name.lower()] = items
            continue
        i += 1
    return tiers


def _parse_short_textgrid(lines: list[str]) -> dict[str, list]:
    def unquote(s: str) -> str:
        s = s.strip()
        return s[1:-1] if s.startswith('"') and s.endswith('"') else s

    def next_val(it):
        while True:
            line = next(it).strip()
            if line:
                return line

    tiers: dict[str, list] = {}
    it = iter(lines)
    try:
        next_val(it); next_val(it)          # header lines
        next_val(it); next_val(it)          # xmin, xmax
        next_val(it)                        # <exists>
        num_tiers = int(next_val(it))
        for _ in range(num_tiers):
            next_val(it)                    # tier class
            tier_name = unquote(next_val(it))
            next_val(it); next_val(it)      # xmin, xmax
            n = int(next_val(it))
            items = []
            for _ in range(n):
                t0   = float(next_val(it))
                t1   = float(next_val(it))
                text = unquote(next_val(it)).strip()
                items.append({'t0': t0, 't1': t1, 'text': text})
            tiers[tier_name.lower()] = items
    except StopIteration:
        pass
    return tiers


# ── Validation ────────────────────────────────────────────────────────────────

def _validate_tiers(tiers: dict, seg_t0: float, seg_t1: float, words: list[str]):
    tol = 0.05
    for tier_name, items in tiers.items():
        for it in items:
            t0, t1, text = it['t0'], it['t1'], it['text']
            if t1 - t0 < -1e-6:
                raise ValueError(
                    f"Negative-duration interval [{t0:.4f}, {t1:.4f}] in '{tier_name}'"
                )
            if text and (t1 - t0) < 1e-4:
                raise ValueError(
                    f"Near-zero interval ({(t1-t0)*1000:.2f} ms) '{text}' in '{tier_name}'"
                )
            if t0 < seg_t0 - tol or t1 > seg_t1 + tol:
                raise ValueError(
                    f"Interval [{t0:.4f}, {t1:.4f}] '{text}' in '{tier_name}' "
                    f"outside segment [{seg_t0:.4f}, {seg_t1:.4f}]"
                )

    if not any('phone' in k for k in tiers):
        raise ValueError(
            "MFA output has no phones tier — alignment failed. "
            "Check acoustic model and dictionary are installed."
        )

    words_tier = tiers.get('words', [])
    found = {it['text'].strip(string.punctuation).lower() for it in words_tier if it['text']}
    for w in words:
        w_norm = w.strip(string.punctuation).lower()
        if w_norm and w_norm not in found:
            raise ValueError(
                f"Word '{w}' from transcript missing in MFA words output. "
                f"Found: {sorted(found)}"
            )


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})


@app.route('/align', methods=['POST'])
def align():
    log.info('─' * 60)
    log.info('POST /align')

    if 'audio' not in request.files:
        log.warning('  missing audio field')
        return jsonify({'error': 'Missing audio file'}), 400

    words_str = request.form.get('words', '').strip()
    t_offset  = float(request.form.get('t_offset', 0))

    if not words_str:
        return jsonify({'error': '"words" field is required'}), 400

    # Strip punctuation/case so "Yep," → "yep" before passing to MFA
    words_raw = words_str.split()
    words = [w.strip(string.punctuation).lower() for w in words_raw]
    words = [w for w in words if w]

    log.info('  t_offset=%.3f s', t_offset)
    log.info('  transcript: %s  (raw: %s)', words, words_raw)

    corpus_name  = f'seg_{uuid.uuid4().hex[:12]}'
    mfa_cache_dir = Path.home() / 'Documents' / 'MFA' / corpus_name
    tmpdir = Path(tempfile.mkdtemp(prefix='mfa_align_'))

    try:
        input_dir  = tmpdir / corpus_name
        output_dir = tmpdir / 'output'
        input_dir.mkdir()
        output_dir.mkdir()

        # ── 1. Save + normalise audio ─────────────────────────────────────────
        log.info('[1/4] Loading and resampling audio …')
        raw_path = tmpdir / 'raw.wav'
        request.files['audio'].save(str(raw_path))
        log.info('  raw file: %.1f KB', raw_path.stat().st_size / 1024)

        samples, duration = _read_and_resample(raw_path)

        if duration < 0.05:
            log.warning('  audio too short: %.1f ms', duration * 1000)
            return jsonify({'error': f'Audio too short ({duration*1000:.0f} ms)'}), 400

        _write_wav(input_dir / 'segment.wav', samples)

        # ── 2. Write .lab transcript ──────────────────────────────────────────
        log.info('[2/4] Writing transcript …')
        transcript = ' '.join(words)
        lab_path = input_dir / 'segment.lab'
        lab_path.write_text(transcript, encoding='utf-8')
        log.info('  .lab: "%s"', transcript)

        # ── 3. Run MFA ────────────────────────────────────────────────────────
        cmd = MFA_CMD + [
            'align', '--clean', '--overwrite',
            str(input_dir), MFA_DICTIONARY, MFA_ACOUSTIC_MODEL, str(output_dir),
        ]
        log.info('[3/4] Running MFA …')
        log.info('  cmd: %s', ' '.join(cmd))

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)

        # Always show MFA's stderr so issues are visible in the terminal
        for line in result.stderr.splitlines():
            line = line.strip()
            if line:
                log.info('  mfa> %s', line)

        if result.returncode != 0:
            log.error('  MFA exited with code %d', result.returncode)
            return jsonify({'error': 'MFA alignment failed',
                            'detail': result.stderr[-3000:]}), 500

        out_tg = output_dir / 'segment.TextGrid'
        if not out_tg.exists():
            log.error('  MFA succeeded but no output TextGrid found in %s', output_dir)
            return jsonify({'error': 'MFA ran but produced no TextGrid',
                            'detail': result.stdout[-1000:] + result.stderr[-1000:]}), 500

        log.info('  output TextGrid: %.1f KB', out_tg.stat().st_size / 1024)

        # ── 4. Parse, validate, shift ─────────────────────────────────────────
        log.info('[4/4] Parsing and validating output …')
        tg_text = out_tg.read_text(encoding='utf-8')
        tiers = _parse_textgrid(tg_text)

        if not tiers:
            return jsonify({'error': 'Could not parse MFA TextGrid',
                            'detail': tg_text[:500]}), 500

        for tier_name, items in tiers.items():
            labeled = [it for it in items if it['text']]
            log.info('  tier %-10s  %d intervals (%d labeled)',
                     f"'{tier_name}'", len(items), len(labeled))

        seg_t0 = t_offset
        seg_t1 = t_offset + duration
        tiers_shifted = {
            name: [{'t0': round(it['t0'] + t_offset, 6),
                    't1': round(it['t1'] + t_offset, 6),
                    'text': it['text']}
                   for it in items]
            for name, items in tiers.items()
        }

        try:
            _validate_tiers(tiers_shifted, seg_t0, seg_t1, words)
        except ValueError as exc:
            log.error('  validation failed: %s', exc)
            return jsonify({'error': 'Validation failed', 'detail': str(exc)}), 422

        phones_key  = next((k for k in tiers_shifted if 'phone' in k), None)
        phones_tier = tiers_shifted.get(phones_key, [])
        words_tier  = tiers_shifted.get('words', [])

        log.info('  → %d phones, %d words returned', len(phones_tier), len(words_tier))
        log.info('  phones: %s', [p['text'] for p in phones_tier if p['text']])
        log.info('SUCCESS')

        return jsonify({'phones': phones_tier, 'words': words_tier,
                        't0': seg_t0, 't1': seg_t1})

    except subprocess.TimeoutExpired:
        log.error('  MFA timed out after 180 s')
        return jsonify({'error': 'MFA timed out (180 s)'}), 504
    except Exception as exc:
        log.exception('  unexpected error: %s', exc)
        return jsonify({'error': str(exc)}), 500
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        shutil.rmtree(mfa_cache_dir, ignore_errors=True)


if __name__ == '__main__':
    port = int(os.environ.get('MFA_SERVER_PORT', 5050))
    log.info('MFA server starting on http://localhost:%d', port)
    log.info('  Acoustic model : %s', MFA_ACOUSTIC_MODEL)
    log.info('  Dictionary     : %s', MFA_DICTIONARY)
    log.info('  MFA command    : %s', ' '.join(MFA_CMD))
    app.run(host='127.0.0.1', port=port, debug=False)
