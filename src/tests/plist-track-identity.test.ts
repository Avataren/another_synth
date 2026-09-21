// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import type { AhxInstrument } from '@another-synth/tracker-playback';
import { defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';
import { buildPListTrack, createPListTrackMemo } from 'src/audio/tracker/plist-track';

/**
 * T2: `updateAhxInstrument` replaces `slot.ahxData` on every edit, and the
 * canvas repaints its static bitmap when the track OBJECT changes. The same
 * PList content must therefore give back the same object.
 */
const withPList = (): AhxInstrument => {
  const ins = defaultAhxInstrument();
  ins.plist = {
    speed: 3,
    entries: [
      { note: 6, waveform: 3, fixed: false, fx: [0, 0], fxParam: [0, 0] },
      { note: 25, waveform: 0, fixed: true, fx: [5, 0], fxParam: [0, 0] },
    ],
  };
  return ins;
};
const clone = (ins: AhxInstrument): AhxInstrument => JSON.parse(JSON.stringify(ins)) as AhxInstrument;

describe('the PList track memo', () => {
  it('returns the identical object for equal content in a different instrument object', () => {
    const project = createPListTrackMemo();
    const a = withPList();
    expect(project(clone(a))).toBe(project(clone(a)));
  });

  it('returns a new object when a shown field changes', () => {
    const project = createPListTrackMemo();
    const a = withPList();
    const first = project(a);
    const b = clone(a);
    b.plist.entries[0]!.note = 7;
    const second = project(b);
    expect(second).not.toBe(first);
    expect(second.entries[0]!.note).toBe('+06');
    const c = clone(b);
    c.plist.entries[1]!.fxParam[1] = 9;
    expect(project(c)).not.toBe(second);
  });

  it('returns a new object when a row is added or removed', () => {
    const project = createPListTrackMemo();
    const a = withPList();
    const first = project(a);
    const b = clone(a);
    b.plist.entries.push({ note: 0, waveform: 0, fixed: false, fx: [0, 0], fxParam: [0, 0] });
    expect(project(b)).not.toBe(first);
  });

  it('keeps the identical object across edits that leave the PList alone', () => {
    const project = createPListTrackMemo();
    const a = withPList();
    const first = project(a);
    const b = clone(a);
    b.envelope = { ...b.envelope, aFrames: b.envelope.aFrames + 5, aVolume: 12 };
    b.volume = 17;
    b.plist.speed = 9; // the speed is not on the canvas
    expect(project(b)).toBe(first);
  });

  it('does not repaint for `fixed` on a row with no note, which the canvas cannot show', () => {
    const project = createPListTrackMemo();
    const a = withPList();
    a.plist.entries.push({ note: 0, waveform: 0, fixed: false, fx: [0, 0], fxParam: [0, 0] });
    const first = project(a);
    const b = clone(a);
    b.plist.entries[2]!.fixed = true;
    expect(project(b)).toBe(first);
  });

  it('gives the same output for a reactive Proxy as for the raw instrument, and never reads through the Proxy', () => {
    const raw = withPList();
    const proxy = reactive(clone(raw));
    const viaProxy = createPListTrackMemo()(proxy);
    const viaRaw = createPListTrackMemo()(raw);
    expect(viaProxy).toEqual(viaRaw);
    expect(viaProxy).toEqual(buildPListTrack(raw.plist.entries));
    // The entries the track was built from are plain data, not Proxy-wrapped objects.
    expect(Object.isFrozen(viaProxy.entries)).toBe(true);
  });

  it('treats a missing instrument as an empty PList', () => {
    const project = createPListTrackMemo();
    expect(project(null).entries).toEqual([]);
    expect(project(undefined)).toBe(project(null));
  });
});
