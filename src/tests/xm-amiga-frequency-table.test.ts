import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { useTrackerStore } from 'src/stores/tracker-store';
import { createPinia, setActivePinia } from 'pinia';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import { createXmAmigaPitchModel } from '../../packages/tracker-playback/src/pitch-model';
import { buildXm, cell, emptyCell } from './helpers/xm-builder';

/**
 * Which frequency table an XM selected has to reach the engine.
 *
 * It chooses the pitch model every pitch *effect* is computed in. Note
 * frequencies are resolved at import and are correct either way, so losing the
 * flag leaves a song perfectly in tune while every portamento, vibrato and
 * arpeggio moves the wrong musical distance -- which is precisely how it hid.
 *
 * `xm-import` read the flag from the parser and put it in a console.log
 * instead of the song data, so `Song.linearFrequency` was always undefined and
 * `profileForFormat` fell through to the linear profile. Roughly half of real
 * XM files use the Amiga table (4 of the 9 in the local corpus), and 4-mat's
 * "rose" is one: its lead lands about a semitone short of where it should,
 * because a `104` portamento moved 0.5 of a semitone (linear units) instead of
 * the 0.886 its Amiga periods call for.
 */

function xmWithTable(linearFrequency: boolean) {
  return buildXm({
    numChannels: 1,
    linearFrequency,
    speed: 3,
    instruments: [{ samples: [{ frames: [0, 1, 0, -1] }] }],
    patterns: [
      {
        numRows: 4,
        cells: [
          // F-5 with a 104 portamento up, the shape rose uses.
          [cell(66, { instrument: 1, effectType: 1, effectParam: 4 })],
          [emptyCell()],
        ],
      },
    ],
  }).buffer as ArrayBuffer;
}

describe('the XM frequency table reaches the song', () => {
  it('is carried on the imported song data', () => {
    expect(importXmToTrackerSong(xmWithTable(false)).data.linearFrequency).toBe(
      false,
    );
    expect(importXmToTrackerSong(xmWithTable(true)).data.linearFrequency).toBe(
      true,
    );
  });

  it('round-trips through the store', () => {
    setActivePinia(createPinia());
    const store = useTrackerStore();
    store.loadSongFile(importXmToTrackerSong(xmWithTable(false)));
    expect(store.linearFrequency).toBe(false);
    expect(store.serializeSong().data.linearFrequency).toBe(false);
  });

  it('defaults to linear for a song saved before the field existed', () => {
    setActivePinia(createPinia());
    const store = useTrackerStore();
    const file = importXmToTrackerSong(xmWithTable(false));
    delete (file.data as { linearFrequency?: boolean }).linearFrequency;
    store.loadSongFile(file);
    expect(store.linearFrequency).toBe(true);
  });

  it('reaches the playback song through the builder', () => {
    const file = importXmToTrackerSong(xmWithTable(false));
    const pattern = file.data.patterns[0]!;
    const ctx: TrackerSongBuilderContext = {
      currentSong: ref(file.data.currentSong),
      moduleFormat: ref(file.data.moduleFormat!),
      initialSpeed: ref(file.data.initialSpeed ?? 6),
      linearFrequency: ref(file.data.linearFrequency ?? true),
      patterns: ref([pattern]),
      sequence: ref([pattern.id]),
      currentPatternId: ref(pattern.id),
      currentPattern: ref(pattern),
      defaultPatternRows: ref(64),
      instrumentSlots: ref(file.data.instrumentSlots),
      songPatches: ref(file.data.songPatches ?? {}),
      songBank: {} as TrackerSongBuilderContext['songBank'],
      normalizeInstrumentId: (id) => (id ? id : undefined),
      formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
    };
    expect(
      useTrackerSongBuilder(ctx).buildPlaybackSong('song').linearFrequency,
    ).toBe(false);
  });
});

/** Where a `104` portamento leaves the pitch after one row at speed 3. */
function portamentoLanding(linearFrequency: boolean): number {
  const file = importXmToTrackerSong(xmWithTable(linearFrequency));
  const pattern = file.data.patterns[0]!;
  const ctx: TrackerSongBuilderContext = {
    currentSong: ref(file.data.currentSong),
    moduleFormat: ref(file.data.moduleFormat!),
    initialSpeed: ref(file.data.initialSpeed ?? 6),
    linearFrequency: ref(file.data.linearFrequency ?? true),
    patterns: ref([pattern]),
    sequence: ref([pattern.id]),
    currentPatternId: ref(pattern.id),
    currentPattern: ref(pattern),
    defaultPatternRows: ref(64),
    instrumentSlots: ref(file.data.instrumentSlots),
    songPatches: ref(file.data.songPatches ?? {}),
    songBank: {} as TrackerSongBuilderContext['songBank'],
    normalizeInstrumentId: (id) => (id ? id : undefined),
    formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
  };
  const song = useTrackerSongBuilder(ctx).buildPlaybackSong('song');
  let last = 0;
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: () => {},
    scheduledPitchHandler: (_i, _v, f) => {
      last = f;
    },
  });
  engine.loadSong(song);
  (engine as unknown as { scheduleRow: (r: number, t: number) => void }).scheduleRow(0, 0);
  return createXmAmigaPitchModel().rawPeriodFromFrequency(last);
}

describe('an Amiga-table song slides in Amiga periods', () => {
  // F-5 is Amiga period 1712 * 2^(-17/12) = 641.3, and FT2 subtracts param*4
  // from the period on each of the two sliding ticks at speed 3.
  const F5_PERIOD = 1712 * Math.pow(2, -17 / 12);

  it('moves param*4 period units per tick', () => {
    expect(portamentoLanding(false)).toBeCloseTo(F5_PERIOD - 2 * 4 * 4, 3);
  });

  it('differs from what the linear table would have done', () => {
    // The linear model treats the same command as 4/64 of a semitone a tick,
    // which is a smaller move -- the song stays in tune but every slide falls
    // short. Guards against the flag being silently dropped again.
    const amiga = portamentoLanding(false);
    const linear = portamentoLanding(true);
    expect(linear).toBeGreaterThan(amiga);
    const semitonesApart = 12 * Math.log2(linear / amiga);
    expect(semitonesApart).toBeGreaterThan(0.3);
  });
});
