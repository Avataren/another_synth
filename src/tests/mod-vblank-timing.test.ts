import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { parseMod } from '../../packages/tracker-playback/src/mod-parser';
import { usesVBlankTiming } from '../../packages/tracker-playback/src/mod-vblank';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * Regression coverage for KLISJE.MOD, whose 32nd pattern ends on `F20`.
 *
 * Read as a CIA tempo that is 32 BPM -- the slowest ProTracker can express --
 * and it sticks for the remaining 50 patterns, which crawl. The module is
 * VBlank-timed: `F20` means "32 ticks on this row", a one-row pause before
 * the next section. See `usesVBlankTiming` for how the two are told apart.
 */

const HEADER_SIZE = 1084;
const ROWS = 64;
const CHANNELS = 4;
const PATTERN_SIZE = ROWS * CHANNELS * 4;

interface CellSpec {
  pattern: number;
  row: number;
  channel: number;
  effectCmd: number;
  effectParam: number;
}

function createModBuffer(options: {
  numPatterns: number;
  orders: number[];
  cells: CellSpec[];
}): Uint8Array {
  const { numPatterns, orders, cells } = options;
  const buf = new Uint8Array(HEADER_SIZE + numPatterns * PATTERN_SIZE + 8);
  const view = new DataView(buf.buffer);

  let offset = 20;
  for (let i = 0; i < 31; i++) {
    // One non-empty sample so the file looks like a real 31-sample module.
    view.setUint16(offset + 22, i === 0 ? 4 : 0, false);
    buf[offset + 25] = 64;
    offset += 30;
  }

  buf[950] = orders.length;
  orders.forEach((order, i) => {
    buf[952 + i] = order;
  });
  for (const [i, ch] of [...'M.K.'].entries()) buf[1080 + i] = ch.charCodeAt(0);

  for (const cell of cells) {
    const at =
      HEADER_SIZE +
      cell.pattern * PATTERN_SIZE +
      (cell.row * CHANNELS + cell.channel) * 4;
    buf[at + 2] = cell.effectCmd & 0x0f;
    buf[at + 3] = cell.effectParam;
  }

  return buf;
}

/**
 * A long song (100 orders) that pauses once on `F20` and resumes at `F06`.
 * As a tempo the F20 drags every later pattern out to 32 BPM.
 */
function createLongPausingMod(pauseParam = 0x20): Uint8Array {
  return createModBuffer({
    numPatterns: 2,
    orders: [0, ...Array<number>(99).fill(1)],
    cells: [
      { pattern: 0, row: 63, channel: 3, effectCmd: 0xf, effectParam: pauseParam },
      { pattern: 1, row: 0, channel: 0, effectCmd: 0xf, effectParam: 0x06 },
    ],
  });
}

describe('usesVBlankTiming', () => {
  it('flags a long module whose only tempo command would slow it to a crawl', () => {
    expect(usesVBlankTiming(parseMod(createLongPausingMod()))).toBe(true);
  });

  it('leaves a module alone when it never uses a tempo command', () => {
    const mod = createModBuffer({
      numPatterns: 2,
      orders: [0, ...Array<number>(99).fill(1)],
      cells: [
        { pattern: 0, row: 63, channel: 3, effectCmd: 0xf, effectParam: 0x1f },
        { pattern: 1, row: 0, channel: 0, effectCmd: 0xf, effectParam: 0x06 },
      ],
    });
    expect(usesVBlankTiming(parseMod(mod))).toBe(false);
  });

  it('keeps CIA timing when the module states a tempo of 100 BPM or more', () => {
    // 0x64 == 100 BPM. As a speed that is nonsense, so the module means it.
    expect(usesVBlankTiming(parseMod(createLongPausingMod(0x64)))).toBe(false);
  });

  it('keeps CIA timing for a short song, where a low tempo is plausible', () => {
    const mod = createModBuffer({
      numPatterns: 2,
      orders: [0, 1],
      cells: [
        { pattern: 0, row: 63, channel: 3, effectCmd: 0xf, effectParam: 0x20 },
        { pattern: 1, row: 0, channel: 0, effectCmd: 0xf, effectParam: 0x06 },
      ],
    });
    expect(usesVBlankTiming(parseMod(mod))).toBe(false);
  });
});

describe('MOD import', () => {
  it('tags a VBlank-timed module on the song', () => {
    const song = importModToTrackerSong(createLongPausingMod().buffer as ArrayBuffer);
    expect(song.data.vblankTiming).toBe(true);
  });

  it('leaves the flag off for an ordinary CIA-timed module', () => {
    const song = importModToTrackerSong(
      createLongPausingMod(0x64).buffer as ArrayBuffer,
    );
    expect(song.data.vblankTiming).toBeUndefined();
  });
});

function makeContext(vblankTiming: boolean): TrackerSongBuilderContext {
  return {
    currentSong: ref({ title: '', author: '', bpm: 125 }),
    vblankTiming: ref(vblankTiming),
    patterns: ref([]),
    sequence: ref([]),
    currentPatternId: ref(null),
    currentPattern: ref(undefined),
    defaultPatternRows: ref(4),
    instrumentSlots: ref([]),
    songPatches: ref({}),
    songBank: {} as TrackerSongBuilderContext['songBank'],
    normalizeInstrumentId: (id) => (id ? id : undefined),
    formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
  };
}

describe('buildPlaybackStepsForTrack Fxx handling', () => {
  const track: TrackerTrackData = {
    id: 't1',
    name: 'Track 1',
    entries: [{ row: 0, macro: 'F20' }],
  };

  it('reads F20 as a tempo change under the default CIA timing', () => {
    const { buildPlaybackStepsForTrack } = useTrackerSongBuilder(makeContext(false));
    const steps = buildPlaybackStepsForTrack(track);
    expect(steps[0]!.tempoCommand).toBe(32);
    expect(steps[0]!.speedCommand).toBeUndefined();
  });

  it('reads F20 as 32 ticks per row in a VBlank-timed song', () => {
    const { buildPlaybackStepsForTrack } = useTrackerSongBuilder(makeContext(true));
    const steps = buildPlaybackStepsForTrack(track);
    expect(steps[0]!.speedCommand).toBe(32);
    expect(steps[0]!.tempoCommand).toBeUndefined();
  });
});
