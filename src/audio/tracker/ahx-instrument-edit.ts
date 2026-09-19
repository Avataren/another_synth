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
  filterLowerLimit: AHX_MAX_FILTER_POSITION,
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
