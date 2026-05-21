/**
 * mfaWorker.js — Web Worker that:
 *   1. Receives a Float32Array audio slice + metadata
 *   2. Encodes it to a 16-bit PCM WAV blob (no external lib needed)
 *   3. POSTs it to the local MFA server
 *   4. Returns the parsed phones/words JSON to the main thread
 *
 * Input message:
 *   {
 *     ch       : Float32Array   — mono channel data for the segment
 *     sr       : number         — sample rate
 *     t0       : number         — segment start in global file time (seconds)
 *     t1       : number         — segment end
 *     words    : string         — space-separated transcript
 *     serverUrl: string         — e.g. "http://localhost:5050"
 *   }
 *
 * Output message (success):
 *   { ok: true, phones: [...], words: [...], t0, t1 }
 *
 * Output message (error):
 *   { ok: false, error: string }
 */

// ── WAV encoder ───────────────────────────────────────────────────────────────

function encodeWav(samples, sampleRate) {
  const numSamples = samples.length;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // Convert float32 → int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// ── Main ──────────────────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  const { ch, sr, t0, t1, words, serverUrl } = data;

  try {
    // Validate inputs before doing anything expensive
    if (!ch || ch.length === 0) throw new Error('Audio channel data is empty');
    if (!words || !words.trim()) throw new Error('No words provided for alignment');
    if (t1 <= t0) throw new Error(`Invalid segment bounds: t0=${t0} t1=${t1}`);

    const wavBlob = encodeWav(ch, sr);

    const form = new FormData();
    form.append('audio', wavBlob, 'segment.wav');
    form.append('words', words.trim());
    form.append('t_offset', String(t0));

    const resp = await fetch(`${serverUrl}/align`, {
      method: 'POST',
      body: form,
    });

    const json = await resp.json();

    if (!resp.ok) {
      const detail = json.detail ? `\n${json.detail}` : '';
      throw new Error(`Server error ${resp.status}: ${json.error || 'unknown'}${detail}`);
    }

    self.postMessage({ ok: true, phones: json.phones, words: json.words, t0: json.t0, t1: json.t1, warning: json.warning || null });

  } catch (err) {
    self.postMessage({ ok: false, error: err.message || String(err) });
  }
};
