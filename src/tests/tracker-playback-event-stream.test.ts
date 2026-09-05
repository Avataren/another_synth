import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import {
  PlaybackEngine,
  buildPlaybackSong,
} from '@another-synth/tracker-playback';
import type {
  PlaybackClock,
  Song,
  ScheduledNoteEvent,
} from '@another-synth/tracker-playback';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { importS3mToTrackerSong } from 'src/audio/tracker/s3m-import';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { useTrackerStore } from 'src/stores/tracker-store';
import type AudioSystem from 'src/audio/AudioSystem';
import type { TrackerSongFile } from 'src/stores/tracker-store';

/**
 * Corpus event-stream harness -- the shared regression net for the
 * playback-library optimization branches (playbook §2 in
 * .ai/invest-playback-optimization.md).
 *
 * Every module in public/demos is loaded through the REAL load path -- the
 * importers, then the tracker store's loadSongFile normalization (the same
 * transformation useTrackerFileIO.applySongFile applies), a real
 * TrackerSongBank.setModuleFormat, and the playback-song builder reading the
 * store state exactly the way useTrackerSongBuilder.source() reads it -- and
 * then driven through a real PlaybackEngine with recording Scheduled*Handlers
 * that serialize (handler, instrumentId, trackIndex, voiceIndex, time, value,
 * ramp) tuples in dispatch order.
 *
 * The recorded streams are the committed goldens under
 * src/tests/golden/event-stream/, generated on a branch cut from unmodified
 * main, so they are the pre-optimization baseline. An optimization branch
 * must diff EMPTY against them before it may claim to be output-preserving.
 *
 * Hand-constructed song fixtures are a red flag here (see the jt_letgo
 * lesson: a test that builds the system by hand never exercises the real
 * load path and can certify the wrong thing). The one deliberate omission is
 * `syncSongBankFromSlots`: it builds audio-worklet instruments and runs
 * sample conditioning (the 4x oversample + mip stack) that no dispatch tuple
 * depends on -- the engine emits its events before any instrument consumes
 * them -- and doing it for 137 modules would put the suite far past its time
 * budget. The bank itself is real, and takes the store's format flags the
 * way applySongFile hands them over.
 *
 * Determinism:
 * - Fixed mock clock: the audio context's currentTime starts at 0 and moves
 *   only when the harness advances it; the engine's playback clock is a
 *   manual stub, so no wall-clock time (Date.now/setInterval) reaches the
 *   scheduling path. No Date.now() appears anywhere on that path.
 * - Bounded window: playback runs for the first 30 seconds of song time, or
 *   until the song ends (looping off), whichever comes first. At the time
 *   this was written the whole file stays under the ~2-3 min budget with
 *   room to spare.
 * - Known-nondeterministic or pathologically slow modules belong in SKIPSET
 *   below with a reason -- never silently skipped.
 */

/**
 * Modules excluded from the harness, with the reason. Empty today; add an
 * entry only with evidence (measured flakiness or >20 s per module), never
 * to make a failure go away.
 */
const SKIPSET: ReadonlyArray<{ path: string; reason: string }> = [];

const DEMOS = path.resolve(__dirname, '../../public/demos');
const GOLDEN_DIR = path.resolve(__dirname, './golden/event-stream');

/**
 * Song-time window recorded per module (seconds). The engine schedules ahead
 * in 0.1 s steps against a manual clock, so 30 s of song time is ~300 ticks
 * of scheduling work, not 30 s of wall time.
 */
const WINDOW_SECONDS = 30;
/** Manual clock step (seconds); smaller than the engine's 0.5 s lookahead. */
const CLOCK_STEP_SECONDS = 0.1;

const createMockAudioSystem = () => {
  const gainNode = { gain: { value: 1 }, connect: () => {}, numberOfOutputs: 1 };
  return {
    audioContext: {
      sampleRate: 48000,
      currentTime: 0,
      state: 'running' as const,
      createGain: () => ({ ...gainNode }),
      destination: gainNode,
      onstatechange: null as unknown,
    },
    destinationNode: { connect: () => {}, numberOfOutputs: 1 },
  };
};

function corpusFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(mod|xm|s3m)$/i.test(entry.name)) {
        out.push(path.relative(DEMOS, abs));
      }
    }
  };
  walk(DEMOS);
  return out.sort();
}

function importModule(relPath: string): TrackerSongFile {
  const buf = fs.readFileSync(path.join(DEMOS, relPath));
  const bytes = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
  if (/\.xm$/i.test(relPath)) return importXmToTrackerSong(bytes);
  if (/\.s3m$/i.test(relPath)) return importS3mToTrackerSong(bytes);
  return importModToTrackerSong(bytes);
}

/**
 * The real load path, minus audio-worklet instrument construction:
 * importer -> tracker store (loadSongFile, what applySongFile feeds) ->
 * real bank setModuleFormat with the store's resolved flags -> playback
 * song built from the store state the way useTrackerSongBuilder.source()
 * reads it.
 */
function loadSongFromModule(relPath: string) {
  const file = importModule(relPath);

  setActivePinia(createPinia());
  const store = useTrackerStore();
  store.loadSongFile(file);

  const bank = new TrackerSongBank(
    createMockAudioSystem() as unknown as AudioSystem,
  );
  bank.setModuleFormat(
    store.moduleFormat,
    store.linearFrequency,
    store.amigaLimits,
  );

  return {
    song: buildStoreSong(store),
  };
}

function buildStoreSong(store: ReturnType<typeof useTrackerStore>): Song {
  return buildPlaybackSong(
    {
      currentSong: { ...store.currentSong },
      moduleFormat: store.moduleFormat,
      initialSpeed: store.initialSpeed,
      linearFrequency: store.linearFrequency,
      amigaLimits: store.amigaLimits,
      initialGlobalVolume: store.initialGlobalVolume,
      vblankTiming: store.vblankTiming,
      patterns: store.patterns,
      sequence: store.sequence,
      currentPatternId: store.currentPatternId,
      currentPattern: store.currentPattern,
      defaultPatternRows: store.defaultPatternRows,
      normalizeInstrumentId: (id) => (id ? id : undefined),
    },
    'song',
  );
}

type EventTuple = (string | number)[];

/**
 * A playback clock the harness drives by hand: no interval timers, no
 * wall-clock reads. `advance` returns once the window is exhausted, the
 * engine stopped itself (song end), or both.
 */
class ManualClock implements PlaybackClock {
  now = 0;
  private tick: ((deltaMs: number) => void) | null = null;

  start(tick: (deltaMs: number) => void) {
    this.tick = tick;
  }

  stop() {
    this.tick = null;
  }

  setVisible() {
    /* the harness never hides the tab */
  }

  get running() {
    return this.tick !== null;
  }

  advance(seconds: number) {
    const end = this.now + seconds;
    while (this.tick !== null && this.now < end) {
      this.now += CLOCK_STEP_SECONDS;
      this.tick(CLOCK_STEP_SECONDS * 1000);
    }
  }
}

/**
 * Run the engine over the song for the bounded window, recording every
 * Scheduled*Handler dispatch in order.
 *
 * Tuple shape per handler (position fixed, undefined fields serialized as
 * their sentinel so the arrays stay regular):
 *   note    [0, type, instrumentId, trackIndex, time, midi, velocity,
 *            frequency, pan, sampleOffsetFrames, tickSeconds]
 *   pitch   [1, instrumentId, voiceIndex, trackIndex, time, frequency, ramp]
 *   volume  [2, instrumentId, voiceIndex, trackIndex, time, volume, ramp]
 *   pan     [3, instrumentId, voiceIndex, trackIndex, time, pan]
 *   macro   [4, instrumentId, trackIndex, time, macroIndex, macroValue, ramp*]
 *   envPos  [5, instrumentId, voiceIndex, trackIndex, time, tick]
 *   offset  [6, instrumentId, voiceIndex, trackIndex, time, offset]
 *   retrig  [7, instrumentId, trackIndex, time, midi, velocity, frequency]
 *   global  [8, time, gain]
 *   filter  [9, time, active]
 *   allOff  [10, time]
 */
function playAndRecord(song: Song) {
  const clock = new ManualClock();
  const audioContext = {
    get currentTime() {
      return clock.now;
    },
  };
  const events: EventTuple[] = [];
  let ended = false;

  const engine = new PlaybackEngine({
    audioContext: audioContext as unknown as AudioContext,
    playbackClock: clock,
    scheduledNoteHandler: (e: ScheduledNoteEvent) => {
      events.push([
        0,
        e.type === 'noteOn' ? 0 : 1,
        e.instrumentId ?? '',
        e.trackIndex,
        e.time,
        e.midi ?? -1,
        e.velocity ?? -1,
        e.frequency ?? -1,
        e.pan ?? -1,
        e.sampleOffsetFrames ?? -1,
        e.tickSeconds ?? -1,
      ]);
    },
    scheduledPitchHandler: (
      instrumentId,
      voiceIndex,
      frequency,
      time,
      trackIndex,
      rampMode,
    ) => {
      events.push([
        1, instrumentId, voiceIndex, trackIndex, time, frequency,
        rampMode === 'linear' ? 1 : rampMode === 'exponential' ? 2 : 0,
      ]);
    },
    scheduledVolumeHandler: (
      instrumentId,
      voiceIndex,
      volume,
      time,
      trackIndex,
      rampMode,
    ) => {
      events.push([
        2, instrumentId, voiceIndex, trackIndex, time, volume,
        rampMode === 'linear' ? 1 : rampMode === 'exponential' ? 2 : rampMode === 'step' ? 3 : 0,
      ]);
    },
    scheduledPanHandler: (instrumentId, voiceIndex, pan, time, trackIndex) => {
      events.push([3, instrumentId, voiceIndex, trackIndex, time, pan]);
    },
    scheduledMacroHandler: (
      instrumentId,
      macroIndex,
      macroValue,
      time,
      ramp,
    ) => {
      events.push([
        4,
        instrumentId,
        time,
        macroIndex,
        macroValue,
        ramp ? ramp.targetValue : -1,
        ramp ? ramp.targetTime : -1,
        ramp?.interpolation === 'linear'
          ? 1
          : ramp?.interpolation === 'exponential'
            ? 2
            : 0,
      ]);
    },
    scheduledEnvelopePositionHandler: (
      instrumentId,
      voiceIndex,
      tick,
      time,
      trackIndex,
    ) => {
      events.push([5, instrumentId, voiceIndex, trackIndex, time, tick]);
    },
    scheduledSampleOffsetHandler: (
      instrumentId,
      voiceIndex,
      offset,
      time,
      trackIndex,
    ) => {
      events.push([6, instrumentId, voiceIndex, trackIndex, time, offset]);
    },
    scheduledRetriggerHandler: (
      instrumentId,
      midi,
      velocity,
      time,
      trackIndex,
      frequency,
    ) => {
      events.push([
        7, instrumentId, trackIndex, time, midi, velocity, frequency ?? -1,
      ]);
    },
    scheduledGlobalVolumeHandler: (gain, time) => {
      events.push([8, time, gain]);
    },
    scheduledFilterHandler: (active, time) => {
      events.push([9, time, active ? 1 : 0]);
    },
    scheduledAllNotesOffHandler: (time) => {
      events.push([10, time]);
    },
  });
  engine.on('songEnd', () => {
    ended = true;
  });

  engine.loadSong(song);
  engine.setLoopSong(false);
  return engine.play().then(() => {
    // The engine has scheduled its first lookahead batch and asked the clock
    // to drive it; advance the manual clock until the window or the song ends.
    clock.advance(WINDOW_SECONDS);
    // If the song is still "playing" at the window edge, stop it explicitly
    // so no state leaks; events were already recorded deterministically.
    engine.stop();
    return { events, ended };
  });
}

const files = corpusFiles().filter(
  (relPath) => !SKIPSET.some((s) => s.path === relPath),
);

describe('corpus event stream (playback optimization regression net)', () => {
  for (const relPath of files) {
    it(
      `event stream matches the pre-optimization golden: ${relPath}`,
      async () => {
        const { song } = loadSongFromModule(relPath);
        const { events, ended } = await playAndRecord(song);

        const goldenPath = path.join(
          GOLDEN_DIR,
          `${relPath}.json`,
        );

        if (process.env.EVENT_STREAM_UPDATE_GOLDENS === '1') {
          fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
          fs.writeFileSync(goldenPath, `${JSON.stringify({ module: relPath, songEnd: ended, events })}\n`);
          return;
        }

        if (!fs.existsSync(goldenPath)) {
          throw new Error(
            'No golden for ' + relPath +
              '. Committed goldens are the pre-optimization baseline and ' +
              'are never generated on an optimization branch. Check out ' +
              'agent/playback-opt-harness (or main) and run ' +
              "'EVENT_STREAM_UPDATE_GOLDENS=1 npx vitest run " +
              "src/tests/tracker-playback-event-stream.test.ts' there, " +
              'then commit src/tests/golden/event-stream/ before rebasing ' +
              'this branch onto it.',
          );
        }

        const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as {
          module: string;
          songEnd: boolean;
          events: EventTuple[];
        };
        expect(golden.module).toBe(relPath);
        // The recorded stream must be byte-identical: same handlers, same
        // order, same values. Compare serialized forms so a failure diff
        // points at the first divergent event.
        expect(JSON.stringify(events)).toBe(JSON.stringify(golden.events));
        // And the macro shape must agree too: a branch that ends the song
        // earlier/later than baseline has changed scheduling even if every
        // surviving event matched.
        expect(ended).toBe(golden.songEnd);
      },
      120_000,
    );
  }
});

it('documents any skips', () => {
  for (const skip of SKIPSET) {
    expect(
      corpusFiles().includes(skip.path),
      `SKIPSET entry ${skip.path} is not in the corpus anymore; remove it`,
    ).toBe(true);
  }
});
