import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type { ModuleFormat } from '../../packages/tracker-playback/src/types';
import { createPinia, setActivePinia } from 'pinia';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { buildXm, cell } from './helpers/xm-builder';

/**
 * The format tag has to survive the whole store -> builder -> engine hop.
 * Phase 2 selects the FormatProfile from it, and a silent drop anywhere on
 * that path would degrade every song to native semantics without any error.
 */
function makeContext(moduleFormat?: ModuleFormat): TrackerSongBuilderContext {
  const pattern = {
    id: 'p1',
    name: 'Pattern 1',
    rows: 4,
    tracks: [{ id: 't1', name: 'Track 1', entries: [], interpolations: [] }],
  };
  return {
    currentSong: ref({ title: 'T', author: 'A', bpm: 125 }),
    ...(moduleFormat ? { moduleFormat: ref(moduleFormat) } : {}),
    patterns: ref([pattern]),
    sequence: ref(['p1']),
    currentPatternId: ref('p1'),
    currentPattern: ref(pattern),
    defaultPatternRows: ref(4),
    instrumentSlots: ref([]),
    songPatches: ref({}),
    songBank: {} as TrackerSongBuilderContext['songBank'],
    normalizeInstrumentId: (id) => (id ? id : undefined),
    formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
  };
}

describe('module format plumbing', () => {
  it('carries the tag from the builder context onto the playback song', () => {
    const { buildPlaybackSong } = useTrackerSongBuilder(makeContext('protracker'));
    expect(buildPlaybackSong('song').moduleFormat).toBe('protracker');
  });

  it('falls back to native when the context omits the tag', () => {
    const { buildPlaybackSong } = useTrackerSongBuilder(makeContext());
    expect(buildPlaybackSong('song').moduleFormat).toBe('native');
  });

  it('engine adopts the song tag on load', () => {
    const { buildPlaybackSong } = useTrackerSongBuilder(makeContext('xm'));
    const engine = new PlaybackEngine();
    engine.loadSong(buildPlaybackSong('song'));
    expect(engine.getModuleFormat()).toBe('xm');
  });

  it('engine falls back to native for an untagged song', () => {
    const engine = new PlaybackEngine();
    engine.loadSong({
      title: 'T',
      author: 'A',
      bpm: 125,
      patterns: [{ id: 'p1', length: 4, tracks: [] }],
      sequence: ['p1'],
    });
    expect(engine.getModuleFormat()).toBe('native');
  });
});

/**
 * The join between the two halves above: a real import, through the store, out
 * as a playback `Song`. `tracker-store-module-format.test.ts` covers import ->
 * store and the tests above cover context -> Song, but the tag has to survive
 * the whole way for `TrackerSongBank.setModuleFormat` to be handed anything
 * useful -- and the bank's channel-replacement policy now depends on it (D60).
 */
describe('an imported module reaches playback tagged', () => {
  it('carries xm from the file all the way to the playback song', () => {
    setActivePinia(createPinia());
    const store = useTrackerStore();
    store.loadSongFile(
      importXmToTrackerSong(
        buildXm({
          numChannels: 1,
          instruments: [{ samples: [{ frames: [0, 1, 0, -1] }] }],
          patterns: [{ numRows: 4, cells: [[cell(49, { instrument: 1 })]] }],
        }).buffer as ArrayBuffer,
      ),
    );
    expect(store.moduleFormat).toBe('xm');

    const pattern = store.patterns[0]!;
    const { buildPlaybackSong } = useTrackerSongBuilder({
      currentSong: ref(store.currentSong),
      moduleFormat: ref(store.moduleFormat),
      patterns: ref(store.patterns),
      sequence: ref(store.sequence),
      currentPatternId: ref(pattern.id),
      currentPattern: ref(pattern),
      defaultPatternRows: ref(64),
      instrumentSlots: ref(store.instrumentSlots),
      songPatches: ref(store.songPatches),
      songBank: {} as TrackerSongBuilderContext['songBank'],
      normalizeInstrumentId: (id) => (id ? id : undefined),
      formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
    });

    // This is the value the playback store hands to songBank.setModuleFormat.
    expect(buildPlaybackSong('song').moduleFormat).toBe('xm');
  });
});

/**
 * A pattern that opens with a key-off, before that channel has played anything
 * in *this* pattern.
 *
 * `ctx.instrumentId` in the song builder only remembers what the current
 * pattern has played, so such a row resolved to no instrument and was dropped
 * outright -- the key-off never reached the engine, and whatever the previous
 * pattern left ringing carried straight on. elw-sick.xm is built this way:
 * patterns routinely open with `###` on several channels to clear the tail of
 * the one before.
 *
 * The engine keeps its own per-track instrument across patterns, so the step
 * only has to survive the builder for it to resolve.
 */
describe('a key-off opening a pattern survives the builder', () => {
  it('produces a note-off step even with no instrument on the row', () => {
    const pattern = {
      id: 'p1',
      name: 'Pattern 1',
      rows: 4,
      tracks: [
        {
          id: 't1',
          name: 'Track 1',
          entries: [{ row: 0, note: '###' }],
          interpolations: [],
        },
      ],
    };
    const { buildPlaybackSong } = useTrackerSongBuilder({
      currentSong: ref({ title: 'T', author: 'A', bpm: 125 }),
      moduleFormat: ref('xm' as ModuleFormat),
      patterns: ref([pattern]),
      sequence: ref(['p1']),
      currentPatternId: ref('p1'),
      currentPattern: ref(pattern),
      defaultPatternRows: ref(4),
      instrumentSlots: ref([]),
      songPatches: ref({}),
      songBank: {} as TrackerSongBuilderContext['songBank'],
      normalizeInstrumentId: (id) => (id ? id : undefined),
      formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
    });

    const step = buildPlaybackSong('song').patterns[0]!.tracks[0]!.steps.find(
      (s) => s.row === 0,
    );
    expect(step).toBeDefined();
    expect(step!.isNoteOff).toBe(true);
  });
});
