/**
 * What a tracker instrument is, before a host decides how to sound it.
 *
 * The importers' *instrument* half produces these: decoded PCM, where it
 * loops, what note it plays untransposed, and the envelopes the format
 * attaches to it. That is everything a player needs and nothing more.
 *
 * It is deliberately not this app's `Patch`. A `Patch` is a full synth preset
 * -- modulation routing, macro assignments, an effects chain -- because in the
 * app a MOD sample *is* a sampler patch. Exporting that would hand the app's
 * synth model to consumers who asked for a module player, so the app keeps
 * `sampler-patch-builder.ts` as the adapter from one of these to a `Patch`.
 */

/**
 * A tracker volume envelope, as XM (and IT) define them: an arbitrary point
 * list rather than an ADSR, with an optional sustain point the envelope holds
 * at until key-off and an optional loop.
 *
 * Positions are in *ticks*, the tracker's own time unit, since that is how the
 * file expresses them and a tick's wall-clock duration depends on the song's
 * BPM at the moment the note plays.
 */
/**
 * The point/sustain/loop shape XM's volume and panning envelopes share.
 *
 * They differ only in what the value means and what it drives: volume also
 * carries a fadeout, panning does not.
 */
export interface TrackerEnvelopeShape {
  /** Envelope points; `value` is 0..64. */
  points: Array<{ tick: number; value: number }>;
  /** Index of the point to hold at until key-off, or -1 for none. */
  sustainPoint: number;
  /** Loop point indices; only meaningful when `loopEnabled`. */
  loopStart: number;
  loopEnd: number;
  loopEnabled: boolean;
}

/**
 * XM panning envelope. 32 is centre; 0 and 64 are the extremes.
 *
 * FastTracker 2 does not use it as an absolute position -- it is an *offset*
 * around the channel's own pan, scaled by how much room that pan leaves, so
 * the envelope can never push a channel past the edge of the field. See
 * ModInstrument.combinePan.
 */
export type TrackerPanningEnvelope = TrackerEnvelopeShape;

export interface TrackerVolumeEnvelope extends TrackerEnvelopeShape {
  /**
   * Fadeout rate, subtracted from a 65536 counter each tick after key-off.
   * 0 means the note does not fade. Time to silence is
   * (65536 / fadeout) ticks.
   */
  fadeout: number;
}

/**
 * XM instrument-level ("auto") vibrato.
 *
 * A property of the instrument rather than the pattern: every note the
 * instrument plays wobbles, without any 4xy in the song. FastTracker 2 adds it
 * to the channel period *on top of* whatever the effect column is doing, so it
 * has to compose with command vibrato and portamento rather than replace them.
 */
export interface TrackerAutoVibrato {
  /** 0 = sine, 1 = square, 2 = ramp up, 3 = ramp down. Quoted from
   * updateVolPanAutoVib (ft2-clone ft2_replayer.c): `type == 2` is ramp up
   * (((pos>>1)+64)&127)-64, `type == 3` ramp down. */
  type: number;
  /** Ticks taken to reach full depth from note start; 0 = immediate. */
  sweepTicks: number;
  /** 0-15, in the song's period units. */
  depth: number;
  /** Position advance per tick, over a 256-step cycle. */
  rate: number;
}

/**
 * The S3M AdLib header's own timbre block, byte-for-byte as the file stores
 * it (see formats/s3m.ts and the ST3.01b format doc's "adlib instrument
 * format"). This IS the patch format for the future dedicated WASM OPL core
 * (Morten, 2026-09-03) -- raw, unmapped, inactive until then.
 */
export interface OplInstrumentData {
  /** 'melody' (type 2) or 'drum' (type 3+). */
  kind: 'melody' | 'drum';
  /** D00..D0B operator/level/feedback register bytes, file order. */
  registers: number[];
  /** Default volume 0..64 from the AdLib header. */
  volume: number;
  /** Middle-C frequency scaling value (the header c2spd, low 16 bits). */
  c2spd: number;
}

/**
 * How a sample repeats.
 *
 * A string union rather than the app's numeric `SamplerLoopMode`, because
 * those numbers are serialised into saved patches: pinning a library type to
 * them would make the app's file format part of this package's API. XM's
 * parser already reports its loop type this way.
 */
export type TrackerSampleLoop = 'off' | 'forward' | 'pingpong';

/**
 * One instrument slot's worth of imported instrument.
 *
 * Frame counts, not seconds: the loop points are sample offsets in `data`.
 * `slot` is the 1-based slot the importer allocated -- MOD keeps the file's
 * own sample numbering, XM and S3M pack the *referenced* instruments down so a
 * file that declares 128 and uses 8 does not exhaust the slots.
 */
export interface TrackerSample {
  /** 1-based instrument slot, as allocated by the importer. */
  slot: number;
  /**
   * The module's own 1-based instrument/sample number, before slot packing.
   *
   * Equal to `slot` for MOD, which does not pack. For XM and S3M it is the
   * number the file used, which is what a name like "Instrument 07" should
   * refer to -- the packed slot would name a different instrument than the
   * one the composer numbered.
   */
  sourceIndex: number;
  /** Instrument or sample name from the file; may be empty. */
  name: string;
  /** Decoded PCM, normalised to -1..1. Empty for an OPL instrument. */
  data: Float32Array;
  /**
   * The rate `data` is declared at. The importers normalise to one rate and
   * compensate in `rootNote` rather than resampling.
   */
  sampleRate: number;
  /** MIDI note at which the sample plays back untransposed. */
  rootNote: number;
  /** Tuning offset in cents, on top of `rootNote`. */
  detuneCents: number;
  /** Base gain 0..1. */
  gain: number;
  loop: TrackerSampleLoop;
  loopStartFrames: number;
  loopLengthFrames: number;
  /**
   * How many voices this instrument wants: one per channel that ever plays
   * it, so no channel has to steal.
   */
  voiceCount: number;
  /**
   * Resting pan 0..1, 0.5 = centre, from the file's per-sample default.
   * Absent means centre. The panning envelope deviates *around* this rather
   * than replacing it.
   */
  pan?: number;
  volumeEnvelope?: TrackerVolumeEnvelope;
  panEnvelope?: TrackerPanningEnvelope;
  autoVibrato?: TrackerAutoVibrato;
  /**
   * Set instead of `data` for an S3M AdLib instrument: the OPL register bytes
   * as the file stores them. Nothing plays these yet -- a host should give the
   * slot no sound source -- but they are carried so the future OPL core never
   * needs a re-parse.
   */
  opl?: OplInstrumentData;
}

/** What an importer's instrument half returns. */
export interface TrackerSampleSet {
  /** One per allocated slot, in slot order. */
  samples: TrackerSample[];
  /**
   * Module instrument number -> slot number, for the pattern half to resolve
   * a cell's instrument byte. Only instruments that got a slot appear.
   */
  slotForInstrument: Map<number, number>;
}
