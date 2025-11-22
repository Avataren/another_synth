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
