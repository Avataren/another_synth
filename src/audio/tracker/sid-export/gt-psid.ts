import type { SidChipModel } from 'src/audio/tracker/sid-doc';

/**
 * The PSID v2 wrapper (plan-sid-authoring.md D3), laid out as GoatTracker's
 * packer writes it (so the gate can compare whole files with `gt2reloc`'s):
 *
 *  - the 124-byte header ($7C): magic `PSID`, version 2, data offset $7C,
 *    load address 0 (the load address is the first two data bytes), init,
 *    play (= player + 3, its `jmp mt_play`), songs, start song 1, speed,
 *    name/author/released (32 bytes each, zero padded), flags (PAL, and
 *    6581 or 8580), four reserved zero bytes;
 *  - at a speed above 1x, 10 bytes in front of the player set the CIA 1
 *    timer A latch to the frame's cycles / speed (PAL: $4CC7 / speed) and
 *    fall through into the player's init (`jmp mt_init`); init and load
 *    address are 10 bytes lower, and every song's speed bit is set (CIA).
 *    A PSID player starts the timer from that latch, as for GT's own files.
 */

export interface PsidFile {
  readonly name: string;
  readonly author: string;
  readonly released: string;
  readonly songs: number;
  readonly chipModel: SidChipModel;
  /** 1..16: play calls per PAL frame. */
  readonly speedMultiplier: number;
  /** Where `code` loads (the player's `.ORG`). */
  readonly address: number;
  /** Player + song data, assembled at `address`. */
  readonly code: Uint8Array;
}

export const PSID_HEADER_LENGTH = 0x7c;
/** CIA cycles of one PAL frame, GoatTracker's value (greloc: `0x4cc7`). */
export const PAL_FRAME_CIA = 0x4cc7;
const TEXT_LENGTH = 32;

export function psidBytes(file: PsidFile): Uint8Array {
  const out: number[] = [];
  const word = (v: number): void => {
    out.push((v >> 8) & 0xff, v & 0xff);
  };
  const text = (s: string): void => {
    for (let i = 0; i < TEXT_LENGTH; i++) out.push(i < s.length ? s.charCodeAt(i) & 0xff : 0);
  };
  const cia = file.speedMultiplier > 1;
  const load = cia ? file.address - 10 : file.address;

  for (const c of 'PSID') out.push(c.charCodeAt(0));
  word(2);
  word(PSID_HEADER_LENGTH);
  word(0);
  word(load);
  word(file.address + 3);
  word(file.songs);
  word(1);
  const speed = cia ? 0xff : 0;
  out.push(speed, speed, speed, speed);
  text(file.name);
  text(file.author);
  text(file.released);
  // Flags: PAL (bits 2-3 = 01), SID model (bits 4-5: 01 = 6581, 10 = 8580).
  out.push(0x00, 0x04 | (file.chipModel === '8580' ? 0x20 : 0x10));
  out.push(0, 0, 0, 0);

  out.push(load & 0xff, load >> 8);
  if (cia) {
    const latch = Math.trunc(PAL_FRAME_CIA / file.speedMultiplier);
    // ldx #lo / stx $dc04 / ldx #hi / stx $dc05, then the player.
    out.push(0xa2, latch & 0xff, 0x8e, 0x04, 0xdc, 0xa2, latch >> 8, 0x8e, 0x05, 0xdc);
  }
  return Uint8Array.from([...out, ...file.code]);
}
