const MIN_SCALE = 0.3;
const MAX_PIXELS = 1_200_000;

/** GPU time excludes unrelated UI work. Frame cadence remains a fallback when timers are unavailable. */
export class TerrainQuality {
  scale = 0.75;
  private lastTime: number | null = null;
  private frameMs = 16.7;
  private gpuMs: number | null = null;
  private gpuAt = -Infinity;
  private decisionAt = -Infinity;
  private blockedUntil = 0;
  private raisedAt = -Infinity;
  private cooldown = 4000;

  recordGpu(milliseconds: number, timeMs: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.gpuMs =
      this.gpuMs === null
        ? milliseconds
        : this.gpuMs + (milliseconds - this.gpuMs) * 0.25;
    this.gpuAt = timeMs;
  }

  update(timeMs: number, pixels: number): void {
    const ceiling = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, pixels)));
    const floor = Math.min(MIN_SCALE, ceiling);
    this.scale = Math.min(this.scale, ceiling);
    const dt = this.lastTime === null ? 0 : timeMs - this.lastTime;
    this.lastTime = timeMs;
    // Resume/pause gaps aren't rendering cost. Sustained 8 fps IS: do not discard slow frames.
    if (dt <= 0 || dt > 1000) return;
    this.frameMs += (dt - this.frameMs) * 0.15;
    if (timeMs - this.decisionAt < 350) return;
    const gpu = this.gpuMs !== null && timeMs - this.gpuAt < 1000;
    const cost = gpu ? (this.gpuMs ?? this.frameMs) : this.frameMs;
    const slow = gpu ? 14 : 20;
    const fast = gpu ? 9 : 17.5;
    if (cost > slow && this.scale > floor) {
      this.decisionAt = timeMs;
      this.scale = Math.max(
        floor,
        this.scale * Math.max(0.7, Math.sqrt((gpu ? 12 : 16.7) / cost)),
      );
      if (timeMs - this.raisedAt < this.cooldown)
        this.cooldown = Math.min(60000, this.cooldown * 2);
      this.blockedUntil = timeMs + this.cooldown;
      this.gpuMs = null;
      this.frameMs = 16.7;
    } else if (
      cost < fast &&
      this.scale < ceiling &&
      timeMs >= this.blockedUntil
    ) {
      this.decisionAt = timeMs;
      this.scale = Math.min(ceiling, this.scale + 0.025);
      this.raisedAt = timeMs;
    }
  }
}
