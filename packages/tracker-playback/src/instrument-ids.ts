/**
 * Instrument identity, in one place.
 *
 * A tracker instrument is addressed by its slot number, but everything that
 * carries one around -- pattern entries, the song bank, the playback engine --
 * uses the zero-padded string form. Keeping the conversion here means the
 * importers, the tracker page, the jukebox and the editing composable cannot
 * drift on what "instrument 7" is called.
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
