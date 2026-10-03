/**
 * The part of an XM instrument that is not audio.
 *
 * An app that stores a slot's samples as playable patches still has to write
 * a .xm back, and a patch has no place for the header fields -- the default
 * volume, the panning and relative note, 8- versus 16-bit, the keymap, the
 * envelopes (including ones switched off), fadeout and autovibrato. This is
 * those fields; the PCM and loop points stay where the sound is.
 */
import type { XmEnvelope, XmInstrument, XmLoopType, XmSample } from './formats/xm';

export interface XmSampleMeta {
  name: string;
  /** Default volume, 0..64. */
  volume: number;
  /** -128..127, in 1/128ths of a semitone. */
  finetune: number;
  /** 0..255, 128 = centre. */
  panning: number;
  relativeNote: number;
  bits: 8 | 16;
  /** Header byte 17; see `XmSample.reserved`. */
  reserved?: number;
}

export interface XmInstrumentMeta {
  name: string;
  /** Note 0..95 -> index into `samples`. */
  keymap: number[];
  volumeEnvelope: XmEnvelope;
  panningEnvelope: XmEnvelope;
  volumeFadeout: number;
  vibratoType: number;
  vibratoSweep: number;
  vibratoDepth: number;
  vibratoRate: number;
  samples: XmSampleMeta[];
}

/** The playable half of one sample: what the patch holds. */
export interface XmSamplePcm {
  data: Float32Array;
  loopStart: number;
  loopLength: number;
  loopType: XmLoopType;
}

function cloneEnvelope(env: XmEnvelope): XmEnvelope {
  return { ...env, points: env.points.map((p) => ({ ...p })) };
}

export function xmMetaOf(instrument: XmInstrument): XmInstrumentMeta {
  return {
    name: instrument.name,
    keymap: [...instrument.keymap],
    volumeEnvelope: cloneEnvelope(instrument.volumeEnvelope),
    panningEnvelope: cloneEnvelope(instrument.panningEnvelope),
    volumeFadeout: instrument.volumeFadeout,
    vibratoType: instrument.vibratoType,
    vibratoSweep: instrument.vibratoSweep,
    vibratoDepth: instrument.vibratoDepth,
    vibratoRate: instrument.vibratoRate,
    samples: instrument.samples.map((s) => ({
      name: s.name,
      volume: s.volume,
      finetune: s.finetune,
      panning: s.panning,
      relativeNote: s.relativeNote,
      bits: s.bits,
      ...(s.reserved !== undefined ? { reserved: s.reserved } : {}),
    })),
  };
}

/** Meta plus each sample's PCM (in the same order) is the whole instrument. */
export function xmInstrumentOf(meta: XmInstrumentMeta, pcm: XmSamplePcm[]): XmInstrument {
  const samples: XmSample[] = meta.samples.map((m, i) => {
    const p = pcm[i];
    const data = p?.data ?? new Float32Array(0);
    return {
      ...m,
      length: data.length,
      loopStart: p?.loopStart ?? 0,
      loopLength: p?.loopLength ?? 0,
      loopType: p?.loopType ?? 'none',
      data,
    };
  });
  return {
    name: meta.name,
    keymap: [...meta.keymap],
    volumeEnvelope: cloneEnvelope(meta.volumeEnvelope),
    panningEnvelope: cloneEnvelope(meta.panningEnvelope),
    volumeFadeout: meta.volumeFadeout,
    vibratoType: meta.vibratoType,
    vibratoSweep: meta.vibratoSweep,
    vibratoDepth: meta.vibratoDepth,
    vibratoRate: meta.vibratoRate,
    samples,
  };
}

export function emptyXmEnvelope(): XmEnvelope {
  return {
    points: [],
    sustainPoint: 0,
    loopStart: 0,
    loopEnd: 0,
    enabled: false,
    sustainEnabled: false,
    loopEnabled: false,
  };
}

export function emptyXmSampleMeta(name = ''): XmSampleMeta {
  return { name, volume: 64, finetune: 0, panning: 128, relativeNote: 0, bits: 8 };
}

export function emptyXmInstrumentMeta(name = ''): XmInstrumentMeta {
  return {
    name,
    keymap: new Array(96).fill(0),
    volumeEnvelope: emptyXmEnvelope(),
    panningEnvelope: emptyXmEnvelope(),
    volumeFadeout: 0,
    vibratoType: 0,
    vibratoSweep: 0,
    vibratoDepth: 0,
    vibratoRate: 0,
    samples: [],
  };
}

/** The sample a note (XM numbering, 1 = C-0) plays, or undefined for an empty instrument. */
export function xmSampleForNote<S>(
  instrument: { keymap: number[]; samples: S[] },
  note: number,
): S | undefined {
  const index = instrument.keymap[Math.max(0, Math.min(95, note - 1))] ?? 0;
  return instrument.samples[index] ?? instrument.samples[0];
}
