import { spectrumBands } from 'src/components/tracker/glow-scope-geometry';

/** The most bars a feed produces. */
export const MAX_SPECTRUM_BANDS = 64;

export interface SpectrumFeedOptions {
  fftSize?: number;
  minHz?: number;
  maxHz?: number;
  minDb?: number;
  maxDb?: number;
  /** dB per octave added above 1 kHz, and the response curve (see `spectrumBands`). */
  tiltDb?: number;
  curve?: number;
  /** Per frame: how fast a bar falls (multiplier), and how fast its peak marker does. */
  barFall?: number;
  peakFall?: number;
}

const DEFAULTS: Required<SpectrumFeedOptions> = {
  fftSize: 8192,
  minHz: 35,
  maxHz: 16000,
  minDb: -95,
  maxDb: -12,
  tiltDb: 3,
  curve: 1.8,
  barFall: 0.88,
  peakFall: 0.012,
};

/**
 * A spectrum analyser on a node, folded into log-spaced bars that jump up at
 * once and fall away smoothly, each with a slower peak marker. Call `update`
 * once per frame; `levels` and `peaks` hold 0..1 values for the first `bands`
 * entries.
 */
export class SpectrumFeed {
  readonly levels = new Float32Array(MAX_SPECTRUM_BANDS);
  readonly peaks = new Float32Array(MAX_SPECTRUM_BANDS);
  private readonly raw = new Float32Array(MAX_SPECTRUM_BANDS);
  private readonly options: Required<SpectrumFeedOptions>;
  private analyser: AnalyserNode | null = null;
  private connected: AudioNode | null = null;
  private freqDb: Float32Array;

  constructor(options: SpectrumFeedOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.freqDb = new Float32Array(this.options.fftSize / 2);
  }

  private disconnect(): void {
    if (this.connected && this.analyser) {
      try {
        this.connected.disconnect(this.analyser);
      } catch {
        // Already disconnected.
      }
    }
    this.analyser?.disconnect();
    this.analyser = this.connected = null;
  }

  private connect(node: AudioNode | null, context: AudioContext | null): void {
    if (node === this.connected) return;
    this.disconnect();
    if (!node) return;
    const analyser = (context ?? node.context).createAnalyser();
    analyser.fftSize = this.options.fftSize;
    analyser.smoothingTimeConstant = 0.6;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    this.freqDb = new Float32Array(analyser.frequencyBinCount);
    node.connect(analyser);
    this.analyser = analyser;
    this.connected = node;
  }

  /** Reads the node's spectrum into `bands` bars (at most `MAX_SPECTRUM_BANDS`). */
  update(node: AudioNode | null, context: AudioContext | null, bands: number): void {
    const o = this.options;
    const count = Math.max(1, Math.min(MAX_SPECTRUM_BANDS, bands));
    this.connect(node, context);
    if (this.analyser) {
      this.analyser.getFloatFrequencyData(this.freqDb);
      spectrumBands(
        this.freqDb,
        this.analyser.context.sampleRate / this.analyser.fftSize,
        count,
        o.minHz,
        o.maxHz,
        o.minDb,
        o.maxDb,
        this.raw,
        o.tiltDb,
        o.curve,
      );
    } else {
      this.raw.fill(0);
    }
    for (let b = 0; b < count; b++) {
      const now = this.raw[b] ?? 0;
      const fallen = (this.levels[b] ?? 0) * o.barFall;
      const level = now > fallen ? now : fallen;
      this.levels[b] = level;
      this.peaks[b] = Math.max(level, (this.peaks[b] ?? 0) - o.peakFall);
    }
  }

  dispose(): void {
    this.disconnect();
  }
}
