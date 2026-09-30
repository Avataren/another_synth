/**
 * The views the tracker and the jukebox can put in the space under their
 * toolbar, chosen with the picker beside the LIM button.
 *
 * `pattern` is the original layout (per-channel scope row over the pattern
 * grid, with the spectrum strips at its sides) and stays the default. Add a
 * mode here and give the pages a branch for it; the picker lists whatever this
 * table holds.
 */
export type VisualizationMode = 'pattern' | 'scopes' | 'glow' | 'bloom' | 'spikes' | 'stereo' | 'equalizer' | 'bars3d' | 'raymarch' | 'crt';

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
  {
    id: 'glow',
    label: 'Glow',
    icon: 'blur_on',
    title: 'One oscilloscope per channel, drawn by a WebGL shader with a glow',
  },
  {
    id: 'bloom',
    label: 'Glow 2',
    icon: 'flare',
    title: 'Thin glow scopes with a bloom post-process: blurred copies of the trace added back',
  },
  {
    id: 'spikes',
    label: 'Spikes',
    icon: 'graphic_eq',
    title: 'Mirrored glowing needles that follow each channel, with a two-colour bloom',
  },
  {
    id: 'stereo',
    label: 'Stereo',
    icon: 'multitrack_audio',
    title: 'The master output as one large needle scope: left above the centre line, right below',
  },
  {
    id: 'equalizer',
    label: 'Equalizer',
    icon: 'equalizer',
    title: 'Neon LED spectrum bars with a glowing waveform line per channel across them',
  },
  {
    id: 'bars3d',
    label: '3D Bars',
    icon: 'view_in_ar',
    title: 'Glowing spectrum bars on a glossy floor, with a diffuse reflection and bloom',
  },
  {
    id: 'raymarch',
    label: 'Raytraced',
    icon: 'deblur',
    title: 'The 3D bars raymarched per pixel: soft shadows, ambient occlusion and a mirror floor (GPU heavy)',
  },
  {
    id: 'crt',
    label: 'CRT',
    icon: 'tv',
    title: 'The glow scopes on little CRT screens: scanlines, colour fringing, graticule',
  },
];

/** A stored value can be anything (an older build, a hand-edited blob): fall back to the default. */
export function sanitizeVisualizationMode(value: unknown): VisualizationMode {
  return VISUALIZATION_MODES.some((mode) => mode.id === value)
    ? (value as VisualizationMode)
    : DEFAULT_VISUALIZATION_MODE;
}

/** The modes that replace the channel row and pattern grid with a wall of scopes. */
export function isScopeWallMode(mode: VisualizationMode): boolean {
  return mode === 'scopes' || mode === 'stereo' || mode === 'equalizer' || mode === 'bars3d' || mode === 'raymarch' || isGlowWallMode(mode);
}

/** The wall views that are WebGL only, whatever the WebGL scopes setting says. */
export function isGlowWallMode(mode: VisualizationMode): boolean {
  return mode === 'glow' || mode === 'bloom' || mode === 'spikes' || mode === 'crt';
}

/** The views that read the per-channel taps (the stereo view listens to the master only). */
export function usesTrackTaps(mode: VisualizationMode): boolean {
  return mode !== 'pattern' && mode !== 'stereo' && mode !== 'bars3d' && mode !== 'raymarch';
}
