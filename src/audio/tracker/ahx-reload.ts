import type { AhxPositionMap } from 'src/audio/tracker/ahx-doc';

/** Idle time after the last edit before a playing song is reloaded. */
export const AHX_RELOAD_IDLE_MS = 350;
/** The longest a steady run of edits can put the reload off. */
export const AHX_RELOAD_MAX_WAIT_MS = 2000;

/**
 * `first`, then `then`: an old position index to the newest one. `null` (the
 * position is gone) is absorbing, so a position deleted by one op stays gone
 * whatever a later op does with the indexes. `undefined` is the identity.
 */
export function composeAhxPositionMaps(
  first: AhxPositionMap | undefined,
  then: AhxPositionMap | undefined,
): AhxPositionMap | undefined {
  if (!first) return then;
  if (!then) return first;
  return (old) => {
    const mid = first(old);
    return mid === null ? null : then(mid);
  };
}

/** Where a place lands after position ops: its position through `map`, a gone one on row 0 of the position now at that index. */
export function mapAhxPlace(
  place: { position: number; row: number },
  map: AhxPositionMap | undefined,
  positionCount: number,
): { position: number; row: number } {
  const last = Math.max(0, positionCount - 1);
  if (!map) return { position: Math.min(place.position, last), row: place.row };
  const mapped = map(place.position);
  if (mapped === null) return { position: Math.min(place.position, last), row: 0 };
  return { position: Math.max(0, Math.min(mapped, last)), row: place.row };
}

export interface AhxReloadTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const realTimers: AhxReloadTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * The debounce in front of a live reload of a playing AHX song.
 *
 * Every structural edit calls `schedule`; the reload runs once, `idleMs` after
 * the last one, and never later than `maxWaitMs` after the first of a run. The
 * position maps of the edits that were coalesced compose as they arrive, and
 * the composed map is handed to `run` (which applies it to the place once, at
 * burst time). While something is pending, `pendingMap` is the map from the
 * song the worklet still plays to the song the editor now holds.
 */
export class AhxReloadScheduler {
  private handle: unknown = null;
  private firstAt = 0;
  private map: AhxPositionMap | undefined;
  private waiting = false;

  constructor(
    private readonly run: (map: AhxPositionMap | undefined) => void,
    private readonly idleMs = AHX_RELOAD_IDLE_MS,
    private readonly maxWaitMs = AHX_RELOAD_MAX_WAIT_MS,
    private readonly timers: AhxReloadTimers = realTimers,
  ) {}

  /** Whether a reload is scheduled and has not run yet. */
  get pending(): boolean {
    return this.waiting;
  }

  /** Old-song index to newest-song index over everything coalesced so far (`undefined`: none moved). */
  get pendingMap(): AhxPositionMap | undefined {
    return this.map;
  }

  schedule(map?: AhxPositionMap): void {
    const now = this.timers.now();
    if (!this.waiting) this.firstAt = now;
    this.waiting = true;
    this.map = composeAhxPositionMaps(this.map, map);
    if (this.handle !== null) this.timers.clear(this.handle);
    const wait = Math.max(0, Math.min(this.idleMs, this.firstAt + this.maxWaitMs - now));
    this.handle = this.timers.set(() => this.fire(), wait);
  }

  /** Run a pending reload now (a resume that finds stale bytes). No-op when nothing is pending. */
  flush(): void {
    if (this.waiting) this.fire();
  }

  /** Forget what is pending (the song changed, or playback stopped). */
  cancel(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
    this.waiting = false;
    this.map = undefined;
  }

  private fire(): void {
    const map = this.map;
    this.cancel();
    this.run(map);
  }
}
