import type { PlaybackClock } from './types';

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

class IntervalClock implements PlaybackClock {
  private handle: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(intervalMs = 16) {
    this.intervalMs = intervalMs;
  }

  start(tick: (deltaMs: number) => void): void {
    if (this.handle) return;
    let last = nowMs();
    this.handle = setInterval(() => {
      const now = nowMs();
      const delta = now - last;
      last = now;
      tick(delta);
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }
}

class RafClock implements PlaybackClock {
  private handle: number | null = null;
  private last = 0;
  private readonly minFrameTime: number;
  private fallbackInterval: IntervalClock | null = null;

  constructor(targetFps = 30) {
    this.minFrameTime = 1000 / targetFps;
  }

  start(tick: (deltaMs: number) => void): void {
    if (this.handle !== null || this.fallbackInterval) return;

    // Fall back when RAF is unavailable (server-side / tests)
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      this.fallbackInterval = new IntervalClock(this.minFrameTime);
      this.fallbackInterval.start(tick);
      return;
    }

    this.last = nowMs();
    const loop = (timestamp: number) => {
      const delta = timestamp - this.last;
      if (delta >= this.minFrameTime) {
        this.last = timestamp;
        tick(delta);
      }
      this.handle = globalThis.requestAnimationFrame(loop);
    };
    this.handle = globalThis.requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.handle !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.handle);
      this.handle = null;
    }
    if (this.fallbackInterval) {
      this.fallbackInterval.stop();
      this.fallbackInterval = null;
    }
  }
}

export class VisibilityAwareClock implements PlaybackClock {
  private mode: 'raf' | 'interval';
  private readonly rafClock: RafClock;
  private readonly intervalClock: IntervalClock;
  private running = false;
  private tickFn: ((deltaMs: number) => void) | null = null;

  constructor(options?: { targetFps?: number; intervalMs?: number; defaultVisible?: boolean }) {
    const targetFps = options?.targetFps ?? 30;
    const intervalMs = options?.intervalMs ?? Math.round(1000 / targetFps);
    this.rafClock = new RafClock(targetFps);
    this.intervalClock = new IntervalClock(intervalMs);
    this.mode = options?.defaultVisible === false ? 'interval' : 'raf';
  }

  start(tick: (deltaMs: number) => void): void {
    this.tickFn = tick;
    this.running = true;
    this.currentClock().start(tick);
  }

  stop(): void {
    this.running = false;
    this.tickFn = null;
    this.rafClock.stop();
    this.intervalClock.stop();
  }

  setVisible(isVisible: boolean): void {
    const desiredMode = isVisible ? 'raf' : 'interval';
    if (desiredMode === this.mode) return;
    this.mode = desiredMode;
    if (this.running && this.tickFn) {
      this.rafClock.stop();
      this.intervalClock.stop();
      this.currentClock().start(this.tickFn);
    }
  }

  private currentClock(): RafClock | IntervalClock {
    return this.mode === 'raf' ? this.rafClock : this.intervalClock;
  }
}

export function createVisibilityClock(options?: {
  targetFps?: number;
  intervalMs?: number;
  defaultVisible?: boolean;
}): PlaybackClock {
  return new VisibilityAwareClock(options);
}
