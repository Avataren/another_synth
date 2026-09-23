import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Gated debug logger (N10): shares the `?diag=playback` opt-in with
 * playback-diagnostics. The flag is read once at module init, so each case
 * sets the URL first and then imports a fresh copy of the module.
 */

async function loadWithSearch(search: string) {
  window.history.replaceState(null, '', `/${search}`);
  vi.resetModules();
  return import('src/diagnostics/debug-log');
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('debugLog', () => {
  it('is a no-op without ?diag=playback', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { debugLog, isDebugLogEnabled } = await loadWithSearch('');

    debugLog('[SongBank] hidden', 1);

    expect(isDebugLogEnabled()).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('ignores other diag values', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { debugLog } = await loadWithSearch('?diag=other');

    debugLog('[SongBank] hidden');

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('forwards all arguments to console.log with ?diag=playback', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { debugLog, isDebugLogEnabled } = await loadWithSearch('?diag=playback');
    const payload = { a: 1 };

    debugLog('[PlaybackStore] shown', payload);

    expect(isDebugLogEnabled()).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('[PlaybackStore] shown', payload);
  });

  it('reads the URL once at init, not per call', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { debugLog } = await loadWithSearch('');

    window.history.replaceState(null, '', '/?diag=playback');
    debugLog('[SongBank] still hidden');

    expect(logSpy).not.toHaveBeenCalled();
  });
});
