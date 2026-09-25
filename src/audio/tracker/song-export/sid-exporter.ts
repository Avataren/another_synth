import type { TrackerSongFile } from 'src/stores/tracker-store';
import { exportSid, type SidExport } from 'src/audio/tracker/sid-export';
import { planSidExport, sentence } from './sng-exporter';
import { SongExportError, type SongExportCheck, type SongExporter } from './types';

/**
 * The C64 `.sid` exporter (plan-sid-authoring.md phase 4): the song's doc,
 * packed and assembled with GoatTracker's own playroutine into a PSID v2 file
 * (`src/audio/tracker/sid-export`), byte for byte what GoatTracker 2.77 writes
 * for the same song with "disable optimization". Its refusals are GoatTracker's
 * packer's; its warnings say where GoatTracker's C64 player plays the song
 * differently from its editor, which is what this app plays.
 */

export const SID_TEXT_NOTE =
  "The title or author has characters a .sid can't hold (more than 32, or outside latin-1); they are replaced or removed.";

type Built = { ok: true; out: Extract<SidExport, { ok: true }>; altered: boolean } | { ok: false; reason: string };

/** Packing and assembling take a few milliseconds; the dialog asks three times per song. */
const cache = new WeakMap<TrackerSongFile, Built>();

function build(song: TrackerSongFile): Built {
  const hit = cache.get(song);
  if (hit !== undefined) return hit;
  const planned = planSidExport(song, 'exported as a C64 .sid');
  let built: Built;
  if (!planned.ok) built = planned;
  else {
    const out = exportSid(planned.doc);
    built = out.ok
      ? { ok: true, out, altered: planned.altered }
      : { ok: false, reason: `This song can't be exported as a .sid: ${out.reason}.` };
  }
  cache.set(song, built);
  return built;
}

function check(song: TrackerSongFile): SongExportCheck {
  const built = build(song);
  return built.ok ? { ok: true } : built;
}

function warnings(song: TrackerSongFile): string[] {
  const built = build(song);
  if (!built.ok) return [];
  return [...(built.altered ? [SID_TEXT_NOTE] : []), ...built.out.notes.map(sentence)];
}

function serialize(song: TrackerSongFile): Uint8Array {
  const built = build(song);
  if (!built.ok) throw new SongExportError(built.reason);
  return built.out.bytes;
}

export const sidExporter: SongExporter = {
  id: 'sid',
  label: 'Commodore 64 SID',
  extension: '.sid',
  mimeType: 'application/octet-stream',
  description:
    "Saves the song as a PSID file that plays on a C64 and in SID players, with GoatTracker's playroutine (as GoatTracker's own export does).",
  available: true,
  check,
  warnings,
  serialize,
};
