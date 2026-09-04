import { describe, it, expect, vi } from 'vitest';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';
import ModInstrument from 'src/audio/mod-instrument';
import { parseXm } from '@another-synth/tracker-playback';
import { buildXm, cell } from './helpers/xm-builder';

/**
 * XM sample-header default panning (byte 15) and the note-to-sample keymap.
 *
 * FT2 resets the channel pan to the sample's own panning on every trigger
 * (`ch->oldPan = s->panning` / `resetVolumes()` in ft2_replayer.c), so the
 * sample's panning is the resting position each new note starts from: the
 * panning envelope offsets around it, and Cxx/8xx replace it outright via
 * setPan. Before this fix the byte was parsed and dropped, so 121 of the 500
 * corpus samples (14 of 18 demo files) played dead-centre.
 */

const XM_PAN = 51; // clearly left of centre, not a bit-pattern edge case

function firstSampler(buffer: ArrayBuffer) {
  const song = importXmToTrackerSong(buffer);
  const patch = Object.values(song.data.songPatches!)[0]!;
  // Through the normalizer: it rebuilds sampler state from an explicit field
  // list and silently drops anything unnamed (D34, D57).
  return [...deserializePatch(patch).samplers.values()][0]!;
}

describe('the sample header default panning reaches the patch', () => {
  it('carries a non-centre panning through the normalizer', () => {
    const sampler = firstSampler(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1, 0, -1], panning: XM_PAN }] }],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );

    // 0..255 -> 0..1, the same scale the pan effects use.
    expect(sampler.pan).toBeCloseTo(XM_PAN / 255, 6);
  });

  it('leaves centre-panned samples at the engine default', () => {
    const sampler = firstSampler(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1, 0, -1], panning: 128 }] }],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );

    expect(sampler.pan).toBe(0.5);
  });

  it('defaults to centre when the byte holds the header default', () => {
    const sampler = firstSampler(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1, 0, -1] }] }],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );

    expect(sampler.pan).toBe(0.5);
  });
});

interface FakeParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

const makeParam = (value = 0): FakeParam => ({
  value,
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

function makeInstrument(state: Record<string, unknown>) {
  const panners: Array<{ pan: FakeParam }> = [];
  const audioContext = {
    currentTime: 0,
    createBufferSource: () => ({
      buffer: null as unknown,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: makeParam(1),
      detune: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      onended: null as unknown,
    }),
    createGain: () => ({ gain: makeParam(1), connect: vi.fn(), disconnect: vi.fn() }),
    createStereoPanner: () => {
      const node = { pan: makeParam(), connect: vi.fn(), disconnect: vi.fn() };
      panners.push(node);
      return node;
    },
    createOscillator: () => ({
      type: 'sine',
      frequency: makeParam(),
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
  } as unknown as AudioContext;

  const instrument = new ModInstrument(
    { connect: vi.fn() } as unknown as AudioNode,
    audioContext,
  );
  Reflect.set(instrument as object, 'audioBuffer', {
    duration: 1,
    sampleRate: 8000,
    length: 8000,
  });
  Reflect.set(instrument as object, 'sampleFrames', 8000);
  Reflect.set(instrument as object, 'samplerState', {
    gain: 1,
    loopMode: 0,
    loopStart: 0,
    loopEnd: 1,
    rootNote: 65,
    sampleRate: 8000,
    ...state,
  });
  Reflect.set(instrument as object, 'ready', true);
  return { instrument, panners };
}

describe('the patch pan is the per-trigger resting pan', () => {
  it('starts a note at the patch pan when the row carries none', () => {
    const { instrument, panners } = makeInstrument({ pan: XM_PAN / 255 });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    // FT2: outPan = s->panning on every trigger.
    expect(panners[0]!.pan.value).toBeCloseTo((XM_PAN / 255 - 0.5) * 2, 6);
  });

  it('offsets the panning envelope around the patch pan, not centre', () => {
    const { instrument, panners } = makeInstrument({
      pan: XM_PAN / 255,
      trackerPanEnvelope: {
        points: [
          { tick: 0, value: 32 },
          { tick: 10, value: 32 },
        ],
        sustainPoint: -1,
        loopStart: 0,
        loopEnd: 0,
        loopEnabled: false,
      },
    });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    // Envelope 32 = no offset, so the parameter holds the base pan itself.
    const start = panners[0]!.pan.setValueAtTime.mock.calls[0]![0] as number;
    expect(start).toBeCloseTo((XM_PAN / 255 - 0.5) * 2, 5);
  });

  it('lets a row pan command replace the patch pan mid-note', () => {
    const { instrument, panners } = makeInstrument({ pan: XM_PAN / 255 });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });
    instrument.setPan(0, 1);

    // setPan writes the base directly (Cxx/8xx replace, per FT2).
    expect(panners[0]!.pan.linearRampToValueAtTime.mock.calls.at(-1)![0]).toBeCloseTo(1, 5);
  });
});

describe('the note-to-sample keymap', () => {
  const KEYMAP = [...Array(48).fill(0), ...Array(48).fill(1)];

  it('is parsed from the instrument header', () => {
    const xm = parseXm(
      buildXm({
        numChannels: 1,
        instruments: [
          {
            keymap: [...KEYMAP],
            samples: [
              { frames: [0, 1, 0, -1] },
              { frames: [0, -1, 0, 1] },
            ],
          },
        ],
      }),
    );

    expect(xm.instruments[0]!.keymap).toEqual(KEYMAP);
    // Split detected: notes 0..47 -> sample 0, 48..95 -> sample 1.
    expect(new Set(xm.instruments[0]!.keymap).size).toBe(2);
  });

  it('imports only the first audible sample, and says so (D99)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const song = importXmToTrackerSong(
        buildXm({
          numChannels: 1,
          instruments: [
            {
              keymap: KEYMAP,
              samples: [
                { frames: [0, 1, 0, -1], name: 'low' },
                { frames: [0, -1, 0, 1], name: 'high' },
              ],
            },
          ],
          patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
        }).buffer as ArrayBuffer,
      );

      const patch = Object.values(song.data.songPatches!)[0]!;
      // The imported sample is the keymap's first target ('low'), not a merge
      // or the last one.
      expect(patch.metadata.name).toBe('low');
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes('multi-sample'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
