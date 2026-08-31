import type { InstrumentSlot } from 'src/stores/tracker-store';

/**
 * Instrument identity, in one place.
 *
 * A tracker instrument is addressed by its slot number, but everything that
 * carries one around -- pattern entries, the song bank, the playback engine --
 * uses the zero-padded string form. Keeping the conversion here means the
 * tracker page, the jukebox and the editing composable cannot drift on what
 * "instrument 7" is called.
 */
export function formatInstrumentId(slotNumber: number): string {
  return slotNumber.toString().padStart(2, '0');
}

/**
 * Bring an instrument reference into the canonical form.
 *
 * Pattern data may carry `7`, `07` or a name; only the numeric forms are the
 * same instrument and have to agree on their padding.
 */
export function normalizeInstrumentId(
  instrumentId?: string,
): string | undefined {
  if (!instrumentId) return undefined;
  const numeric = Number(instrumentId);
  if (Number.isFinite(numeric)) return formatInstrumentId(numeric);
  return instrumentId;
}

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
