import { uid } from 'quasar';
import type {
  TrackerSongFile,
  TrackerPattern,
  InstrumentSlot,
} from 'src/stores/tracker-store';
import { TOTAL_SLOTS, CURRENT_SONG_FILE_VERSION } from 'src/stores/tracker-store';
import type {
  TrackerTrackData,
  TrackerEntryData,
} from 'src/components/tracker/tracker-types';
import type { Patch } from 'src/audio/types/preset-types';
import { SamplerLoopMode } from 'src/audio/types/synth-layout';
import {
  createSamplerPatch,
} from 'src/audio/tracker/sampler-patch-builder';
import {
  looksLikeMod as looksLikeModInternal,
  parseMod,
  type ModSong,
  type ModPatternCell,
  type ModSample,
} from '@another-synth/tracker-playback';
import { usesVBlankTiming } from '@another-synth/tracker-playback';

const PATTERN_ROWS = 64;
const DEFAULT_BPM = 125;
const DEFAULT_STEP_SIZE = 1;
const DEFAULT_SAMPLE_RATE = 44100;

export const looksLikeMod = looksLikeModInternal;

export function importModToTrackerSong(buffer: ArrayBuffer): TrackerSongFile {
  const bytes = new Uint8Array(buffer);
  const mod: ModSong = parseMod(bytes);

  // Log basic MOD metadata on import to help debug tracker-specific behavior.
  // eslint-disable-next-line no-console
  console.log('[MOD Import]', {
    title: mod.title,
    signature: mod.signature,
    trackerFlavor: mod.trackerFlavor,
    numChannels: mod.numChannels,
    numSamples: mod.samples.length,
  });

  // Whether every Fxx on this module sets the speed rather than the tempo.
  // See `usesVBlankTiming`; carried on the song because the distinction is
  // per module, not per format, and cannot be recovered from the cells later.
  const vblankTiming = usesVBlankTiming(mod);
  if (vblankTiming) {
    // eslint-disable-next-line no-console
    console.log('[MOD Import] VBlank timing detected: Fxx sets speed, not tempo');
  }

  const patterns = buildTrackerPatterns(mod);
  // Build song sequence from the MOD order table so repeated
  // patterns (e.g. first pattern listed twice) are preserved.
  const sequenceIds: string[] = [];
  const orderLength = mod.songLength || mod.orders.length;
  for (let i = 0; i < orderLength; i++) {
    const patIndex = mod.orders[i] ?? 0;
    const pattern = patterns[patIndex];
    if (pattern) {
      sequenceIds.push(pattern.id);
    }
  }

  const { slots, songPatches } = buildInstrumentSlotsAndPatches(mod);

  const songFile: TrackerSongFile = {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        title: mod.title || 'Imported MOD',
        author: 'Unknown',
        bpm: DEFAULT_BPM,
      },
      moduleFormat: 'protracker',
      ...(vblankTiming ? { vblankTiming: true } : {}),
      patternRows: PATTERN_ROWS,
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

  return songFile;
}

/**
 * The order patterns are *converted* in, which is the order they are *played*
 * in, not the order they are stored in.
 *
 * The channel's latched sample number has to survive a pattern boundary --
 * ProTracker keeps it as channel state -- so conversion has to follow the
 * order list to know what each pattern inherits. Patterns the order list never
 * reaches are converted afterwards, from a clean latch, so an unused or
 * orphaned pattern still imports.
 *
 * A pattern played at more than one order position inherits whatever the
 * *first* of those positions had, since one pattern converts to one object
 * that every position shares. Resolving that properly means latching at
 * playback time rather than at import; see the note on `channelSamples`.
 */
function conversionOrder(mod: ModSong): number[] {
  const patternCount = mod.patterns.length;
  const seen = new Set<number>();
  const order: number[] = [];
  const orderLength = mod.songLength || mod.orders.length;
  for (let i = 0; i < orderLength; i++) {
    const index = mod.orders[i] ?? 0;
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

function buildTrackerPatterns(mod: ModSong): TrackerPattern[] {
  const trackCount = Math.max(1, mod.numChannels);

  const patterns: TrackerPattern[] = [];

  // Which sample each channel has selected, carried across pattern boundaries.
  //
  // A bare sample number latches the sample for the channel's *next* note
  // without switching what is currently sounding (see the note on
  // `selectedSample`), and in ProTracker that latch is channel state that
  // outlives the pattern. This used to be re-created per pattern, so a note
  // written without a sample number in the first rows of a pattern resolved to
  // no instrument at all. GSLINGER.MOD is the case: channel 1 latches sample
  // 24 at row 32 of pattern 24 (displayed numbering) and plays `D-2 ... C10`
  // at row 0 of pattern 25 with no sample number. That row imported with no
  // instrument, so it was silent when the pattern was played on its own, and
  // fell back to whatever the engine had last seen -- sample 4, the wrong
  // guitar -- when reached from the previous pattern.
  const channelSamples: number[] = new Array(trackCount).fill(0);

  for (const p of conversionOrder(mod)) {
    const patternId = uid();

    const tracks: TrackerTrackData[] = [];
    for (let ch = 0; ch < trackCount; ch++) {
      tracks.push({
        id: `T${(ch + 1).toString().padStart(2, '0')}`,
        name: `Track ${ch + 1}`,
        entries: [],
        interpolations: [],
      });
    }

    for (let row = 0; row < PATTERN_ROWS; row++) {
      for (let ch = 0; ch < trackCount; ch++) {
        const cell: ModPatternCell | undefined =
          mod.patterns[p]?.rows[row]?.[ch];
        if (!cell) continue;

        const panNorm = resolveChannelPanNorm(ch, trackCount);
        const entry = modCellToTrackerEntry(
          cell,
          row,
          panNorm,
          mod,
          channelSamples[ch] ?? 0,
        );
        // A sample number latches for the channel whether or not an entry
        // results from this cell.
        if (cell.sampleNumber > 0) {
          channelSamples[ch] = cell.sampleNumber;
        }
        if (!entry) continue;

        const track = tracks[ch];
        if (!track) continue;
        track.entries.push(entry);
      }
    }

    // Assigned by pattern index, not appended: the loop runs in play order,
    // but the caller indexes this array by the order list's pattern numbers.
    patterns[p] = {
      id: patternId,
      name: `Pattern ${p + 1}`,
      // ProTracker patterns are always 64 rows; XM will vary this per pattern.
      rows: PATTERN_ROWS,
      tracks,
    };
  }

  return patterns;
}

function resolveChannelPanNorm(channelIndex: number, trackCount: number): number {
  // Map MOD channels to stereo positions using fixed macro values:
  // Left  ~ M040 (64/255), center ~ M080 (128/255), right ~ M0BF (191/255).
  // These feed macro 0 (0..1) which the mixer interprets as 0 = left, 0.5 = center, 1 = right.
  const leftNorm = 0x40 / 0xff;   // ≈ 0.25
  const centerNorm = 0.5;         // 0x80 / 0xFF ≈ 0.5
  const rightNorm = 0xbf / 0xff;  // ≈ 0.75

  if (trackCount <= 1) {
    return centerNorm;
  }

  if (trackCount === 2) {
    // Two channels: left / right
    return channelIndex === 0 ? leftNorm : rightNorm;
  }

  if (trackCount === 3) {
    // Three channels: left / center / right
    if (channelIndex === 0) return leftNorm;
    if (channelIndex === 1) return centerNorm;
    return rightNorm;
  }

  if (trackCount === 4) {
    // Classic Amiga: Paula's four hardware voices are wired 2 left, 2 right,
    // so channels 0 and 3 go left and 1 and 2 go right.
    const isLeft = channelIndex === 0 || channelIndex === 3;
    return isLeft ? leftNorm : rightNorm;
  }

  // More than four channels means a PC-tracker extension (6CHN, 8CHN, xxCH),
  // which has no Paula wiring to reproduce: those modules are written against
  // centred channels and place anything they care about with 8xx.
  //
  // Repeating the L-R-R-L grouping here -- as this used to, on an assumption
  // never checked against a real module -- hard-pans alternating channels. On
  // DOPE.MOD, a 28-channel module carrying just 54 panning commands in total,
  // that splits the mix into two hard-panned halves the composer never heard.
  return centerNorm;
}

/**
 * Ultimate Soundtracker's command numbering, translated to ProTracker's.
 *
 * UST puts arpeggio on 1; ProTracker moved it to 0 and gave 1 to portamento
 * up. Read as ProTracker, every arpeggio in a UST module becomes a fast
 * upward slide -- lepeltheme.mod carries `137` (a minor triad) on all 64 rows
 * of a channel, which as portamento runs the pitch off the top instead of
 * playing the chord.
 *
 * Command 0 carries no effect in UST, so a stray parameter on it is dropped
 * rather than read as an arpeggio that was never written.
 *
 * Command 2 is a pitch bend with the direction chosen by which nibble is set.
 * Which nibble means which way is the one part of this not established from
 * the corpus -- it appears five times in one module, always with a single
 * nibble set. Either reading beats leaving it as ProTracker portamento down,
 * where a parameter like 0x80 is a slide rate of 128 units per tick.
 */
function ultimateSoundtrackerEffect(
  effectCmd: number,
  effectParam: number,
): { effectCmd: number; effectParam: number } {
  switch (effectCmd) {
    case 0x0:
      return { effectCmd: 0, effectParam: 0 };
    case 0x1:
      return { effectCmd: 0x0, effectParam };
    case 0x2: {
      const down = effectParam >> 4;
      const up = effectParam & 0x0f;
      if (down) return { effectCmd: 0x2, effectParam: down };
      if (up) return { effectCmd: 0x1, effectParam: up };
      return { effectCmd: 0, effectParam: 0 };
    }
    default:
      return { effectCmd, effectParam };
  }
}

function modCellToTrackerEntry(
  cell: ModPatternCell,
  row: number,
  panNorm: number,
  mod: ModSong,
  selectedSample: number,
): TrackerEntryData | undefined {
  const { period, sampleNumber } = cell;
  const { effectCmd, effectParam } =
    mod.trackerFlavor === 'UltimateSoundtracker'
      ? ultimateSoundtrackerEffect(cell.effectCmd, cell.effectParam)
      : cell;
  const effectType = effectCmd & 0x0f;
  const isTonePorta = effectType === 0x3;      // 3xx
  const isTonePortaVol = effectType === 0x5;   // 5xy
  const hasEffect = effectCmd !== 0 || effectParam !== 0;
  // Raw format-native effect bytes, stored on the entry alongside the text
  // macro derived from them below (D94): the bytes are what the module said,
  // the text is how this tracker displays it.

  const hasNote = period > 0;
  const hasSample = sampleNumber > 0;

  if (!hasNote && !hasSample && !hasEffect) {
    return undefined;
  }

  const entry: TrackerEntryData = { row };

  // Only a row that actually starts a note switches which instrument this
  // channel is playing.
  //
  // In ProTracker a sample number alone does not change the sounding sample;
  // it selects the sample for the channel's *next* note and reloads the
  // channel volume. Here one MOD sample is one instrument, so stamping
  // entry.instrument on such a row re-routes every per-voice effect on it --
  // arpeggio pitch, volume, slides -- to an instrument that has nothing
  // playing, and the sounding voice receives none of them.
  //
  // think_twice_iii.mod is the case that exposed it: a C64-style channel
  // holds one note and steps the sample number through 11..18, whose header
  // volumes descend 64..13 to form a hand-made decay envelope, with an
  // arpeggio (05A) repeated on every row. Stamping those rows sent both the
  // envelope and the arpeggio to silent instruments, so the arpeggio was
  // audible for exactly one row and the envelope never applied at all.
  //
  // Tone portamento (3xx/5xy) is excluded for the same underlying reason: it
  // does not retrigger, so the slide must keep addressing the voice that is
  // already sounding.
  //
  // `selectedSample` carries the channel's latched sample number so a note
  // written without one still resolves to the right instrument.
  if (hasNote && !isTonePorta && !isTonePortaVol) {
    const instrumentNumber = hasSample ? sampleNumber : selectedSample;
    if (instrumentNumber > 0) {
      entry.instrument = formatInstrumentId(instrumentNumber);
    }
  }

  if (hasNote) {
    const midi = periodToMidi(period);
    if (midi !== undefined) {
      entry.note = midiToTrackerNote(midi);
    }
    // Store exact ProTracker frequency for accurate playback
    const freq = periodToFrequency(period);
    if (freq !== undefined) {
      entry.frequency = freq;
    }
  }

  let effectMacro: string | undefined;
  if (hasEffect) {
    const paramHex = effectParam.toString(16).toUpperCase().padStart(2, '0');
    let prefix: string | undefined;

    switch (effectCmd & 0x0f) {
      case 0x0:
        // 0xy: Arpeggio (xy != 00)
        if (effectParam !== 0) {
          prefix = '0';
        }
        break;
      case 0x1:
        // 1xx: Portamento up
        prefix = '1';
        break;
      case 0x2:
        // 2xx: Portamento down
        prefix = '2';
        break;
      case 0x3:
        // 3xx: Tone portamento
        prefix = '3';
        break;
      case 0x4:
        // 4xy: Vibrato
        prefix = '4';
        break;
      case 0x5:
        // 5xy: Tone portamento + volume slide
        prefix = '5';
        break;
      case 0x6:
        // 6xy: Vibrato + volume slide
        prefix = '6';
        break;
      case 0x7:
        // 7xy: Tremolo
        prefix = '7';
        break;
      case 0x8:
        // 8xx: Set panning
        prefix = '8';
        break;
      case 0x9:
        // 9xx: Sample offset
        prefix = '9';
        break;
      case 0xa:
        // Axy: Volume slide
        prefix = 'A';
        break;
      case 0xb:
        // Bxx: Position jump
        prefix = 'B';
        break;
      case 0xc:
        // Cxx: Set volume
        prefix = 'C';
        break;
      case 0xd:
        // Dxx: Pattern break
        prefix = 'D';
        break;
      case 0xe:
        // Exy: Extended effects
        prefix = 'E';
        break;
      case 0xf:
        // Fxx: Speed/tempo
        prefix = 'F';
        break;
      default:
        prefix = undefined;
        break;
    }

    if (prefix) {
      effectMacro = `${prefix}${paramHex}`;
    }
  }

  // 9xx sample offset is passed through unchanged.
  //
  // It used to be re-encoded here against the sample's byte length, because
  // the effect processor treated the parameter as a 0-1 fraction of the
  // sample (raw/255) rather than ProTracker's absolute "param * 256 frames".
  // That correction could only fire on rows naming an instrument -- 13 of
  // peacedroid.mod's 205 9xx rows do not, and those fell back to the raw
  // (wrong by a factor of four or more) fraction -- it quantised the position
  // back down to 8 bits, and being an import-time fixup it did nothing for
  // XM. The processor now carries the offset in frames, so the parameter
  // needs no adjustment and every row gets the right position.

  // Convert Cxx volume effects to the volume column (instead of macro column).
  // This ensures notes trigger with the correct velocity, avoiding the note-on
  // gain (velocity/127) conflicting with the Cxx effect gain.
  const hasVolumeEffectCmd = (effectCmd & 0x0f) === 0xc;
  if (hasVolumeEffectCmd && effectMacro) {
    // Extract the Cxx parameter (00-40 hex) and convert to volume column format (00-FF hex)
    // ProTracker: C00-C40 (0-64) → Volume column: 00-FF (0-255)
    // NOTE: Cxx sets ABSOLUTE volume in ProTracker's 0-64 range, not relative to sample's default volume.
    // This allows EA/EB effects to boost above the sample's header volume.
    const volumeParam = effectParam; // 0-64
    const targetGain = Math.max(0, Math.min(1, volumeParam / 64));
    const volumeScaled = Math.round(targetGain * 255);
    const volumeHex = volumeScaled.toString(16).toUpperCase().padStart(2, '0');
    entry.volume = volumeHex;
    // Clear the effect macro since we moved it to volume column
    effectMacro = undefined;
  }

  if (!entry.volume) {
    // Set the default volume from the sample header when a note with an instrument is played.
    // ProTracker samples have a default volume (0-64) that should be used unless a Cxx command overrides it.
    // This intentionally applies even when the same row also carries a volume-slide effect
    // (Axy/EAx/EBx): a genuine new note+instrument trigger always resets to that instrument's
    // default volume in real ProTracker, and the slide then proceeds from that fresh baseline --
    // NOT from whatever the channel's volume had decayed to on the *previous* note. Without this,
    // a note like "D#2 <newSample> A0A" inherits the prior note's already-slid-down volume, gets
    // immediately pushed to (near-)zero by the volSlide tick-0 handling, and never recovers until
    // an explicit Cxx/volume-column value appears -- audibly, the note "dies" right after it
    // triggers.
    //
    // It applies to tone-portamento rows (3xx/5xy) too. Those were excluded on
    // the grounds that a tone portamento does not retrigger the sample, so
    // resetting the volume "would be wrong" -- but that conflates two things
    // ProTracker keeps separate. A *sample number* loads the sample's volume
    // into the channel whether or not anything retriggers; that is the same
    // rule a bare sample number follows (see below). The tone-porta check only
    // decides whether the sample restarts and how the period is used.
    //
    // nexus_seven.mod pattern 6 is what this cost: channel 1 alternates
    // "C-3 12 3F0" against "A06" volume-slide rows, the classic pumped
    // portamento bassline. Each sample number is meant to reload volume 58 and
    // each A06 to walk it back down. Without the reload the slides only ever
    // subtract: the channel reached zero by row 3 and every one of the
    // pattern's remaining notes was silent, since a tone portamento never
    // retriggers and so never brings a volume of its own.
    //
    // The same reset happens for a sample number with NO note. In ProTracker
    // a bare sample number does not retrigger anything, but it *does* reload
    // that sample's default volume into the channel. Composers lean on this:
    // alternating "sample number only" rows against volume-slide rows is the
    // standard hand-rolled tremolo/pump, since PT has one effect column and
    // Axy alone can only travel in one direction. musiklinjen.mod pattern 4
    // channel 2 is exactly this -- rows of "smp=13 A06" and bare "smp=13"
    // pumping a string. Dropping the reset left the slide free to walk the
    // volume down with nothing to restore it, so the part faded out and
    // stayed "mostly quiet" for the rest of the pattern.
    //
    // Setting the volume here also stops these rows being mistaken for the
    // engine's "naked instrument number revives the last note" convention
    // (shouldRetriggerLastNote bails once velocity is present), which is
    // right: ProTracker does not retrigger on a bare sample number either.
    if (
      hasSample &&
      mod.trackerFlavor !== 'Soundtracker' &&
      mod.trackerFlavor !== 'Unknown'
    ) {
      const sampleVol =
        sampleNumber > 0 && sampleNumber <= mod.samples.length
          ? mod.samples[sampleNumber - 1]?.volume ?? 64
          : 64;
      // Convert ProTracker volume (0-64) to internal volume column format (0-255)
      // Use sample header as max volume reference
      const volumeScaled = Math.round((sampleVol / 64) * 255);
      const volumeHex = volumeScaled.toString(16).toUpperCase().padStart(2, '0');
      entry.volume = volumeHex;
    }

    // A note with no sample number deliberately gets *no* volume.
    //
    // ProTracker leaves the channel volume alone there, and the channel volume
    // is playback state: it is whatever Cxx, the sample defaults and any
    // running Axy/EAx/EBx slide have left it at. The effect processor tracks
    // exactly that in `currentVolume`, and now emits it on every note trigger.
    //
    // This used to stamp the importer's own running channel volume here, a
    // snapshot of the last volume *written into a cell* that knows nothing
    // about slides. GSLINGER.MOD pattern 36 is the case that exposes the
    // difference: channel 4 plays the flute with `D-3 23 A50`, swelling from
    // the sample's default 8 up to 33 across the row, and the next row's bare
    // `C#3 ... ED3` was stamped back down to 8 -- the swell the passage is
    // built on, discarded every time. Guarding the stamp against rows that
    // themselves carry a slide (as it did) does not help, because the slide
    // that matters ran on an *earlier* row.
    //
    // If no note at all, no volume either; only Cxx without a note sets one.
  }

  // Always add a macro command that drives macro 0 for stereo pan, using the
  // resolved channel pan. This lives in the second effect column so the first
  // column can carry the original MOD effect.
  let panMacro: string | undefined;
  if (hasNote) {
    const clamped = Math.max(0, Math.min(1, panNorm));
    const raw = Math.round(clamped * 255);
    const hex = raw.toString(16).toUpperCase().padStart(2, '0');
    // Use 3-char macro shorthand (Mxx) for macro 0 so it fits the tracker column.
    panMacro = `M${hex}`;
  }

  if (effectMacro) {
    entry.macro = effectMacro;
    entry.effectCommand = effectType;
    entry.effectParam = effectParam;
  }
  if (panMacro) {
    entry.macro2 = panMacro;
  }

  return entry;
}

/**
 * How many distinct channels ever play each sample.
 *
 * One sample is one instrument here, so every channel playing it shares that
 * instrument's voice pool, and a tracker channel needs a voice of its own -- a
 * smaller pool makes new notes steal voices from channels that are still
 * sounding, heard as notes going missing.
 *
 * This matters far beyond the classic four channels: DOPE.MOD is a 28-channel
 * module whose busiest sample appears on 19 of them, against the fixed four
 * voices every MOD instrument used to get.
 */
function measureChannelsPerSample(mod: ModSong): Map<number, Set<number>> {
  const channels = new Map<number, Set<number>>();
  for (const pattern of mod.patterns) {
    for (const row of pattern.rows) {
      row.forEach((cell, channel) => {
        if (cell.sampleNumber > 0) {
          let set = channels.get(cell.sampleNumber);
          if (!set) {
            set = new Set<number>();
            channels.set(cell.sampleNumber, set);
          }
          set.add(channel);
        }
      });
    }
  }
  return channels;
}

function buildInstrumentSlotsAndPatches(mod: ModSong): {
  slots: InstrumentSlot[];
  songPatches: Record<string, Patch>;
} {
  const channelsPerSample = measureChannelsPerSample(mod);
  const usedSamples = new Set<number>();
  for (const pattern of mod.patterns) {
    for (const row of pattern.rows) {
      for (const cell of row) {
        if (cell.sampleNumber > 0) {
          usedSamples.add(cell.sampleNumber);
        }
      }
    }
  }

  const slots: InstrumentSlot[] = [];
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    slots.push({
      slot: i + 1,
      bankName: '',
      patchName: '',
      instrumentName: '',
    });
  }

  const songPatches: Record<string, Patch> = {};

  const sortedSamples = Array.from(usedSamples).sort((a, b) => a - b);

  for (const sampleNumber of sortedSamples) {
    if (sampleNumber < 1 || sampleNumber > mod.samples.length) continue;
    if (sampleNumber > TOTAL_SLOTS) {
      // Extra samples beyond available slots are ignored for now.
      // They will show up with instrument IDs that have no patch.
      continue;
    }

    const sampleMeta = mod.samples[sampleNumber - 1];
    if (!sampleMeta) continue;
    const patch = createSamplerPatchForSample(
      sampleMeta,
      sampleNumber,
      mod,
      channelsPerSample.get(sampleNumber)?.size ?? 1,
    );
    const slotIndex = sampleNumber - 1;
    const slot = slots[slotIndex];
    if (!slot) continue;

    slot.bankName = 'MOD Import';
    slot.patchId = patch.metadata.id;
    slot.patchName = patch.metadata.name;
    slot.instrumentName = patch.metadata.name;
    slot.source = 'song';
    slot.instrumentType = 'mod';
    console.log('[MOD Import] Setting slot instrumentType=mod for:', patch.metadata.name, 'slot:', slot.slot);
    // MOD sample volumes are handled via Cxx commands on notes, not sampler gain,
    // so slot volume remains at unity to avoid double-scaling.
    slot.volume = 1.0;

    songPatches[patch.metadata.id] = patch;
  }

  return { slots, songPatches };
}

function createSamplerPatchForSample(
  sample: ModSample,
  sampleIndex: number,
  _mod: ModSong,
  channelCount: number,
): Patch {
  const sampleLengthFrames = Math.max(1, sample.length);
  // ProTracker marks "no loop" with a loop length of 2 words or less.
  const loopEnabled = sample.loopLength > 2;

  const patch = createSamplerPatch({
    name: sample.name,
    fallbackName: `Instrument ${formatInstrumentId(sampleIndex)}`,
    category: 'Imported/MOD',
    data: convertSampleToFloat32(sample),
    sampleRate: DEFAULT_SAMPLE_RATE,
    // Empirically calibrated root note for MOD import. A fixed root of 65
    // keeps most instruments (including AmegAs) close to their original
    // ProTracker pitch; per-sample finetune is baked into detune instead.
    rootNote: 65,
    // MOD finetune is -8..7 in 1/8 semitone steps.
    detuneCents: ((sample.finetune ?? 0) / 8) * 100,
    // Unity. The sample's default volume (0-64) is a *channel* volume in
    // ProTracker, not a property of the sample, and it already reaches
    // playback through the volume column -- every note with a sample number is
    // stamped with it above. Baking it in here as well made the instrument
    // permanently quiet everywhere the volume column is not in charge, most
    // visibly when auditioning it from the keyboard: sample 23 of
    // GSLINGER.MOD has a header volume of 8, so it played at an eighth of the
    // level of any sample whose header says 64, with no way to turn it up.
    gain: 1,
    loopMode: loopEnabled ? SamplerLoopMode.Loop : SamplerLoopMode.Off,
    loopStartFrames: loopEnabled ? sample.loopStart : 0,
    loopLengthFrames: loopEnabled ? sample.loopLength : sampleLengthFrames,
    // One voice per channel that ever plays this sample, so every channel owns
    // one and none has to steal. Four is right for a classic 4-channel module
    // and badly short for the multi-channel ones.
    voiceCount: Math.max(4, Math.min(32, channelCount)),
  });

  console.log(
    '[MOD Import] Creating patch with instrumentType=mod:',
    patch.metadata.name,
  );
  return patch;
}
export function convertSampleToFloat32(sample: ModSample): Float32Array {
  const data = sample.data;
  const floats = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    // 8-bit signed -> -1..1
    floats[i] = (data[i] ?? 0) / 128;
  }
  return floats;
}

function formatInstrumentId(slotNumber: number): string {
  return slotNumber.toString().padStart(2, '0');
}

/**
 * Convert Amiga period to a synth frequency in Hz.
 *
 * ProTracker's Paula playback frequency is:
 *   f_paula = AMIGA_CLOCK / (2 * period)
 *
 * Those values are ~128× higher than the equal‑tempered note frequencies
 * our synth expects (e.g. period 856 → ~4181 Hz, but C-1 in our tuning is
 * ~32.7 Hz). To stay in the engine's \"musical Hz\" domain and avoid driving
 * the sampler at 128× speed, we scale the Paula frequency down by 2^7.
 */
function periodToFrequency(period: number): number | undefined {
  if (!period || !Number.isFinite(period)) return undefined;
  const AMIGA_CLOCK = 7159090.5;
  const PAULA_TO_SYNTH_SCALE = 128; // 2^7 – matches the -84 semitone offset used previously
  const freq = AMIGA_CLOCK / (2 * period * PAULA_TO_SYNTH_SCALE);
  if (!Number.isFinite(freq) || freq <= 0) return undefined;
  return freq;
}

/**
 * Convert Amiga period to MIDI note number (for note display only).
 * Uses the scaled synth frequency so C-1..B-3 land at the expected MIDI
 * positions (C-1 = 24, C-2 = 36, etc.).
 */
function periodToMidi(period: number): number | undefined {
  const freq = periodToFrequency(period);
  if (!freq) return undefined;

  const rawMidi = 69 + 12 * Math.log2(freq / 440);
  const rounded = Math.round(rawMidi);
  if (rounded < 0 || rounded > 127) return undefined;
  return rounded;
}

function midiToTrackerNote(midi: number): string {
  const names = [
    'C-',
    'C#',
    'D-',
    'D#',
    'E-',
    'F-',
    'F#',
    'G-',
    'G#',
    'A-',
    'A#',
    'B-',
  ];
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const name = names[clamped % 12] ?? 'C-';
  const octave = Math.floor(clamped / 12) - 1;
  return `${name}${octave}`;
}
