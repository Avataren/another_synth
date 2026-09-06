import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import {
  PlaybackEngine,
  buildPlaybackSong,
} from '@another-synth/tracker-playback';
import {
  AMIGA_CLOCK,
  PAULA_TO_SYNTH_SCALE,
} from '@another-synth/tracker-playback';
import type {
  PlaybackClock,
  Song,
  ScheduledNoteEvent,
} from '@another-synth/tracker-playback';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { useTrackerStore } from 'src/stores/tracker-store';

/**
 * End-to-end tuning check for a MOD that leaves ProTracker's three octaves.
 *
 * The importer always wrote each note's literal Amiga-period frequency and a
 * MIDI number derived from the same period, so the two agree by construction.
 * The engine then re-derived the played frequency through the pitch model's
 * clamp -- and for DOPE.MOD that pinned 3137 of 6589 notes to period 113 and
 * 29 to period 856, up to two octaves from what the MIDI number said. So
 * "does the frequency the engine schedules still name the note the row
 * wrote?" is the whole bug, stated without a period table.
 *
 * The window starts at order 15, the first pattern in the song with a
 * substantial number of notes above B-3 (40 of its 88).
 */

const DEMOS = path.resolve(__dirname, '../../public/demos');
const START_ORDER = 15;
const WINDOW_SECONDS = 20;
const CLOCK_STEP_SECONDS = 0.1;

class ManualClock implements PlaybackClock {
  now = 0;
  private tick: ((deltaMs: number) => void) | null = null;
  start(tick: (deltaMs: number) => void) {
    this.tick = tick;
  }
  stop() {
    this.tick = null;
  }
  setVisible() {}
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

function loadDope(): Song {
  const buf = fs.readFileSync(path.join(DEMOS, 'amiga/DOPE.MOD'));
  const file = importModToTrackerSong(
    buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer,
  );

  setActivePinia(createPinia());
  const store = useTrackerStore();
  store.loadSongFile(file);

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

async function recordNotes(song: Song): Promise<ScheduledNoteEvent[]> {
  const clock = new ManualClock();
  const notes: ScheduledNoteEvent[] = [];
  const engine = new PlaybackEngine({
    audioContext: {
      get currentTime() {
        return clock.now;
      },
    } as unknown as AudioContext,
    playbackClock: clock,
    scheduledNoteHandler: (event) => {
      if (event.type === 'noteOn') notes.push(event);
    },
  });
  engine.loadSong(song, START_ORDER);
  engine.setLoopSong(false);
  await engine.play();
  clock.advance(WINDOW_SECONDS);
  engine.stop();
  return notes;
}

const midiToFrequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

describe('DOPE.MOD tuning', () => {
  it('plays every note at the pitch its row names', async () => {
    const notes = await recordNotes(loadDope());
    // A pattern this dense has to produce notes, or the assertion below is
    // vacuously true.
    expect(notes.length).toBeGreaterThan(50);

    const detuned = notes
      .filter((note) => note.frequency !== undefined)
      .map((note) => ({
        midi: note.midi,
        frequency: note.frequency as number,
        cents:
          1200 *
          Math.log2(
            (note.frequency as number) /
              midiToFrequency(note.midi as number),
          ),
      }))
      // The importer rounds the period-derived MIDI number, so a note can sit
      // up to half a semitone from equal temperament and still be right.
      .filter((note) => Math.abs(note.cents) > 50);

    expect(detuned).toEqual([]);
  });

  it("reaches well above the note ProTracker's clamp allowed", async () => {
    const notes = await recordNotes(loadDope());
    // Period 113 (B-3) is ~247.7 Hz in the synth's domain; the clamp made it
    // the ceiling for the whole module.
    const ceiling = AMIGA_CLOCK / (2 * 113 * PAULA_TO_SYNTH_SCALE);
    const above = notes.filter((note) => (note.frequency ?? 0) > ceiling + 1);
    expect(above.length).toBeGreaterThan(20);
  });
});
