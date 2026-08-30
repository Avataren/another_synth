import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';

/**
 * A key-off on an instrument whose envelope has no sustain point.
 *
 * Reported on "im in love with you.xm": the opening patterns trade two triads
 * between channels 0-2 and 3-5 every sixteen rows, each swap keying off the
 * three channels that were sounding while the other three start. The released
 * chord rang on far too loudly.
 *
 * FT2 advances `volEnvTick` every tick unconditionally and only holds at the
 * sustain point, and only while `(volEnvFlags & ENV_SUSTAIN) && !keyOff`. With
 * sustain disabled there is nothing to release from: the envelope was already
 * running its whole shape and simply carries on. `keyOff` additionally starts
 * the fadeout, which does nothing when the instrument's fadeout is 0, since
 * `fadeoutVol` is then never decremented.
 *
 * The engine froze the envelope at the key-off instead, so the decay stopped
 * dead and the note hung at whatever level it had reached until the channel
 * played again. See D82.
 */

const SONG = path.resolve(
  __dirname,
  '../../public/demos/ft2/im in love with you.xm',
);

function importedSong() {
  const buf = fs.readFileSync(SONG);
  return importXmToTrackerSong(
    buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer,
  );
}

/** Linear interpolation of an envelope, the way the scheduler reads it. */
function valueAtTick(
  points: { tick: number; value: number }[],
  tick: number,
): number {
  if (points.length === 0) return 64;
  if (tick <= points[0]!.tick) return points[0]!.value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (tick <= b.tick) {
      const span = Math.max(1, b.tick - a.tick);
      return a.value + ((b.value - a.value) * (tick - a.tick)) / span;
    }
  }
  return points[points.length - 1]!.value;
}

describe('the chord instrument in “im in love with you”', () => {
  /**
   * The sampler patch the opening chords are played by, resolved the way
   * playback resolves it: the pattern names a slot, the slot names a patch.
   * (Only *used* XM instruments get slots, so the slot number is not the file's
   * instrument number.)
   */
  function chordEnvelope() {
    const song = importedSong();
    const opening = song.data.patterns[0]!;
    const firstNote = opening.tracks[0]!.entries.find((e) => e.note);
    expect(firstNote?.instrument).toBeDefined();

    const slot = song.data.instrumentSlots.find(
      (s) => String(s.slot).padStart(2, '0') === firstNote!.instrument,
    );
    expect(slot).toBeDefined();

    const patch = song.data.songPatches[slot!.patchId!];
    expect(patch).toBeDefined();
    const sampler = [...deserializePatch(patch!).samplers.values()][0]!;
    return sampler.trackerEnvelope!;
  }

  it('has an envelope with no sustain point and no fadeout', () => {
    // Which is what makes FT2's key-off a no-op for it, and what the engine
    // has to reproduce. If this ever changes the test below stops meaning
    // anything, so assert it rather than assume it.
    const envelope = chordEnvelope();
    expect(envelope.sustainPoint).toBe(-1);
    expect(envelope.fadeout).toBe(0);
    expect(envelope.points.map((p) => p.tick)).toEqual([0, 43, 110, 200, 309]);
    expect(envelope.points.map((p) => p.value)).toEqual([64, 41, 20, 6, 0]);
  });

  it('keeps decaying across the sixteen rows after a key-off', () => {
    // The song runs at speed 6, so a swap is 16 * 6 = 96 envelope ticks. The
    // chord is keyed off one swap in and replaced one swap later.
    const envelope = chordEnvelope();
    const atKeyOff = valueAtTick(envelope.points, 96);
    const atNextNote = valueAtTick(envelope.points, 192);

    // Freezing at the key-off left the note more than three times louder than
    // FT2 has it by the time the channel plays again.
    expect(atKeyOff).toBeGreaterThan(20);
    expect(atNextNote).toBeLessThan(atKeyOff / 3);
  });

  it('reaches silence well before the envelope’s last point is reached', () => {
    const envelope = chordEnvelope();
    expect(valueAtTick(envelope.points, 309)).toBe(0);
  });
});
