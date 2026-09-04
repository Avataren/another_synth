/**
 * Re-export shim: the sample-quality settings moved into
 * `@another-synth/tracker-playback`, alongside the instrument that reads them.
 */
export {
  defaultSampleQuality,
  getSampleQuality,
  setSampleQuality,
  resetSampleQuality,
} from '@another-synth/tracker-playback';
export type { SampleQualitySettings } from '@another-synth/tracker-playback';
