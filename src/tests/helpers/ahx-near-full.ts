import type { AhxInstrument } from '@another-synth/tracker-playback';
import { parseAhx } from '@another-synth/tracker-playback';
import {
  AHX_SIZE_LIMIT,
  ahxInstrumentBytes,
  ahxUsedBytes,
  allocTrack,
  docFromBytes,
  setTrackLength,
  type AhxDoc,
} from 'src/audio/tracker/ahx-doc';
import { defaultAhxInstrument, emptyPListEntry } from 'src/audio/tracker/ahx-instrument-edit';
import { ahxCorpus, instrumentsOf, slotsOf } from './ahx-doc-fixtures';

export type NearFullSlots = { ahxData: AhxInstrument }[];

export const corpusBytes = (name: string): Uint8Array => ahxCorpus().find((f) => f.name === name)!.bytes;

/**
 * A corpus song grown to `slack..slack+3` bytes short of the limit: tracks to
 * the cap, then PLists filled row by row (the room is a multiple of 4 short of
 * `slack`), with new instruments appended when the existing ones are full.
 */
export function nearFullSong(name: string, slack: number): { doc: AhxDoc; slots: NearFullSlots } {
  const bytes = corpusBytes(name);
  let doc = docFromBytes(bytes);
  const slots: NearFullSlots = slotsOf(parseAhx(bytes)).filter((s): s is { ahxData: AhxInstrument } => s.ahxData !== undefined);
  const used = (): number => ahxInstrumentBytes(instrumentsOf(slots));
  const grown = setTrackLength(doc, 64, { instrumentBytes: used() });
  if (grown.ok) doc = grown.doc;
  for (let i = 0; i < 256; i++) {
    const r = allocTrack(doc, { append: true }, { instrumentBytes: used() });
    if (!r.ok) break;
    doc = r.doc;
  }
  for (;;) {
    const room = AHX_SIZE_LIMIT - ahxUsedBytes(doc, used()) - slack;
    if (room < 4) break;
    // Slot 0 is left alone: the tests edit it, so it must have room for a row.
    const target = slots.slice(1).find((s) => s.ahxData.plist.entries.length < 255);
    if (target === undefined) {
      if (slots.length >= 63 || room < 26) break;
      const fresh = defaultAhxInstrument();
      fresh.plist.entries = [];
      slots.push({ ahxData: fresh });
      continue;
    }
    const add = Math.min(255 - target.ahxData.plist.entries.length, Math.floor(room / 4));
    target.ahxData.plist.entries.push(...Array.from({ length: add }, () => emptyPListEntry()));
  }
  return { doc, slots };
}

