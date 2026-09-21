/**
 * The edits the AHX instrument editor makes, as pure functions over
 * `AhxInstrument`: each takes an instrument and returns a changed copy (the
 * input is never touched), with the value clamped into what the file format can
 * hold (`AHX_FIELD_MAX`), so an edit can neither produce an instrument the
 * serializer refuses nor one the engine has no table for.
 *
 * What an edit means, and which are honest about AHX's model:
 * an instrument has no waveform of its own. The waveform a note plays is
 * picked by its PList (row by row), so "the waveform" here is the waveform of
 * the first PList row, the timbre a note starts with, and "the filter position"
 * is the parameter of a filter-position command (PList command 0) on that row.
 */
import {
  AHX_FIELD_MAX,
  AHX_MAX_PLIST_ENTRIES,
  AHX_PLIST_MAX_NOTE,
  ahxPListCommandsFor,
  type AhxInstrument,
  type AhxPListEntry,
  type AhxSongFormat,
} from '@another-synth/tracker-playback';
import {
  AHX_SWEEP_PARAM,
  AHX_WAVE_SQUARE,
  ahxSweepSetup,
  canEnableAhxSweep,
  type AhxSweepContext,
  type AhxSweepKind,
} from 'src/audio/tracker/ahx-instrument-visuals';

/** Wave lengths the engine has tables for: 4 << 0 .. 4 << 5 samples. */
export const AHX_MAX_WAVE_LENGTH = 5;

/** Volumes are 0..=64. */
export const AHX_EDIT_MAX_VOLUME = 64;

/** Filter positions a PList command sets: 1..=63 (0 leaves the position alone). */
export const AHX_MAX_FILTER_POSITION = 0x3f;

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;

const copy = (ins: AhxInstrument): AhxInstrument => JSON.parse(JSON.stringify(ins)) as AhxInstrument;

/** Instrument fields that hold one number, with the largest value each takes. */
export const AHX_NUMBER_FIELDS = {
  volume: AHX_EDIT_MAX_VOLUME,
  waveLength: AHX_MAX_WAVE_LENGTH,
  // The codec holds 7 bits here, and an imported value can be up to 0x7f; the
  // engine clamps the positions it walks to 1..=63 (E14), so 64..=127 sit past the useful range.
  filterLowerLimit: AHX_FIELD_MAX.filterLowerLimit,
  filterUpperLimit: AHX_FIELD_MAX.filterUpperLimit,
  filterSpeed: AHX_FIELD_MAX.filterSpeed,
  squareLowerLimit: 255,
  squareUpperLimit: 255,
  squareSpeed: 255,
  vibratoDelay: 255,
  vibratoSpeed: 255,
  vibratoDepth: AHX_FIELD_MAX.vibratoDepth,
  hardCutReleaseFrames: AHX_FIELD_MAX.hardCutReleaseFrames,
} as const;

export type AhxNumberFieldKey = keyof typeof AHX_NUMBER_FIELDS;

export function setAhxNumber(ins: AhxInstrument, field: AhxNumberFieldKey, value: number): AhxInstrument {
  const next = copy(ins);
  next[field] = clamp(value, 0, AHX_NUMBER_FIELDS[field]);
  return next;
}

export function setAhxHardCutRelease(ins: AhxInstrument, on: boolean): AhxInstrument {
  const next = copy(ins);
  next.hardCutRelease = on;
  // A hard cut with no frames is no release at all (the live voice would fall
  // back to its plain release): start it at a short one.
  if (on && next.hardCutReleaseFrames === 0) next.hardCutReleaseFrames = 3;
  return next;
}

export type AhxEnvelopeField = keyof AhxInstrument['envelope'];

/** Envelope stage lengths are frames (a byte); the levels are volumes, 0..=64. */
export function setAhxEnvelope(ins: AhxInstrument, field: AhxEnvelopeField, value: number): AhxInstrument {
  const next = copy(ins);
  const isVolume = field === 'aVolume' || field === 'dVolume' || field === 'rVolume';
  next.envelope[field] = clamp(value, 0, isVolume ? AHX_EDIT_MAX_VOLUME : 255);
  return next;
}

/** Several envelope fields at once (one node drag moves a stage's frames and its level), each clamped as `setAhxEnvelope` does. */
export function setAhxEnvelopeFields(ins: AhxInstrument, fields: Partial<AhxInstrument['envelope']>): AhxInstrument {
  const next = copy(ins);
  for (const [key, value] of Object.entries(fields) as Array<[AhxEnvelopeField, number]>) {
    const isVolume = key === 'aVolume' || key === 'dVolume' || key === 'rVolume';
    next.envelope[key] = clamp(value, 0, isVolume ? AHX_EDIT_MAX_VOLUME : 255);
  }
  return next;
}

/**
 * True when the attack and decay are both 0 frames. The replayer only moves the
 * envelope during a stage that has frames (`AdsrState::step`), so such an
 * envelope never rises: the note starts, and holds, at silence, and then its
 * release ramps from that 0 towards the release level by a step worked out from
 * the *decay level* -- which swings the volume negative (an inverted, loud
 * note) whenever the decay level is above the release level. That is the
 * reference's behaviour and the editor keeps it, but it is almost never what
 * was meant, so the editor says so.
 */
export function ahxEnvelopeNeverRises(ins: AhxInstrument): boolean {
  return ins.envelope.aFrames === 0 && ins.envelope.dFrames === 0;
}

export interface AhxEnvelopeWarning {
  /** Stable id; the editor uses it in a test id. */
  id: 'never-rises' | 'no-attack' | 'no-decay' | 'no-release';
  text: string;
}

/**
 * What the engine does with an envelope that has a 0-frame stage, which the
 * four numbers do not suggest (editor plan E1; `envelope.rs:74-97`). The
 * never-rises case (attack and decay both 0) keeps its own, longer warning.
 */
export function ahxEnvelopeWarnings(ins: AhxInstrument): AhxEnvelopeWarning[] {
  const { aFrames, dFrames, aVolume, dVolume, rFrames } = ins.envelope;
  const out: AhxEnvelopeWarning[] = [];
  if (aFrames === 0 && dFrames === 0) {
    out.push({
      id: 'never-rises',
      text:
        'Attack and decay are both 0 frames: the envelope never rises, so the note is silent until its ' +
        'release, which then swings the volume unpredictably. Give the attack at least 1 frame.',
    });
  } else if (aFrames === 0) {
    out.push({
      id: 'no-attack',
      text:
        'Attack is 0 frames, so the engine skips it: the note starts at silence and the decay ramps up from 0 ' +
        'by its own step, then snaps to the decay level on its last frame (the dotted line is what the numbers ' +
        'suggest, the solid one what plays).',
    });
  }
  if (dFrames === 0 && aFrames > 0 && dVolume !== aVolume) {
    out.push({
      id: 'no-decay',
      text:
        'Decay is 0 frames, so the engine skips it: the sustain holds the attack level, and the decay level ' +
        `(${dVolume}) is never reached.`,
    });
  }
  if (rFrames === 0) {
    out.push({
      id: 'no-release',
      text: 'Release is 0 frames, so the engine skips it: the note never releases and holds its level until it is cut.',
    });
  }
  return out;
}

/**
 * The largest value a PList command parameter takes. A version-0 AHX file drops
 * the high nibble of a filter-toggle (command 4) parameter when it loads, so
 * only 0..=15 can be heard there (`normalizeAhxInstrumentForVersion`).
 */
export function ahxFxParamMax(fx: number, format: AhxSongFormat, version: number): number {
  return fx === 4 && format === 'ahx' && version === 0 ? 0x0f : 255;
}

// ---------------------------------------------------------------------------
// PList
// ---------------------------------------------------------------------------

export function setAhxPListSpeed(ins: AhxInstrument, speed: number): AhxInstrument {
  const next = copy(ins);
  next.plist.speed = clamp(speed, 0, 255);
  return next;
}

export function emptyPListEntry(): AhxPListEntry {
  return { note: 0, waveform: 0, fixed: false, fx: [0, 0], fxParam: [0, 0] };
}

export type AhxPListEdit =
  | { field: 'note'; value: number }
  | { field: 'waveform'; value: number }
  | { field: 'fixed'; value: boolean }
  /** `slot` is 0 or 1: the entry's first or second command. */
  | { field: 'fx'; slot: 0 | 1; value: number }
  | { field: 'fxParam'; slot: 0 | 1; value: number };

/**
 * Change one field of PList row `row`; an unknown row leaves the instrument as
 * it is. `format` is the song's: it decides which commands a row can be given.
 */
export function editAhxPListEntry(
  ins: AhxInstrument,
  row: number,
  edit: AhxPListEdit,
  format: AhxSongFormat = 'ahx',
): AhxInstrument {
  const next = copy(ins);
  const entry = next.plist.entries[row];
  if (!entry) return next;
  switch (edit.field) {
    case 'note':
      entry.note = clamp(edit.value, 0, AHX_PLIST_MAX_NOTE);
      break;
    case 'waveform':
      entry.waveform = clamp(edit.value, 0, AHX_FIELD_MAX.plistWaveform);
      break;
    case 'fixed':
      entry.fixed = edit.value;
      break;
    case 'fx': {
      // Only commands the song format's PList can hold; anything else is not written.
      if (ahxPListCommandsFor(format).includes(edit.value)) entry.fx[edit.slot] = edit.value;
      break;
    }
    case 'fxParam':
      entry.fxParam[edit.slot] = clamp(edit.value, 0, 255);
      break;
  }
  return next;
}

/** Add an empty row after `after` (default: at the end); a full PList is unchanged. */
export function addAhxPListEntry(ins: AhxInstrument, after?: number): AhxInstrument {
  const next = copy(ins);
  if (next.plist.entries.length >= AHX_MAX_PLIST_ENTRIES) return next;
  const at = after === undefined ? next.plist.entries.length : clamp(after + 1, 0, next.plist.entries.length);
  next.plist.entries.splice(at, 0, emptyPListEntry());
  return next;
}

export function removeAhxPListEntry(ins: AhxInstrument, row: number): AhxInstrument {
  const next = copy(ins);
  if (row >= 0 && row < next.plist.entries.length) next.plist.entries.splice(row, 1);
  return next;
}

/** Insert a copy of `row` right after it; an unknown row or a full PList is unchanged. */
export function duplicateAhxPListEntry(ins: AhxInstrument, row: number): AhxInstrument {
  const next = copy(ins);
  const entry = next.plist.entries[row];
  if (!entry || next.plist.entries.length >= AHX_MAX_PLIST_ENTRIES) return next;
  next.plist.entries.splice(row + 1, 0, { ...entry, fx: [...entry.fx], fxParam: [...entry.fxParam] } as AhxPListEntry);
  return next;
}

/** Empty row `row` in place (the row stays, so no later row moves); an unknown row is unchanged. */
export function clearAhxPListEntry(ins: AhxInstrument, row: number): AhxInstrument {
  const next = copy(ins);
  if (next.plist.entries[row]) next.plist.entries[row] = emptyPListEntry();
  return next;
}

// ---------------------------------------------------------------------------
// "The waveform": what the first PList row picks
// ---------------------------------------------------------------------------

/** The waveform field (0 = none, 1..4 = triangle, sawtooth, square, noise) of PList row 0. */
export function ahxStartWaveform(ins: AhxInstrument): number {
  return ins.plist.entries[0]?.waveform ?? 0;
}

/** Sets row 0's waveform, adding row 0 to an empty PList. */
export function setAhxStartWaveform(ins: AhxInstrument, waveform: number): AhxInstrument {
  const base = ins.plist.entries.length === 0 ? addAhxPListEntry(ins) : ins;
  return editAhxPListEntry(base, 0, { field: 'waveform', value: waveform });
}

/**
 * The filter position set on PList row 0 (a command 0 with a non-zero
 * parameter), 0 when row 0 sets none.
 */
export function ahxStartFilterPosition(ins: AhxInstrument): number {
  const entry = ins.plist.entries[0];
  if (!entry) return 0;
  const slot = entry.fx.findIndex((fx, i) => fx === 0 && (entry.fxParam[i] ?? 0) !== 0);
  return slot < 0 ? 0 : (entry.fxParam[slot] ?? 0);
}

/**
 * Whether row 0 can carry a filter position: it already has one, or has a
 * command slot that is empty (command 0, parameter 0).
 */
export function canSetAhxStartFilterPosition(ins: AhxInstrument): boolean {
  const entry = ins.plist.entries[0];
  if (!entry) return true; // there is no row 0 yet; setting it adds one
  // A slot holding command 0 is either the position itself or an empty slot.
  return entry.fx.some((fx) => fx === 0);
}

/** Sets (or, with 0, clears) row 0's filter position, adding row 0 to an empty PList. */
export function setAhxStartFilterPosition(ins: AhxInstrument, position: number): AhxInstrument {
  const base = ins.plist.entries.length === 0 ? addAhxPListEntry(ins) : ins;
  const next = copy(base);
  const entry = next.plist.entries[0]!;
  // The slot that already holds the position, else the first free one.
  const slot = entry.fx.findIndex((fx, i) => fx === 0 && (entry.fxParam[i] ?? 0) !== 0);
  const target = slot >= 0 ? slot : entry.fx.findIndex((fx) => fx === 0);
  if (target < 0) return next;
  entry.fxParam[target] = clamp(position, 0, AHX_MAX_FILTER_POSITION);
  return next;
}

// ---------------------------------------------------------------------------
// Sweeps: "Turn on at row 0" (editor plan E8)
// ---------------------------------------------------------------------------

/**
 * Turns a sweep on the way the engine only can: PList command 4 (a toggle) on
 * row 0, in a free command slot (`plist.rs:47-65`). A square sweep also needs a
 * row that selects the square wave, so row 0 is switched to it when none does.
 * Nothing changes when the sweep is already toggled on, or when it cannot be
 * turned on (no free slot on row 0; a version-0 AHX file cannot toggle the
 * filter).
 */
export function enableAhxSweep(
  ins: AhxInstrument,
  kind: AhxSweepKind,
  context: AhxSweepContext = { format: 'ahx', version: 1 },
): AhxInstrument {
  const setup = ahxSweepSetup(ins, kind, context);
  let next = ins;
  if (!setup.toggled) {
    if (!canEnableAhxSweep(ins, kind, context)) return ins;
    next = copy(ins.plist.entries.length === 0 ? addAhxPListEntry(ins) : ins);
    const entry = next.plist.entries[0]!;
    const slot = entry.fx.findIndex((fx, i) => fx === 0 && (entry.fxParam[i] ?? 0) === 0);
    entry.fx[slot] = 4;
    entry.fxParam[slot] = AHX_SWEEP_PARAM[kind];
  }
  if (kind === 'square' && !ahxSweepSetup(next, 'square', context).hasSquareWave) {
    next = setAhxStartWaveform(next, AHX_WAVE_SQUARE);
  }
  return next;
}

// ---------------------------------------------------------------------------
// A new instrument
// ---------------------------------------------------------------------------

export const DEFAULT_AHX_INSTRUMENT_NAME = 'New instrument';

/**
 * The instrument "New AHX instrument" starts from: audible, with an envelope
 * that goes up, down and out (attack and decay are never both 0 frames, which
 * would make the release ramp the wrong way), and one PList row that selects
 * the sawtooth wave. Not the AHX tracker's own default (unverified); a
 * test renders it through the real engine.
 */
export function defaultAhxInstrument(): AhxInstrument {
  return {
    name: DEFAULT_AHX_INSTRUMENT_NAME,
    volume: 64,
    waveLength: 3,
    filterLowerLimit: 0,
    filterUpperLimit: 0,
    filterSpeed: 0,
    squareLowerLimit: 32,
    squareUpperLimit: 63,
    squareSpeed: 1,
    vibratoDelay: 0,
    vibratoSpeed: 0,
    vibratoDepth: 0,
    hardCutRelease: false,
    hardCutReleaseFrames: 0,
    envelope: { aFrames: 1, aVolume: 64, dFrames: 10, dVolume: 48, sFrames: 0, rFrames: 10, rVolume: 0 },
    plist: { speed: 1, entries: [{ note: 0, waveform: 2, fixed: false, fx: [0, 0], fxParam: [0, 0] }] },
  };
}
