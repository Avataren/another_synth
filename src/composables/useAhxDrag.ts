/**
 * Drag plumbing for the AHX instrument editor (editor plan, cross-cutting rules):
 *
 * - pointer capture, so a drag that leaves the handle keeps reporting;
 * - at most ONE commit per animation frame (`requestAnimationFrame`), because a
 *   commit deep-copies the instrument and sends `replace-instrument` to the
 *   worklets;
 * - fields that cost the song worklet a hi-fi table walk (wave length, filter,
 *   square, vibrato, the PList) are throttled further with `intervalMs`
 *   (~15 Hz, `AHX_TABLE_THROTTLE_MS`), while envelope and volume run at the
 *   full frame rate;
 * - the last value is ALWAYS flushed on release, so the song ends up with
 *   exactly what the user let go on.
 *
 * `createCoalescer` is the shared core: the SVG nodes use it through
 * `useAhxDrag`, and the native range inputs (which do their own dragging) use
 * it directly from their `input` / `change` events.
 */
import { getCurrentInstance, onBeforeUnmount, ref, type Ref } from 'vue';

/** ~15 Hz: how often a table-cost field may commit while it is being dragged. */
export const AHX_TABLE_THROTTLE_MS = 66;

/** How much of a pointer movement counts while Shift is held (4x finer). */
export const AHX_FINE_SCALE = 0.25;

/**
 * Whether a coalesced value is due: nothing goes out before `intervalMs` has
 * passed since the last one. With `intervalMs` 0 every frame is due.
 */
export function dragCommitDue(now: number, lastEmit: number | null, intervalMs: number): boolean {
  return lastEmit === null || intervalMs <= 0 || now - lastEmit >= intervalMs;
}

export interface Coalescer<T> {
  /** Remember the newest value; it is emitted on the next due frame. */
  push(value: T): void;
  /** Emit the newest pending value now (release, blur, change), if there is one. */
  flush(): void;
  /** Drop the pending value without emitting. */
  cancel(): void;
}

export interface CoalescerOptions {
  intervalMs?: number;
  raf?: (cb: (time: number) => void) => number;
  cancelRaf?: (handle: number) => void;
  now?: () => number;
}

export function createCoalescer<T>(emit: (value: T) => void, options: CoalescerOptions = {}): Coalescer<T> {
  const intervalMs = options.intervalMs ?? 0;
  const raf = options.raf ?? ((cb) => requestAnimationFrame(cb));
  const cancelRaf = options.cancelRaf ?? ((h) => cancelAnimationFrame(h));
  const now = options.now ?? (() => performance.now());
  let pending: { value: T } | null = null;
  let handle: number | null = null;
  let lastEmit: number | null = null;

  const emitPending = (): void => {
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastEmit = now();
    emit(value);
  };

  const frame = (): void => {
    handle = null;
    if (!pending) return;
    if (dragCommitDue(now(), lastEmit, intervalMs)) emitPending();
    else handle = raf(frame);
  };

  return {
    push(value) {
      pending = { value };
      if (handle === null) handle = raf(frame);
    },
    flush() {
      if (handle !== null) {
        cancelRaf(handle);
        handle = null;
      }
      emitPending();
    },
    cancel() {
      if (handle !== null) {
        cancelRaf(handle);
        handle = null;
      }
      pending = null;
    },
  };
}

/** Where a drag is, in pixels from where it began, with Shift's fine scaling already applied. */
export interface AhxDragPoint {
  dx: number;
  dy: number;
  fine: boolean;
}

export interface AhxDragOptions {
  /** Called with the newest point, at most once per animation frame (and per `intervalMs`). */
  onDrag: (point: AhxDragPoint) => void;
  /** Called after the last `onDrag` has been flushed, when the pointer is released or cancelled. */
  onEnd?: () => void;
  intervalMs?: number;
}

/**
 * Start dragging from a `pointerdown` on a handle. Movements are accumulated
 * with the fine scale in force at the time, so pressing Shift mid-drag slows the
 * drag from there on instead of making the value jump.
 */
export function useAhxDrag(options: AhxDragOptions): {
  dragging: Ref<boolean>;
  begin: (event: PointerEvent) => void;
  end: () => void;
} {
  const dragging = ref(false);
  let stop: (() => void) | null = null;

  function begin(event: PointerEvent): void {
    if (dragging.value || (event.button !== undefined && event.button > 0)) return;
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const pointerId = event.pointerId;
    try {
      target.setPointerCapture?.(pointerId);
    } catch {
      // The pointer is already gone: a synthetic event, or released before this ran.
    }
    let lastX = event.clientX;
    let lastY = event.clientY;
    let dx = 0;
    let dy = 0;
    const coalescer = createCoalescer<AhxDragPoint>(options.onDrag, { intervalMs: options.intervalMs ?? 0 });
    dragging.value = true;

    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      const scale = e.shiftKey ? AHX_FINE_SCALE : 1;
      dx += (e.clientX - lastX) * scale;
      dy += (e.clientY - lastY) * scale;
      lastX = e.clientX;
      lastY = e.clientY;
      coalescer.push({ dx, dy, fine: e.shiftKey });
    };
    const finish = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      // Whatever the last move was goes out before the drag is over.
      coalescer.flush();
      stop?.();
      options.onEnd?.();
    };
    stop = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', finish);
      try {
        target.releasePointerCapture?.(pointerId);
      } catch {
        // Already released with the pointer.
      }
      coalescer.cancel();
      dragging.value = false;
      stop = null;
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', finish);
  }

  const end = (): void => stop?.();
  if (getCurrentInstance()) onBeforeUnmount(end);
  return { dragging, begin, end };
}
