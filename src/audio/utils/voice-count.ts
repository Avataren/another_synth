import type { Patch } from '../types/preset-types';
import { patchLayoutToSynthLayout } from '../types/synth-layout';

const clampVoices = (count: number | undefined): number => {
  if (!count || !Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(8, Math.round(count)));
};

/**
 * Resolve the intended voice count from a patch layout, clamped to 1–8.
 */
export function resolvePatchVoiceCount(patch: Patch): number {
  try {
    const synthLayout = patchLayoutToSynthLayout(patch.synthState.layout);
    return clampVoices(synthLayout.voiceCount ?? synthLayout.voices.length);
  } catch (_err) {
    // Fallback to a safe mono count if the patch is malformed
    return 1;
  }
}
