// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createAhxPListPlayheadDriver,
  type AhxPListPlayheadEnv,
} from 'src/audio/tracker/ahx-plist-playhead';
import { playheadTiming } from 'src/audio/tracker/plist-playhead-clock';

/**
 * The playhead driver: the clock, fed from a frame callback and only while a
 * report is waiting. A fake environment (time, frames, visibility) stands in
 * for the page, so a hidden tab is a thing this test can make.
 */
function fakeEnv(options: { frames?: boolean } = {}) {
  const state = {
    now: 0,
    hidden: false,
    pending: [] as Array<{ handle: number; callback: () => void }>,
    handles: 0,
    requested: 0,
    cancelled: 0,
    visibleListener: null as null | (() => void),
  };
  const env: AhxPListPlayheadEnv = {
    now: () => state.now,
    requestFrame:
      options.frames === false
        ? undefined
        : (callback) => {
            state.handles += 1;
            state.requested += 1;
            state.pending.push({ handle: state.handles, callback });
            return state.handles;
          },
    cancelFrame: (handle) => {
      state.cancelled += 1;
      state.pending = state.pending.filter((p) => p.handle !== handle);
    },
    hidden: () => state.hidden,
    onVisible: (callback) => {
      state.visibleListener = callback;
      return () => {
        state.visibleListener = null;
      };
    },
  };
  /** One display frame: time moves on, the callbacks that were waiting run. */
  const frame = (ms = 1000 / 60): void => {
    state.now += ms;
    const run = state.pending;
    state.pending = [];
    for (const p of run) p.callback();
  };
  return { env, state, frame };
}

const rep = (instrument: number, row: number) => ({ instrument, row });

describe('the playhead driver', () => {
  it('shows nothing from a report until a frame runs, and then the newest one (coalesced to the frame)', () => {
    const { env, frame } = fakeEnv();
    const seen: Array<{ instrument: number; row: number }> = [];
    const driver = createAhxPListPlayheadDriver((r) => seen.push(r), env);
    driver.push(rep(1, 0));
    driver.push(rep(1, 1));
    driver.push(rep(1, 2));
    expect(seen).toEqual([]);
    frame();
    expect(seen).toEqual([rep(1, 2)]);
  });

  it('asks for a frame only while something is waiting: no loop when idle', () => {
    const { env, state, frame } = fakeEnv();
    const driver = createAhxPListPlayheadDriver(() => undefined, env);
    expect(state.requested).toBe(0);
    driver.push(rep(1, 0));
    expect(state.requested).toBe(1);
    // A second report inside the same frame is not a second request.
    driver.push(rep(1, 1));
    expect(state.requested).toBe(1);
    frame();
    // Drained: no further frame is asked for.
    expect(state.pending).toHaveLength(0);
    expect(state.requested).toBe(1);
  });

  it('holds a report for the source’s latency, polling each frame until it is due', () => {
    const { env, state, frame } = fakeEnv();
    const seen: Array<{ instrument: number; row: number }> = [];
    const driver = createAhxPListPlayheadDriver((r) => seen.push(r), env);
    driver.setTimingSource(() => playheadTiming(48000, 1, 40));
    driver.push(rep(1, 4));
    frame();
    frame();
    expect(seen).toEqual([]);
    // Two frames, 33 ms; due at 40.
    expect(state.pending).toHaveLength(1);
    frame();
    expect(seen).toEqual([rep(1, 4)]);
    expect(state.pending).toHaveLength(0);
  });

  it('a source that throws (no context yet) leaves the timing that stood', () => {
    const { env, frame } = fakeEnv();
    const seen: Array<{ instrument: number; row: number }> = [];
    const driver = createAhxPListPlayheadDriver((r) => seen.push(r), env);
    driver.setTimingSource(() => {
      throw new Error('no audio context');
    });
    expect(() => driver.push(rep(1, 0))).not.toThrow();
    frame();
    expect(seen).toEqual([rep(1, 0)]);
  });

  it('reads the timing at each report, so a context whose latency settles later is followed', () => {
    const { env, state, frame } = fakeEnv();
    const seen: Array<{ instrument: number; row: number }> = [];
    const driver = createAhxPListPlayheadDriver((r) => seen.push(r), env);
    let latency = 0;
    driver.setTimingSource(() => playheadTiming(48000, 1, latency));
    driver.push(rep(1, 0));
    frame();
    expect(seen).toEqual([rep(1, 0)]);
    latency = 100;
    driver.push(rep(1, 1));
    frame();
    expect(seen).toHaveLength(1);
    expect(state.pending).toHaveLength(1);
  });

  describe('a hidden tab', () => {
    it('asks for no frame, keeps the queue small, and shows the newest report when it is visible again', () => {
      const { env, state, frame } = fakeEnv();
      const seen: Array<{ instrument: number; row: number }> = [];
      const driver = createAhxPListPlayheadDriver((r) => seen.push(r), env);
      driver.setTimingSource(() => playheadTiming(48000, 1, 40));
      state.hidden = true;
      for (let k = 0; k < 500; k += 1) {
        state.now += 20;
        driver.push(rep(1, k % 96));
      }
      expect(state.requested).toBe(0);
      expect(seen).toEqual([]);
      // Visible again: the listener drains what is due, and a frame is asked for the rest.
      state.hidden = false;
      state.now += 100;
      state.visibleListener!();
      expect(seen).toEqual([rep(1, 499 % 96)]);
      frame();
      expect(seen).toHaveLength(1);
      expect(state.pending).toHaveLength(0);
    });

    it('a frame already asked for when the tab hides is left to run when it comes back', () => {
      const { env, state, frame } = fakeEnv();
      const seen: Array<{ instrument: number; row: number }> = [];
      const driver = createAhxPListPlayheadDriver((r) => seen.push(r), env);
      driver.push(rep(1, 0));
      state.hidden = true;
      driver.push(rep(1, 1));
      expect(state.requested).toBe(1);
      state.hidden = false;
      frame();
      expect(seen).toEqual([rep(1, 1)]);
    });
  });

  it('with no frame callback in the environment a due report is shown at once', () => {
    const { env } = fakeEnv({ frames: false });
    const seen: Array<{ instrument: number; row: number }> = [];
    const driver = createAhxPListPlayheadDriver((r) => seen.push(r), env);
    driver.push(rep(1, 3));
    expect(seen).toEqual([rep(1, 3)]);
  });

  it('clear drops what waits and cancels the frame; a late frame shows nothing', () => {
    const { env, state } = fakeEnv();
    const seen: Array<{ instrument: number; row: number }> = [];
    const driver = createAhxPListPlayheadDriver((r) => seen.push(r), env);
    driver.push(rep(1, 0));
    driver.clear();
    expect(state.cancelled).toBe(1);
    expect(state.pending).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it('dispose stops listening for visibility', () => {
    const { env, state } = fakeEnv();
    const driver = createAhxPListPlayheadDriver(() => undefined, env);
    expect(state.visibleListener).not.toBeNull();
    driver.dispose();
    expect(state.visibleListener).toBeNull();
  });
});
