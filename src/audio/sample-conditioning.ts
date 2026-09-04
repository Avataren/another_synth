/**
 * Re-export shim: the offline sample conditioning moved into
 * `@another-synth/tracker-playback`, alongside the instrument that applies it.
 */
export {
  buildPolyphaseKernel,
  oversample,
  removeDcOffset,
  crossfadeLoop,
  lowpassForRate,
  mipLevelForRate,
} from '@another-synth/tracker-playback';
export type { LoopRegion } from '@another-synth/tracker-playback';
