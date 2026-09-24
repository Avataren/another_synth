# S5.13 — Mono spectrum mirrored (SID): verdict

Branch `agent/sid-mirror-0924b` off `f8c7a8f2`. The only product file changed is `src/components/tracker/TrackerSpectrumAnalyzer.vue`. Tests are in `src/tests/sid-spectrum-taps.test.ts`.

## Before / after

- **Before (S5.7):** `buildMonoGraph` put its one master analyser in `left.channels` and emptied `right.channels`. A SID song drew one trace in the left strip only. The right strip never registered an animation callback, so it stayed blank.
- **After:** that same analyser is wired into both strips (`right.channels = [channel]`). The strips anchor at their inner edges, where they meet the pattern, and fan outward:
  - The left strip draws right-to-left from its right edge.
  - The right strip draws left-to-right from its left edge.

  So the same data gives a mirror image: bass meets at the screen center and treble runs out to both screen edges.
- There is still **one** AnalyserNode, connected once. `connectChannel` runs only in `buildMonoGraph`. On teardown the second `disconnectChannel` on the shared channel does nothing: `connectChannel(null)` returns early, and `analyser.disconnect()` with no arguments can safely run twice.
- **The one-line change was not enough on its own (proven red below).** `drawSide` called `updateChannelData` once per strip, so the shared channel was read and smoothed twice each frame. The right strip drew a trace one smoothing step ahead of the left, so it was taller and not a true mirror.
  - **Fix:** `ChannelAnalyzer` gets `updatedAt` and `updatedBars`. The animation loop's frame `time` is now passed through to `drawSide` and on to `updateChannelData`. That function returns early if the channel was already updated this frame with the same bar count, so the second strip reuses the first strip's data.
  - Channels that appear in only one strip (stereo and per-track modes) are updated exactly once per frame, as before. The guard never triggers for them.
  - If the two gutters differ in width enough to give different bar counts, each strip still gets correctly mapped data (the key includes the bar count). In that rare case the smoothing advances twice for that frame.

## Pages affected

`TrackerPage.vue` (`:mono="isSidSong"`) and `JukeboxPage.vue` (`:mono="trackerStore.isSidSong"`). Both already pass `:mono` from S5.7 and neither was changed. Non-SID songs are unaffected: the stereo L/R pair and the per-track 3/4-voice layouts are unchanged.

## Test proof

New tests in `src/tests/sid-spectrum-taps.test.ts`:

1. `S5.13: a mono (SID) trace is mirrored across the screen center > mono: ONE analyser, painted in BOTH strips -- the right strip is the left one mirrored`
   - This test runs the real draw loop in jsdom, with a recording 2D context on each canvas and a fixed 160×40 strip. The analyser returns a ramp, so every bar is different.
   - It asserts:
     - there is exactly 1 analyser, on the master, and nothing is connected to the voices;
     - both strips paint;
     - the right strip's rects equal the left strip's rects reflected about the center line;
     - the shared analyser is read once per frame.
2. `... > stereo (not mono): each strip paints its own analyser, as before`: regression guard. It asserts 2 analysers, both strips painting, and each analyser read once per frame of its strip.
3. `... > per-track (three live taps): quad layout unchanged -- two voices left, one right, one analyser each`: regression guard. It asserts 3 analysers, with the left strip overlaying two channels and the right strip drawing one.
4. `TrackerSpectrumAnalyzer with a SID song's three taps > S5.13 per-source discrimination unchanged: the stereo master keeps its splitter and a distinct analyser per side`: regression guard on the wiring. The master feeds the splitter; splitter output 0 goes to analyser A and output 1 to analyser B, and A ≠ B.

The existing S5.7 mono tests were not changed and pass. They still see exactly one AnalyserNode.

**Red-first evidence:**
- `.ai/checks-s513-red.txt` (unfixed code): test 1 fails with `expected 0 to be greater than 0` because the right strip painted nothing. Exit 1. The other 13 tests pass, so the guards are green before the change.
- `.ai/checks-s513-red-naive.txt` (only `right.channels = [channel]`): test 1 fails the mirror assertion. The right strip's bars are taller (`[1, 35.709, 6, 4.291]` vs `[1, 36.29, 6, 3.71]`) because of the double smoothing. Exit 1.
- After the full fix, all 14 tests in the file pass.

## Gates

| Gate | File | Result |
|---|---|---|
| vitest (full) | `.ai/checks-s513-vitest.txt` | exit 0 — 261 files, 4209 tests passed |
| lint | `.ai/checks-s513-lint.txt` | exit 0 |
| vue-tsc | `.ai/checks-s513-vuetsc.txt` | exit 0 |
| gitleaks | `.ai/checks-s513-gitleaks.txt` | exit 0, no leaks |

The first vue-tsc run exited 2 with 11 errors (`#q-app/wrappers` not found, implicit `any` in `quasar.config.ts` and `src/boot/axios.ts`). None of them were in the changed files. The cause was this fresh worktree's setup: `node_modules` was a real directory holding only `.vite`, not the symlink to the main checkout. I replaced it with the symlink `node_modules -> ../../../node_modules`, ran `npx quasar prepare`, and reran all four gates. The files above are from that rerun.

## Honest note

The tests prove the geometry is symmetric and the data is identical: the right strip is exactly the left strip mirrored about the center line. Whether it *looks* right is Morten's call. He will check it on PC with a SID song, in both the tracker and the jukebox. Things he may want to tune: an asymmetric pattern grid gives gutters of different widths, and so different bar counts per side (the mirror is by frequency band, not by pixel). The colour gradient is also mirrored (primary at the center, secondary at the edges).
