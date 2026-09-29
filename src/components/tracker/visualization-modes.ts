/**
 * The views the tracker and the jukebox can put in the space under their
 * toolbar, chosen with the picker beside the LIM button.
 *
 * `pattern` is the original layout (per-channel scope row over the pattern
 * grid, with the spectrum strips at its sides) and stays the default. Add a
 * mode here and give the pages a branch for it; the picker lists whatever this
 * table holds.
 */
export type VisualizationMode = 'pattern' | 'scopes';

export interface VisualizationModeOption {
  id: VisualizationMode;
  label: string;
  /** A Material icon name. */
  icon: string;
  title: string;
}

export const DEFAULT_VISUALIZATION_MODE: VisualizationMode = 'pattern';

export const VISUALIZATION_MODES: readonly VisualizationModeOption[] = [
  {
    id: 'pattern',
    label: 'Pattern',
    icon: 'view_list',
    title: 'Channel scopes over the pattern grid',
  },
  {
    id: 'scopes',
    label: 'Scopes',
    icon: 'show_chart',
    title: 'Fill the whole area with one oscilloscope per channel',
  },
];

/** A stored value can be anything (an older build, a hand-edited blob): fall back to the default. */
export function sanitizeVisualizationMode(value: unknown): VisualizationMode {
  return VISUALIZATION_MODES.some((mode) => mode.id === value)
    ? (value as VisualizationMode)
    : DEFAULT_VISUALIZATION_MODE;
}
