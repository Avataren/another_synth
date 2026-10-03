import type { A2mDoc, A2mInstrumentJson } from 'src/audio/tracker/a2m-codec';
import { a2mText, a2mTextBytes } from 'src/audio/tracker/a2m-codec';

/**
 * An Adlib Tracker II instrument as the editor shows it: two OPL operators
 * and the channel's feedback and connection. The file stores them as eleven
 * register bytes (`techinfo.htm`, "instrument specifications"), modulator
 * then carrier in each pair:
 *
 * | byte | register | holds |
 * |---|---|---|
 * | 0-1 | `0x20` | AM (tremolo), VIB, EG (sustain), KSR, multiplier |
 * | 2-3 | `0x40` | key scale level (bits 6-7), total level (0 = loudest) |
 * | 4-5 | `0x60` | attack (high nibble), decay |
 * | 6-7 | `0x80` | sustain level (high nibble), release |
 * | 8-9 | `0xE0` | waveform 0-7 |
 * | 10 | `0xC0` | feedback (bits 1-3), connection (bit 0) |
 *
 * The OPL chip's registers are written from those bytes at note-on, so an
 * edit here is what the chip hears.
 */

export interface A2mOperator {
  /** AM: the operator's amplitude follows the tremolo LFO. */
  tremolo: boolean;
  /** VIB: its pitch follows the vibrato LFO. */
  vibrato: boolean;
  /** EG: holds at the sustain level until key-off instead of decaying on. */
  sustain: boolean;
  /** KSR: the envelope speeds up with pitch. */
  ksr: boolean;
  /** Frequency multiplier, 0-15 (0 is one half). */
  multiplier: number;
  /** Key scale level, 0-3: attenuation per octave. */
  keyScaleLevel: number;
  /** Total level 0-63, in 0.75 dB steps of attenuation: 0 is loudest. */
  totalLevel: number;
  attack: number;
  decay: number;
  sustainLevel: number;
  release: number;
  /** 0 sine, 1 half sine, 2 abs sine, 3 pulse sine, 4-7 the OPL3 shapes. */
  waveform: number;
}

export interface A2mFmVoice {
  modulator: A2mOperator;
  carrier: A2mOperator;
  /** Modulator feedback, 0-7. */
  feedback: number;
  /** `fm`: the modulator drives the carrier. `additive`: the two are summed. */
  connection: 'fm' | 'additive';
}

export const A2M_WAVEFORM_NAMES = [
  'Sine',
  'Half sine',
  'Abs sine',
  'Pulse sine',
  'Sine, double speed',
  'Abs sine, double speed',
  'Square',
  'Derived square',
] as const;

const bit = (v: number, n: number) => ((v >> n) & 1) === 1;

function decodeOperator(fm: ReadonlyArray<number>, i: 0 | 1): A2mOperator {
  const flags = fm[i] ?? 0;
  const level = fm[2 + i] ?? 0;
  const ad = fm[4 + i] ?? 0;
  const sr = fm[6 + i] ?? 0;
  return {
    tremolo: bit(flags, 7),
    vibrato: bit(flags, 6),
    sustain: bit(flags, 5),
    ksr: bit(flags, 4),
    multiplier: flags & 15,
    keyScaleLevel: level >> 6,
    totalLevel: level & 63,
    attack: ad >> 4,
    decay: ad & 15,
    sustainLevel: sr >> 4,
    release: sr & 15,
    waveform: (fm[8 + i] ?? 0) & 7,
  };
}

/** The editor's view of the eleven FM bytes. */
export function decodeA2mFm(fm: ReadonlyArray<number>): A2mFmVoice {
  const fb = fm[10] ?? 0;
  return {
    modulator: decodeOperator(fm, 0),
    carrier: decodeOperator(fm, 1),
    feedback: (fb >> 1) & 7,
    connection: bit(fb, 0) ? 'additive' : 'fm',
  };
}

const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(Number.isFinite(v) ? v : 0)));

/**
 * The eleven FM bytes for `voice`. `base` is the bytes the voice came from:
 * bits the editor does not show (a waveform's upper bits, the feedback
 * byte's high nibble) keep their value.
 */
export function encodeA2mFm(voice: A2mFmVoice, base: ReadonlyArray<number> = []): number[] {
  const out = Array.from({ length: 11 }, (_, i) => base[i] ?? 0);
  const put = (op: A2mOperator, i: 0 | 1) => {
    out[i] =
      (op.tremolo ? 0x80 : 0) |
      (op.vibrato ? 0x40 : 0) |
      (op.sustain ? 0x20 : 0) |
      (op.ksr ? 0x10 : 0) |
      clamp(op.multiplier, 15);
    out[2 + i] = (clamp(op.keyScaleLevel, 3) << 6) | clamp(op.totalLevel, 63);
    out[4 + i] = (clamp(op.attack, 15) << 4) | clamp(op.decay, 15);
    out[6 + i] = (clamp(op.sustainLevel, 15) << 4) | clamp(op.release, 15);
    out[8 + i] = ((base[8 + i] ?? 0) & ~7) | clamp(op.waveform, 7);
  };
  put(voice.modulator, 0);
  put(voice.carrier, 1);
  out[10] = ((base[10] ?? 0) & ~0x0f) | (clamp(voice.feedback, 7) << 1) | (voice.connection === 'additive' ? 1 : 0);
  return out;
}

/** The longest instrument name the song's version stores. */
export function a2mInstrumentNameLimit(version: number): number {
  return version >= 9 ? 42 : 32;
}

/** An instrument's name as text. */
export function a2mInstrumentName(instrument: A2mInstrumentJson): string {
  return a2mText(instrument.name).trim();
}

/** A playable two-operator voice: a sine carrier, an unmodulated modulator, sustained. */
export function defaultA2mInstrument(name = 'New instrument', version = 14): A2mInstrumentJson {
  return {
    name: a2mTextBytes(name, a2mInstrumentNameLimit(version)),
    fm: [0x21, 0x21, 0x3f, 0x00, 0xf2, 0xf4, 0x24, 0x27, 0x00, 0x00, 0x00],
    panning: 0,
    finetune: 0,
    voice_type: 0,
  };
}

/** How many instruments the song has (250 before version 9, 255 from it). */
export function a2mInstrumentCount(doc: Pick<A2mDoc, 'instruments'>): number {
  return doc.instruments.length;
}

/** Whether an instrument holds nothing (AT2's own test for an unused slot). */
export function isEmptyA2mInstrument(instrument: A2mInstrumentJson): boolean {
  return (
    instrument.fm.every((b) => b === 0) &&
    instrument.panning === 0 &&
    instrument.finetune === 0 &&
    instrument.voice_type === 0
  );
}

/** `doc` with instrument `number` (1-based) replaced. The doc is never mutated: it is shared with undo history. */
export function withA2mInstrument(doc: A2mDoc, number: number, instrument: A2mInstrumentJson): A2mDoc {
  if (number < 1 || number > doc.instruments.length) return doc;
  const instruments = doc.instruments.slice();
  instruments[number - 1] = instrument;
  return { ...doc, instruments };
}
