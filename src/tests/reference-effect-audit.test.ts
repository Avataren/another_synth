/**
 * Effects checked against 8bitbubsy's cycle-accurate replayer clones rather
 * than against a plausible reading of the format.
 *
 * Every number here is quoted from one of:
 *   - pt2-clone `src/pt2_replayer.c` / `src/pt2_tables.c` (ProTracker)
 *   - ft2-clone `src/ft2_replayer.c` / `src/ft2_tables.c` (FastTracker 2)
 *
 * See PLAN-module-format-support.md D83-D86.
 */

import { describe, it, expect } from 'vitest';
import {
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  type TrackEffectState,
} from '../../packages/tracker-playback/src/effect-processor';
import {
  PROTRACKER_PROFILE,
  XM_PROFILE,
  type FormatProfile,
} from '../../packages/tracker-playback/src/format-profile';
import type { EffectCommand } from '../../packages/tracker-playback/src/types';

const PERIOD_C2 = 428;

function stateFor(profile: FormatProfile): TrackEffectState {
  const state = createTrackEffectState(profile);
  state.currentVolume = 0.5;
  return state;
}

/** A ProTracker state sounding C-2 (period 428). */
function protrackerOnC2(): TrackEffectState {
  const state = stateFor(PROTRACKER_PROFILE);
  const frequency = PROTRACKER_PROFILE.pitch.frequencyFromPeriod(PERIOD_C2);
  state.currentPeriod = PERIOD_C2;
  state.currentFrequency = frequency;
  state.targetFrequency = frequency;
  return state;
}

/** An XM (linear table) state sounding C-4, period 4608. */
function xmOnC4(): TrackEffectState {
  const state = stateFor(XM_PROFILE);
  const frequency = XM_PROFILE.pitch.frequencyFromPeriod(4608);
  state.currentPeriod = 4608;
  state.currentFrequency = frequency;
  state.targetFrequency = frequency;
  return state;
}

function periodOf(state: TrackEffectState, commands: unknown[]): number {
  const pitches = commands.filter(
    (c): c is { kind: 'pitch'; frequency: number } =>
      (c as { kind: string }).kind === 'pitch',
  );
  const last = pitches[pitches.length - 1];
  expect(last).toBeDefined();
  return state.profile.pitch.rawPeriodFromFrequency(last!.frequency);
}

/** The semitone offset an arpeggio tick produced, relative to the base note. */
function arpeggioOffsets(
  state: TrackEffectState,
  effect: EffectCommand,
  speed: number,
): number[] {
  const base = state.currentFrequency;
  const offsets: number[] = [];
  processEffectTick0(state, effect, undefined, undefined, undefined, speed);
  for (let tick = 1; tick < speed; tick++) {
    const { commands } = processEffectTickN(state, effect, tick, speed);
    const pitches = commands.filter(
      (c): c is { kind: 'pitch'; frequency: number } =>
        (c as { kind: string }).kind === 'pitch',
    );
    const last = pitches[pitches.length - 1]!;
    offsets.push(Math.round(12 * Math.log2(last.frequency / base)));
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// D83 -- arpeggio tick order
// ---------------------------------------------------------------------------

describe("D83: arpeggio walks its notes in the format's own order", () => {
  // `047` is a major triad: x = 4 semitones (major third), y = 7 (fifth).
  const arp: EffectCommand = { type: 'arpeggio', paramX: 4, paramY: 7 };

  it('ProTracker plays base, x, y -- song->tick counts up, and it reads tick % 3', () => {
    // pt2_replayer.c:
    //   int32_t arpTick = song->tick % 3; // 0, 1, 2
    //   if (arpTick == 1) arpNote = ch->n_cmd >> 4;
    //   else if (arpTick == 2) arpNote = ch->n_cmd & 0xF;
    // with song->tick++ per tick from 0 (line 1369).
    expect(arpeggioOffsets(protrackerOnC2(), arp, 6)).toEqual([4, 7, 0, 4, 7]);
  });

  it('FT2 plays base, y, x at speed 6 -- song.tick counts down', () => {
    // ft2_replayer.c tickReplayer():
    //   if (--song.tick == 0) song.tick = song.speed;
    // so row tick t sees song.tick == speed - t, and
    //   const uint8_t tick = arpeggioTab[song.tick & 31];
    // with arpeggioTab = {0,1,2,0,1,2,...} gives, for speed 6:
    //   t=1 -> tab[5] = 2 -> y
    //   t=2 -> tab[4] = 1 -> x
    //   t=3 -> tab[3] = 0 -> base
    //   t=4 -> tab[2] = 2 -> y
    //   t=5 -> tab[1] = 1 -> x
    //
    // This is the fix's headline: x and y are swapped against ProTracker for
    // 7608 of the corpus's 12987 XM arpeggio commands (those at speed 6) and
    // 5186 more at speed 3, so a major triad arpeggiated root-third-fifth was
    // being played root-fifth-third.
    expect(arpeggioOffsets(xmOnC4(), arp, 6)).toEqual([7, 4, 0, 7, 4]);
  });

  it('FT2 plays base, y, x at speed 3 too', () => {
    // t=1 -> tab[2] = 2 -> y; t=2 -> tab[1] = 1 -> x.
    expect(arpeggioOffsets(xmOnC4(), arp, 3)).toEqual([7, 4]);
  });

  it('FT2 at speed 4 opens on the base note twice, which ProTracker never does', () => {
    // t=1 -> tab[3] = 0 -> base; t=2 -> tab[2] = 2 -> y; t=3 -> tab[1] = 1 -> x.
    // Tick 0 is already the base note (arpeggio has `dummy` at slot 0 of
    // JumpTab_TickZero), so the row opens base, base, y, x.
    expect(arpeggioOffsets(xmOnC4(), arp, 4)).toEqual([0, 7, 4]);
    expect(arpeggioOffsets(protrackerOnC2(), arp, 4)).toEqual([4, 7, 0]);
  });

  it('FT2 reads the sixteen overflow bytes past the end of its table', () => {
    // arpeggioTab is 32 bytes in ft2-clone but only the first 16 are FT2's;
    // the rest are the bytes that follow it in FT2's binary, reproduced
    // verbatim. At speed 20 the row's first tick indexes tab[19] = 0x4A,
    // which is neither 0 nor 1, so the `else` arm selects y.
    expect(arpeggioOffsets(xmOnC4(), arp, 20)[0]).toBe(7);
    // tab[16] is the one 0 among them, reached at speed 20, tick 4.
    expect(arpeggioOffsets(xmOnC4(), arp, 20)[3]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D84 -- 5xy / 6xy share Axy's volume-slide memory on XM
// ---------------------------------------------------------------------------

describe('D84: 6xy and 5xy run the same volume slide Axy does', () => {
  it("XM: a 600 continues the channel's last volume slide", () => {
    // ft2_replayer.c:
    //   static void vibratoPlusVolSlide(channel_t *ch, uint8_t param)
    //   { doVibrato(ch); volSlide(ch, param); }
    // and volSlide starts `if (param == 0) param = ch->volSlideSpeed;`.
    //
    // an-path.xm carries 1428 `600` cells, every one of which was doing
    // nothing at all before this.
    const state = xmOnC4();
    state.currentVolume = 0.5;

    // A04: slide down 4 units per tick.
    processEffectTick0(
      state,
      { type: 'volSlide', paramX: 0, paramY: 4 },
      undefined,
      undefined,
      undefined,
      6,
    );
    expect(state.volumeSlide.delta).toBeCloseTo(-4 / 64, 10);

    // 600 on the next row: no parameter of its own, so it repeats the A04.
    processEffectTick0(
      state,
      { type: 'vibratoVol', paramX: 0, paramY: 0 },
      undefined,
      undefined,
      undefined,
      6,
    );
    expect(state.volumeSlide.delta).toBeCloseTo(-4 / 64, 10);

    const before = state.currentVolume;
    processEffectTickN(
      state,
      { type: 'vibratoVol', paramX: 0, paramY: 0 },
      1,
      6,
    );
    expect(state.currentVolume).toBeCloseTo(before - 4 / 64, 10);
  });

  it('XM: a non-zero 6xy overwrites the memory a later A00 repeats', () => {
    const state = xmOnC4();
    state.currentVolume = 0.5;

    processEffectTick0(
      state,
      { type: 'volSlide', paramX: 0, paramY: 4 },
      undefined,
      undefined,
      undefined,
      6,
    );
    // 620: slide *up* by 2. FT2's volSlide writes volSlideSpeed on every
    // non-zero parameter, whichever command supplied it.
    processEffectTick0(
      state,
      { type: 'vibratoVol', paramX: 2, paramY: 0 },
      undefined,
      undefined,
      undefined,
      6,
    );
    expect(state.volumeSlide.delta).toBeCloseTo(2 / 64, 10);

    // A00 now repeats the 620, not the A04.
    processEffectTick0(
      state,
      { type: 'volSlide', paramX: 0, paramY: 0 },
      undefined,
      undefined,
      undefined,
      6,
    );
    expect(state.volumeSlide.delta).toBeCloseTo(2 / 64, 10);
  });

  it('ProTracker: a 600 really is a no-op, because it has no memory', () => {
    // pt2_replayer.c's volumeSlide reads `ch->n_cmd & 0xFF` raw:
    //   if ((param & 0xF0) == 0) ch->n_volume -= param & 0x0F;
    // so a zero parameter subtracts zero. The MOD corpus has 612 `600` cells
    // that depend on this staying inert.
    const state = protrackerOnC2();
    state.currentVolume = 0.5;

    processEffectTick0(
      state,
      { type: 'volSlide', paramX: 0, paramY: 4 },
      undefined,
      undefined,
      undefined,
      6,
    );
    processEffectTick0(
      state,
      { type: 'vibratoVol', paramX: 0, paramY: 0 },
      undefined,
      undefined,
      undefined,
      6,
    );
    expect(state.volumeSlide.delta).toBe(0);

    const before = state.currentVolume;
    processEffectTickN(
      state,
      { type: 'vibratoVol', paramX: 0, paramY: 0 },
      1,
      6,
    );
    expect(state.currentVolume).toBeCloseTo(before, 10);
  });

  it('the up nibble wins outright, in both formats', () => {
    // `if ((param & 0xF0) == 0) { down } else { up }` -- the down nibble is
    // never even read when the up nibble is set.
    for (const state of [protrackerOnC2(), xmOnC4()]) {
      processEffectTick0(
        state,
        { type: 'volSlide', paramX: 1, paramY: 2 },
        undefined,
        undefined,
        undefined,
        6,
      );
      expect(state.volumeSlide.delta).toBeCloseTo(1 / 64, 10);
    }
  });
});

// ---------------------------------------------------------------------------
// D85 -- the vibrato/tremolo oscillator
// ---------------------------------------------------------------------------

describe('D85: the vibrato oscillator matches the replayers', () => {
  it('samples position 0 on the first tick, then advances', () => {
    // doVibrato ends with `ch->vibratoPos += ch->vibratoSpeed;`, and vibrato
    // is `dummy` at slot 4 of JumpTab_TickZero, so tick 1 of a fresh note
    // reads position 0 -- vibratoTab[0] == 0, the note's own pitch.
    const state = protrackerOnC2();
    const vib: EffectCommand = { type: 'vibrato', paramX: 4, paramY: 8 };

    processEffectTick0(state, vib, undefined, undefined, undefined, 6);
    const t1 = processEffectTickN(state, vib, 1, 6);
    expect(periodOf(state, t1.commands)).toBeCloseTo(PERIOD_C2, 6);

    // Tick 2 reads position 4 (speed 4): vibratoTab[4] == 97, and
    // (97 * 8) >> 7 == 6 period units, added while the position is positive.
    const t2 = processEffectTickN(state, vib, 2, 6);
    expect(periodOf(state, t2.commands)).toBeCloseTo(
      PERIOD_C2 + (97 * 8) / 128,
      4,
    );
  });

  it("uses the replayers' own 32-entry sine table", () => {
    // vibratoTable / vibratoTab: 0,24,49,74,97,120,141,161,180,197,212,...
    const state = protrackerOnC2();
    const vib: EffectCommand = { type: 'vibrato', paramX: 1, paramY: 8 };
    processEffectTick0(state, vib, undefined, undefined, undefined, 20);

    const expected = [0, 24, 49, 74, 97, 120, 141, 161];
    for (let tick = 1; tick <= expected.length; tick++) {
      const { commands } = processEffectTickN(state, vib, tick, 20);
      expect(periodOf(state, commands)).toBeCloseTo(
        PERIOD_C2 + (expected[tick - 1]! * 8) / 128,
        4,
      );
    }
  });

  it('waveform 1 is a rising ramp, not a falling one', () => {
    // Both replayers build the ramp as `tmpVib = (pos >> 2 & 31) << 3`,
    // rising 0..248, and negate it in the second half of the cycle. It rises
    // from 0 to +1, jumps to -1, and rises back: the opposite direction to
    // the `1 - 2 * phase` this used to compute, and a quarter cycle out of
    // phase with it.
    const state = protrackerOnC2();
    state.vibratoWaveform = 1;
    const vib: EffectCommand = { type: 'vibrato', paramX: 1, paramY: 8 };
    processEffectTick0(state, vib, undefined, undefined, undefined, 40);

    // Position 0 -> 0; position 1 -> 8; position 2 -> 16 ...
    for (const [tick, raw] of [
      [1, 0],
      [2, 8],
      [3, 16],
      [4, 24],
    ] as const) {
      const { commands } = processEffectTickN(state, vib, tick, 40);
      expect(periodOf(state, commands)).toBeCloseTo(
        PERIOD_C2 + (raw * 8) / 128,
        4,
      );
    }

    // Position 32 is the jump to the negative peak: 255 - 0 == 255, subtracted.
    state.vibratoPos = 32;
    const { commands } = processEffectTickN(state, vib, 5, 40);
    expect(periodOf(state, commands)).toBeCloseTo(
      PERIOD_C2 - (255 * 8) / 128,
      4,
    );
  });

  it('waveform 3 is a square wave, not noise', () => {
    // Neither replayer has a random waveform: both switch on the low two bits
    // with `default:` covering 2 and 3 alike, and both defaults are a flat
    // 255. The old Math.random() also made playback non-deterministic.
    const first: number[] = [];
    const second: number[] = [];
    for (const sink of [first, second]) {
      const state = protrackerOnC2();
      state.vibratoWaveform = 3;
      const vib: EffectCommand = { type: 'vibrato', paramX: 8, paramY: 8 };
      processEffectTick0(state, vib, undefined, undefined, undefined, 12);
      for (let tick = 1; tick < 12; tick++) {
        const { commands } = processEffectTickN(state, vib, tick, 12);
        sink.push(periodOf(state, commands));
      }
    }
    expect(first).toEqual(second);
    // Speed 8: positions 0,8,...,24 are the positive half (offset +15.9375),
    // 32,40,48,56 the negative half.
    expect(first[0]).toBeCloseTo(PERIOD_C2 + (255 * 8) / 128, 4);
    expect(first[4]).toBeCloseTo(PERIOD_C2 - (255 * 8) / 128, 4);
  });

  it('the tremolo position also advances only after it is read', () => {
    // `ch->tremoloPos += ch->tremoloSpeed;` is the last line of both tremolo
    // routines. Tick 1 of a fresh note therefore reads vibratoTab[0] == 0 and
    // leaves the volume alone.
    const state = protrackerOnC2();
    state.currentVolume = 0.5;
    const trem: EffectCommand = { type: 'tremolo', paramX: 4, paramY: 8 };
    processEffectTick0(state, trem, undefined, undefined, undefined, 6);

    const { commands } = processEffectTickN(state, trem, 1, 6);
    const volume = commands.filter(
      (c): c is { kind: 'volume'; volume: number } => c.kind === 'volume',
    );
    expect(volume[volume.length - 1]!.volume).toBeCloseTo(0.5, 6);
  });
});

// ---------------------------------------------------------------------------
// D86 -- Rxy volume case 6
// ---------------------------------------------------------------------------

describe('D86: Rxy volume change x=6 is 11/16, not two thirds', () => {
  it("applies FT2's shift arithmetic", () => {
    // doMultiNoteRetrig: `case 0x6: vol = (vol >> 1) + (vol >> 3) + (vol >> 4);`
    // which is 1/2 + 1/8 + 1/16 == 11/16 == 0.6875, not 0.6667.
    const state = xmOnC4();
    state.currentVolume = 1;

    // R61: volume change 6, retrigger every tick.
    const retrig: EffectCommand = { type: 'retrigVol', paramX: 6, paramY: 1 };
    processEffectTick0(state, retrig, undefined, undefined, undefined, 6);
    processEffectTickN(state, retrig, 1, 6);

    expect(state.currentVolume).toBeCloseTo(11 / 16, 10);
    expect(state.currentVolume).not.toBeCloseTo(2 / 3, 4);
  });
});
