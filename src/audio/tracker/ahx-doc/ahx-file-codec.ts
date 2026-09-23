import { parseAhx, type AhxSongFormat } from '@another-synth/tracker-playback';

/**
 * The AHX file a `.cmod` carries (`data.ahxFile`): the bytes `buildAhxFile`
 * writes, as base64 text. A song file is untrusted input, and base64 is decoded
 * into a `Uint8Array` before `parseAhx` sees it, so the text is bounded first.
 */

/**
 * The largest `ahxFile` text read: 512 KiB of base64, which decodes to at most
 * 384 KiB. The corpus maximum is 50 199 bytes, and the 16-bit `nameOffset`
 * bounds the structural part of a file at 65 535, so this is generous.
 */
export const AHX_FILE_MAX_BASE64_LENGTH = 512 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CHUNK = 0x8000;

export function encodeAhxFile(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export type AhxFileDecoding = { ok: true; bytes: Uint8Array; format: AhxSongFormat } | { ok: false; reason: string };

/**
 * The AHX or HVL bytes `text` holds, and which of the two they are, or why it
 * holds none. Never throws and refuses an over-cap or malformed text before
 * allocating the decoded array. The bytes must parse. An HVL song with a doc
 * saves its file here too (plan-hvl-editing.md P3), so a reader that needs one
 * format (the AHX exporter) checks `format` itself.
 */
export function decodeAhxFile(text: unknown): AhxFileDecoding {
  if (typeof text !== 'string') return { ok: false, reason: 'it is not text' };
  if (text.length > AHX_FILE_MAX_BASE64_LENGTH) {
    return { ok: false, reason: `it is larger than the ${AHX_FILE_MAX_BASE64_LENGTH >> 10} KiB limit` };
  }
  if (text.length % 4 !== 0 || !BASE64.test(text)) return { ok: false, reason: 'it is not valid base64' };
  let bytes: Uint8Array;
  try {
    const binary = atob(text);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return { ok: false, reason: 'it is not valid base64' };
  }
  let format: AhxSongFormat;
  try {
    format = parseAhx(bytes).format;
  } catch (error) {
    return { ok: false, reason: `its bytes are not a readable AHX/HVL file (${(error as Error).message})` };
  }
  return { ok: true, bytes, format };
}
