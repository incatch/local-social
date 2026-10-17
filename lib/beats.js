// Radius beats: short music loops made here, note by note, so Moment
// Reels never use anyone else's music. Three moods; each Moment gets one
// (picked from its id) so the same Moment always sounds the same.

const RATE = 44100;

const STYLES = {
  // bpm, beats per photo, root notes (Hz) for the bass, chord (ratios), swing
  chill: { bpm: 92, perShot: 3, roots: [110, 98, 87.31, 98], chord: [1, 1.26, 1.5, 1.89], hat: 0.18 },
  bright: { bpm: 118, perShot: 4, roots: [130.81, 146.83, 110, 123.47], chord: [1, 1.26, 1.5, 2], hat: 0.24 },
  night: { bpm: 102, perShot: 3, roots: [110, 130.81, 98, 87.31], chord: [1, 1.19, 1.5, 1.78], hat: 0.2 },
};
const STYLE_NAMES = Object.keys(STYLES);

/** A small, repeatable random number source (so a Moment's beat never changes). */
function rng(seed) {
  let x = (Number(seed) * 2654435761) % 4294967296 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

function styleFor(seed) {
  return STYLE_NAMES[Math.abs(Number(seed) || 0) % STYLE_NAMES.length];
}

/** A beat `seconds` long, as a 16-bit stereo WAV file. */
function makeBeat({ seconds, style = "chill", seed = 1 }) {
  const s = STYLES[style] || STYLES.chill;
  const n = Math.ceil(seconds * RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const beat = 60 / s.bpm;
  const rand = rng(seed);
  const add = (start, len, fn, pan = 0) => {
    const a = Math.max(0, Math.floor(start * RATE));
    const b = Math.min(n, a + Math.floor(len * RATE));
    for (let i = a; i < b; i++) {
      const v = fn((i - a) / RATE);
      left[i] += v * (1 - pan);
      right[i] += v * (1 + pan);
    }
  };
  const beats = Math.ceil(seconds / beat);
  for (let k = 0; k < beats; k++) {
    const t = k * beat;
    const bar = Math.floor(k / 4);
    const root = s.roots[bar % s.roots.length];
    // Kick on 1 and 3, a soft clap on 2 and 4.
    if (k % 2 === 0) add(t, 0.35, (x) => Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-x * 30)) * x) * Math.exp(-x * 9) * 0.9);
    else add(t, 0.18, (x) => (rand() * 2 - 1) * Math.exp(-x * 28) * 0.32, 0.1);
    // Hats on the off-beats (and a few sixteenths).
    add(t + beat / 2, 0.05, (x) => (rand() * 2 - 1) * Math.exp(-x * 90) * s.hat, -0.3);
    if (rand() > 0.6) add(t + beat * 0.75, 0.04, (x) => (rand() * 2 - 1) * Math.exp(-x * 110) * s.hat * 0.7, 0.3);
    // Bass: the bar's root, plucked.
    add(t, beat * 0.9, (x) => {
      const ph = (root / 2) * x;
      return (2 * (ph - Math.floor(ph + 0.5))) * 0.22 * Math.exp(-x * 3);
    });
    // A soft chord at the start of each bar.
    if (k % 4 === 0) {
      add(t, beat * 4, (x) => {
        const env = Math.min(1, x * 3) * Math.exp(-x * 0.6);
        return s.chord.reduce((sum, r) => sum + Math.sin(2 * Math.PI * root * 2 * r * x), 0) * 0.045 * env;
      }, 0.15);
    }
  }
  // Fade in and out, and keep it below clipping.
  const fadeOut = Math.min(1.5, seconds / 4);
  const out = Buffer.alloc(44 + n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const g = Math.min(1, t / 0.08) * Math.min(1, (seconds - t) / fadeOut);
    out.writeInt16LE(Math.round(Math.tanh(left[i] * g) * 30000), 44 + i * 4);
    out.writeInt16LE(Math.round(Math.tanh(right[i] * g) * 30000), 46 + i * 4);
  }
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 4, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 4, 40);
  return out;
}

module.exports = { makeBeat, styleFor, STYLES };
