import { AHX_SCOPE_FULL_SCALE } from 'src/audio/worklets/ahx-core';
import { scopeAnalyserSize } from 'src/components/tracker/scope-trace';

/** Headroom over a known full scale in the triggered scope; see `TrackWaveform`. */
const ANALYSER_SCOPE_HEADROOM = 1.15;
/** Analyser window of a source with a known full scale (SID, OPL). */
const TRIGGERED_FFT_SIZE = 2048;

/** Where the per-channel traces come from: what the scope components are given. */
export interface ChannelScopeSources {
  audioNodes: Record<number, AudioNode | null>;
  audioContext: AudioContext | null;
  /** The AHX/HVL per-voice snapshot source; see `TrackWaveform`. */
  scopeSource?: ((channel: number) => Int16Array | null) | null | undefined;
  /** The triggered-scope scale of one channel (SID, OPL), or null for the plain trace. */
  analyserFullScale?: ((channel: number) => (() => number | null) | null) | null | undefined;
  scopeGain?: number | undefined;
}

/** One channel's samples and how to scale them into a scope. */
export interface ChannelTrace {
  data: ArrayLike<number>;
  fullScale: number;
  /** Draw about the window's midrange (a DC-blocked source). */
  centered: boolean;
  gain: number | undefined;
}

interface Tap {
  node: AudioNode;
  analyser: AnalyserNode;
  data: Float32Array;
}

/**
 * Reads the traces of every channel the way `TrackWaveform` does, for the
 * views that draw all of them at once: an analyser per channel tap, or the
 * AHX worklet's snapshot. `sources` is read on every call, so it may return
 * live props.
 */
export class ChannelScopeFeed {
  private readonly taps = new Map<number, Tap>();

  constructor(private readonly sources: () => ChannelScopeSources) {}

  private release(channel: number): void {
    const tap = this.taps.get(channel);
    if (!tap) return;
    try {
      tap.node.disconnect(tap.analyser);
    } catch {
      // Already disconnected.
    }
    tap.analyser.disconnect();
    this.taps.delete(channel);
  }

  /** Drops every analyser (the source changed, or the view is going away). */
  releaseAll(): void {
    for (const channel of [...this.taps.keys()]) this.release(channel);
  }

  /** Drops the analysers of channels at or past `count`. */
  releaseFrom(count: number): void {
    for (const channel of [...this.taps.keys()]) if (channel >= count) this.release(channel);
  }

  /** The channel's analyser, created or re-pointed to follow `audioNodes`. */
  private tapFor(channel: number): Tap | null {
    const { audioNodes, audioContext } = this.sources();
    const node = audioNodes[channel] ?? null;
    const existing = this.taps.get(channel);
    if (existing && existing.node !== node) this.release(channel);
    if (!node) return null;
    let tap = this.taps.get(channel);
    if (!tap) {
      const analyser = (audioContext ?? node.context).createAnalyser();
      analyser.fftSize = TRIGGERED_FFT_SIZE;
      node.connect(analyser);
      tap = { node, analyser, data: new Float32Array(analyser.fftSize) };
      this.taps.set(channel, tap);
    }
    return tap;
  }

  /** The channel's samples for a scope `cellWidth` CSS pixels wide, or null for a flat line. */
  trace(channel: number, cellWidth: number): ChannelTrace | null {
    const { scopeSource, analyserFullScale, scopeGain } = this.sources();
    if (scopeSource) {
      const data = scopeSource(channel);
      if (!data) return null;
      return { data, fullScale: AHX_SCOPE_FULL_SCALE, centered: false, gain: scopeGain };
    }
    const tap = this.tapFor(channel);
    if (!tap) return null;
    const known = analyserFullScale?.(channel) ?? null;
    const size = known ? TRIGGERED_FFT_SIZE : scopeAnalyserSize(cellWidth);
    if (tap.analyser.fftSize !== size) {
      tap.analyser.fftSize = size;
      tap.data = new Float32Array(size);
    }
    tap.analyser.getFloatTimeDomainData(tap.data);
    if (known) {
      const fullScale = known();
      return {
        data: tap.data,
        fullScale: (fullScale && fullScale > 0 ? fullScale : 1) * ANALYSER_SCOPE_HEADROOM,
        centered: true,
        gain: scopeGain,
      };
    }
    // A sampled format's track: full scale 1.0, about zero, no display gain.
    return { data: tap.data, fullScale: 1, centered: false, gain: 1 };
  }
}
