/**
 * FastTracker 2 XM patterns -> the tracker row model.
 *
 * The pattern half of the XM importer: cells in, `TrackerPattern`s out, given
 * the module's pitch model and its instrument-to-slot mapping. The sample
 * half -- instruments into slots and sampler patches, envelopes and all --
 * stays app-side; see `src/audio/tracker/xm-import.ts`.
 */
import type { XmSong, XmPatternCell, XmInstrument, XmSample } from '../formats/xm';
import { XM_KEY_OFF } from '../formats/xm';
import type { PitchModel } from '../pitch-model';
import type {
  TrackerPattern,
  TrackerTrackData,
  TrackerEntryData,
} from '../tracker-types';
import { clampPatternRows } from '../song-constants';
import { formatInstrumentId } from '../instrument-ids';
import { midiToTrackerNote } from '../note-utils';

/** XM note 1 is C-0, which is MIDI 12. */
const XM_NOTE_TO_MIDI_OFFSET = 11;

export function buildXmTrackerPatterns(
  xm: XmSong,
  pitch: PitchModel,
  slotForInstrument: Map<number, number>,
): TrackerPattern[] {
  return xm.patterns.map((pattern, index) => {
    const tracks: TrackerTrackData[] = [];
    for (let ch = 0; ch < xm.numChannels; ch++) {
      tracks.push({
        id: `T${(ch + 1).toString().padStart(2, '0')}`,
        name: `Track ${ch + 1}`,
        entries: [],
        interpolations: [],
      });
    }

    for (let row = 0; row < pattern.rows.length; row++) {
      for (let ch = 0; ch < xm.numChannels; ch++) {
        const cell = pattern.rows[row]?.[ch];
        if (!cell) continue;
        const entry = xmCellToTrackerEntry(cell, row, xm, pitch, slotForInstrument);
        if (!entry) continue;
        tracks[ch]?.entries.push(entry);
      }
    }

    return {
      id: crypto.randomUUID(),
      name: `Pattern ${index + 1}`,
      rows: clampPatternRows(pattern.numRows),
      tracks,
    };
  });
}

/**
 * The frequency a note should sound at, in the engine's musical-Hz domain.
 *
 * Only the written note is converted here. A sample's `relativeNote` is folded
 * into its patch root note instead, so it must not be applied twice.
 */
function frequencyForNote(note: number, pitch: PitchModel): number | undefined {
  if (note < 1 || note > 96) return undefined;
  const zeroBased = note - 1;
  const period =
    pitch.kind === 'linear'
      ? 7680 - zeroBased * 64
      : 1712 * Math.pow(2, (48 - zeroBased) / 12);
  return pitch.frequencyFromPeriod(period);
}

function xmCellToTrackerEntry(
  cell: XmPatternCell,
  row: number,
  xm: XmSong,
  pitch: PitchModel,
  slotForInstrument: Map<number, number>,
): TrackerEntryData | undefined {
  const hasNote = cell.note > 0 && cell.note <= 96;
  const isKeyOff = cell.note === XM_KEY_OFF;
  const hasInstrument = cell.instrument > 0;
  const hasEffect = cell.effectType !== 0 || cell.effectParam !== 0;
  const hasVolumeColumn = cell.volumeColumn > 0;
  // 3xx and 5xy in the effect column, and the volume column's own 0xFy.
  const isTonePorta =
    cell.effectType === 0x3 ||
    cell.effectType === 0x5 ||
    (cell.volumeColumn & 0xf0) === 0xf0;

  if (!hasNote && !isKeyOff && !hasInstrument && !hasEffect && !hasVolumeColumn) {
    return undefined;
  }

  const entry: TrackerEntryData = { row };

  // Only a row that starts a note switches which instrument this channel is
  // playing. An instrument number on a *key-off* row selects the sample for the
  // channel's next note; it does not change what is currently sounding, and
  // stamping it here re-routes every per-voice effect that follows to an
  // instrument with nothing playing. Same rule mod-import follows for a bare
  // sample number (D29).
  //
  // xyce-dans_la_rue.xm is full of `=== <instrument>` rows on channels holding
  // a note from an earlier pattern; the volume slides that follow them were
  // landing on the wrong instrument, so the note carried on at full level.
  //
  // Tone portamento is excluded for the same underlying reason, and mod-import
  // has excluded it since D55: `3xx`/`5xy` slide the voice that is already
  // sounding rather than starting a new one, so stamping the row's instrument
  // re-addresses the slide to an instrument with nothing playing and it is
  // dropped on the floor. FT2 reloads the volume from that instrument but goes
  // on playing the current sample.
  //
  // "im in love with you" is the case that showed it: `F-5 04` then
  // `G-5 01 307`. The slide was emitted correctly, note for note, against
  // instrument 01 -- which had no voice on that channel -- so the lead stayed
  // where the preceding `101` had left it instead of arriving on G-5.
  if (hasInstrument && !isKeyOff && !isTonePorta) {
    const slot = slotForInstrument.get(cell.instrument);
    if (slot !== undefined) entry.instrument = formatInstrumentId(slot);
  }

  if (isKeyOff) {
    // The tracker's note-off symbol; the engine releases the track's voice.
    entry.note = '###';
  } else if (hasNote) {
    entry.note = midiToTrackerNote(cell.note + XM_NOTE_TO_MIDI_OFFSET);
    const frequency = frequencyForNote(cell.note, pitch);
    if (frequency !== undefined) entry.frequency = frequency;
  }

  // Volume column: 0x10..0x50 is "set volume" 0..64, which is a velocity like
  // any other. From 0x60 up it holds commands -- volume and pan slides, fine
  // slides, panning, vibrato, tone portamento -- which are carried separately
  // (see TrackerEntryData.volumeCommand) because they have no velocity
  // meaning and run alongside the effect column rather than replacing it.
  if (cell.volumeColumn >= 0x60) {
    entry.volumeCommand = cell.volumeColumn
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  }

  if (cell.volumeColumn >= 0x10 && cell.volumeColumn <= 0x50) {
    const volume = cell.volumeColumn - 0x10; // 0..64
    entry.volume = Math.round((volume / 64) * 255)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
    // Distinguishes a volume-column volume from the sample's default (the
    // other thing that lands in entry.volume below); see volumeColumnVolume.
    // FT2's Rxy quirk only suppresses the tick-0 count when the volume
    // handling left a non-zero byte, so volume 0 does not count as one.
    if (volume > 0) entry.volumeColumnVolume = true;
  } else if (hasNote && hasInstrument) {
    // A note with an instrument and no explicit volume plays at the sample's
    // default, as in ProTracker.
    const sample = firstSampleOf(xm.instruments[cell.instrument - 1]);
    if (sample) {
      entry.volume = Math.round((sample.volume / 64) * 255)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0');
    }
  }

  // Raw bytes are the source of truth (D94); the text macro is derived from
  // them for display and hand-editing. Both share the same gate: 0x00/00 is
  // a no-op, not an arpeggio.
  if (cell.effectType !== 0 || cell.effectParam !== 0) {
    entry.effectCommand = cell.effectType;
    entry.effectParam = cell.effectParam;
  }
  const macro = xmEffectToMacro(cell.effectType, cell.effectParam);
  if (macro) entry.macro = macro;

  return entry;
}

/**
 * Map an XM effect to the tracker's text macro form.
 *
 * XM numbers its effects 0..0x22: 0-0xF match the MOD/ProTracker letters this
 * tracker already understands, and 0x10+ are FT2's extras (Gxx global volume,
 * Kxx key off, Rxy retrigger and so on), which continue the alphabet.
 */
function xmEffectToMacro(effectType: number, effectParam: number): string | undefined {
  if (effectType === 0 && effectParam === 0) return undefined;

  const paramHex = effectParam.toString(16).toUpperCase().padStart(2, '0');

  // 0..0xF share ProTracker's numbering, so reuse the same characters.
  const prefixes = '0123456789ABCDEF';
  if (effectType < prefixes.length) {
    const prefix = prefixes[effectType]!;
    // 000 is a no-op rather than an arpeggio.
    if (effectType === 0 && effectParam === 0) return undefined;
    return `${prefix}${paramHex}`;
  }

  // 0x10 = G, 0x11 = H, ... continuing past F.
  const extended = String.fromCharCode('G'.charCodeAt(0) + (effectType - 0x10));
  return `${extended}${paramHex}`;
}

export function firstSampleOf(instrument: XmInstrument | undefined): XmSample | undefined {
  if (!instrument) return undefined;
  return instrument.samples.find((s) => s.data.length > 0) ?? instrument.samples[0];
}
