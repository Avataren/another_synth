/**
 * .ai/plan-opl.md O5: the song bank sends every event for an S3M AdLib
 * instrument to its OPL output (the chip), and nothing else there. The
 * wiring mirrors `playThroughDriver` in s3m-adlib-st3-trace.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OplInstrumentData } from '@another-synth/tracker-playback';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { OplOutput } from 'src/audio/tracker/opl-output';
import type AudioSystem from 'src/audio/AudioSystem';

const TIMBRE: OplInstrumentData = { kind: 'melody', registers: [1, 1, 16, 0, 240, 240, 119, 119, 0, 0, 0], volume: 63, c2spd: 8363 };

function makeBank() {
  const gain = () => ({
    gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
    numberOfOutputs: 1,
  });
  const audioContext = { sampleRate: 48000, currentTime: 5, state: 'running', createGain: gain, onstatechange: null };
  const bank = new TrackerSongBank({ audioContext, destinationNode: gain() } as unknown as AudioSystem);
  // The node factory would need a real AudioWorklet; the routing does not.
  vi.spyOn(OplOutput.prototype, 'ready').mockResolvedValue();
  bank.setOplSong({ instruments: new Map([['02', TIMBRE]]), channels: [null, 0], amigaLimits: false });
  return bank;
}

afterEach(() => vi.restoreAllMocks());

describe('TrackerSongBank OPL routing', () => {
  it('routes an AdLib instrument’s notes, pitch, volume and retrigger to the chip', () => {
    const noteOn = vi.spyOn(OplOutput.prototype, 'noteOn');
    const noteOff = vi.spyOn(OplOutput.prototype, 'noteOff');
    const setPitch = vi.spyOn(OplOutput.prototype, 'setPitch');
    const setVolume = vi.spyOn(OplOutput.prototype, 'setVolume');
    const bank = makeBank();

    expect(bank.isOplInstrument('02')).toBe(true);
    expect(bank.isOplInstrument('01')).toBe(false);

    bank.noteOnAtTime('02', 60, 127, 6, 1, 261.63);
    bank.setVoicePitchAtTime('02', 0, 262, 6.02, 1, undefined, 'table');
    bank.setVoiceVolumeAtTime('02', 0, 0.5, 6.04, 1);
    bank.retriggerNoteAtTime('02', 60, 100, 6.06, 1);
    bank.noteOffAtTime('02', 60, 6.1, 1);

    expect(noteOn).toHaveBeenNthCalledWith(1, '02', 127, 6, 1, 261.63);
    expect(setPitch).toHaveBeenCalledWith(6.02, 1, 262, 'table');
    expect(setVolume).toHaveBeenCalledWith(6.04, 1, 0.5);
    expect(noteOn).toHaveBeenCalledTimes(2);
    expect(noteOff).toHaveBeenCalledWith(6.1, 1);
  });

  it('leaves a sampler instrument’s events alone', () => {
    const noteOn = vi.spyOn(OplOutput.prototype, 'noteOn');
    const bank = makeBank();
    bank.noteOnAtTime('01', 60, 127, 6, 0);
    expect(noteOn).not.toHaveBeenCalled();
  });

  it('restarts the chip on stop, and keys it off on a song-loop cut', () => {
    const restart = vi.spyOn(OplOutput.prototype, 'restart');
    const allOff = vi.spyOn(OplOutput.prototype, 'allNotesOffAt');
    const bank = makeBank();
    restart.mockClear();
    bank.cancelAllScheduled();
    bank.allNotesOff();
    expect(restart).toHaveBeenCalledTimes(2);
    bank.cutAllVoicesAtTime(9);
    expect(allOff).toHaveBeenCalledWith(9);
  });
});
