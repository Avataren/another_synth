/**
 * The PSID/RSID file (`.sid`), versions 1-4, as HVSC's `SID_file_format.txt`
 * lays it out (plan-psid-import.md). All header words are big-endian:
 *
 *   $00 magic 'PSID' or 'RSID'      $0E songs (1-256)
 *   $04 version (1-4)               $10 start song (1-based)
 *   $06 data offset ($76 / $7C)     $12 speed: bit n = song n+1 CIA-timed
 *   $08 load address (0: the data's first two bytes, little-endian)
 *   $0A init address (0: the load address)
 *   $0C play address (0: init installs its own interrupt)
 *   $16/$36/$56 name, author, released: 32 latin-1 bytes each
 *   v2+: $76 flags, $78 relocation start page, $79 pages,
 *        $7A second SID ($42-$FE: $D420-$DFE0), $7B third SID (v4)
 *
 * Flags: bit 0 the data is Compute!'s Sidplayer MUS (PSID) or reserved
 * (RSID), bit 1 PlaySID-specific (PSID) or C64 BASIC (RSID), bits 2-3 the
 * clock (01 PAL, 10 NTSC, 11 either), bits 4-5 / 6-7 / 8-9 the model of SID
 * 1 / 2 / 3 (01 6581, 10 8580, 11 either).
 */

export type PsidType = 'PSID' | 'RSID';
export type PsidClock = 'unknown' | 'pal' | 'ntsc' | 'any';
export type PsidSidModel = 'unknown' | '6581' | '8580' | 'any';

export interface PsidFile {
  readonly type: PsidType;
  readonly version: number;
  /** Where `data` goes in the C64's memory. */
  readonly loadAddress: number;
  /** Called with the subsong (0-based) in A. The load address when the header says 0. */
  readonly initAddress: number;
  /** Called once per tick; 0: the init routine installs its own interrupt handler. */
  readonly playAddress: number;
  /** 1-256. */
  readonly songs: number;
  /** 1-based, within `songs` (the header's 0 or out-of-range value reads as 1). */
  readonly startSong: number;
  /** The raw speed word: bit n set = song n+1 (songs past 32: bit 31) is timed by CIA 1 timer A. */
  readonly speed: number;
  readonly name: string;
  readonly author: string;
  readonly released: string;
  /** The raw flags word (0 in a v1 file). */
  readonly flags: number;
  readonly clock: PsidClock;
  /** The first SID's model. */
  readonly sidModel: PsidSidModel;
  /** The addresses of a second and third SID, if the file names them (v3/v4). */
  readonly extraSids: readonly number[];
  /** Relocation hints (v2+): the free memory range a player may use; 0 = none said. */
  readonly relocStartPage: number;
  readonly relocPages: number;
  /** The C64 bytes, without the load-address prefix. */
  readonly data: Uint8Array;
}

export type PsidParse = { readonly ok: true; readonly file: PsidFile } | { readonly ok: false; readonly reason: string };

const V1_HEADER = 0x76;
const V2_HEADER = 0x7c;
const TEXT = 32;

/** The magic of a PSID or RSID file. */
export function looksLikePsid(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const m = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  return m === 'PSID' || m === 'RSID';
}

const word = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;

/** A header text: latin-1, cut at the first zero (a full 32 bytes needs none). */
function text(b: Uint8Array, at: number): string {
  let s = '';
  for (let i = 0; i < TEXT; i++) {
    const c = b[at + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const CLOCKS: readonly PsidClock[] = ['unknown', 'pal', 'ntsc', 'any'];
const MODELS: readonly PsidSidModel[] = ['unknown', '6581', '8580', 'any'];

/**
 * A second/third SID's address from its header byte: $42-$7F and $E0-$FE
 * (even) are $D420-$D7F0 and $DE00-$DFE0; anything else is no SID.
 */
function extraSidAddress(v: number): number | null {
  if (v & 1) return null;
  if ((v >= 0x42 && v <= 0x7f) || (v >= 0xe0 && v <= 0xfe)) return 0xd000 | (v << 4);
  return null;
}

const hex4 = (v: number): string => `$${v.toString(16).toUpperCase().padStart(4, '0')}`;

/** `bytes` as a PSID/RSID file, or the true reason it is not one this importer can run. */
export function parsePsid(bytes: Uint8Array): PsidParse {
  if (!looksLikePsid(bytes)) return { ok: false, reason: 'it is not a SID file (no PSID/RSID magic)' };
  if (bytes.length < V1_HEADER) return { ok: false, reason: `the file is ${bytes.length} bytes, shorter than a SID header` };
  const type = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) as PsidType;
  const version = word(bytes, 4);
  if (version < 1 || version > 4) return { ok: false, reason: `its header is version ${version}; SID files are versions 1-4` };
  if (type === 'RSID' && version < 2) return { ok: false, reason: 'it is an RSID file of version 1, which the format does not have' };
  const dataOffset = word(bytes, 6);
  const expected = version === 1 ? V1_HEADER : V2_HEADER;
  if (dataOffset !== expected) {
    return { ok: false, reason: `its data starts at ${hex4(dataOffset)}; a version ${version} file's starts at ${hex4(expected)}` };
  }
  if (bytes.length < dataOffset) return { ok: false, reason: 'the file ends inside its header' };

  let loadAddress = word(bytes, 8);
  let data = bytes.subarray(dataOffset);
  if (loadAddress === 0) {
    if (data.length < 2) return { ok: false, reason: 'the file has no data after its header' };
    loadAddress = data[0]! | (data[1]! << 8);
    data = data.subarray(2);
  }
  if (data.length === 0) return { ok: false, reason: 'the file has no C64 data' };
  if (loadAddress + data.length > 0x10000) {
    return { ok: false, reason: `its ${data.length} bytes load at ${hex4(loadAddress)} and run past the end of the C64's memory` };
  }
  const initAddress = word(bytes, 10) || loadAddress;
  const playAddress = word(bytes, 12);
  const songs = word(bytes, 14);
  if (songs < 1 || songs > 256) return { ok: false, reason: `its header says ${songs} songs; a SID file has 1-256` };
  const start = word(bytes, 16);
  const startSong = start >= 1 && start <= songs ? start : 1;
  const speed = ((bytes[18]! << 24) | (bytes[19]! << 16) | (bytes[20]! << 8) | bytes[21]!) >>> 0;

  const flags = version >= 2 ? word(bytes, 0x76) : 0;
  if (type === 'PSID' && flags & 1) {
    return { ok: false, reason: "it holds Compute!'s Sidplayer (MUS) data, not a program to run" };
  }
  if (type === 'RSID' && flags & 2) {
    return { ok: false, reason: 'it is a C64 BASIC program; running it needs the C64\'s BASIC ROM, which this importer does not have' };
  }
  const extraSids: number[] = [];
  if (version >= 3) {
    const second = extraSidAddress(bytes[0x7a]!);
    if (second !== null) {
      extraSids.push(second);
      if (version >= 4) {
        const third = extraSidAddress(bytes[0x7b]!);
        if (third !== null && third !== second) extraSids.push(third);
      }
    }
  }
  return {
    ok: true,
    file: {
      type,
      version,
      loadAddress,
      initAddress,
      playAddress,
      songs,
      startSong,
      speed,
      name: text(bytes, 0x16),
      author: text(bytes, 0x36),
      released: text(bytes, 0x56),
      flags,
      clock: CLOCKS[(flags >> 2) & 3]!,
      sidModel: MODELS[(flags >> 4) & 3]!,
      extraSids,
      relocStartPage: version >= 2 ? bytes[0x78]! : 0,
      relocPages: version >= 2 ? bytes[0x79]! : 0,
      data,
    },
  };
}

/** Whether song `song` (1-based) is timed by CIA 1 timer A (else by the vertical blank). RSID: always its own timing. */
export function psidSongUsesCia(file: PsidFile, song: number): boolean {
  if (file.type === 'RSID') return false;
  const bit = Math.min(31, Math.max(0, song - 1));
  return ((file.speed >>> bit) & 1) === 1;
}

/** Whether the file's PSID flags say PlaySID-specific data (samples through PlaySID's own registers). */
export function psidIsPlaySidSpecific(file: PsidFile): boolean {
  return file.type === 'PSID' && (file.flags & 2) !== 0;
}
