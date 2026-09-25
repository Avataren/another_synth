import { gtSongExportProblem, type SidDoc } from 'src/audio/tracker/sid-doc';
import { assemble6502 } from './asm6502';
import { GT_PACK_DEFAULTS, gtPackSource, type GtPackOptions } from './gt-pack';
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

export { assemble6502, type AsmError, type AsmResult } from './asm6502';
export { GT_PACK_DEFAULTS, gtPackSource, type GtPack, type GtPackOptions } from './gt-pack';
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

/** `doc` as a PSID `.sid`, or why it can't be one. Never throws. */
export function exportSid(doc: SidDoc, options: GtPackOptions = SID_EXPORT_DEFAULTS): SidExport {
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
    const hex = (v: number): string => `$${v.toString(16).toUpperCase().padStart(4, '0')}`;
    return {
      ok: false,
      reason: `the player and song take ${asm.bytes.length} bytes from ${hex(asm.origin)} and run to ${hex(end - 1)}, into the C64's I/O area at ${hex(SID_EXPORT_MEMORY_END)}`,
    };
  }
  const bytes = psidBytes({
    name: doc.songName,
    author: doc.author,
    released: doc.copyright,
    songs: packed.songs,
    chipModel: doc.chipModel,
    speedMultiplier: doc.speedMultiplier,
    address: asm.origin,
    code: asm.bytes,
  });
  return { ok: true, bytes, address: asm.origin, size: asm.bytes.length, notes: packed.notes };
}
