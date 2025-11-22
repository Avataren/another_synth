import type { PlaybackScheduler } from './types';

/**
 * Simple interval-based scheduler that drives the playback engine.
 * Consumers can swap this for raf/audio-clock-backed schedulers later.
 */
export class IntervalScheduler implements PlaybackScheduler {
  private handle: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(intervalMs = 16) {
    this.intervalMs = intervalMs;
  }

  start(tick: (deltaMs: number) => void) {
    if (this.handle) return;
    let last = performance.now();
    this.handle = setInterval(() => {
      const now = performance.now();
      const delta = now - last;
      last = now;
      tick(delta);
    }, this.intervalMs);
  }

  stop() {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }
}

/**
 * Web Audio–backed scheduler that uses AudioContext time for stable timing.
 * Falls back to an interval if the APIs are unavailable.
 */
class AudioContextScheduler implements PlaybackScheduler {
  private readonly ctx: AudioContext;
  private rafHandle: number | null = null;
  private running = false;
  private lastTime = 0;

  constructor(context?: AudioContext) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - AudioContext may be undefined in non-DOM environments
    this.ctx = context ?? new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  }

  start(tick: (deltaMs: number) => void) {
    if (this.running) return;
    this.running = true;
    void this.ctx.resume();
    this.lastTime = this.ctx.currentTime;
    const loop = () => {
      if (!this.running) return;
      const now = this.ctx.currentTime;
      const deltaMs = (now - this.lastTime) * 1000;
      this.lastTime = now;
      tick(deltaMs);
      this.rafHandle = typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame(loop)
        : (setTimeout(loop, 16) as unknown as number);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.rafHandle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.rafHandle);
    }
    this.rafHandle = null;
  }
}

export function createAudioContextScheduler(context?: AudioContext): PlaybackScheduler | null {
  const hasAudioContext =
    typeof globalThis !== 'undefined' &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (!!(globalThis as any).AudioContext || !!(globalThis as any).webkitAudioContext);

  if (!hasAudioContext) return null;

  try {
    return new AudioContextScheduler(context);
  } catch {
    return null;
  }
}
