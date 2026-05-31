#!/usr/bin/env python3
"""
DSP server: computes mel spectrogram and formants for a WAV file region.

Called by the Vite dev-server middleware via subprocess:
  python dsp_server.py <wav_path> <t0> <t1> <n_mels> <n_fft> <colormap>

Prints a single JSON object to stdout:
{
  "spec": {                       // mel spectrogram as RGBA pixel strip
    "pixels": [...],              // flat RGBA Uint8 array, row-major (top=high freq)
    "pw": <int>,                  // pixel width
    "ph": <int>,                  // pixel height
    "stripT0": <float>,
    "stripT1": <float>
  },
  "formants": {                   // Praat Burg formant track
    "f1": [...],                  // Hz per frame (0 = unvoiced)
    "f2": [...],
    "f3": [...],
    "times": [...],               // center time of each frame in seconds
    "regionT0": <float>,
    "sr": <int>
  }
}
"""
import sys
import json
import numpy as np
import librosa
import parselmouth
from parselmouth.praat import call

COLORMAPS = {
    "inferno": [
        [0,0,4],[40,11,84],[101,21,110],[159,42,99],
        [212,72,66],[245,125,21],[252,194,75],[252,255,164]
    ],
    "viridis": [
        [68,1,84],[72,40,120],[62,83,160],[49,120,165],
        [38,150,162],[53,183,121],[109,206,89],[180,222,44],[253,231,37]
    ],
    "jet": None,   # handled separately
    "greys": None, # handled separately
}

def lerp_stops(stops, t):
    t = max(0.0, min(1.0, t))
    n = len(stops) - 1
    idx = min(n - 1, int(t * n))
    f = t * n - idx
    a, b = stops[idx], stops[idx + 1]
    return [int(a[i] + (b[i] - a[i]) * f) for i in range(3)]

def colormap_fn(name, t):
    t = max(0.0, min(1.0, t))
    if name == "jet":
        r = max(0, min(1, 1.5 - abs(4*t - 3)))
        g = max(0, min(1, 1.5 - abs(4*t - 2)))
        b = max(0, min(1, 1.5 - abs(4*t - 1)))
        return [int(r*255), int(g*255), int(b*255)]
    if name == "greys":
        v = int(t * 255)
        return [v, v, v]
    stops = COLORMAPS.get(name) or COLORMAPS["inferno"]
    return lerp_stops(stops, t)

def compute_spectrogram(y, sr, t0, t1, n_mels, n_fft, colormap, pw=1200, ph=200):
    """Compute mel spectrogram and return RGBA pixel strip."""
    # Full-file mel spec, then slice the time range
    hop = max(128, n_fft // 4)
    S = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=n_mels, n_fft=n_fft, hop_length=hop, fmax=min(8000, sr//2))
    S_db = librosa.power_to_db(S, ref=np.max)

    # Normalize 0-1
    vmin, vmax = S_db.min(), S_db.max()
    rng = vmax - vmin if vmax > vmin else 1.0
    S_norm = (S_db - vmin) / rng

    # Frame range for t0..t1
    total_frames = S_norm.shape[1]
    duration = len(y) / sr
    f0 = max(0, int(t0 / duration * total_frames))
    f1 = min(total_frames, int(t1 / duration * total_frames) + 1)
    strip = S_norm[:, f0:f1]  # (n_mels, frames)

    n_mels_actual, n_frames = strip.shape
    pixels = []
    for cy in range(ph):
        mel_idx = (ph - 1 - cy) / (ph - 1) * (n_mels_actual - 1)
        m0 = int(mel_idx)
        m1 = min(n_mels_actual - 1, m0 + 1)
        mt = mel_idx - m0
        for cx in range(pw):
            frame_idx = cx / (pw - 1) * (n_frames - 1) if n_frames > 1 else 0
            fr0 = int(frame_idx)
            fr1 = min(n_frames - 1, fr0 + 1)
            ft = frame_idx - fr0
            v = (strip[m0, fr0] * (1-ft) * (1-mt) +
                 strip[m0, fr1] * ft     * (1-mt) +
                 strip[m1, fr0] * (1-ft) * mt     +
                 strip[m1, fr1] * ft     * mt)
            rgb = colormap_fn(colormap, float(v))
            pixels += rgb + [255]

    return {"pixels": pixels, "pw": pw, "ph": ph, "stripT0": t0, "stripT1": t1}

def compute_formants(wav_path, t0, t1):
    """Use Praat Burg algorithm to extract F1/F2/F3 for the region t0..t1."""
    snd = parselmouth.Sound(wav_path)
    sr = int(snd.sampling_frequency)

    # Extract the region
    region = snd.extract_part(from_time=t0, to_time=t1, preserve_times=True)

    # Praat Burg formant tracking — max 5500 Hz ceiling (typical for adult speech)
    formant = call(region, "To Formant (burg)", 0.0, 5, 5500, 0.025, 50)

    times_list = []
    f1_list = []
    f2_list = []
    f3_list = []

    n_frames = call(formant, "Get number of frames")
    for i in range(1, n_frames + 1):
        t = call(formant, "Get time from frame number", i)
        # Get formant values (returns NaN if unvoiced)
        f1 = call(formant, "Get value at time", 1, t, "Hertz", "Linear")
        f2 = call(formant, "Get value at time", 2, t, "Hertz", "Linear")
        f3 = call(formant, "Get value at time", 3, t, "Hertz", "Linear")
        times_list.append(round(float(t), 5))
        f1_list.append(round(float(f1), 2) if f1 == f1 else 0)  # NaN check
        f2_list.append(round(float(f2), 2) if f2 == f2 else 0)
        f3_list.append(round(float(f3), 2) if f3 == f3 else 0)

    return {
        "f1": f1_list,
        "f2": f2_list,
        "f3": f3_list,
        "times": times_list,
        "regionT0": t0,
        "sr": sr,
    }

def main():
    if len(sys.argv) < 7:
        print(json.dumps({"error": "usage: dsp_server.py <wav> <t0> <t1> <n_mels> <n_fft> <colormap> [pw] [ph]"}))
        sys.exit(1)

    wav_path = sys.argv[1]
    t0       = float(sys.argv[2])
    t1       = float(sys.argv[3])
    n_mels   = int(sys.argv[4])
    n_fft    = int(sys.argv[5])
    colormap = sys.argv[6]
    pw       = int(sys.argv[7]) if len(sys.argv) > 7 else 1400
    ph       = int(sys.argv[8]) if len(sys.argv) > 8 else 400

    y, sr = librosa.load(wav_path, sr=None, mono=True)
    duration = len(y) / sr
    t0 = max(0.0, t0)
    t1 = min(duration, t1)

    spec     = compute_spectrogram(y, sr, t0, t1, n_mels, n_fft, colormap, pw=pw, ph=ph)
    formants = compute_formants(wav_path, t0, t1)

    print(json.dumps({"spec": spec, "formants": formants}))

if __name__ == "__main__":
    main()
