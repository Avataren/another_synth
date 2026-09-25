// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The `isReadOnly` audit of Song Edit B2a. Before B2a, `isReadOnly` meant three
 * different things: "the song is an AHX song" (scopes, the playback cursor),
 * "the song's structure is not a pattern list's" (channels, patterns, slots)
 * and "nothing may be written". With editable AHX songs they part ways: the
 * store has `isAhxSong`, `isAhxEditable` and `isReadOnly` (= AHX/HVL without a
 * doc). Every one of the 52 hits (src, outside tests, at 8ec8539) was read and
 * classified; this pins the classification so a new use is a decision:
 *
 *  - tracker-store.ts, 15 -> 4: the getter itself, `pushHistory`, `undo`, `redo`
 *    stay "may I write". `addTrack`, `removeTrack` (4 channels), `setPatternRows`,
 *    `deletePattern`, `addPatternToSequence`, `removePatternFromSequence`,
 *    `setPatternName`, `moveSequenceItem` (the position ops do these, B4) and
 *    `clearSlot`, `updateEditingPatch`, `assignPatchToSlot` (an AHX song's slots
 *    are not the patch editor's) moved to `isAhxSong`.
 *  - useTrackerSelection.ts, 7: the context member and the six track / pattern
 *    operations that switch edit mode on: "may I write", stay.
 *  - JukeboxPage.vue, 1 -> 0: `isAhxSong` (the scope row) is "is AHX": moved.
 *  - TrackerPage.vue, 29 -> 25: the edit-mode buttons (2), the getter, the edit-mode
 *    gate and its watch, the selection context, the three transpose wrappers and the
 *    hint titles stay "may I write". Moved to `isAhxSong`: the scope source, the
 *    waveform visualizers, `restartPlaybackIfActive`, the paused-cursor watch, and
 *    (as an addition to `isReadOnly`, until B4's position UI) add/remove track, the
 *    sequence list, BPM, pattern length, New patch / Clear, and the pattern-list
 *    handlers.
 *  - TrackerPage.vue, 25 -> 30 (plan-sid-authoring.md phase 2): a SID song's Tempo and
 *    Speed fields and its three subsong buttons are "may I write" (a SID song saved
 *    without its doc is a display).
 */
const src = (file: string): string => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
/** Lines that mention it (the way the audit counted: by `grep -n`). */
const count = (text: string, needle: RegExp): number => text.split('\n').filter((line) => needle.test(line)).length;

describe('isReadOnly audit (B2a)', () => {
  it('pins how many uses of isReadOnly are left in each file', () => {
    expect(count(src('stores/tracker-store.ts'), /isReadOnly/)).toBe(4);
    expect(count(src('composables/useTrackerSelection.ts'), /isReadOnly/)).toBe(7);
    expect(count(src('pages/JukeboxPage.vue'), /isReadOnly/)).toBe(0);
    expect(count(src('pages/TrackerPage.vue'), /isReadOnly/)).toBe(30);
  });

  it('the "is AHX" questions ask isAhxSong', () => {
    const page = src('pages/TrackerPage.vue');
    expect(page).toContain(':scope-source="isAhxSong ? playbackStore.getAhxChannelWaveform : null"');
    expect(page).toContain('waveformVisualizersVisible.value && isAhxSong.value');
    expect(page).toContain('if (!isPlaying.value || isAhxSong.value) return;');
    expect(page).toContain('if (paused && isAhxSong.value) activeRow.value = playbackRow.value;');
    expect(src('pages/JukeboxPage.vue')).toContain('const isAhxSong = computed(() => trackerStore.isAhxSong);');
  });

  it('the store getters are the capability split', () => {
    const store = src('stores/tracker-store.ts');
    expect(store).toContain("return this.moduleFormat === 'ahx' && this.ahxDoc === null;");
    expect(store).toContain("return this.moduleFormat === 'ahx' && this.ahxDoc !== null;");
  });
});
