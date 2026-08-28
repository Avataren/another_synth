/**
 * Per-format playback semantics.
 *
 * ProTracker, FastTracker 2 and Scream Tracker disagree on enough behaviour
 * that a single blended code path degrades all of them. Rather than branching
 * on the format inside effect handlers -- which spreads unauditable
 * conditionals through a 1200-line file -- the differences are enumerated
 * here as data, and the effect processor reads them from the profile attached
 * to each track's state.
 *
 * See PLAN-module-format-support.md (D2) for the reasoning, and section 3 for
 * the full list of behaviours that still need to move behind this.
 */

import type { ModuleFormat } from './types';
import {
  type PitchModel,
  createAmigaPitchModel,
  createLinearPitchModel,
} from './pitch-model';

export interface FormatProfile {
  /** The format this profile describes. */
  readonly format: ModuleFormat;

  /**
   * Volume change represented by one unit of a volume-slide parameter, as a
   * fraction of full scale.
   *
   * ProTracker and FT2 both use a 0-64 volume range, so one unit is 1/64.
   */
  readonly volumeSlideUnit: number;

  /**
   * How pitch is represented and slid. ProTracker uses Amiga periods against
   * a hand-tuned table; XM defaults to a linear frequency table. Arpeggio's
   * table-overflow behaviour belongs to the model, since it is a consequence
   * of stepping through a table at all.
   */
  readonly pitch: PitchModel;

  /**
   * Whether a volume slide with a zero parameter (A00) reuses the channel's
   * last non-zero slide.
   *
   * FastTracker 2 keeps volume-slide memory; ProTracker does not -- there A00
   * simply means "no volume change". The difference is not academic: across a
   * 20-module sample, 569 of 27378 Axx commands carry a zero parameter, and in
   * one module (resii.mod) it is 27% of them. Treating those as "continue the
   * previous slide" makes volume drift where ProTracker holds it steady.
   *
   * Note this is specifically volume-slide memory. Vibrato's per-nibble memory
   * (4xy, used with a zero parameter in over half of all occurrences) and tone
   * portamento's speed memory (3xx) exist in both formats and are unaffected.
   */
  readonly volumeSlideHasMemory: boolean;

  /**
   * ProTracker quirk: an EDx note delay longer than the row's tick count
   * leaks the note into the following row instead of dropping it.
   */
  readonly noteDelayOverflowCarries: boolean;
}

/**
 * ProTracker / classic MOD semantics. This is also the behaviour the engine
 * had before profiles existed, so it doubles as the compatibility baseline.
 */
export const PROTRACKER_PROFILE: FormatProfile = {
  format: 'protracker',
  volumeSlideUnit: 1 / 64,
  pitch: createAmigaPitchModel({ arpeggioWrapsToDC: true }),
  volumeSlideHasMemory: false,
  noteDelayOverflowCarries: true,
};

/**
 * FastTracker 2 semantics, using XM's default linear frequency table.
 *
 * XM can also be flagged into Amiga mode, which needs its own profile with an
 * Amiga-style model; that arrives with the XM parser in Phase 3, since only
 * the file header says which mode a song wants.
 *
 * The remaining fields still hold ProTracker values and are corrected as each
 * behaviour is migrated -- see PLAN-module-format-support.md Phase 2. Nothing
 * selects this profile yet, so MOD playback is unaffected either way.
 */
export const XM_PROFILE: FormatProfile = {
  ...PROTRACKER_PROFILE,
  format: 'xm',
  pitch: createLinearPitchModel(),
  volumeSlideHasMemory: true,
};

/** Scream Tracker 3 semantics. Placeholder, as for XM_PROFILE. */
export const S3M_PROFILE: FormatProfile = {
  ...PROTRACKER_PROFILE,
  format: 's3m',
};

/**
 * Songs authored in this tracker.
 *
 * Deliberately keeps the ProTracker values for now: songs written against the
 * current engine were composed by ear with those behaviours in place, so
 * changing them here would alter existing work. Revisit once the legacy
 * quirks are genuinely optional.
 */
export const NATIVE_PROFILE: FormatProfile = {
  ...PROTRACKER_PROFILE,
  format: 'native',
  // Songs written against this engine were composed with volume-slide memory
  // in place, so keep it rather than silently altering existing work.
  volumeSlideHasMemory: true,
};

const PROFILES: Record<ModuleFormat, FormatProfile> = {
  native: NATIVE_PROFILE,
  protracker: PROTRACKER_PROFILE,
  xm: XM_PROFILE,
  s3m: S3M_PROFILE,
};

/** The playback semantics to apply for a given module format. */
export function profileForFormat(format: ModuleFormat | undefined): FormatProfile {
  if (!format) return PROTRACKER_PROFILE;
  return PROFILES[format] ?? PROTRACKER_PROFILE;
}
