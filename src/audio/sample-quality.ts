/**
 * Playback-quality settings for tracker samples, shared with the audio layer.
 *
 * These live in a module rather than being threaded through constructors
 * because the audio layer is reached from several places that have no view of
 * the settings store, and the values are read once per sample at load time
 * rather than per note. The settings store owns them; this is where the audio
 * side reads them from.
 */

export interface SampleQualitySettings {
  /**
   * Integer oversampling applied to every sample at load.
   *
   * Web Audio resamples buffer sources with linear interpolation, which rolls
   * off about 1.8 dB at half Nyquist. Oversampling offline with a windowed
   * sinc puts the same content two octaves lower relative to the buffer, where
   * that error is around 0.1 dB. 1 disables it.
   */
  oversampleFactor: number;

  /** Centre samples that sit off zero, which otherwise thump on note-on. */
  removeDcOffset: boolean;

  /**
   * Frames of crossfade applied to the seam of a forward loop, or 0 for none.
   *
   * FT2 does not do this, so it is a deliberate departure -- but a loop whose
   * ends do not meet ticks once per cycle, and many samples are like that.
   */
  loopCrossfadeFrames: number;

  /**
   * Build pre-filtered copies for notes played above the sample's own pitch.
   *
   * Playing a sample faster shifts its content up, and anything past the
   * output's Nyquist folds back as inharmonic noise. Oversampling cannot help
   * -- the fold happens after the buffer is read -- so the only fix is to play
   * a copy with the offending content already removed.
   */
  antiAliasHighNotes: boolean;
}

export const defaultSampleQuality: SampleQualitySettings = {
  oversampleFactor: 4,
  removeDcOffset: true,
  loopCrossfadeFrames: 0,
  antiAliasHighNotes: true,
};

let current: SampleQualitySettings = { ...defaultSampleQuality };

export function getSampleQuality(): SampleQualitySettings {
  return current;
}

export function setSampleQuality(next: Partial<SampleQualitySettings>): void {
  current = { ...current, ...next };
}

/** Test seam. */
export function resetSampleQuality(): void {
  current = { ...defaultSampleQuality };
}
