import type { AhxSong } from '@another-synth/tracker-playback';
import { TOTAL_SLOTS, formatInstrumentId } from '@another-synth/tracker-playback';
import type { InstrumentSlot } from 'src/stores/tracker-store';

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
  const slots: InstrumentSlot[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
    slot: i + 1,
    bankName: '',
    patchName: '',
    instrumentName: '',
  }));
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
