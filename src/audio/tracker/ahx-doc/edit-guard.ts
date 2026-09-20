import type { TrackerEntryData } from '@another-synth/tracker-playback';
import { entriesToTrack } from './entries';
import { AHX_CHANNELS } from './types';

/** C-1 in MIDI, which is AHX note 1 (`ahx-patterns.ts`'s offset). */
export const AHX_MIN_INPUT_MIDI = 24;
/** B-5, AHX note 60: the highest note the engine plays and the editor lets you write. */
export const AHX_MAX_INPUT_MIDI = 83;

/**
 * What an edit of an AHX song wants to write, asked *before* anything changes
 * (before the undo snapshot, before the cursor moves). `entries` is a whole
 * track's rows as they would stand after a bulk edit.
 */
export type AhxEditCheck =
  | { readonly kind: 'volume' }
  | { readonly kind: 'noteOff' }
  | { readonly kind: 'macro2' }
  | { readonly kind: 'macroLetter'; readonly char: string }
  | { readonly kind: 'instrument'; readonly value: number }
  | { readonly kind: 'note'; readonly midi: number }
  | { readonly kind: 'interpolation' }
  | { readonly kind: 'channels'; readonly count: number }
  | { readonly kind: 'entries'; readonly entries: readonly TrackerEntryData[] };

/**
 * Why an AHX step cannot hold what `check` describes, or `null` when it can.
 * The one rule table the handlers' pre-guards and the write-back's safety net
 * share (the net asks `entriesToTrack`, which is the `entries` case).
 */
export function ahxEditRefusal(check: AhxEditCheck, trackLength: number): string | null {
  switch (check.kind) {
    case 'volume':
      return 'AHX steps have no volume column: use effect C.';
    case 'noteOff':
      return 'AHX has no note-off: use the envelope release.';
    case 'macro2':
      return 'AHX steps have one effect column.';
    case 'macroLetter':
      return `"${check.char}" is not an AHX effect: an effect is a hex digit and two hex digits.`;
    case 'instrument':
      return check.value >= 0 && check.value <= 63 ? null : `AHX instruments go up to 63 (got ${check.value}).`;
    case 'note':
      return check.midi >= AHX_MIN_INPUT_MIDI && check.midi <= AHX_MAX_INPUT_MIDI ? null : 'AHX notes go from C-1 to B-5.';
    case 'interpolation':
      return 'AHX effects have no interpolation ranges.';
    case 'channels':
      return check.count === AHX_CHANNELS ? null : `AHX songs have exactly ${AHX_CHANNELS} channels (this needs ${check.count}).`;
    case 'entries': {
      const track = entriesToTrack(check.entries, trackLength);
      if (!('error' in track)) return null;
      const tooTall = /outside this song's tracks/.test(track.error);
      if (!tooTall) return track.error;
      const needed = check.entries.reduce((max, e) => Math.max(max, e.row + 1), 0);
      return `This needs ${needed} rows; this song's tracks have ${trackLength}.`;
    }
  }
}

/**
 * What the edit composables ask before they write in an AHX song. `refuse`
 * answers whether the edit must not happen (and has said why); it is `false`
 * for every song that is not an editable AHX one, so a handler asks
 * unconditionally.
 */
export interface AhxEditGate {
  /** An editable AHX song is open: its format limits apply to every edit. */
  readonly active: () => boolean;
  /** `true` when `check` cannot be written to an AHX step; the reason has been reported. */
  readonly refuse: (check: AhxEditCheck) => boolean;
  /**
   * Writes every pending grid edit into the doc now. A bulk edit calls it
   * before it reads the grid: `pushHistory` syncs too, and a sync that ran
   * after the results were computed could re-project a cell those results are
   * about to overwrite.
   */
  readonly flush?: () => void;
}
