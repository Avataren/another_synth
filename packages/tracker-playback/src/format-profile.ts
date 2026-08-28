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
   * ProTracker's arpeggio steps through its period *table* rather than
   * scaling the period continuously, and running off the top of that table
   * wraps to period 0 (DC) instead of clamping.
   *
   * FT2 computes arpeggio arithmetically and does not have this artefact.
   */
  readonly arpeggioWrapsToDC: boolean;

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
  arpeggioWrapsToDC: true,
  noteDelayOverflowCarries: true,
};

/**
 * FastTracker 2 semantics.
 *
 * Currently identical to ProTracker: the plumbing lands first so that moving
 * a behaviour behind the profile is a separate, individually testable change
 * rather than a single sweeping rewrite. Fields are corrected for FT2 as each
 * behaviour is migrated -- see PLAN-module-format-support.md Phase 2.
 */
export const XM_PROFILE: FormatProfile = {
  ...PROTRACKER_PROFILE,
  format: 'xm',
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
