import { defineBoot } from '#q-app/wrappers';
import { initPlaybackDiagnostics } from 'src/diagnostics/playback-diagnostics';

/**
 * Playback telemetry, opt-in via `?diag=playback` (see
 * src/diagnostics/playback-diagnostics.ts). The check for the URL param
 * happens inside initPlaybackDiagnostics(); this boot file is just the one
 * place that calls it once, at startup, for every page.
 */
export default defineBoot(() => {
  initPlaybackDiagnostics();
});
