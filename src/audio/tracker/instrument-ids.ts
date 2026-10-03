import type { InstrumentSlot } from 'src/stores/tracker-store';
import { formatInstrumentId } from '@another-synth/tracker-playback';
import { normalizeInstrumentFormat } from 'src/audio/tracker/instrument-types';

/**
 * `formatInstrumentId` and `normalizeInstrumentId` moved into
 * `@another-synth/tracker-playback`: the importers there produce these ids and
 * the engine consumes them, so the convention belongs with them. Only
 * `pickActiveInstrumentId` stays, because it reads `InstrumentSlot` -- an
 * editor concept, tied to the app's patches.
 */
export { formatInstrumentId, normalizeInstrumentId } from '@another-synth/tracker-playback';

/** Whether a slot holds an instrument a note can use (a patch, an AHX instrument or a SID one). */
export function isInstrumentSlotFilled(slot: InstrumentSlot): boolean {
  return (
    Boolean(slot.patchId) ||
    slot.ahxData !== undefined ||
    normalizeInstrumentFormat(slot.instrumentFormat) === 'sid'
  );
}

/**
 * The instrument that should be selected: the current one while it still has
 * a patch, otherwise the first slot that has one, otherwise nothing. An AHX
 * slot has an instrument instead of a patch (`ahxData`), and counts the same:
 * an editable AHX song writes notes with the instrument selected here. So does
 * a SID slot (tagged only for an instrument the song's doc holds).
 */
export function pickActiveInstrumentId(
  slots: readonly InstrumentSlot[],
  current: string | null,
): string | null {
  const isFilled = isInstrumentSlotFilled;
  if (current) {
    const stillThere = slots.some((slot) => isFilled(slot) && formatInstrumentId(slot.slot) === current);
    if (stillThere) return current;
  }
  const firstFilled = slots.find(isFilled);
  return firstFilled ? formatInstrumentId(firstFilled.slot) : null;
}
