import type { XmSong } from '@another-synth/tracker-playback';

/**
 * What an XM's header says about where it came from and where it loops: the
 * tracker name (players apply per-tracker quirks to a file by it, so a
 * re-export has to keep it) and the restart order. Not heard on playback here;
 * kept so the file can be written back as it was.
 */
export interface XmOrigin {
  trackerName: string;
  restartPosition: number;
  /** Instruments (1-based) with no samples whose header is the short 29 bytes, not FT2's 33. */
  shortEmptyHeaders?: number[];
}

export function xmOriginOf(xm: Pick<XmSong, 'trackerName' | 'restartPosition' | 'instruments'>): XmOrigin {
  const short = xm.instruments.flatMap((ins, i) => (ins.emptyHeaderSize === 29 ? [i + 1] : []));
  return {
    trackerName: xm.trackerName,
    restartPosition: xm.restartPosition,
    ...(short.length > 0 ? { shortEmptyHeaders: short } : {}),
  };
}

/** A song file's `xmOrigin`, or null when it is absent or not one (a file is untrusted input). */
export function readXmOrigin(value: unknown): XmOrigin | null {
  if (typeof value !== 'object' || value === null) return null;
  const { trackerName, restartPosition } = value as Record<string, unknown>;
  if (typeof trackerName !== 'string' || trackerName.length > 20) return null;
  if (typeof restartPosition !== 'number' || !Number.isInteger(restartPosition) || restartPosition < 0 || restartPosition > 255) return null;
  const short = (value as Record<string, unknown>).shortEmptyHeaders;
  const list = Array.isArray(short)
    ? short.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 256)
    : [];
  return { trackerName, restartPosition, ...(list.length > 0 ? { shortEmptyHeaders: list } : {}) };
}
