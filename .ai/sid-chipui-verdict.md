# S5.7 verdict — SID chip-model switcher + mono spectrum (TS-only)

Branch `agent/sid-chipui-0924a` off `4322c848`. No Rust changes, no wasm rebuild
(`git status --porcelain rust-wasm/` is empty; cargo baseline stands).

## What the UI shows

A small segmented control labelled **SID** with two buttons, `8580` and `6581`,
the song's current model highlighted (`aria-pressed`). New component
`src/components/tracker/SidChipModelToggle.vue`. It is rendered only when
`sidChipModel` is non-null, i.e. `trackerStore.isSidSong` and the song has a doc
(`TrackerPage.vue`: `sidChipModel = isSidSong ? sidDoc?.chipModel ?? null : null`).
MOD/XM/S3M/AHX/HVL never show it.

- **Phone** (`isMobileLayout`): in the top toolbar strip, directly after the
  Play / Play-pattern / Stop icons and before the first divider — so it is in
  the part of the strip that is visible without scrolling sideways. The compact
  buttons are 44×30 px, `touch-action: manipulation`.
- **Desktop**: in the song panel's transport row, after Stop and before the
  volume slider; buttons 48×34 px. (On phone, opening the "Song" sheet also
  shows this second copy, just as the transport buttons are shown twice.)
- Disabled while a song is loading.

Default state = the doc's tagged `chipModel` (the toggle reads the doc; nothing
else stores the choice).

## Switch behaviour (what happens to playback)

Clicking the other model calls the new store action
`trackerStore.setSidChip(model)` = `editSidDoc(setSidChipModel(doc, model))`:
an ordinary undoable doc edit. That bumps `sidRevision`, which the playback
store already watches (`SidSongTransport.onDocChange`), so the switch rides the
existing edit-reload path — no new transport code:

- **Playing → RESUMES in place, it does not restart.** After the 150 ms edit
  debounce (`SID_RELOAD_IDLE_MS`) the transport serialises the retagged doc
  (`serializeSidFile`, chip byte = new model) and posts `load-song`, `seek(<row
  it was on>)`, `play` in order on the port; the worklet builds a new
  `SidPlayer` from those bytes (the Rust player reads the model from the header)
  and seeks it. How I know: `sid-playback-chain.test.ts` "while playing" runs the
  REAL `SidProcessorCore` over the REAL `public/wasm`: after 3 rows + a bit, the
  switch produces exactly one extra `load-song` whose byte 5 is the new chip
  code, the next commands are `seek {row: 3}` then `play`, the client's
  `song-loaded` info (the Rust `chip_model()`) flips `6581 → 8580`, `isPlaying`
  stays true and the mix keeps sounding (peak > 0.05). Undo flips it back and
  reloads again.
- Granularity: the resume point is the last row the worklet reported (~25 Hz
  reports), i.e. the **start of the current row** — up to one row can replay.
  The seek is the existing Rust `seek_row` (replays the sequencer from the top
  to that row); it is the same path every in-play edit already uses.
- **Paused**: nothing reloads until Resume; Resume then loads the new chip and
  seeks to the paused row (tested: `seek {row: 2}`, chip reported `8580`).
- **Stopped**: the next Play loads the retagged doc (tested).

Note: the chip byte in the SID song file is **byte 5** (after `ASID` + version),
not byte 3 as the task text said; the tests assert byte 5.

## Export / save

The retag is in the doc, so everything that writes the doc carries it: the
`.cmod` save (`serializeSong().data.sidFile`, tested: decodes to the new model,
byte 5 = new code) and the SID file codec (tested). GoatTracker `.sng` export
cannot carry it — the format has no chip field (`gt-sng-write.ts` already
reports that as an export note); unchanged.

## Mono display

`TrackerSpectrumAnalyzer.vue` gets a `mono` prop and a `'mono'` mode: ONE
`AnalyserNode` connected straight to the master node (no channel splitter),
drawn in the left strip; the right strip stays empty; the per-voice taps are
not used by the spectrum while mono (the per-track scopes still use them).
Both pages pass it per source: `TrackerPage` `:mono="isSidSong"`,
`JukeboxPage` `:mono="trackerStore.isSidSong"`. Every other format keeps the
old behaviour (stereo L/R pair, or the 4-track LRRL per-track layout).

Proof (`sid-spectrum-taps.test.ts`):
- mono + a SID song's three live taps → exactly 1 analyser, the master's only
  connection goes to it, no voice tap is connected; flipping `mono` to false
  (next song not SID) rebuilds the per-track graph (voices connected again);
- mono with no taps → 1 analyser; same props without mono → 2 (the L/R pair);
- both pages bind `:mono=` on their `<TrackerSpectrumAnalyzer>`.

`OscilloscopeComponent` / `FrequencyAnalyzerComponent` needed no change: on the
tracker/jukebox pages neither is used; the SID instrument page already mounts
the oscilloscope with `:mono="true"`, and `FrequencyAnalyzerComponent` has only
ever drawn one trace.

## Test deltas

| file | new tests |
|---|---|
| `src/tests/sid-playback-chain.test.ts` | +3 (switch while playing / paused / stopped, real wasm) |
| `src/tests/sid-spectrum-taps.test.ts` | +3 (mono graph, mono vs stereo fallback, page wiring) |
| `src/tests/sid-chip-toggle.test.ts` (new) | +5 (toggle emits/active/disabled, store retag + save/codec byte + undo, non-SID refusal, both-layout placement) |

Total +11.

## Gates

| gate | baseline | S5.7 |
|---|---|---|
| vitest | exit 0, 258 files / 4177 tests | exit 0, **259 files / 4188 tests** (+1 file, +11 tests) — `.ai/checks-s57-vitest.txt` |
| lint | exit 0 | exit 0 — `.ai/checks-s57-lint.txt` |
| vue-tsc | exit 0 | exit 0 — `.ai/checks-s57-vuetsc.txt` |
| gitleaks | exit 0 | exit 0, no leaks — `.ai/checks-s57-gitleaks.txt` |
| cargo | exit 101 (only `manifest_covers_every_fixture`) | not rerun: no `rust-wasm/` change; baseline stands |

(vitest and lint were run twice; the files hold the final run after a one-line
`:disabled` type fix that vue-tsc's first run caught.)

## Honest caveats

- **Not run in a real browser or on a phone.** All proof is vitest (the worklet
  is the real core + real wasm behind a fake port, the page placement is a
  source check). The phone strip placement, touch size and that the strip does
  not need scrolling to reach the toggle are by construction, not observed.
  Manual check for Morten: load a SID demo on the phone, press Play, tap the
  other chip — the sound should change within ~0.2 s and carry on from the same
  row (possibly repeating the start of that row).
- The spectrum analyser is not shown on the phone layout at all (existing rule:
  `showSpectrumAnalyzer && !isMobileLayout`), so the mono fix is visible on
  desktop (tracker and jukebox) only.
- `StereoLevelMeter` in the instrument panel still shows two identical L/R bars
  for SID — not changed (it is a level meter, not an analyser trace; kept out of
  this urgent batch).
- In mono mode the SID spectrum shows the mix, not the three voices it showed
  per-strip before; the right gutter is empty for SID.
- A switch is an undo step (Ctrl+Z switches back) and two quick taps inside
  150 ms coalesce into one reload.
