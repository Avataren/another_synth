/**
 * Fills the app's instrument slots from the library's `TrackerSample`s.
 *
 * The importers' instrument half now stops at a `TrackerSample` -- decoded
 * PCM, loop points, root note, envelopes -- and this is where that becomes
 * something the app can play: a sampler `Patch` per instrument, and an
 * `InstrumentSlot` pointing at it.
 *
 * All three formats used to carry their own copy of this loop. They differed
 * only in the bank and category strings, which is why they are parameters
 * here rather than three near-identical functions.
 */
import type { InstrumentSlot } from 'src/stores/tracker-store';
import { TOTAL_SLOTS } from 'src/stores/tracker-store';
import type { Patch } from 'src/audio/types/preset-types';
import type { InstrumentFormat } from 'src/audio/tracker/instrument-types';
import { createSamplerPatch } from 'src/audio/tracker/sampler-patch-builder';
import {
  formatInstrumentId,
  type AhxSong,
  type TrackerSample,
} from '@another-synth/tracker-playback';

export interface SlotBuildOptions {
  /**
   * The format the instruments came from, stamped as `instrumentFormat` on
   * every slot: the lineage that picks the editor and, later, the exporter.
   */
  format: InstrumentFormat;
  /** Bank name for a slot with a playable patch, e.g. 'MOD Import'. */
  bankName: string;
  /** Patch metadata category, e.g. 'Imported/MOD'. */
  category: string;
  /**
   * Bank name for an instrument that occupies a slot but has nothing to play
   * it -- currently only S3M's AdLib instruments. Defaults to `bankName`.
   */
  oplBankName?: string;
}

/** A full-length table of empty slots, addressed by position. */
function createEmptySlotTable(): InstrumentSlot[] {
  return Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
    slot: i + 1,
    bankName: '',
    patchName: '',
    instrumentName: '',
  }));
}

/**
 * One patch and one filled slot per sample, in a full-length slot table.
 *
 * The table is always `TOTAL_SLOTS` long and mostly empty: slots are
 * addressed by position, and the editor expects every one to exist. Each
 * sample lands at its own `slot`, which the importer already allocated.
 */
export function buildSlotsAndPatches(
  samples: readonly TrackerSample[],
  options: SlotBuildOptions,
): { slots: InstrumentSlot[]; songPatches: Record<string, Patch> } {
  const slots = createEmptySlotTable();
  const songPatches: Record<string, Patch> = {};

  for (const sample of samples) {
    const slot = slots[sample.slot - 1];
    if (!slot) continue;

    // Named for the number the *file* used, not the slot it was packed into:
    // "Instrument 07" should mean the composer's instrument 7.
    const fallbackName = `Instrument ${formatInstrumentId(sample.sourceIndex)}`;

    // An OPL instrument takes its slot and carries its register bytes, but
    // gets no patchId -- nothing can play it until the dedicated OPL core
    // exists, and a slot without a patch is exactly how that is expressed.
    if (sample.opl) {
      slot.bankName = options.oplBankName ?? options.bankName;
      slot.patchName = sample.name || fallbackName;
      slot.instrumentName = slot.patchName;
      slot.source = 'song';
      slot.instrumentType = 'opl';
      slot.instrumentFormat = options.format;
      slot.oplData = sample.opl;
      continue;
    }

    const patch = createSamplerPatch(sample, {
      fallbackName,
      category: options.category,
    });

    slot.bankName = options.bankName;
    slot.patchId = patch.metadata.id;
    slot.patchName = patch.metadata.name;
    slot.instrumentName = patch.metadata.name;
    slot.source = 'song';
    slot.instrumentType = 'sampler';
    slot.instrumentFormat = options.format;
    // Unity: a tracker sample's own volume reaches playback through the
    // volume column, so scaling the slot as well would double-apply it.
    slot.volume = 1.0;

    songPatches[patch.metadata.id] = patch;
  }

  return { slots, songPatches };
}

/**
 * One filled slot per AHX instrument, in a full-length slot table.
 *
 * AHX instruments are synthesized by the worklet's own engine from the file,
 * so a slot lists the instrument but carries no `patchId` (a `Patch` is the
 * app's synth preset and an AHX instrument is not one). What it does carry is
 * `ahxData`, the parsed instrument, for the AHX display and the later editor.
 *
 * The file numbers its instruments 1..=N and the row model already refers to
 * them by that number, so instrument N sits in slot N; anything past the
 * slot table has nowhere to go and is left out.
 */
export function buildAhxSlots(song: AhxSong): InstrumentSlot[] {
  const slots = createEmptySlotTable();
  for (let n = 1; n <= song.instrumentNr; n++) {
    const instrument = song.instruments[n];
    const slot = slots[n - 1];
    if (!instrument || !slot) continue;

    slot.bankName = 'AHX Import';
    slot.patchName = instrument.name.trim() || `Instrument ${formatInstrumentId(n)}`;
    slot.instrumentName = slot.patchName;
    slot.source = 'song';
    slot.instrumentType = 'ahx';
    slot.instrumentFormat = 'ahx';
    slot.ahxData = instrument;
  }
  return slots;
}
