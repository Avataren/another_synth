/**
 * A small drum synthesiser for 8-bit module samples: pitched sine bodies,
 * noise and metallic oscillators, shaped by one-pole filters and exponential
 * envelopes. Pure and seeded, so the same parameters make the same sample.
 *
 * It renders at the rate a given Paula period plays a sample at, so the
 * sample sounds as designed when the note it is tuned to is played.
 */

export type DrumKind = 'kick' | 'tom' | 'snare' | 'clap' | 'hihat' | 'openhat' | 'crash';

export const DRUM_KINDS: readonly DrumKind[] = ['kick', 'tom', 'snare', 'clap', 'hihat', 'openhat', 'crash'];

export interface DrumParams {
  /** Body pitch in Hz (kick, tom, snare); the metallic pitch of a hat or crash. */
  pitch: number;
  /** Time to fall 60 dB, in ms. */
  decay: number;
  /** Noise against tone, 0-100. */
  noise: number;
  /** Filter corner in Hz: a high-pass for hats and crash, a band for snare and clap. */
  cutoff: number;
  /** Attack emphasis, 0-100: a kick's click, a snare's crack, a clap's burst sharpness. */
  snap: number;
}

export const DRUM_PRESETS: Readonly<Record<DrumKind, DrumParams>> = {
  kick: { pitch: 50, decay: 280, noise: 0, cutoff: 3000, snap: 35 },
  tom: { pitch: 110, decay: 320, noise: 0, cutoff: 3000, snap: 20 },
  snare: { pitch: 190, decay: 170, noise: 65, cutoff: 1800, snap: 50 },
  clap: { pitch: 0, decay: 220, noise: 100, cutoff: 1300, snap: 60 },
  hihat: { pitch: 300, decay: 45, noise: 50, cutoff: 6500, snap: 30 },
  openhat: { pitch: 300, decay: 320, noise: 50, cutoff: 6000, snap: 20 },
  crash: { pitch: 260, decay: 1100, noise: 70, cutoff: 4500, snap: 40 },
};

/** Ranges for the controls, shared with the UI. */
export const DRUM_RANGES = {
  pitch: { min: 20, max: 1000 },
  decay: { min: 10, max: 2000 },
  noise: { min: 0, max: 100 },
  cutoff: { min: 200, max: 15000 },
  snap: { min: 0, max: 100 },
} as const;

/** The periods drums can be rendered for: the rate each plays a sample at. */
export const DRUM_RATES = [
  { label: 'C-2', period: 428 },
  { label: 'C-3', period: 214 },
  { label: 'B-3', period: 113 },
] as const;

const PAULA_CLOCK = 3546895;
const MAX_FRAMES = 60000;

/** mulberry32: a small seeded generator. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One-pole low-pass state: `y += a * (x - y)`. */
function lowpass(rate: number, hz: number): (x: number) => number {
  const a = 1 - Math.exp((-2 * Math.PI * Math.min(hz, rate * 0.45)) / rate);
  let y = 0;
  return (x) => (y += a * (x - y));
}

/** Two cascaded one-pole high-passes: 12 dB/octave. */
function highpass(rate: number, hz: number): (x: number) => number {
  const l1 = lowpass(rate, hz);
  const l2 = lowpass(rate, hz);
  return (x) => {
    const a = x - l1(x);
    return a - l2(a);
  };
}

/** A band around `hz`: high-pass at 0.6x then low-pass at 1.6x. */
function band(rate: number, hz: number): (x: number) => number {
  const hp = highpass(rate, hz * 0.6);
  const lp = lowpass(rate, hz * 1.6);
  return (x) => lp(hp(x));
}

/** The six square oscillators of the classic analogue hat, as ratios of the first. */
const METAL_RATIOS = [1, 1.483, 1.8, 2.546, 2.63, 3.9];

/**
 * A drum as signed 8-bit data, rendered for `period`. `seed` picks the noise.
 */
export function generateDrum(kind: DrumKind, params: DrumParams, period: number, seed = 1): Int8Array {
  const rate = PAULA_CLOCK / period;
  const decaySec = Math.max(0.005, params.decay / 1000);
  const frames = Math.max(64, Math.min(MAX_FRAMES, Math.round(decaySec * 1.15 * rate)) & ~1);
  const random = seeded(seed);
  const noise = () => random() * 2 - 1;
  const mix = params.noise / 100;
  const snap = params.snap / 100;
  const tau = decaySec / 6.9; // exp(-t/tau) is -60 dB at decaySec
  const out = new Float32Array(frames);

  switch (kind) {
    case 'kick':
    case 'tom': {
      const sweep = kind === 'kick' ? 4 : 1.7;
      const sweepTau = kind === 'kick' ? 0.025 : 0.04;
      const click = lowpass(rate, params.cutoff);
      let phase = 0;
      for (let i = 0; i < frames; i++) {
        const t = i / rate;
        const hz = params.pitch * (1 + (sweep - 1) * Math.exp(-t / sweepTau));
        phase += (2 * Math.PI * hz) / rate;
        const body = Math.sin(phase) * Math.exp(-t / tau);
        const tick = click(noise()) * Math.exp(-t / 0.0015) * snap * 1.5;
        out[i] = body * (1 - mix * 0.5) + tick + noise() * mix * 0.3 * Math.exp(-t / (tau * 0.5));
      }
      break;
    }
    case 'snare': {
      const shape = band(rate, params.cutoff);
      let phase = 0;
      for (let i = 0; i < frames; i++) {
        const t = i / rate;
        phase += (2 * Math.PI * params.pitch * (1 + 0.35 * Math.exp(-t / 0.012))) / rate;
        const tone = Math.sin(phase) * Math.exp(-t / (tau * 0.45));
        const hiss = shape(noise()) * 2.2 * (Math.exp(-t / tau) + snap * 0.8 * Math.exp(-t / 0.004));
        out[i] = tone * (1 - mix) + hiss * mix;
      }
      break;
    }
    case 'clap': {
      const shape = band(rate, params.cutoff);
      const burst = 0.011;
      for (let i = 0; i < frames; i++) {
        const t = i / rate;
        // Three quick bursts, then the tail; snap shortens each burst's decay.
        const phaseInBurst = t % burst;
        const early = t < burst * 3;
        const env = early ? Math.exp(-phaseInBurst / (0.002 + (1 - snap) * 0.004)) : Math.exp(-(t - burst * 3) / tau) * 0.8;
        out[i] = shape(noise()) * 2.2 * env;
      }
      break;
    }
    case 'hihat':
    case 'openhat':
    case 'crash': {
      const shape = highpass(rate, params.cutoff);
      const base = Math.max(20, params.pitch);
      const phases = METAL_RATIOS.map(() => 0);
      const attack = kind === 'crash' ? 0.004 : 0.0005;
      for (let i = 0; i < frames; i++) {
        const t = i / rate;
        let metal = 0;
        for (let k = 0; k < METAL_RATIOS.length; k++) {
          phases[k]! += (METAL_RATIOS[k]! * base) / rate;
          metal += (phases[k]! % 1) < 0.5 ? 1 : -1;
        }
        const body = (metal / METAL_RATIOS.length) * (1 - mix) + noise() * mix;
        const env = Math.min(1, t / attack) * (Math.exp(-t / tau) + snap * 0.6 * Math.exp(-t / 0.003));
        out[i] = shape(body) * 2.5 * env;
      }
      break;
    }
  }

  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? 127 / peak : 0;
  // A short fade at the very end so a sample that ends loud does not click.
  const fade = Math.min(frames >> 3, 64);
  return Int8Array.from(out, (v, i) => {
    const tail = i >= frames - fade ? (frames - 1 - i) / fade : 1;
    return Math.max(-128, Math.min(127, Math.round(v * gain * tail)));
  });
}
