import type { InstrumentSlot } from 'src/stores/tracker-store';
import { formatInstrumentId } from '@another-synth/tracker-playback';

/**
 * `formatInstrumentId` and `normalizeInstrumentId` moved into
 * `@another-synth/tracker-playback`: the importers there produce these ids and
 * the engine consumes them, so the convention belongs with them. Only
 * `pickActiveInstrumentId` stays, because it reads `InstrumentSlot` -- an
 * editor concept, tied to the app's patches.
 */
export { formatInstrumentId, normalizeInstrumentId } from '@another-synth/tracker-playback';

/**
 * The instrument that should be selected: the current one while it still has
 * a patch, otherwise the first slot that has one, otherwise nothing.
 */
export function pickActiveInstrumentId(
  slots: readonly InstrumentSlot[],
  current: string | null,
): string | null {
  if (current) {
    const stillThere = slots.some(
      (slot) => slot.patchId && formatInstrumentId(slot.slot) === current,
    );
    if (stillThere) return current;
  }
  const firstWithPatch = slots.find((slot) => slot.patchId);
  return firstWithPatch ? formatInstrumentId(firstWithPatch.slot) : null;
}
