import { describe, expect, it, vi } from 'vitest';
import {
  AHX_FINE_SCALE,
  AHX_TABLE_THROTTLE_MS,
  createCoalescer,
  dragCommitDue,
  useAhxDrag,
  type AhxDragPoint,
} from 'src/composables/useAhxDrag';

/** A manual animation-frame clock: callbacks run only when `tick` says so. */
function clock() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    now: () => now,
    raf: (cb: (t: number) => void) => {
      const id = next++;
      pending.set(id, () => cb(now));
      return id;
    },
    cancelRaf: (id: number) => void pending.delete(id),
    tick(ms = 16) {
      now += ms;
      const due = [...pending.entries()];
      pending.clear();
      for (const [, cb] of due) cb();
    },
    get waiting() {
      return pending.size;
    },
  };
}

describe('dragCommitDue (the throttle predicate)', () => {
  it('the first value is always due', () => expect(dragCommitDue(5, null, 66)).toBe(true));
  it('interval 0 (envelope, volume): every frame is due', () => {
    expect(dragCommitDue(16, 0, 0)).toBe(true);
    expect(dragCommitDue(1, 0, 0)).toBe(true);
  });
  it('a table-cost field waits out the interval (~15 Hz)', () => {
    expect(AHX_TABLE_THROTTLE_MS).toBeGreaterThanOrEqual(60);
    expect(dragCommitDue(50, 0, AHX_TABLE_THROTTLE_MS)).toBe(false);
    expect(dragCommitDue(66, 0, AHX_TABLE_THROTTLE_MS)).toBe(true);
  });
});

describe('createCoalescer', () => {
  it('emits one value per frame, the newest, however many were pushed', () => {
    const c = clock();
    const out: number[] = [];
    const co = createCoalescer<number>((v) => out.push(v), { raf: c.raf, cancelRaf: c.cancelRaf, now: c.now });
    co.push(1);
    co.push(2);
    co.push(3);
    expect(out).toEqual([]);
    c.tick();
    expect(out).toEqual([3]);
    co.push(4);
    c.tick();
    expect(out).toEqual([3, 4]);
    c.tick();
    expect(out).toEqual([3, 4]); // nothing pending: nothing emitted
  });

  it('a throttled field commits at most once per interval and still ends on the last value', () => {
    const c = clock();
    const out: number[] = [];
    const co = createCoalescer<number>((v) => out.push(v), { intervalMs: 66, raf: c.raf, cancelRaf: c.cancelRaf, now: c.now });
    let value = 0;
    for (let frame = 0; frame < 12; frame++) {
      co.push(++value);
      c.tick(16); // 12 frames = 192 ms
    }
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(Math.ceil(192 / 66));
    co.flush();
    expect(out[out.length - 1]).toBe(12);
  });

  it('flush emits the pending value at once and leaves nothing scheduled', () => {
    const c = clock();
    const out: number[] = [];
    const co = createCoalescer<number>((v) => out.push(v), { raf: c.raf, cancelRaf: c.cancelRaf, now: c.now });
    co.push(9);
    co.flush();
    expect(out).toEqual([9]);
    expect(c.waiting).toBe(0);
    co.flush();
    expect(out).toEqual([9]);
  });

  it('cancel drops the pending value', () => {
    const c = clock();
    const out: number[] = [];
    const co = createCoalescer<number>((v) => out.push(v), { raf: c.raf, cancelRaf: c.cancelRaf, now: c.now });
    co.push(1);
    co.cancel();
    c.tick();
    expect(out).toEqual([]);
  });
});

function pointer(type: string, init: { x?: number; y?: number; shift?: boolean; id?: number; button?: number } = {}): PointerEvent {
  const e = new MouseEvent(type, {
    bubbles: true,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    shiftKey: init.shift ?? false,
    button: init.button ?? 0,
  });
  Object.defineProperty(e, 'pointerId', { value: init.id ?? 1 });
  return e as PointerEvent;
}

describe('useAhxDrag', () => {
  function setup() {
    const points: AhxDragPoint[] = [];
    const ended = vi.fn();
    const el = document.createElement('button');
    el.setPointerCapture = vi.fn();
    el.releasePointerCapture = vi.fn();
    document.body.appendChild(el);
    const drag = useAhxDrag({ onDrag: (p) => points.push(p), onEnd: ended });
    el.addEventListener('pointerdown', drag.begin);
    return { points, ended, el, drag };
  }

  it('captures the pointer, coalesces moves to one per frame and flushes the last on release', async () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      queued.push(cb);
      return queued.length;
    });
    const queued: FrameRequestCallback[] = [];
    const { points, ended, el, drag } = setup();
    el.dispatchEvent(pointer('pointerdown', { x: 100, y: 100 }));
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    expect(drag.dragging.value).toBe(true);

    el.dispatchEvent(pointer('pointermove', { x: 110, y: 100 }));
    el.dispatchEvent(pointer('pointermove', { x: 120, y: 90 }));
    el.dispatchEvent(pointer('pointermove', { x: 130, y: 80 }));
    expect(points).toEqual([]); // nothing commits between frames
    queued.shift()!(0);
    expect(points).toEqual([{ dx: 30, dy: -20, fine: false }]);

    // Released before the next frame: the last movement is not lost.
    el.dispatchEvent(pointer('pointermove', { x: 140, y: 80 }));
    el.dispatchEvent(pointer('pointerup', { x: 140, y: 80 }));
    expect(points[points.length - 1]).toEqual({ dx: 40, dy: -20, fine: false });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(el.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(drag.dragging.value).toBe(false);

    // After the drag, moves are ignored.
    el.dispatchEvent(pointer('pointermove', { x: 300, y: 300 }));
    expect(points.length).toBe(2);
    raf.mockRestore();
  });

  it('Shift makes the drag 4x finer from that move on, without a jump', () => {
    const queued: FrameRequestCallback[] = [];
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      queued.push(cb);
      return queued.length;
    });
    const { points, el } = setup();
    el.dispatchEvent(pointer('pointerdown', { x: 0, y: 0 }));
    el.dispatchEvent(pointer('pointermove', { x: 40, y: 0 }));
    el.dispatchEvent(pointer('pointermove', { x: 80, y: 0, shift: true }));
    el.dispatchEvent(pointer('pointerup', { x: 80, y: 0 }));
    // 40 at full speed, then 40 more at 1/4.
    expect(points[points.length - 1]!.dx).toBe(40 + 40 * AHX_FINE_SCALE);
    expect(points[points.length - 1]!.fine).toBe(true);
    raf.mockRestore();
  });

  it('ignores a secondary button and another pointer', () => {
    const { points, el, drag } = setup();
    el.dispatchEvent(pointer('pointerdown', { button: 2 }));
    expect(drag.dragging.value).toBe(false);
    el.dispatchEvent(pointer('pointerdown', { id: 7 }));
    expect(drag.dragging.value).toBe(true);
    el.dispatchEvent(pointer('pointermove', { x: 30, id: 8 }));
    el.dispatchEvent(pointer('pointerup', { id: 8 }));
    expect(drag.dragging.value).toBe(true); // another pointer's release does not end it
    expect(points).toEqual([]);
    el.dispatchEvent(pointer('pointerup', { id: 7 }));
    expect(drag.dragging.value).toBe(false);
  });
});
