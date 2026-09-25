import type { TrackerSongFile } from 'src/stores/tracker-store';
import type { SidDoc } from 'src/audio/tracker/sid-doc';
import { exportBin, exportPrg, exportSid, PAL_FRAME_CIA, PRG_MAX_KEYED_SUBSONGS, type SidExport } from 'src/audio/tracker/sid-export';
import { planSidExport, sentence } from './sng-exporter';
import { SongExportError, type SongExporter } from './types';

/**
 * The C64 exporters (plan-sid-authoring.md phases 4 and 5): the song's doc,
 * packed and assembled with GoatTracker's own playroutine
 * (`src/audio/tracker/sid-export`), as
 *  - `.sid`: a PSID v2 file, byte for byte what GoatTracker 2.77 writes for
 *    the same song with "disable optimization";
 *  - `.prg`: a C64 program you LOAD and RUN (`c64-prg.ts`), the same player
 *    and song behind a BASIC line and a small shell;
 *  - `.bin`: the player and song alone, raw, at $1000 (GoatTracker's "BIN").
 * Their refusals are GoatTracker's packer's; their warnings say where
 * GoatTracker's C64 player plays the song differently from its editor, which
 * is what this app plays.
 */

export const SID_TEXT_NOTE =
  "The title or author has characters a .sid can't hold (more than 32, or outside latin-1); they are replaced or removed.";

export const PRG_TEXT_NOTE =
  'The title or author is longer than 32 characters or has characters outside latin-1; the program shows it shortened or with them replaced.';

/** The .prg's screen: characters the C64's character set lacks. */
export const PRG_SCREEN_TEXT_NOTE =
  "The title, author or copyright has characters the C64's screen doesn't have; they show as ? or without their accents.";

/** A .bin carries no speed: whoever links it calls play at the song's rate. */
export const binSpeedNote = (speed: number): string =>
  `The song runs at ${speed}x speed: call play ${speed} times per frame, evenly spaced (e.g. from a CIA timer every ${Math.trunc(PAL_FRAME_CIA / speed) + 1} cycles on a PAL C64).`;

/** The .prg picks subsongs with the keys 1-9. */
export const prgUnkeyedNote = (songs: number): string =>
  `Subsongs 10-${songs} can't be picked on the C64: the program plays subsong 1 and the keys 1-9 pick the first nine.`;

type Format = 'sid' | 'prg' | 'bin';
type Built = { ok: true; out: Extract<SidExport, { ok: true }>; altered: boolean; songs: number; speed: number } | { ok: false; reason: string };

const WRITERS: Record<Format, { as: string; write: (doc: SidDoc) => SidExport }> = {
  sid: { as: 'exported as a C64 .sid', write: (doc) => exportSid(doc) },
  prg: { as: 'exported as a C64 .prg', write: (doc) => exportPrg(doc) },
  bin: { as: 'exported as a C64 .bin', write: (doc) => exportBin(doc) },
};

/** Packing and assembling take a few milliseconds; the dialog asks three times per song. */
const caches: Record<Format, WeakMap<TrackerSongFile, Built>> = { sid: new WeakMap(), prg: new WeakMap(), bin: new WeakMap() };

function build(format: Format, song: TrackerSongFile): Built {
  const cache = caches[format];
  const hit = cache.get(song);
  if (hit !== undefined) return hit;
  const writer = WRITERS[format];
  const planned = planSidExport(song, writer.as);
  let built: Built;
  if (!planned.ok) built = planned;
  else {
    const out = writer.write(planned.doc);
    built = out.ok
      ? { ok: true, out, altered: planned.altered, songs: planned.doc.subsongs.length, speed: planned.doc.speedMultiplier }
      : { ok: false, reason: `This song can't be ${writer.as.replace('exported as a C64 ', 'exported as a ')}: ${out.reason}.` };
  }
  cache.set(song, built);
  return built;
}

function c64Exporter(
  format: Format,
  row: Pick<SongExporter, 'label' | 'extension' | 'description'>,
  notes: (built: Extract<Built, { ok: true }>) => string[],
): SongExporter {
  return {
    id: format,
    ...row,
    mimeType: 'application/octet-stream',
    available: true,
    check(song) {
      const built = build(format, song);
      return built.ok ? { ok: true } : built;
    },
    warnings(song) {
      const built = build(format, song);
      return built.ok ? [...notes(built), ...built.out.notes.map(sentence)] : [];
    },
    serialize(song) {
      const built = build(format, song);
      if (!built.ok) throw new SongExportError(built.reason);
      return built.out.bytes;
    },
  };
}

export const sidExporter: SongExporter = c64Exporter(
  'sid',
  {
    label: 'Commodore 64 SID',
    extension: '.sid',
    description:
      "Saves the song as a PSID file that plays on a C64 and in SID players, with GoatTracker's playroutine (as GoatTracker's own export does).",
  },
  (b) => (b.altered ? [SID_TEXT_NOTE] : []),
);

export const prgExporter: SongExporter = c64Exporter(
  'prg',
  {
    label: 'Commodore 64 program',
    extension: '.prg',
    description:
      "Saves the song as a C64 program you LOAD and RUN, with GoatTracker's playroutine and the song's name on screen; the keys 1-9 pick a subsong.",
  },
  (b) => [
    ...(b.altered ? [PRG_TEXT_NOTE] : []),
    ...(b.out.textAltered === true ? [PRG_SCREEN_TEXT_NOTE] : []),
    ...(b.songs > PRG_MAX_KEYED_SUBSONGS ? [prgUnkeyedNote(b.songs)] : []),
  ],
);

export const binExporter: SongExporter = c64Exporter(
  'bin',
  {
    label: 'Commodore 64 player + song, raw',
    extension: '.bin',
    description:
      "Saves GoatTracker's playroutine and the song as raw bytes for $1000, without a load address, for your own C64 program: init at $1000 with the subsong in A, play at $1003 once per frame; zero page $FC-$FD.",
  },
  (b) => (b.speed > 1 ? [binSpeedNote(b.speed)] : []),
);
