import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { useTrackerSongBuilder, type TrackerSongBuilderContext } from 'src/composables/useTrackerSongBuilder';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * Regression coverage for "one pattern mutes the next, but the next
 * pattern plays fine on its own" (see effect-processor.spec.ts for the
 * matching engine-level test).
 *
 * Root cause: a track's runtime volume can decay via a volume-slide
 * effect (Axy), and the audio engine only ever resets that decayed
 * volume when the tracker step carries an explicit velocity (i.e. the
 * row's volume column has a value). A genuine new note+instrument
 * trigger with a *blank* volume column used to leave step.velocity
 * undefined, silently inheriting whatever the channel had decayed to --
 * possibly from the end of the *previous* pattern. Playing the next
 * pattern in isolation started from a clean engine state, which is why
 * the bug only showed up during continuous playback across patterns.
 *
 * Fix: buildPlaybackStepsForTrack defaults step.velocity to 255 (full)
 * whenever a row has both a note and an explicit instrument number but
 * no explicit volume column value. A row with a note but NO instrument
 * number (the deliberate "sample 0" tracker convention for continuing
 * the previous instrument without resetting volume) must NOT get this
 * default -- that's the whole point of the convention.
 */
function makeContext(): TrackerSongBuilderContext {
  return {
    currentSong: ref({ title: '', author: '', bpm: 125 }),
    patterns: ref([]),
    sequence: ref([]),
    currentPatternId: ref(null),
    currentPattern: ref(undefined),
    patternRows: ref(4),
    instrumentSlots: ref([]),
    songPatches: ref({}),
    songBank: {} as TrackerSongBuilderContext['songBank'],
    normalizeInstrumentId: (id) => (id ? id : undefined),
    formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
  };
}

describe('buildPlaybackStepsForTrack volume reset on new instrument trigger', () => {
  it('defaults velocity to full when a note has an explicit instrument but no volume column value', () => {
    const { buildPlaybackStepsForTrack } = useTrackerSongBuilder(makeContext());
    const track: TrackerTrackData = {
      id: 't1',
      name: 'Track 1',
      entries: [{ row: 0, note: 'C-4', instrument: '01' }],
    };

    const steps = buildPlaybackStepsForTrack(track);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.velocity).toBe(255);
  });

  it('does not override an explicit volume column value', () => {
    const { buildPlaybackStepsForTrack } = useTrackerSongBuilder(makeContext());
    const track: TrackerTrackData = {
      id: 't1',
      name: 'Track 1',
      entries: [{ row: 0, note: 'C-4', instrument: '01', volume: '40' }],
    };

    const steps = buildPlaybackStepsForTrack(track);
    expect(steps[0]!.velocity).toBe(0x40);
  });

  it('leaves velocity unset for a note continuing a previously-established instrument (no instrument number this row)', () => {
    const { buildPlaybackStepsForTrack } = useTrackerSongBuilder(makeContext());
    const track: TrackerTrackData = {
      id: 't1',
      name: 'Track 1',
      entries: [
        { row: 0, note: 'C-4', instrument: '01' },
        // Second note on the same track, same instrument, deliberately
        // omitting the instrument number -- the "sample 0" convention for
        // continuing without resetting volume.
        { row: 1, note: 'D-4' },
      ],
    };

    const steps = buildPlaybackStepsForTrack(track);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.velocity).toBe(255); // first note: explicit instrument, no volume column -> default
    expect(steps[1]!.velocity).toBeUndefined(); // second note: no instrument number -> untouched
  });

  it('does not touch velocity for a row with an instrument but no note at all', () => {
    // A bare instrument-number-only row (no note, no volume/macro/effect)
    // doesn't produce a playback step in this builder at all -- confirms
    // the new default is scoped to genuine note triggers (midi !==
    // undefined), not just "instrument present on this row".
    const { buildPlaybackStepsForTrack } = useTrackerSongBuilder(makeContext());
    const track: TrackerTrackData = {
      id: 't1',
      name: 'Track 1',
      entries: [{ row: 0, instrument: '01' }],
    };

    const steps = buildPlaybackStepsForTrack(track);
    expect(steps).toHaveLength(0);
  });
});
