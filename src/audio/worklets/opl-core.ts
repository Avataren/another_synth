/**
 * The render-thread logic of the OPL worklet (.ai/plan-opl.md O2), kept
 * apart from the `AudioWorkletProcessor` shell (`opl-worklet.ts`) so it can
 * be unit-tested against the real wasm in node, as `sid-core.ts` is.
 *
 * Unlike the SID and AHX worklets this plays no song. The Rust
 * `OplRenderer` (`rust-wasm/src/opl/wasm.rs`) is a register-stream chip:
 * whoever plays the music sends register writes stamped with AudioContext
 * times, the way notes are scheduled, and this core turns each stamp into a
 * frame on the renderer's own clock and queues it there. The renderer
 * applies it on the native chip sample it belongs to.
 *
 * Output 0 is stereo: an OPL3 pans per channel, and OPL2 music comes out
 * centred on both sides.
 */

/** The slice of the wasm `OplRenderer` class this core uses. */
export interface OplWasmRenderer {
  write(reg: number, val: number): void;
  /** Queue a write for output frame `frame` of the renderer's own clock. */
  write_at(frame: number, reg: number, val: number): void;
  render(left: Float32Array, right: Float32Array): number;
  frames_rendered(): number;
  late_writes(): number;
  queued_writes(): number;
  set_gain(gain: number): void;
  set_channel_mask(mask: number): void;
  /** Drop queued writes and key everything off at the fastest release. */
  panic(): void;
  free(): void;
}

export type OplWasmRendererCtor = new (sampleRate: number) => OplWasmRenderer;

/** Main thread -> worklet. */
export type OplCommand =
  /**
   * Register writes as (time, reg, val) triples: `time` in seconds on the
   * AudioContext clock, `reg` 0x000..0x1FF, `val` a byte. A time already
   * past applies at once and counts as late.
   */
  | { type: 'writes'; writes: Float64Array | number[] }
  | { type: 'set-gain'; gain: number }
  /** Bit per channel (0..17): 1 plays, 0 mutes. The chip keeps running. */
  | { type: 'set-channel-mask'; mask: number }
  /** Stop: drop queued writes, key everything off (transport stop, seek). */
  | { type: 'panic' }
  | { type: 'dispose' };

/** Worklet -> main thread. */
export type OplEvent =
  /** Writes applied after their time since the worklet started (a late batch). */
  | { type: 'late-writes'; total: number }
  | { type: 'error'; message: string };

/** How often a changed late-write count is reported, at most. */
const LATE_REPORT_SECONDS = 0.5;

export class OplProcessorCore {
  private renderer: OplWasmRenderer | null;
  /** Context frame minus renderer frame; constant while every quantum renders. */
  private frameOffset: number;
  private lateReported = 0;
  private framesSinceReport = 0;
  private disposedFlag = false;

  /**
   * `contextFrame` is the AudioContext frame at construction (the worklet's
   * `currentFrame`), so writes that arrive before the first quantum map too.
   */
  constructor(
    RendererCtor: OplWasmRendererCtor,
    private readonly sampleRate: number,
    contextFrame: number,
    private readonly post: (event: OplEvent) => void,
  ) {
    this.renderer = new RendererCtor(sampleRate);
    this.frameOffset = contextFrame;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  handle(command: OplCommand): void {
    if (this.disposedFlag) return;
    const renderer = this.renderer;
    switch (command.type) {
      case 'writes': {
        if (!renderer) return;
        const w = command.writes;
        for (let i = 0; i + 2 < w.length; i += 3) {
          const frame = (w[i] as number) * this.sampleRate - this.frameOffset;
          renderer.write_at(frame, (w[i + 1] as number) & 0x1ff, (w[i + 2] as number) & 0xff);
        }
        break;
      }
      case 'set-gain':
        renderer?.set_gain(command.gain);
        break;
      case 'set-channel-mask':
        renderer?.set_channel_mask(command.mask >>> 0);
        break;
      case 'panic':
        renderer?.panic();
        break;
      case 'dispose':
        this.disposedFlag = true;
        this.drop();
        break;
    }
  }

  /**
   * Fills one render quantum starting at AudioContext frame `contextFrame`
   * (the worklet's `currentFrame`). `right` may be absent on a mono output.
   */
  process(left: Float32Array, right: Float32Array | undefined, contextFrame: number): void {
    const renderer = this.renderer;
    if (!renderer) {
      left.fill(0);
      right?.fill(0);
      return;
    }
    try {
      this.frameOffset = contextFrame - renderer.frames_rendered();
      if (right && right.length === left.length) {
        renderer.render(left, right);
      } else {
        const scratch = new Float32Array(left.length);
        renderer.render(left, scratch);
      }
      this.reportLate(renderer, left.length);
    } catch (error) {
      // A wasm trap leaves the instance unusable: go silent, say so.
      this.drop();
      left.fill(0);
      right?.fill(0);
      this.post({ type: 'error', message: `OPL render failed: ${String(error)}` });
    }
  }

  private reportLate(renderer: OplWasmRenderer, frames: number): void {
    this.framesSinceReport += frames;
    if (this.framesSinceReport < this.sampleRate * LATE_REPORT_SECONDS) return;
    this.framesSinceReport = 0;
    const total = renderer.late_writes();
    if (total === this.lateReported) return;
    this.lateReported = total;
    this.post({ type: 'late-writes', total });
  }

  private drop(): void {
    if (!this.renderer) return;
    try {
      this.renderer.free();
    } catch {
      // already dead
    }
    this.renderer = null;
  }
}
