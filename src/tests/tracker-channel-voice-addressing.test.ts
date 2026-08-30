import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

/**
 * Per-voice commands address the *channel's* voice, not the instrument on the
 * row.
 *
 * The instrument number written on a pattern row says what a new note should
 * use. It is not a name for what the channel is currently sounding, and on a
 * module the two routinely disagree: a tone-portamento row, a MOD sample
 * latch, a key-off carrying the next note's instrument. Resolving a per-voice
 * command instrument-first then finds no voice on that channel and drops the
 * command silently -- computed perfectly, delivered nowhere. That is the shape
 * of D29, D55, D65, D68 and D77 in PLAN-module-format-support.md.
 *
 * The rule these tests pin: *only a row that starts a note changes what a
 * channel is playing, and every per-voice command must address the voice that
 * is sounding.*
 *
 * Native songs are the exception, and get their own section below: a native
 * track is polyphonic, so "the track's voice" is not unique there and the
 * instrument-keyed lookup is the only one that can answer.
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

/**
 * An instrument that hands out a fresh voice per note, so a test can tell
 * which voice a command actually landed on.
 */
function makeInstrument(firstVoice: number) {
  let next = firstVoice;
  return {
    getVoiceLimit: () => 4,
    getQuantumDurationSeconds: () => 128 / 48000,
    noteOnAtTime: vi.fn(() => next++),
    gateOffVoiceAtTime: vi.fn(),
    cutVoiceAtTime: vi.fn(),
    cancelAndSilenceVoice: vi.fn(),
    cancelScheduledNotes: vi.fn(),
    noteOffAtTime: vi.fn(),
    setVoiceFrequencyAtTime: vi.fn(),
    setVoiceGainAtTime: vi.fn(),
    setVoiceMacroAtTime: vi.fn(),
    setEnvelopePositionAtTime: vi.fn(),
    get isReady() {
      return true;
    },
    workletNode: null,
  };
}

function makeBank(format: 'protracker' | 'xm' | 'native') {
  const bank = new TrackerSongBank(
    createMockAudioSystem() as unknown as AudioSystem,
  );
  bank.setModuleFormat(format);

  const one = makeInstrument(0);
  const two = makeInstrument(0);
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

const TRACK = 3;

describe('module channels: a command carrying the wrong instrument still lands', () => {
  /**
   * Channel 3 is sounding instrument 01. Every command below is addressed to
   * instrument 02 -- which has no voice on this channel at all -- exactly as a
   * row that names the next note's instrument would address it.
   */
  const soundingOn01 = (format: 'protracker' | 'xm') => {
    const rig = makeBank(format);
    rig.bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    expect(rig.one.noteOnAtTime).toHaveBeenCalledTimes(1);
    return rig;
  };

  it('routes a pitch slide to the channel’s voice (D77)', () => {
    const { one, two, bank } = soundingOn01('xm');

    bank.setVoicePitchAtTime('02', -1, 440, 2, TRACK, 'exponential');

    expect(one.setVoiceFrequencyAtTime).toHaveBeenCalledWith(
      0,
      440,
      2,
      'exponential',
    );
    expect(two.setVoiceFrequencyAtTime).not.toHaveBeenCalled();
  });

  it('routes a volume slide to the channel’s voice', () => {
    const { one, two, bank } = soundingOn01('protracker');

    bank.setVoiceVolumeAtTime('02', -1, 0.25, 2, TRACK);

    expect(one.setVoiceGainAtTime).toHaveBeenCalledWith(0, 0.25, 2, 'linear');
    expect(two.setVoiceGainAtTime).not.toHaveBeenCalled();
  });

  it('routes a pan command to the channel’s voice', () => {
    const { one, two, bank } = soundingOn01('protracker');

    bank.setVoicePanAtTime('02', -1, 0.75, 2, TRACK);

    expect(one.setVoiceMacroAtTime).toHaveBeenCalledWith(0, 0, 0.75, 2);
    expect(two.setVoiceMacroAtTime).not.toHaveBeenCalled();
  });

  it('routes an envelope position (Lxx) to the channel’s voice', () => {
    const { one, two, bank } = soundingOn01('xm');

    bank.setVoiceEnvelopePositionAtTime('02', -1, 12, 2, TRACK);

    expect(one.setEnvelopePositionAtTime).toHaveBeenCalledWith(0, 12, 2);
    expect(two.setEnvelopePositionAtTime).not.toHaveBeenCalled();
  });

  it('routes a sample offset to the channel’s voice', () => {
    const { one, two, bank } = soundingOn01('protracker');

    bank.setVoiceSampleOffsetAtTime('02', -1, 0.5, 2, TRACK);

    expect(one.setVoiceMacroAtTime).toHaveBeenCalledWith(0, 1, 0.5, 2);
    expect(two.setVoiceMacroAtTime).not.toHaveBeenCalled();
  });

  it('retriggers the sample the channel is sounding, not the row’s (D65)', () => {
    const { one, two, bank } = soundingOn01('protracker');

    bank.retriggerNoteAtTime('02', 60, 100, 2, TRACK);

    // The retrigger restarted 01 -- the sample actually playing -- and took
    // the channel over rather than stacking a second voice.
    expect(one.noteOnAtTime).toHaveBeenCalledTimes(2);
    expect(two.noteOnAtTime).not.toHaveBeenCalled();
    expect(one.cutVoiceAtTime).toHaveBeenCalled();
  });

  it('honours an explicit voice index from the effect processor', () => {
    const { two, bank } = soundingOn01('xm');

    bank.setVoiceVolumeAtTime('02', 2, 0.5, 2, TRACK, 'step');

    expect(two.setVoiceGainAtTime).toHaveBeenCalledWith(2, 0.5, 2, 'step');
  });
});

describe('module channels: a command with nothing sounding is dropped', () => {
  it('does not fall back to the instrument’s voice on another channel', () => {
    const { one, bank } = makeBank('protracker');

    // Instrument 01 is sounding on channel 3 only.
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    one.setVoiceGainAtTime.mockClear();

    // A volume command on the silent channel 0, naming the same instrument.
    // The old `-1` global-last-voice key made this land on channel 3's note.
    bank.setVoiceVolumeAtTime('01', -1, 0, 2, 0);

    expect(one.setVoiceGainAtTime).not.toHaveBeenCalled();
  });

  it('drops a command with no track index rather than guessing a channel', () => {
    const { one, bank } = makeBank('xm');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    one.setVoiceFrequencyAtTime.mockClear();

    bank.setVoicePitchAtTime('01', -1, 440, 2, NaN);

    expect(one.setVoiceFrequencyAtTime).not.toHaveBeenCalled();
  });

  it('drops a command after a key-off has released the channel', () => {
    const { one, bank } = makeBank('xm');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOffAtTime('01', undefined, 2, TRACK);

    bank.setVoicePitchAtTime('01', -1, 440, 3, TRACK);

    expect(one.setVoiceFrequencyAtTime).not.toHaveBeenCalled();
  });
});

describe('native songs keep polyphonic per-track behaviour', () => {
  /**
   * The reason this refactor is not a blanket change. A native track may hold
   * several overlapping notes on different instruments at once, so the
   * channel does not own a single voice and `trackVoiceOwner` cannot answer
   * for it -- the instrument-keyed lookup has to stay.
   */
  it('addresses each instrument’s own voice on a shared track', () => {
    const { one, two, bank } = makeBank('native');

    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOnAtTime('02', 64, 100, 1, TRACK);

    bank.setVoicePitchAtTime('01', -1, 440, 2, TRACK);
    bank.setVoicePitchAtTime('02', -1, 550, 2, TRACK);

    expect(one.setVoiceFrequencyAtTime).toHaveBeenCalledWith(
      0,
      440,
      2,
      undefined,
    );
    expect(two.setVoiceFrequencyAtTime).toHaveBeenCalledWith(
      0,
      550,
      2,
      undefined,
    );
  });

  it('lets an earlier note keep sounding under a later one on the same track', () => {
    const { one, bank } = makeBank('native');

    // Two notes on one instrument and one track: a native track is polyphonic,
    // so the second does not cut the first.
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);
    bank.noteOnAtTime('01', 64, 100, 2, TRACK);

    expect(one.cutVoiceAtTime).not.toHaveBeenCalled();
    expect(one.noteOnAtTime).toHaveBeenCalledTimes(2);
  });

  it('still resolves a command with no track index via the last voice used', () => {
    const { one, bank } = makeBank('native');
    bank.noteOnAtTime('01', 60, 100, 1, TRACK);

    bank.setVoicePitchAtTime('01', -1, 440, 2, NaN);

    expect(one.setVoiceFrequencyAtTime).toHaveBeenCalledWith(
      0,
      440,
      2,
      undefined,
    );
  });
});
