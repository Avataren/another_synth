import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

/**
 * A MOD or XM channel has one voice, so a new note leaves nothing of the
 * previous one. A song authored in this tracker has no such limit: overlapping
 * notes on one track are allowed, and a new note releases the previous one.
 *
 * The gap this pins was a key-off followed by a note on a *different*
 * instrument. `dispatchNoteOffAtTime` released the voice and then cleared the
 * track's voice tracking -- correct in that the voice is no longer what the
 * track plays, but it left the voice untracked and therefore unkillable, so it
 * went on sounding under the new note for its whole fadeout (seconds, on XM).
 * `ModInstrument` cuts a releasing voice occupying the slot it is about to
 * reuse, which is why this only bit when the channel changed instrument.
 */

const createMockAudioSystem = () => {
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
    numberOfOutputs: 1,
  };
  return {
    audioContext: {
      sampleRate: 48000,
      currentTime: 0,
      state: 'running' as const,
      createGain: () => ({ ...gainNode }),
      destination: gainNode,
      onstatechange: null as unknown,
    },
    destinationNode: { connect: vi.fn(), numberOfOutputs: 1 },
  };
};

function makeInstrument(voiceIndex: number) {
  return {
    getVoiceLimit: () => 4,
    getQuantumDurationSeconds: () => 128 / 48000,
    noteOnAtTime: vi.fn(
      (
        _midi: number,
        _velocity: number,
        _time: number,
        _options?: { trackIndex?: number },
      ) => voiceIndex,
    ),
    gateOffVoiceAtTime: vi.fn(),
    cutVoiceAtTime: vi.fn(),
    cancelAndSilenceVoice: vi.fn(),
    cancelScheduledNotes: vi.fn(),
    noteOffAtTime: vi.fn(),
    get isReady() {
      return true;
    },
    workletNode: null,
  };
}

/** A bank with two instruments, '01' and '02', both ready. */
function makeBank(format: 'protracker' | 'xm' | 'native' | undefined) {
  const bank = new TrackerSongBank(
    createMockAudioSystem() as unknown as AudioSystem,
  );
  if (format !== undefined) bank.setModuleFormat(format);

  const one = makeInstrument(0);
  const two = makeInstrument(1);
  const instruments = Reflect.get(bank as object, 'instruments') as Map<
    string,
    unknown
  >;
  for (const [id, instrument] of [
    ['01', one],
    ['02', two],
  ] as const) {
    instruments.set(id, {
      instrument,
      patchId: 'p',
      patchReuseKey: null,
      hasPortamento: false,
    });
  }
  return { bank, one, two };
}

const TRACK = 0;

describe('a module channel leaves nothing of the previous note', () => {
  it('cuts a voice still releasing from an earlier key-off, even on another instrument', () => {
    const { bank, one, two } = makeBank('xm');

    // Track 0 plays instrument 01, then is keyed off: 01's voice is releasing.
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOffAtTime('01', undefined, 2, TRACK);
    expect(one.gateOffVoiceAtTime).toHaveBeenCalled();
    expect(one.cutVoiceAtTime).not.toHaveBeenCalled();

    // A new note on the same track, different instrument, must kill it.
    bank.noteOnAtTime('02', 62, 100, 3, TRACK);

    expect(one.cutVoiceAtTime).toHaveBeenCalled();
    const [cutVoice, cutTime] = one.cutVoiceAtTime.mock.calls[0]!;
    expect(cutVoice).toBe(0);
    // Before the new note, so nothing of it is heard underneath.
    expect(cutTime as number).toBeLessThan(3);
    expect(two.noteOnAtTime).toHaveBeenCalled();
  });

  it('does not cut it twice on a second note', () => {
    const { bank, one } = makeBank('xm');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOffAtTime('01', undefined, 2, TRACK);
    bank.noteOnAtTime('02', 62, 100, 3, TRACK);
    bank.noteOnAtTime('02', 64, 100, 4, TRACK);

    expect(one.cutVoiceAtTime).toHaveBeenCalledTimes(1);
  });

  it('leaves another track alone', () => {
    const { bank, one, two } = makeBank('protracker');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOffAtTime('01', undefined, 2, TRACK);

    // A note on a *different* track must not disturb track 0's release.
    bank.noteOnAtTime('02', 62, 100, 3, TRACK + 1);

    expect(one.cutVoiceAtTime).not.toHaveBeenCalled();
    expect(two.noteOnAtTime).toHaveBeenCalled();
  });

  it('cuts rather than releases when a new note replaces a sounding one', () => {
    const { bank, one, two } = makeBank('xm');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOnAtTime('02', 62, 100, 2, TRACK);

    expect(one.cutVoiceAtTime).toHaveBeenCalled();
    expect(one.gateOffVoiceAtTime).not.toHaveBeenCalled();
    void two;
  });
});

describe('a native song lets a replaced note ring out', () => {
  it('releases rather than cutting when a new note replaces a sounding one', () => {
    const { bank, one } = makeBank('native');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOnAtTime('02', 62, 100, 2, TRACK);

    expect(one.gateOffVoiceAtTime).toHaveBeenCalled();
    expect(one.cutVoiceAtTime).not.toHaveBeenCalled();
  });

  it('leaves an earlier key-off to finish its release', () => {
    const { bank, one } = makeBank('native');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOffAtTime('01', undefined, 2, TRACK);
    bank.noteOnAtTime('02', 62, 100, 3, TRACK);

    expect(one.cutVoiceAtTime).not.toHaveBeenCalled();
  });
});

describe('a bank with no song loaded is native', () => {
  it('matches DEFAULT_MODULE_FORMAT and the engine default', () => {
    // A song carrying no format tag is a native song, and every real module
    // sets the format from loadSong before a note is scheduled.
    const { bank, one } = makeBank(undefined);
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOffAtTime('01', undefined, 2, TRACK);
    bank.noteOnAtTime('02', 62, 100, 3, TRACK);

    expect(one.cutVoiceAtTime).not.toHaveBeenCalled();
  });
});

/**
 * A retrigger is a note-on on the same channel.
 *
 * E9x and Rxy restart the sample from the beginning, so a retrigger has to
 * take the channel over exactly as a new note does. `retriggerNoteAtTime` used
 * to call the instrument directly with `allowDuplicate` and *no track index*,
 * which skipped all of it: with no track the instrument allocates from its
 * round-robin pool rather than the channel's own voice, so every repeat stacked
 * another voice and none was ever cut -- nor could be, since nothing that cuts
 * a channel could see them.
 *
 * peacedroid.mod patterns 16 and 17 end their track-1 phrase on `E93 E92 E91`,
 * which at speed 6 is eight repeats across three rows. They piled up and went
 * on sounding into the next pattern, through the notes that followed.
 */
describe('a retrigger takes the channel like any other note', () => {
  it('uses the channel voice rather than allocating a fresh one', () => {
    const { bank, one } = makeBank('protracker');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    one.noteOnAtTime.mockClear();

    bank.retriggerNoteAtTime('01', 60, 100, 2, TRACK);

    expect(one.noteOnAtTime).toHaveBeenCalledTimes(1);
    expect(one.noteOnAtTime.mock.calls[0]![3]?.trackIndex).toBe(TRACK);
  });

  it('cuts what the channel was playing', () => {
    const { bank, one } = makeBank('protracker');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);

    bank.retriggerNoteAtTime('01', 60, 100, 2, TRACK);

    expect(one.cutVoiceAtTime).toHaveBeenCalled();
  });

  it('cuts a voice left ringing by an earlier key-off', () => {
    const { bank, one } = makeBank('xm');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOffAtTime('01', undefined, 2, TRACK);

    bank.retriggerNoteAtTime('01', 60, 100, 3, TRACK);

    expect(one.cutVoiceAtTime).toHaveBeenCalled();
  });

  it('carries the retrigger level through', () => {
    const { bank, one } = makeBank('protracker');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    one.noteOnAtTime.mockClear();

    bank.retriggerNoteAtTime('01', 60, 69, 2, TRACK);

    // E9x leaves the channel volume alone, so the retrigger sounds at whatever
    // the slides have left it at rather than resetting.
    expect(one.noteOnAtTime.mock.calls[0]![1]).toBe(69);
  });
});

/**
 * Looping the song is a restart, and a restart begins from silence.
 *
 * A song that ends on a fade leaves notes running: the fade is usually a
 * global-volume ramp, which turns the mix down without stopping anything. Wrap
 * back to the start, restore the volume, and whatever was still sounding comes
 * back with it. xyce-dans_la_rue.xm ends that way and opens with `G80`.
 */
describe('cutAllVoicesAtTime', () => {
  it('silences voices the track maps have lost sight of', () => {
    // The point of sweeping voice indices rather than the tracking maps: a
    // voice nothing is tracking is exactly the kind this has to catch.
    const { bank, one } = makeBank('xm');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOffAtTime('01', undefined, 2, TRACK);
    one.cutVoiceAtTime.mockClear();

    bank.cutAllVoicesAtTime(5);

    expect(one.cutVoiceAtTime).toHaveBeenCalled();
  });

  it('cuts across every instrument, not just the one last played', () => {
    const { bank, one, two } = makeBank('xm');
    bank.noteOnAtTime('01', 60, 100, 1, 0);
    bank.noteOnAtTime('02', 62, 100, 1, 1);
    one.cutVoiceAtTime.mockClear();
    two.cutVoiceAtTime.mockClear();

    bank.cutAllVoicesAtTime(5);

    expect(one.cutVoiceAtTime).toHaveBeenCalled();
    expect(two.cutVoiceAtTime).toHaveBeenCalled();
  });

  it('releases rather than cutting for a native song', () => {
    const { bank, one } = makeBank('native');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    one.gateOffVoiceAtTime.mockClear();

    bank.cutAllVoicesAtTime(5);

    expect(one.cutVoiceAtTime).not.toHaveBeenCalled();
    expect(one.gateOffVoiceAtTime).toHaveBeenCalled();
  });

  it('schedules the cut rather than doing it now', () => {
    // The engine decides this while scheduling ahead, so "now" is still part
    // of the previous pass through the song.
    const { bank, one } = makeBank('xm');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    one.cutVoiceAtTime.mockClear();

    bank.cutAllVoicesAtTime(5);

    expect(one.cutVoiceAtTime.mock.calls[0]![1]).toBe(5);
  });
});
