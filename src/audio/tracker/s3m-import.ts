import { uid } from 'quasar';
import type {
  TrackerSongFile,
  TrackerPattern,
  InstrumentSlot,
} from 'src/stores/tracker-store';
import {
  TOTAL_SLOTS,
  CURRENT_SONG_FILE_VERSION,
  clampPatternRows,
} from 'src/stores/tracker-store';
import type {
  TrackerTrackData,
  TrackerEntryData,
} from 'src/components/tracker/tracker-types';
import type { Patch } from 'src/audio/types/preset-types';
import {
  SamplerLoopMode,
} from 'src/audio/types/synth-layout';
import { createSamplerPatch } from 'src/audio/tracker/sampler-patch-builder';
import {
  looksLikeS3m as looksLikeS3mInternal,
  parseS3m,
  S3M_KEY_OFF,
  S3M_NO_NOTE,
  S3M_NO_VOLUME,
  type S3mSong,
  type S3mInstrument,
  type S3mPatternCell,
} from '@another-synth/tracker-playback';
import {
  createS3mPitchModel,
  s3mPeriodForNote,
  type PitchModel,
} from '@another-synth/tracker-playback';

export const looksLikeS3m = looksLikeS3mInternal;

const DEFAULT_STEP_SIZE = 1;
/**
 * The sample buffer is declared at this rate regardless of its true rate, and
 * the root note compensates. Matches what the other importers do.
 */
const ASSET_SAMPLE_RATE = 44100;

/**
 * MIDI note at which an S3M sample with c2spd 8363 plays untransposed.
 *
 * The engine schedules notes in musical Hz (the ST3 rate divided by 16 --
 * ST3's reference note C-5 is one octave above XM Amiga's C-4, see
 * pitch-model.ts), and the sampler computes playbackRate =
 * scheduledFrequency / f(rootNote). For the buffer -- declared at
 * ASSET_SAMPLE_RATE -- to play back at the ST3 rate, f(rootNote) must equal
 * ASSET_SAMPLE_RATE / 16, so
 *
 *   rootNote = 69 + 12*log2(ASSET_SAMPLE_RATE / 16 / 440) ~= 100.78
 *
 * (The same derivation with XM's /32 scale gives xm-import's 88.77, which is
 * the cross-check that this is the right relation rather than a fitted
 * number.)
 */
const S3M_ROOT_NOTE =
  69 + 12 * Math.log2(ASSET_SAMPLE_RATE / 16 / 440);

/** c2spd of a sample with no finetune (st3play digdata.h: C2FREQ). */
const S3M_C2FREQ = 8363;

/**
 * S3M's per-channel volume commands (M 0x0D / N 0x0E) have no
 * format-neutral behaviour yet (D96/D97: deliberately unmapped). The importer
 * counts corpus uses of every byte the profile leaves undefined, so the
 * count-then-decide rule (P5 audit) has a number to act on.
 */
const UNMAPPED_COMMAND_BYTES = [0x0d, 0x0e, 0x19, 0x1a];

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

export function importS3mToTrackerSong(buffer: ArrayBuffer): TrackerSongFile {
  const bytes = new Uint8Array(buffer);
  const s3m = parseS3m(bytes);

  const counts = measureS3m(s3m);

  // eslint-disable-next-line no-console
  console.log('[S3M Import]', {
    title: s3m.title,
    tracker: `cwtv ${s3m.trackerVersion.toString(16)}`,
    patterns: s3m.patterns.length,
    instruments: s3m.instruments.length,
    amigaLimits: s3m.amigaLimits,
    fastVolumeSlides: s3m.fastVolumeSlides,
    st2Vibrato: s3m.st2Vibrato,
    amigaSlidesBitSet: s3m.amigaSlidesBitSet,
    counts,
  });

  if (counts.adlibInstruments > 0 || counts.adlibNotes > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `${counts.adlibInstruments} AdLib instruments ignored -- FM not supported yet ` +
        `(${counts.adlibNotes} notes on ${counts.adlibChannels} AdLib channels were not imported). ` +
        'Their OPL register data is preserved on the instrument slots for the future OPL task.',
    );
  }
  if (counts.stereoSamples > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `${counts.stereoSamples} stereo sample(s) not decoded -- no stereo sampler path exists.`,
    );
  }
  if (counts.packedSamples > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `${counts.packedSamples} DP30AD1F-packed 16-bit sample(s) not decoded -- no ` +
        'reference player implements the packing (OpenMPT: "unused"; Schism: "never used"), ' +
        'so decoding would be guesswork.',
    );
  }
  if (counts.unmappedCommands > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `${counts.unmappedCommands} effect cell(s) use command bytes the S3M profile leaves ` +
        `unmapped (${UNMAPPED_COMMAND_BYTES.map((b) => '0x' + b.toString(16)).join('/')} ` +
        '-- M/N/Y/Z, D96/D97); they decode to nothing rather than to a borrowed reading.',
    );
  }

  // The pitch model every effect runs in. The amiga-limits header flag is
  // per-file song data (D1/D24: a file-level flag must not masquerade as a
  // format) and selects the variant profile exactly like XM's Amiga mode.
  const pitch = createS3mPitchModel({ amigaLimits: s3m.amigaLimits });

  const { slots, songPatches, slotForInstrument } =
    buildInstrumentSlotsAndPatches(s3m);

  const patterns = buildTrackerPatterns(s3m, pitch, slotForInstrument);

  // Walk the order table in play order: 255 terminates the song, 254 is a
  // skipped separator (st3play digread.c neworder). The importer -- not the
  // parser -- owns that policy.
  const sequenceIds: string[] = [];
  const orderLength = Math.min(s3m.songLength || s3m.orders.length, s3m.orders.length);
  for (let i = 0; i < orderLength; i++) {
    const order = s3m.orders[i] ?? 255;
    if (order === 255) break; // end marker
    if (order === 254) continue; // pattern separator
    const pattern = patterns[order];
    if (pattern) sequenceIds.push(pattern.id);
  }

  // ST3's own loader defaults (st3play checkheader, quoted in D101):
  // `initspeed == 255` -> 6, `inittempo == 0` -> 125; OpenMPT adds "ST3
  // fails to load an otherwise valid default tempo of 32", so anything
  // below 33 falls back to 125.
  const speed = s3m.initialSpeed === 0 || s3m.initialSpeed === 255 ? 6 : s3m.initialSpeed;
  const tempo = s3m.initialTempo < 33 ? 125 : s3m.initialTempo;

  // Header global volume: OpenMPT clamps to 64 and -- quoting -- "fixes a
  // few tunes, e.g. DARKNESS.S3M by Purple Motion (ST 3.00)": a global
  // volume of 0 on a pre-ST3.20 file is treated as full, because ST3.01
  // exported 255-as-unset that those files read back as 0.
  const globalVolumeRaw = Math.min(s3m.globalVolume, 64);
  const initialGlobalVolume =
    globalVolumeRaw === 0 && s3m.trackerVersion < 0x1320 ? 1 : globalVolumeRaw / 64;

  return {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        title: s3m.title || 'Imported S3M',
        author: 'Unknown',
        bpm: tempo,
      },
      moduleFormat: 's3m',
      initialSpeed: speed,
      linearFrequency: true,
      // Per-file header data that must reach the engine's effect arithmetic
      // (D59 discipline). Serialized additively; no song-file version bump.
      ...(s3m.amigaLimits ? { amigaLimits: true } : {}),
      ...(initialGlobalVolume !== 1 ? { initialGlobalVolume } : {}),
      patternRows: clampPatternRows(patterns[0]?.rows),
      stepSize: DEFAULT_STEP_SIZE,
      patterns,
      sequence: sequenceIds,
      currentPatternId: sequenceIds[0] ?? patterns[0]?.id ?? null,
      instrumentSlots: slots,
      activeInstrumentId: (() => {
        const firstUsed = slots.find((s) => s.patchId);
        return firstUsed ? formatInstrumentId(firstUsed.slot) : null;
      })(),
      currentInstrumentPage: 0,
      songPatches,
    },
  };
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

function measureS3m(s3m: S3mSong): S3mImportCounts {
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

function buildTrackerPatterns(
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
      id: uid(),
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
        id: uid(),
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

/**
 * How many distinct channels ever play each instrument.
 *
 * A tracker channel is monophonic and owns a voice of its own (D32/D42) --
 * sized by peak, a channel without a voice steals notes.
 */
function measureChannelsPerInstrument(
  s3m: S3mSong,
): Map<number, Set<number>> {
  const channels = new Map<number, Set<number>>();

  for (const pattern of s3m.patterns) {
    for (const row of pattern.rows) {
      row.forEach((cell, ch) => {
        if (cell.instrument > 0) {
          let set = channels.get(cell.instrument);
          if (!set) {
            set = new Set<number>();
            channels.set(cell.instrument, set);
          }
          set.add(ch);
        }
      });
    }
  }

  return channels;
}

function buildInstrumentSlotsAndPatches(
  s3m: S3mSong,
): {
  slots: InstrumentSlot[];
  songPatches: Record<string, Patch>;
  slotForInstrument: Map<number, number>;
} {
  // Only instruments actually referenced by pattern data need a slot (the
  // D76 guard: S3M declares up to 99; 130 slots cover them).
  const referenced = new Set<number>();
  for (const pattern of s3m.patterns) {
    for (const row of pattern.rows) {
      for (const cell of row) {
        if (cell.instrument > 0) referenced.add(cell.instrument);
      }
    }
  }

  const slots: InstrumentSlot[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
    slot: i + 1,
    bankName: '',
    patchName: '',
    instrumentName: '',
  }));

  const songPatches: Record<string, Patch> = {};
  const slotForInstrument = new Map<number, number>();
  const channelsPerInstrument = measureChannelsPerInstrument(s3m);

  let nextSlot = 1;
  for (const instrumentNumber of [...referenced].sort((a, b) => a - b)) {
    if (nextSlot > TOTAL_SLOTS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[S3M Import] Out of instrument slots; dropping instrument ${instrumentNumber}`,
      );
      break;
    }
    const instrument = s3m.instruments[instrumentNumber - 1];
    if (!instrument) continue;

    const slot = slots[nextSlot - 1]!;

    // AdLib/OPL instruments: preserve the parsed register data on the slot,
    // marked inactive (no patchId -- nothing can play it). Morten,
    // 2026-09-03: the future OPL instrument type consumes these bytes, so
    // that phase never needs a re-parse.
    if (instrument.kind === 'adlib') {
      slot.bankName = 'S3M Import (FM inactive)';
      slot.patchName = instrument.name || `Instrument ${formatInstrumentId(instrumentNumber)}`;
      slot.instrumentName = slot.patchName;
      slot.source = 'song';
      slot.instrumentType = 'mod';
      slot.oplData = {
        kind: instrument.adlibKind ?? 'melody',
        registers: instrument.oplRegisters ?? [],
        volume: instrument.adlibVolume ?? 0,
        c2spd: instrument.c2spd,
      };
      nextSlot++;
      continue;
    }

    const sample = instrument;
    if (sample.data.length === 0) continue; // stereo / packed / empty: counted, warned

    const patch = createSamplerPatchForS3mSample(
      instrument,
      instrumentNumber,
      channelsPerInstrument.get(instrumentNumber)?.size ?? 1,
    );

    slot.bankName = 'S3M Import';
    slot.patchId = patch.metadata.id;
    slot.patchName = patch.metadata.name;
    slot.instrumentName = patch.metadata.name;
    slot.source = 'song';
    slot.instrumentType = 'mod';
    slot.volume = 1.0;

    songPatches[patch.metadata.id] = patch;
    // Only PCM instruments map into the playable slot space.
    slotForInstrument.set(instrumentNumber, nextSlot);
    nextSlot++;
  }

  return { slots, songPatches, slotForInstrument };
}

/**
 * The root note folds the sample's c2spd in (it is per-sample finetune in
 * S3M, D96): a sample whose c2spd differs from 8363 must play proportionally
 * faster/slower, so rootNote = S3M_ROOT_NOTE - 12*log2(c2spd/8363).
 */
function rootNoteForSample(sample: S3mInstrument): number {
  const c2spd = sample.c2spd > 0 ? sample.c2spd : S3M_C2FREQ;
  return S3M_ROOT_NOTE - 12 * Math.log2(c2spd / S3M_C2FREQ);
}

function createSamplerPatchForS3mSample(
  sample: S3mInstrument,
  instrumentNumber: number,
  channelCount: number,
): Patch {
  const sampleLengthFrames = Math.max(1, sample.data.length);
  const loopEnabled = sample.loopEnabled && sample.loopEnd > sample.loopStart;

  return createSamplerPatch({
    name: sample.name,
    fallbackName: `Instrument ${formatInstrumentId(instrumentNumber)}`,
    category: 'Imported/S3M',
    data: sample.data,
    sampleRate: ASSET_SAMPLE_RATE,
    rootNote: rootNoteForSample(sample),
    detuneCents: 0,
    // Unity -- the sample's default volume reaches playback through the
    // volume stamped on every note carrying an instrument, exactly as in the
    // XM/MOD importers.
    gain: 1,
    // S3M has no ping-pong loop; SamplerLoopMode.Loop only.
    loopMode: loopEnabled ? SamplerLoopMode.Loop : SamplerLoopMode.Off,
    loopStartFrames: loopEnabled ? sample.loopStart : 0,
    loopLengthFrames: loopEnabled
      ? sample.loopEnd - sample.loopStart
      : sampleLengthFrames,
    // One voice per channel that ever plays this instrument, so every
    // channel owns one and none has to steal.
    voiceCount: Math.max(1, Math.min(32, channelCount)),
  });
}

function formatInstrumentId(slotNumber: number): string {
  return slotNumber.toString().padStart(2, '0');
}

function midiToTrackerNote(midi: number): string {
  const names = [
    'C-', 'C#', 'D-', 'D#', 'E-', 'F-',
    'F#', 'G-', 'G#', 'A-', 'A#', 'B-',
  ];
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const name = names[clamped % 12] ?? 'C-';
  const octave = Math.floor(clamped / 12) - 1;
  return `${name}${octave}`;
}
