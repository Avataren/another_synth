import { looksLikePsid, parsePsid, type PsidFile } from 'src/audio/tracker/psid/psid-file';

/**
 * A C64 `.sid` kept as it is, to be played by running its own code
 * (.ai/plan-psid-playback.md), not transcribed into a GoatTracker song
 * (`psid-import.ts`). The tune has no rows to show or edit: the song file
 * carries the `.sid` bytes (`data.psidFile`, base64) and a stand-in grid of
 * three empty voices, which the tracker page covers with the visualizers.
 *
 * It is a `'sid'` song with no `sidFile`: the format the tracker already
 * treats as read-only without a doc. What plays it is the SID worklet, as for
 * any SID song (`SidSongTransport`). The song file is made in `psid-import.ts`
 * (`psidTuneToTrackerSong`); this module has no store import, so the store can
 * read the file back.
 */

export interface PsidTune {
  readonly bytes: Uint8Array;
  readonly file: PsidFile;
  /** 0-based. */
  readonly subsong: number;
}

/** The largest `.sid` kept: the C64's 64 KiB plus a header, as base64. */
const PSID_MAX_BYTES = 0x10000 + 0x200;
export const PSID_FILE_MAX_BASE64_LENGTH = Math.ceil((PSID_MAX_BYTES * 4) / 3) + 4;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CHUNK = 0x8000;

/** `data.psidFile`: the `.sid` as base64 text. */
export function encodePsidFile(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export type PsidFileDecoding = { readonly ok: true; readonly bytes: Uint8Array; readonly file: PsidFile } | { readonly ok: false; readonly reason: string };

/** The `.sid` a `data.psidFile` text holds, or why it holds none. Never throws: a song file is untrusted input. */
export function decodePsidFile(text: unknown): PsidFileDecoding {
  if (typeof text !== 'string') return { ok: false, reason: 'it is not text' };
  if (text.length > PSID_FILE_MAX_BASE64_LENGTH) return { ok: false, reason: 'it is larger than a C64 tune can be' };
  if (text.length % 4 !== 0 || !BASE64.test(text)) return { ok: false, reason: 'it is not valid base64' };
  let bytes: Uint8Array;
  try {
    const binary = atob(text);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return { ok: false, reason: 'it is not valid base64' };
  }
  if (!looksLikePsid(bytes)) return { ok: false, reason: 'its bytes are not a SID file' };
  const parsed = parsePsid(bytes);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, bytes, file: parsed.file };
}

/** The tune a `.sid` is, or the true reason it cannot be one. */
export function psidTuneOf(bytes: Uint8Array, subsong?: number): { readonly ok: true; readonly tune: PsidTune } | { readonly ok: false; readonly reason: string } {
  if (!looksLikePsid(bytes)) return { ok: false, reason: 'it is not a SID file' };
  const parsed = parsePsid(bytes);
  if (!parsed.ok) return parsed;
  const wanted = subsong ?? parsed.file.startSong - 1;
  return { ok: true, tune: { bytes, file: parsed.file, subsong: Math.max(0, Math.min(parsed.file.songs - 1, wanted)) } };
}
