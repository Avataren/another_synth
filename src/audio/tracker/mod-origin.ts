import type { ModSong, ModTrackerFlavor } from '@another-synth/tracker-playback';

/**
 * Where a MOD came from, as the parser read it: its tracker flavor and the
 * signature at offset 1080. A `.mod` can be SoundTracker, NoiseTracker,
 * ProTracker or a PC tracker's (FT2, TakeTracker, OpenMPT); the song keeps
 * this so the UI can say which (`modVariantLabel`). Display only: playback
 * never reads it.
 */
export interface ModOrigin {
  flavor: ModTrackerFlavor;
  signature: string;
}

export function modOriginOf(mod: Pick<ModSong, 'trackerFlavor' | 'signature'>): ModOrigin {
  return { flavor: mod.trackerFlavor, signature: mod.signature };
}

const FLAVORS: ReadonlySet<ModTrackerFlavor> = new Set<ModTrackerFlavor>([
  'ProTracker',
  'NoiseTracker',
  'Soundtracker',
  'UltimateSoundtracker',
  'Unknown',
]);

/** A song file's `modOrigin`, or null when it is absent or not one (a file is untrusted input). */
export function readModOrigin(value: unknown): ModOrigin | null {
  if (typeof value !== 'object' || value === null) return null;
  const { flavor, signature } = value as Record<string, unknown>;
  if (typeof flavor !== 'string' || !FLAVORS.has(flavor as ModTrackerFlavor)) return null;
  if (typeof signature !== 'string' || signature.length > 4) return null;
  return { flavor: flavor as ModTrackerFlavor, signature };
}
