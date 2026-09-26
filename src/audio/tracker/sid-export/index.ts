import { gtSongExportProblem, type SidDoc } from 'src/audio/tracker/sid-doc';
import { assemble6502 } from './asm6502';
import { GT_PACK_DEFAULTS, gtPackSource, type GtPackOptions } from './gt-pack';
import { PRG_LOAD_ADDRESS, prgShellSource, prgTextsAltered, type PrgShell } from './c64-prg';
import { psidBytes } from './gt-psid';
import playerSource from './gt2/player.s?raw';

/**
 * `.sid` export (plan-sid-authoring.md phase 4, D2/D3): the song packed the
 * way GoatTracker's packer packs it (`gt-pack.ts`), assembled with
 * GoatTracker's own playroutine (`gt2/player.s`, V2.73 as GoatTracker 2.77
 * ships it; its header puts it outside the GPL: "Use it, or song binaries
 * created from it freely for any purpose") by our assembler (`asm6502.ts`),
 * in a PSID v2 file (`gt-psid.ts`). The same bytes GoatTracker's `gt2reloc`
 * writes for the song's `.sng` (`.ai/sid-oracle/psid_gate.ts`).
 */

export { assemble6502, parseAsmTree, type AsmError, type AsmResult, type AsmStmt } from './asm6502';
export { GT_PACK_DEFAULTS, gtPackedPatternSize, gtPackSource, gtTableDuplicateRows, type GtPack, type GtPackOptions } from './gt-pack';
export {
  basicSysStub,
  c64ScreenCodes,
  PRG_LOAD_ADDRESS,
  PRG_MAX_KEYED_SUBSONGS,
  PRG_RASTER_LINE,
  PRG_SHELL_ADDRESS,
  prgShellSource,
  type PrgShell,
} from './c64-prg';
export { PAL_FRAME_CIA, PSID_HEADER_LENGTH, psidBytes, type PsidFile } from './gt-psid';

/** The first address the C64's I/O area takes ($D000); the tune must end below it. */
export const SID_EXPORT_MEMORY_END = 0xd000;

export type SidExport =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly address: number;
      readonly size: number;
      /** Where the file plays differently from the app (GoatTracker's C64 player vs its editor). */
      readonly notes: readonly string[];
      /** `.prg` only: the screen shows a character of the texts differently or cuts a line. */
      readonly textAltered?: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** GoatTracker's playroutine source, as shipped. */
export const GT_PLAYER_SOURCE: string = playerSource;

/**
 * What the export dialog writes: GoatTracker's "disable optimization" build,
 * every player feature on (Morten, 2026-09-25). About 330 bytes more than
 * GT's default, and it sounds like the app where GT's default does not: GT's
 * SIMPLEPULSE optimization keeps a pulse in one nybble-swapped byte, so its
 * sweeps wrap and carry differently (7 of 118 corpus subsongs).
 */
export const SID_EXPORT_DEFAULTS: GtPackOptions = { ...GT_PACK_DEFAULTS, optimize: false };

/** The first label of the song data `gt-pack.ts` puts after the player. */
const SONG_DATA_LABEL = 'mt_freqtbllo';

type Tune =
  | {
      readonly ok: true;
      readonly origin: number;
      readonly code: Uint8Array;
      /** Bytes of player code and variables before the song data. */
      readonly playerLength: number;
      readonly songs: number;
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const hex4 = (v: number): string => `$${v.toString(16).toUpperCase().padStart(4, '0')}`;

/** Player + song data assembled at the player's address: what every C64 format holds. */
function buildTune(doc: SidDoc, options: GtPackOptions): Tune {
  const problem = gtSongExportProblem(doc);
  if (problem !== null) return { ok: false, reason: problem };
  const packed = gtPackSource(doc, playerSource, options);
  if (!packed.ok) return packed;
  const asm = assemble6502(packed.source);
  if (!asm.ok) {
    return { ok: false, reason: `the player could not be assembled (line ${asm.line}: ${asm.reason})` };
  }
  const end = asm.origin + asm.bytes.length;
  if (end > SID_EXPORT_MEMORY_END) {
    return {
      ok: false,
      reason: `the player and song take ${asm.bytes.length} bytes from ${hex4(asm.origin)} and run to ${hex4(end - 1)}, into the C64's I/O area at ${hex4(SID_EXPORT_MEMORY_END)}`,
    };
  }
  const data = asm.symbols.get(SONG_DATA_LABEL);
  if (data === undefined) throw new Error(`the packed source has no ${SONG_DATA_LABEL}`);
  return { ok: true, origin: asm.origin, code: asm.bytes, playerLength: data - asm.origin, songs: packed.songs, notes: packed.notes };
}

/** `doc` as a PSID `.sid`, or why it can't be one. Never throws. */
export function exportSid(doc: SidDoc, options: GtPackOptions = SID_EXPORT_DEFAULTS): SidExport {
  const tune = buildTune(doc, options);
  if (!tune.ok) return tune;
  const bytes = psidBytes({
    name: doc.songName,
    author: doc.author,
    released: doc.copyright,
    songs: tune.songs,
    chipModel: doc.chipModel,
    speedMultiplier: doc.speedMultiplier,
    address: tune.origin,
    code: tune.code,
  });
  return { ok: true, bytes, address: tune.origin, size: tune.code.length, notes: tune.notes };
}

/**
 * `doc` as a C64 program you LOAD and RUN (`c64-prg.ts`): BASIC line, shell,
 * then the player and song at the player's address. `address` is the
 * player's; the file loads at $0801. `textAltered`: the screen shows a
 * character of the texts differently (`?`, no accent) or cuts a line.
 */
export function exportPrg(doc: SidDoc, options: GtPackOptions = SID_EXPORT_DEFAULTS): SidExport {
  const tune = buildTune(doc, options);
  if (!tune.ok) return tune;
  const tuneEnd = tune.origin + tune.code.length;
  const backupAddress = Math.ceil(tuneEnd / 256) * 256;
  const backupEnd = backupAddress + Math.ceil(tune.playerLength / 256) * 256;
  if (backupEnd > SID_EXPORT_MEMORY_END) {
    return {
      ok: false,
      reason: `the player and song run to ${hex4(tuneEnd - 1)}, leaving no room below ${hex4(SID_EXPORT_MEMORY_END)} for the program's copy of the player (${backupEnd - backupAddress} bytes)`,
    };
  }
  const shell: PrgShell = {
    playerAddress: tune.origin,
    playerLength: tune.playerLength,
    backupAddress,
    songs: tune.songs,
    speedMultiplier: doc.speedMultiplier,
    name: doc.songName,
    author: doc.author,
    released: doc.copyright,
  };
  const asm = assemble6502(prgShellSource(shell));
  if (!asm.ok) return { ok: false, reason: `the program's start-up code could not be assembled (line ${asm.line}: ${asm.reason})` };
  const shellEnd = asm.origin + asm.bytes.length;
  if (shellEnd > tune.origin) {
    return {
      ok: false,
      reason: `the program's start-up code runs from ${hex4(asm.origin)} to ${hex4(shellEnd - 1)}, past the player at ${hex4(tune.origin)}`,
    };
  }
  const bytes = new Uint8Array(2 + tune.origin + tune.code.length - PRG_LOAD_ADDRESS);
  bytes[0] = PRG_LOAD_ADDRESS & 0xff;
  bytes[1] = PRG_LOAD_ADDRESS >> 8;
  bytes.set(asm.bytes, 2);
  bytes.set(tune.code, 2 + tune.origin - PRG_LOAD_ADDRESS);
  return { ok: true, bytes, address: tune.origin, size: tune.code.length, notes: tune.notes, textAltered: prgTextsAltered(shell) };
}

/**
 * `doc` as the raw player + song (GoatTracker's "BIN" format): no header,
 * no load address, assembled at the player's address, for linking into
 * one's own program. Init at `address` (A = subsong), play at `address + 3`,
 * called once per frame, or `speedMultiplier` times at multispeed.
 */
export function exportBin(doc: SidDoc, options: GtPackOptions = SID_EXPORT_DEFAULTS): SidExport {
  const tune = buildTune(doc, options);
  if (!tune.ok) return tune;
  return { ok: true, bytes: tune.code, address: tune.origin, size: tune.code.length, notes: tune.notes };
}
