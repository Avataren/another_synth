/**
 * The A2M file a `.cmod` carries (`data.a2mFile`): the module's bytes as
 * base64, exactly as opened. The Rust player in the OPL worklet plays them;
 * the grid beside them is display only. A song file is untrusted input, so
 * the text is bounded and checked before it is decoded; whether the bytes
 * are a module the player takes is the player's to say, at load.
 */

/** 1 MiB of base64 (768 KiB decoded). The corpus maximum is 37 KB packed. */
export const A2M_FILE_MAX_BASE64_LENGTH = 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CHUNK = 0x8000;

export function encodeA2mFile(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The bytes `text` holds, or why it holds none. Never throws. */
export function decodeA2mFile(text: unknown): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'it is not text' };
  if (text.length > A2M_FILE_MAX_BASE64_LENGTH) {
    return { ok: false, reason: `it is larger than the ${A2M_FILE_MAX_BASE64_LENGTH >> 10} KiB limit` };
  }
  if (text.length % 4 !== 0 || !BASE64.test(text)) return { ok: false, reason: 'it is not valid base64' };
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: 'it is not valid base64' };
  }
}
