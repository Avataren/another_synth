import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import { songFromImport } from './helpers/imported-song';

/**
 * butterfly_syndrome.mod (ProTracker M.K.), order 9, channel 4 (track index 3),
 * rows 48-63. Reported by ear: instrument 03 should "pump" three times in this
 * window; the engine produced only two.
 *
 * The mechanism, from the module data and the ProTracker 2.3 play routine:
 *
 *   row 48  D#3 03 C00   channel 4 triggers sample 3, volume forced to 0 (Cxx).
 *   rows 49-53           nothing -- the voice runs on silently, as Paula keeps
 *                        DMA'ing the sample whatever the volume register says.
 *   row 54     03 A08    a *bare sample number* (no note): mt_PlayVoice's
 *                        sample-number block writes `n_volume = ft_volume`
 *                        (sample 3's header volume, 64) straight to Paula on
 *                        tick 0 -- instantaneous -- and then A08 slides it
 *                        down 8 per tick on ticks 1..3 (speed 4).
 *   rows 55-57 A08       the slide continues from where row 54 left it.
 *
 * That tick-0 reload to 64 is the third pump: a hard attack on a voice that
 * was already sounding. The engine computed the value but emitted it as an
 * unqualified volume command, which SongBank turns into a
 * `linearRampToValueAtTime` -- and with no volume event on the channel since
 * row 48, the ramp ran from 0 over the whole rows 48->54 gap. The hard attack
 * became a six-row swell up from silence, inaudible as a distinct pump.
 *
 * Fix: a row that (re)states the channel volume outright -- a sample-number
 * reload here -- states it as a `step` even when a volume slide shares the row.
 * See `emitTick0VolumeSlide` in effect-processor.ts.
 *
 * Reference volume trajectory for channel 4 (ProTracker `mt_VolumeSlide`,
 * `mt_VolSlideDown`: `n_volume -= y` per tick, clamped at 0; ticks 1..3 at
 * speed 4), sample 3 header volume 64:
 *
 *   row 54: tick0 64 -> 56 -> 48 -> 40
 *   row 55:       40 -> 32 -> 24 -> 16
 *   row 56:       16 ->  8 ->  0 ->  0
 *   row 57:        0 ...
 *
 * so the value Paula holds at each row start is 64, 40, 16, 0.
 */

const TRACK = 3; // channel 4
const ORDER = 9;
const ROW_SECONDS = 0.1; // arbitrary, only relative timing matters

function loadSong() {
  const buf = fs.readFileSync(
    path.resolve(__dirname, '../../public/demos/amiga/butterfly_syndrome.mod'),
  );
  return songFromImport(
    importModToTrackerSong(
      buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer,
    ),
  );
}

interface Automation {
  time: number;
  volume: number;
  ramp: 'linear' | 'exponential' | 'step';
}

/**
 * Play orders 0..9 in sequence, keeping effect state across the pattern
 * changes, and collect every volume automation the engine schedules for
 * `TRACK`, plus the gain the track's voices start at (the note-on velocity).
 */
function trackAutomation() {
  const song = loadSong();
  const events: Automation[] = [];
  const noteOnGains: { time: number; gain: number }[] = [];

  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: (e) => {
      if (e.trackIndex === TRACK && e.type === 'noteOn') {
        noteOnGains.push({ time: e.time, gain: (e.velocity ?? 0) / 127 });
      }
    },
    scheduledVolumeHandler: (_i, _v, volume, time, trackIndex, ramp) => {
      if (trackIndex === TRACK) {
        events.push({ time, volume, ramp: ramp ?? 'linear' });
      }
    },
  });

  const sequence = song.sequence ?? [];
  engine.loadSong(song, 0);
  const internals = engine as unknown as {
    scheduleRow: (row: number, time: number) => void;
  };
  const rowTime = (order: number, row: number) =>
    (order * 64 + row) * ROW_SECONDS;
  for (let order = 0; order <= ORDER; order++) {
    if (order > 0) {
      engine.loadPattern(sequence[order]!, { updatePosition: false });
    }
    for (let row = 0; row < 64; row++) {
      internals.scheduleRow(row, rowTime(order, row));
    }
  }
  return { events, noteOnGains, rowTime };
}

/**
 * A faithful-enough Web Audio gain-param evaluator: `step` is
 * setValueAtTime, everything else is linearRampToValueAtTime running from the
 * previous automation point. This is exactly what SongBank.setVoiceVolumeAtTime
 * -> TrackerSampler.setVoiceGainAtTime do with the engine's output.
 */
function makeGainCurve(
  initial: { time: number; value: number },
  events: Automation[],
) {
  const points: { time: number; value: number }[] = [
    { time: initial.time, value: initial.value },
  ];
  for (const e of events) {
    if (e.ramp === 'step') {
      // cancelScheduledValues + setValueAtTime: drop anything at/after e.time.
      while (points.length && points[points.length - 1]!.time >= e.time) {
        points.pop();
      }
      const held = valueAt(points, e.time);
      points.push({ time: e.time, value: held });
      points.push({ time: e.time, value: e.volume });
    } else {
      points.push({ time: e.time, value: e.volume });
    }
  }
  return (t: number) => valueAt(points, t);
}

function valueAt(points: { time: number; value: number }[], t: number): number {
  if (!points.length) return 0;
  if (t <= points[0]!.time) return points[0]!.value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (t >= b.time) continue;
    if (b.time === a.time) return b.value;
    const f = (t - a.time) / (b.time - a.time);
    return a.value + (b.value - a.value) * f;
  }
  return points[points.length - 1]!.value;
}

describe('butterfly_syndrome.mod order 9 channel 4 — instrument 03 pumps 3 times', () => {
  it('reloads the channel volume as a hard step, not a swell up from silence', () => {
    const { events, noteOnGains, rowTime } = trackAutomation();

    // The channel's voice for this window starts at row 48 with a C00 -> gain 0.
    const seed = noteOnGains.filter((n) => n.time <= rowTime(ORDER, 50)).at(-1);
    expect(seed).toBeDefined();
    expect(seed!.gain).toBe(0);

    const gain = makeGainCurve(
      { time: seed!.time, value: seed!.gain },
      events.filter((e) => e.time < rowTime(ORDER, 60)),
    );

    const t54 = rowTime(ORDER, 54);
    const t55 = rowTime(ORDER, 55);
    const t56 = rowTime(ORDER, 56);
    const t57 = rowTime(ORDER, 57);
    const secPerTick = (t55 - t54) / 4; // speed 4

    // The pump: at row 54's start the channel volume jumps to full scale
    // instantly. The tick just before it is still silent (the C00 from row 48,
    // untouched for five rows).
    const before = gain(t54 - secPerTick);
    const at = gain(t54);
    expect(before).toBeLessThan(2 / 64); // essentially silent
    expect(at).toBeCloseTo(1, 5); // 64/64
    // The instantaneous attack is what makes it a distinct pump. The old code
    // ramped 0 -> 64 across the whole rows 48..54 gap, so this jump was ~1/64.
    expect(at - before).toBeGreaterThan(60 / 64);

    // The value Paula holds at each following row start, from mt_VolumeSlide.
    expect(gain(t54) * 64).toBeCloseTo(64, 1);
    expect(gain(t55) * 64).toBeCloseTo(40, 1);
    expect(gain(t56) * 64).toBeCloseTo(16, 1);
    expect(gain(t57) * 64).toBeCloseTo(0, 1);
  });

  it('schedules the row-54 reload as a step', () => {
    const { events, rowTime } = trackAutomation();
    const t54 = rowTime(ORDER, 54);
    const secPerTick = (rowTime(ORDER, 55) - t54) / 4;

    // The tick-0 command for row 54: full scale, stepped.
    const reload = events.find(
      (e) => e.time >= t54 - 1e-9 && e.time < t54 + secPerTick,
    );
    expect(reload).toBeDefined();
    expect(reload!.volume).toBeCloseTo(1, 5);
    expect(reload!.ramp).toBe('step');
  });
});
