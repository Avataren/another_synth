/**
 * Scream Tracker 3 S3M patterns -> the tracker row model.
 *
 * The pattern half of the S3M importer: cells in, `TrackerPattern`s out,
 * plus `measureS3m`, the corpus audit of what the format carries and this
 * importer deliberately drops (D96/D97). Both need only the parsed module.
 * The sample half -- instruments into slots and sampler patches -- stays
 * app-side; see `src/audio/tracker/s3m-import.ts`.
 */
import type { S3mSong, S3mPatternCell } from '../formats/s3m';
import { S3M_KEY_OFF, S3M_NO_NOTE, S3M_NO_VOLUME } from '../formats/s3m';
import type { PitchModel } from '../pitch-model';
import { s3mPeriodForNote } from '../pitch-model';
import type {
  TrackerPattern,
  TrackerTrackData,
  TrackerEntryData,
} from '../tracker-types';
import { clampPatternRows } from '../song-constants';
import { formatInstrumentId } from '../instrument-ids';
import { midiToTrackerNote } from '../note-utils';

/**
 * S3M's per-channel volume commands (M 0x0D / N 0x0E) have no
 * format-neutral behaviour yet (D96/D97: deliberately unmapped). The importer
 * counts corpus uses of every byte the profile leaves undefined, so the
 * count-then-decide rule (P5 audit) has a number to act on.
 */
export const UNMAPPED_COMMAND_BYTES = [0x0d, 0x0e, 0x19, 0x1a];

export interface S3mImportCounts {
  /** Type-0x02/0x03 instruments declared in the header. */
  adlibInstruments: number;
  /** Enabled AdLib channel settings (16..29), regardless of use. */
  adlibChannels: number;
  /** Note-starting cells found on those channels in the pattern data. */
  adlibNotes: number;
  /** Volume bytes in the 128..192 panning range (dropped, counted). */
  volumeColumnPans: number;
  /** Cells carrying a command byte the profile leaves undefined. */
  unmappedCommands: number;
  /** Samples dropped for stereo (no stereo sampler path exists). */
  stereoSamples: number;
  /** Samples skipped for DP30AD1F packing (no reference unpacker exists). */
  packedSamples: number;
  /** Pattern cells on disabled/muted channels (dropped, counted). */
  disabledChannelCells: number;
}


/**
 * Enabled (non-0xFF) channel numbers, in file order.
 *
 * A settings byte of 0xFF means the channel is disabled. The mute flag
 * (bit 7) is a saved runtime toggle -- OpenMPT maps it to CHN_MUTE -- so a
 * muted channel imports as nothing, exactly like a disabled one. Channel
 * types 16..29 are the AdLib ones (OpenMPT Load_s3m.cpp: `if (ctype >= 16
 * && ctype <= 29) ... isAdlibChannel[i] = true`).
 */
function enabledChannels(s3m: S3mSong): number[] {
  const channels: number[] = [];
  for (let ch = 0; ch < 32; ch++) {
    const setting = s3m.channelSettings[ch] ?? 0xff;
    if (setting === 0xff) continue;
    channels.push(ch);
  }
  return channels;
}

function isAdlibChannel(s3m: S3mSong, ch: number): boolean {
  const setting = s3m.channelSettings[ch] ?? 0xff;
  if (setting === 0xff) return false;
  const ctype = setting & 0x7f;
  return ctype >= 16 && ctype <= 29;
}

/**
 * Default panning for a channel, normalized 0..1 (0.5 = centre), or
 * undefined for the engine's centre default.
 *
 * OpenMPT Load_s3m.cpp, quoted: a stereo file
 * (`fileHeader.masterVolume & 0x80`) gives each non-disabled channel
 * `nPan = (ctype & 8) ? 0xCC : 0x33` -- ST3's own defaults write
 * L1-L8 as 0x00-0x07 and R1-R8 as 0x08-0x0F, so low-nibble bit 3 is the
 * side. The extended panning table (byte 0x35 == 0xFC) overrides per
 * channel: `(pan[i] & 0x20) != 0` -> `nPan = ((pan[i] & 0x0F) * 256 + 8) / 15`.
 * AdLib channels are forced to centre.
 */
function channelPan(s3m: S3mSong, ch: number): number | undefined {
  if (isAdlibChannel(s3m, ch)) return undefined;
  const setting = s3m.channelSettings[ch] ?? 0xff;
  if (setting === 0xff) return undefined;

  if (s3m.hasPanningTable && s3m.defaultPans) {
    const pan = s3m.defaultPans[ch] ?? 0;
    if (pan & 0x20) {
      const raw = ((pan & 0x0f) * 256 + 8) / 15; // 0..255
      return raw / 255;
    }
  }
  if (!s3m.masterStereo) return undefined;
  return setting & 0x08 ? 204 / 255 : 51 / 255;
}

/** The (cmd, param) pairs the S3M profile deliberately leaves unmapped. */
function isUnmappedCommand(cell: S3mPatternCell): boolean {
  if (cell.effectCommand === 0) return false;
  if (UNMAPPED_COMMAND_BYTES.includes(cell.effectCommand)) return true;
  // Sxx subcommands that st3play's ssoncejmp maps to s_ret.
  if (
    cell.effectCommand === 0x13 &&
    [0x5, 0x6, 0x7, 0x9, 0xa, 0xf].includes((cell.effectParam ?? 0) >> 4)
  ) {
    return true;
  }
  return false;
}

export function measureS3m(s3m: S3mSong): S3mImportCounts {
  const counts: S3mImportCounts = {
    adlibInstruments: 0,
    adlibChannels: 0,
    adlibNotes: 0,
    volumeColumnPans: 0,
    unmappedCommands: 0,
    stereoSamples: 0,
    packedSamples: 0,
    disabledChannelCells: 0,
  };

  for (const instrument of s3m.instruments) {
    if (instrument.kind === 'adlib') counts.adlibInstruments++;
    if (instrument.notDecoded === 'stereo') counts.stereoSamples++;
    if (instrument.notDecoded === 'dp30ad1f-packed') counts.packedSamples++;
  }
  for (let ch = 0; ch < 32; ch++) {
    if (isAdlibChannel(s3m, ch)) counts.adlibChannels++;
  }

  const enabled = new Set(enabledChannels(s3m));
  for (const pattern of s3m.patterns) {
    for (const row of pattern.rows) {
      row.forEach((cell, ch) => {
        if (!enabled.has(ch)) {
          if (cellHasContent(cell)) counts.disabledChannelCells++;
          return;
        }
        if (isAdlibChannel(s3m, ch) && cell.note !== undefined && cell.note < S3M_KEY_OFF) {
          counts.adlibNotes++;
        }
        if (cell.volume !== undefined && cell.volume >= 128 && cell.volume <= 192) {
          counts.volumeColumnPans++;
        }
        if (isUnmappedCommand(cell)) counts.unmappedCommands++;
      });
    }
  }
  return counts;
}

function cellHasContent(cell: S3mPatternCell): boolean {
  return (
    cell.note !== undefined ||
    cell.instrument > 0 ||
    cell.volume !== undefined ||
    cell.effectCommand !== 0 ||
    cell.effectParam !== 0
  );
}

/**
 * The order patterns are *converted* in, which is the order they are *played*
 * in, not the order they are stored in -- the same play-order conversion the
 * MOD importer needs because the channel sample latch is state that survives
 * pattern boundaries (D56; S3M has the identical bare-sample-number latch
 * idiom). Order 254 separators are skipped, 255 terminates (st3play's
 * neworder). Orphan patterns follow, converted from a clean latch.
 */
function conversionOrder(s3m: S3mSong): number[] {
  const patternCount = s3m.patterns.length;
  const seen = new Set<number>();
  const order: number[] = [];
  const orderLength = Math.min(s3m.songLength || s3m.orders.length, s3m.orders.length);
  for (let i = 0; i < orderLength; i++) {
    const index = s3m.orders[i] ?? 255;
    if (index === 255) break;
    if (index === 254) continue;
    if (index < patternCount && !seen.has(index)) {
      seen.add(index);
      order.push(index);
    }
  }
  for (let p = 0; p < patternCount; p++) {
    if (!seen.has(p)) order.push(p);
  }
  return order;
}

export function buildS3mTrackerPatterns(
  s3m: S3mSong,
  pitch: PitchModel,
  slotForInstrument: Map<number, number>,
): TrackerPattern[] {
  const channels = enabledChannels(s3m);
  const patterns: TrackerPattern[] = new Array(s3m.patterns.length);

  // Which instrument each channel has selected, carried across pattern
  // boundaries. S3M has the same bare-instrument-number latch idiom as
  // ProTracker: an instrument byte without a note selects the sample for the
  // channel's next note without switching what is sounding (D56).
  const channelInstruments = new Map<number, number>(channels.map((ch) => [ch, 0]));

  for (const p of conversionOrder(s3m)) {
    const pattern = s3m.patterns[p]!;
    const tracks: TrackerTrackData[] = [];
    const trackForChannel = new Map<number, TrackerTrackData>();
    for (const ch of channels) {
      const track: TrackerTrackData = {
        id: `T${(ch + 1).toString().padStart(2, '0')}`,
        name: `Track ${ch + 1}`,
        entries: [],
        interpolations: [],
      };
      tracks.push(track);
      trackForChannel.set(ch, track);
    }

    for (let row = 0; row < pattern.numRows; row++) {
      const cells = pattern.rows[row] ?? [];
      for (const ch of channels) {
        const cell = cells[ch];
        if (!cell) continue;
        const latched = channelInstruments.get(ch) ?? 0;
        const entry = s3mCellToTrackerEntry(
          s3m,
          cell,
          row,
          ch,
          pitch,
          slotForInstrument,
          latched,
        );
        // An instrument number latches for the channel whether or not an
        // entry results from this cell.
        if (cell.instrument > 0) {
          channelInstruments.set(ch, cell.instrument);
        }
        if (!entry) continue;
        trackForChannel.get(ch)?.entries.push(entry);
      }
    }

    // Assigned by pattern index, not appended: the loop runs in play order,
    // but the caller indexes this array by the order list's pattern numbers.
    patterns[p] = {
      id: crypto.randomUUID(),
      name: `Pattern ${p + 1}`,
      rows: clampPatternRows(pattern.numRows),
      tracks,
    };
  }

  // Holes (patterns never converted) still need objects so indexing by
  // pattern number stays safe.
  for (let p = 0; p < patterns.length; p++) {
    if (!patterns[p]) {
      patterns[p] = {
        id: crypto.randomUUID(),
        name: `Pattern ${p + 1}`,
        rows: 64,
        tracks: channels.map((ch) => ({
          id: `T${(ch + 1).toString().padStart(2, '0')}`,
          name: `Track ${ch + 1}`,
          entries: [],
          interpolations: [],
        })),
      };
    }
  }

  return patterns as TrackerPattern[];
}

/**
 * The frequency a note should sound at, in the engine's musical-Hz domain.
 *
 * Converted through the S3M pitch model's own table (D96: never re-derive
 * periods in the importer). Only the written note is converted here; the
 * sample's c2spd is folded into its patch root note instead.
 */
function frequencyForNote(noteByte: number, pitch: PitchModel): number | undefined {
  const period = s3mPeriodForNote(noteByte);
  if (period === undefined) return undefined;
  return pitch.frequencyFromPeriod(period);
}

/** File note byte -> MIDI (0x00 = C-1 = MIDI 24; 0x39 = A-4 = MIDI 69). */
function s3mNoteToMidi(noteByte: number): number {
  return (noteByte & 0x0f) + 12 * (noteByte >> 4) + 24;
}

function s3mCellToTrackerEntry(
  s3m: S3mSong,
  cell: S3mPatternCell,
  row: number,
  channel: number,
  pitch: PitchModel,
  slotForInstrument: Map<number, number>,
  latchedInstrument: number,
): TrackerEntryData | undefined {
  const hasNoteField = cell.note !== undefined;
  const isKeyOff = hasNoteField && cell.note === S3M_KEY_OFF;
  const hasNote = hasNoteField && cell.note !== S3M_KEY_OFF && cell.note !== S3M_NO_NOTE;
  const hasInstrument = cell.instrument > 0;
  // A volume byte of 0xFF is "no volume" (st3play's clearnotes sentinel);
  // 128..192 is the S3M volume-column panning (OpenMPT: VOLCMD_PANNING),
  // which has no engine home -- counted and dropped rather than guessed.
  const hasVolume =
    cell.volume !== undefined && cell.volume !== S3M_NO_VOLUME && cell.volume < 128;
  const hasEffect =
    (cell.effectCommand !== 0 || cell.effectParam !== 0) &&
    validPatternBreak(cell);

  if (!hasNote && !isKeyOff && !hasInstrument && !hasEffect && !hasVolume) {
    return undefined;
  }

  // Only a row that starts a note switches which instrument this channel is
  // playing -- the same rule the other importers follow (D29/D55/D68/D77/
  // D78). A note without an instrument number resolves through the channel's
  // latch (D56: S3M has the identical bare-sample-number idiom). Tone
  // portamento (G 0x07) and its volume-slide combination (L 0x0C,
  // tonePortaVol) are excluded: they slide the voice that is already
  // sounding rather than starting a new one, so stamping the row's
  // instrument re-addresses the slide to an instrument with nothing playing
  // and it is dropped on the floor.
  const isTonePorta =
    cell.effectCommand === 0x07 || cell.effectCommand === 0x0c;

  const entry: TrackerEntryData = { row };

  // ST3's default panning for the channel (its own defaults, or the extended
  // panning table) rides the second macro column on note rows, exactly as
  // the MOD importer stamps Paula's L/R wiring. AdLib channels stay centred.
  if (hasNote) {
    const panNorm = channelPan(s3m, channel);
    if (panNorm !== undefined) {
      const raw = Math.round(Math.max(0, Math.min(1, panNorm)) * 255);
      entry.macro2 = `M${raw.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }

  if (hasNote && !isTonePorta) {
    const instrumentNumber = hasInstrument ? cell.instrument : latchedInstrument;
    const slot = instrumentNumber > 0 ? slotForInstrument.get(instrumentNumber) : undefined;
    if (slot !== undefined) entry.instrument = formatInstrumentId(slot);
  }

  if (isKeyOff) {
    // S3M's note-off byte (0xFE); the engine releases the track's voice.
    entry.note = '###';
  } else if (hasNote) {
    const noteByte = cell.note!;
    entry.note = midiToTrackerNote(s3mNoteToMidi(noteByte));
    const frequency = frequencyForNote(noteByte, pitch);
    if (frequency !== undefined) entry.frequency = frequency;
  }

  if (hasVolume && cell.volume !== undefined) {
    const volume = cell.volume;
    entry.volume = Math.round((volume / 64) * 255)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  } else if (hasNote && hasInstrument) {
    // A note with an instrument and no explicit volume plays at the sample's
    // default, as in ProTracker (the D53/D54 semantics: the effect processor
    // states currentVolume on triggers).
    //
    // The predicate is the row's own instrument *number*, not `entry.instrument`
    // -- D55's rule ("has an instrument id does not mean named an instrument"),
    // which this had re-derived wrongly in both directions. `entry.instrument`
    // is deliberately absent on a tone-portamento row (D77) and deliberately
    // present on a bare note via the channel latch (D56), so keying off it
    // stamped a volume where ST3 preserves the channel's and withheld one
    // where ST3 resets it.
    //
    // A sample number loads that sample's volume into the channel whether or
    // not anything retriggers; the tone-porta check only decides whether the
    // sample restarts. mod-import states this at length (nexus_seven.mod,
    // where withholding it let the volume slides walk the channel to zero and
    // silence the rest of the pattern) and xm-import already keys off
    // `hasInstrument` too. Fourth time this rule has had to be re-derived.
    const sample = s3m.instruments[cell.instrument - 1];
    if (sample && sample.kind === 'pcm') {
      entry.volume = Math.round((sample.volume / 64) * 255)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0');
    }
  }

  // Raw bytes are the source of truth (D94); the text macro is derived from
  // them for display. S3M bytes decode through S3M_PROFILE's tables.
  if (hasEffect && cell.effectCommand !== 0) {
    entry.effectCommand = cell.effectCommand;
    entry.effectParam = cell.effectParam;
    entry.macro = s3mEffectToMacro(cell.effectCommand, cell.effectParam);
  }

  // AdLib channels' cells are dropped after counting (the warning machinery
  // owns the numbers); their tracks stay so track indexing remains 1:1 with
  // the file's enabled channels.
  if (isAdlibChannel(s3m, channel)) return undefined;

  return entry;
}

/**
 * S3M's Cxx pattern break is BCD, and ST3 ignores it entirely when either
 * nibble is out of range (st3play digcmd.c s_break, quoted in D101:
 * `if (hi <= 9 && lo <= 9)`). Valid BCD is stored RAW: the engine's existing
 * patBreak handler reads `paramX * 10 + paramY` (the decimal-nibble reading
 * MOD's Dxx produces), which is exactly the BCD value. Invalid parameters
 * are dropped here rather than stored as a break the replayer would ignore.
 */
function validPatternBreak(cell: S3mPatternCell): boolean {
  if (cell.effectCommand !== 0x03) return true;
  return (cell.effectParam >> 4) <= 9 && (cell.effectParam & 0x0f) <= 9;
}

/**
 * Map an S3M effect to the tracker's text macro form.
 *
 * S3M stores the command letter minus 0x40 (OpenMPT's S3MConvert switches on
 * `command | 0x40`), so the display macro is the letter plus the parameter.
 * This is presentation only -- decoding goes through the raw bytes and
 * S3M_PROFILE's tables (D94/D96), because the letter dialects collide (S3M's
 * A is speed, ProTracker's A is a volume slide).
 */
function s3mEffectToMacro(effectCommand: number, effectParam: number): string {
  const letter = String.fromCharCode(0x40 + effectCommand);
  const paramHex = effectParam.toString(16).toUpperCase().padStart(2, '0');
  return `${letter}${paramHex}`;
}
