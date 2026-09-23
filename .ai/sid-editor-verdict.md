# S4 verdict — SID editor integration (coder's record)

Branch `agent/sid-editor-0923a`, off main `96f1d2d4` (S3 landed). Not pushed, not merged.
Plan: `.ai/plan-sid-tracking.md` §6 row S4 (incl. Morten's visual-parity addendum 2026-09-23 13:54).
Templates: `.ai/plan-hvl-editing.md` §8–9 (P2 write-back discipline), S3 verdict "What S4/S5 inherit".

**Run history (honest):** run 1 was aborted because its worktree was cut one landing behind (missing
S3); its leftovers are in `.ai/aborted-run-1/` and were not used. This run (run 2) was cut off by the
API rate limit (429) at ~18:00 right after `9fdb8b3b`; the orchestrator verified the branch and re-ran
the gates (`.ai/checks-s4-*-run1.txt`), and this record is written by the resumed session, which
finished the instrument page, the visuals feed, the red controls and the final gates.

## What landed (6 commits)

| Commit | What |
|---|---|
| `30b4a2e1` | **Rust/wasm.** `Chip::render_taps` (each voice's pre-filter signal, DC-blocked, beside the mix; the mix stays bit-identical to `render`), `Chip::set_voice_mask` (mute/solo). `SidSongPlayer`: `song_row`/`song_rows`, `seek_row` (sequencer replay on the running chip), row-range loop, preview voice. `rust-wasm/src/sid/wasm.rs`: `SidPlayer` (wasm-bindgen, `cfg_attr` like `AhxPlayer`). `public/wasm` rebuilt (`node build-wasm.cjs`). |
| `5bc93d55` | **Grid write-back + undo.** `sid-doc/grid.ts` (the edit mapping, below), `setSidPatternSlice` op, store `syncSidWriteBack` + watcher, snapshots carry `sidDoc` by reference, `isReadOnly` lifted for SID with a doc, `hasDocStructure` getter, `editSidDoc`, SID-aware `ahxRefusal`; TrackerPage gate + structural guards. |
| `1ded41f4` | **Browser playback.** `src/audio/worklets/sid-core.ts` + `sid-worklet.ts` (outputs: 0 = mix stereo, 1..3 = voice taps), `src/audio/tracker/sid-player.ts` (client + handshake), `src/audio/tracker/sid-song-transport.ts`, `'sid'` branch in `tracker-playback-store`, `TrackerSongBank.getTrackTap`. Worklets rebuilt (`node build-worklets.cjs`); `sid-worklet.ts` added to the freshness gate's entry list. |
| `9fdb8b3b` | **Visual parity.** `useTrackerSongHost`: SID track nodes = the bank's per-track taps the SID voices feed; `TrackerSpectrumAnalyzer`: per-track layouts by count (4 LRRL, 3 = SID). |
| `75a739bf` | **Instrument visuals feed** (`sid-instrument-visuals.ts`, on the `ahx-instrument-visuals` model) + Rust dumper `rust-wasm/tests/sid_visuals_parity.rs` + fixture `src/tests/fixtures/sid-visuals-parity.json`. |
| `c59f8c97` | **SID instrument page** `src/pages/SidInstrumentPage.vue`, `sid-instrument-edit.ts`; `INSTRUMENT_EDITOR_BY_FORMAT.sid = 'sid-editor'` → route `sid-instrument-editor` (`sid/instrument/:slot`); legacy patch paths redirect SID slots there. |

35 files changed outside `public/` and fixtures (+5628/−196).

### The edit mapping (S4's decision)
S3's projection cuts a grid position wherever *any* voice starts a pattern. Therefore each
(position, voice) cell is a contiguous slice of exactly **one** pattern under one orderlist transpose
(`SidGridCell {pattern, transpose, offset, rows}`, `sidGridLayout`, now shared by the projection so
the two cannot disagree). A cell edit is an edit of that slice: row `r` → pattern row `offset + r`,
notes stored un-transposed. Patterns are shared, so every cell showing the pattern re-projects —
GoatTracker's own model and the AHX "shared track changes everywhere" rule. Only changed rows are
written (two edited cells over one pattern both land); rows that still show what the doc projects keep
the doc's row (key-on, clamped notes survive). Unrepresentable input reverts with a notice. The grid
cannot change orderlists (positions, lengths, order): refused, like AHX structure.

## Tests

TS (vitest), **+55 new tests in 6 new files, 3 existing files changed (intended):**
- `sid-grid-writeback.test.ts` (16) — real store + real editing/selection composables wired as TrackerPage: transposed/repeated shared cell, slice offsets, command entry, key-on preserved, clear/delete-row, transpose-track, pre-guard refusals, write-back revert, watcher, undo/redo by reference, `editSidDoc`, save/load round trip, unflushed edit in save.
- `sid-worklet-core.test.ts` (8) — `SidProcessorCore` over the **real rebuilt wasm** with the app-saved chain file.
- `sid-playback-chain.test.ts` (8) — the playable proof (below).
- `sid-spectrum-taps.test.ts` (7) — the jt_letgo spectrum/waveform proof (below).
- `sid-instrument-visuals.test.ts` (7) — every port held to the Rust-dumped fixture.
- `sid-instrument-page.test.ts` (9) — page mounted on a real store: edits → doc with undo, slot names follow, chip switch, hex tables, new instrument, preview keys, doc→file→doc.
- Changed: `sid-format-chain.test.ts` (S3 pin `isReadOnly` true → false), `instrument-types.test.ts` (S3 pin `sid: null` → `'sid-editor'`), both intended by the S4 scope.

Rust, **+11:** `src/sid/tests_s4.rs` (10: taps leave the mix bit-identical, taps are the voices, voice mask, song rows, seek lands on the natural registers, seek keeps the chip, row loop, preview, wasm shell, shell preview) + `tests/sid_visuals_parity.rs` (1).

## Gates (final, after the last code change; real exits)

| Gate | Baseline (untouched tree) | Final | Exit | File |
|---|---|---|---|---|
| `npm run test:run` | 3954 passed / 2 failed (artifact-freshness) | **251 files, 4011 passed / 0 failed** | 0 | `.ai/checks-s4-final-test.txt` |
| `npm run lint` | clean | clean | 0 | `.ai/checks-s4-final-lint.txt` |
| `npx vue-tsc --noEmit` | clean | clean | 0 | `.ai/checks-s4-final-vuetsc.txt` |
| `gitleaks detect --no-git --source .` | no leaks | no leaks | 0 | `.ai/checks-s4-final-gitleaks.txt` |
| `npm run check:artifacts` | (stale wasm) | worklets + wasm match sources | 0 | `.ai/checks-s4-final-artifacts.txt` |
| `cargo test --features native-host --no-fail-fast` | 370 / 1 / 1 | **381 / 1 / 1** | 101 | `.ai/checks-s4-final-cargo.txt` |

Reconciliation: TS 3954 + 55 new + the 2 artifact-freshness tests now green (the committed `public/wasm`
and worklet rebuilds) = 4011. Rust 370 + 11 new = 381; the one failure is the pre-existing
`ahx_render_golden::manifest_covers_every_fixture`, unchanged. Baselines: `.ai/checks-s4-baseline-*.txt`
(the brief expected 3932/2 — that is the pre-S3 number; S3's own record gives 3954/2, which is what
the untouched tree measured).

## The playback proof
`sid-playback-chain.test.ts`: a real SidDoc (S3 chain song) → real store → real `.cmod` →
real host `parseSongBuffer` → `applySongFile` → real `playbackStore.play` → `'sid'` branch →
`SidSongTransport` → real `createSidPlayer` (handshake incl. the wasm fetch) → real `SidPlayerClient`
→ port → **real `SidProcessorCore` over the real rebuilt wasm**. Only the browser render thread is
stood in for: a fake `AudioWorkletNode` whose `pump()` does what `sid-worklet.ts`'s ten-line
`process` does. Asserted: the worklet receives exactly `serializeSidFile(store.sidDoc)`, then seek +
play; audio peak > 0.05, L = R, A-4 (440.03 Hz) dominates 466 Hz by >100× on the mix and on voice 1's
tap; voice outputs 1..3 connect to the bank's `getTrackTap(0..2)` (the same nodes the host gives the
analyzer and scopes); worklet rows move the grid playhead (song row 20 → position 1 row 4); a grid
edit while playing reloads in place (load/seek/play burst, seek to the current row) and the new E-5
is heard on voice 2's tap; mute from the tracker silences voice 1's tap; pause/resume/stop; loading a
native song disposes the node; no-loop play ends at the song end and fires song-end listeners; "play
pattern" loops the position's row range.
Negative control NC2 (`.ai/checks-s4-red-controls.txt`): with the playback store from before the
`'sid'` branch, all 8 fail; restored, all 8 pass.

**Not proven by a test (manual check for Morten):** that a real browser runs the processor and the
sound is heard. No headless-browser run was made in this batch (the Firefox harness exists,
`.ai/ahx/app-browser-check/e2e.mjs`, but was not adapted). Manual step: `npm run dev`, open any SID
song (e.g. build one via `trackerStore.adoptSidDoc(createNewSidDoc())` in the console and type notes,
or load a `.cmod` saved from the chain test), press Play in the tracker: audio, moving playhead, three
live per-voice scopes and three spectrum strips (0 & 2 left, 1 right); open an instrument's Edit →
SID editor, play keys, change waveform/filter and hear it on the next key.

## The spectrum / waveform proof (jt_letgo)
`sid-spectrum-taps.test.ts`: real SidDoc → store → real `.cmod` → host `parseSongBuffer` →
`applySongFile` → `spectrumTrackNodes` = three distinct non-null taps, each `songBank.getTrackTap(i)`;
`trackAudioNodes[0..2]` = the same taps, kept through `updateTrackAudioNodes`, the per-note callback
and play/stop clears; nulls when the analyzer and scopes are off (native parity); AHX still `[]`;
both TrackerPage and JukeboxPage bind `spectrumTrackNodes` and `trackAudioNodes[...]` from the host
(source pin). Analyzer: 3 live taps → 3 analysers, no master connection; 3 nulls → stereo master.
**Red evidence:** NC1 in `.ai/checks-s4-red-controls.txt` — with `useTrackerSongHost.ts` and
`TrackerSpectrumAnalyzer.vue` from `1ded41f4` (unfixed), 3 of 7 fail (spectrum taps null, waveform
nodes null, analyzer drops 3 taps to the master); restored, 7/7. The first red run during the build is
`.ai/checks-s4-red-spectrum.txt` (same 3 failures). Resolution: the analyzer renders SID's three
voices per track, like a MOD's four (the "same quad/stereo resolution" of the plan row).

## Instrument page and its visuals feed
Waveform bits (tri/saw/pulse/noise/ring/sync/test) with the chip's wave cycle; ADSR with datasheet ms
and the envelope curve; pulse width (+%) with the pulse-table lane; filter enable / cutoff (Hz on the
song's chip) / resonance / LP-BP-HP with the response curve and cutoff lane; wave/speed pointers,
vibrato delay, first-frame byte, gate timer, hard restart with the pitch lane; the chip model shown and
switchable (per song); New instrument; the four shared tables as hex byte rows, this instrument's rows
marked. Keys play the instrument on the SID preview voice (its own worklet), whose output feeds the
page's scope + spectrum. Edits are doc ops through `editSidDoc` (undo step) and round-trip through the
slots (names re-derived from the doc) and doc→file→doc; an unedited song's file is still byte-exact
(S3's chain test green; page test re-checks).
Visuals: `simulateSidInstrument`, `sidEnvelopeLevels`, `sidWaveCycle`, `sidCutoffHz`/`sidResonanceQ`
reproduce the Rust dump exactly (every envelope level, every register of 96 frames × 4 instruments,
waves on both models incl. 6581 combined); all matched on the first comparison — no port or fixture was
adjusted. The Rust test fails if the Rust drifts from the committed fixture.

## What S5 inherits
- `adoptSidDoc` stays the importer's entry point; imported songs are immediately grid-editable, playable,
  and have an instrument editor.
- Grid ↔ doc mapping is `sidGridLayout`; an import that produces orderlists GT-style needs nothing more.
- Player semantics are still S3's INFERRED ones; S5 pins them against real `.sng` (wave-table
  `$F0-$FE` commands, funktempo, HR ADSR 0/0, 50 vs 50.125 Hz). The visuals ports must follow any
  player change: regenerate the fixture (`UPDATE_SID_VISUALS_FIXTURE=1 cargo test --features
  native-host --test sid_visuals_parity`) and fix the TS ports until `sid-instrument-visuals.test.ts`
  passes.
- Any change under `rust-wasm/src` requires a committed `public/wasm` + worklets rebuild (the freshness
  tests are green now and will go red otherwise).
- S7 (dual SID): the analyzer's layout table takes a 6-entry row; the transport's `SID_VOICES`, the
  worklet's 4 outputs and `getTrackTap(0..2)` are the places that grow. Not built.

## Honest caveats
1. **No real-browser audio check** (above). The worklet shell itself (`sid-worklet.ts`) is not executed
   by any test; its logic is mirrored by the test's `pump`.
2. **Per-voice taps are pre-filter.** The filter is shared (and nonlinear on the 6581), so a filtered
   voice's scope/spectrum shows it unfiltered; the mix is exact. Documented in `chip.rs`.
3. **Seek is "cold" for envelopes.** `seek_row` replays the sequencer without clocking the chip and
   keeps the running chip, so held notes carry on and notes started during the replay begin their
   envelopes at the seek, not where they would be. Same for "play pattern" loop wraps.
4. **Playhead past the song's end** is shown modulo the song length; exact only when every voice's
   orderlist restarts at its top (voices loop independently from `restart`).
5. **Edits while playing** reload after 150 ms of quiet (`SID_RELOAD_IDLE_MS`) at the current row —
   a short discontinuity, and the cold-envelope caveat applies.
6. **Grid refusals come after the undo snapshot in one case**: a note typable in C-0..G#7 but pushed
   out of the table by the cell's orderlist transpose is reverted by the write-back's safety net, leaving
   an empty undo step (AHX's net behaves the same). The pre-guard cannot know the cell's transpose.
7. **The PList canvas did not transfer**: SID instruments point into four shared two-byte tables, not an
   own PList; tables are edited as hex rows. No table playhead in v1.
8. The filter response curve is an ideal 2-pole display, not a port (6581 saturation and warping not
   drawn) — labelled on the page.
9. Commit granularity: `1ded41f4`'s playback test asserts the host taps that land in `9fdb8b3b`, so
   that one test file is red at `1ded41f4` alone (bisect note).
10. No D-log entry in `PLAN-module-format-support.md` §8: S3 made none either; SID landings are recorded
    in the plan's §6 "Landing records" by the orchestrator.
11. The page has no dedicated keyboard (typing-to-play) path like the AHX audition bar; the on-screen
    keys only.
12. Zero new deps; goldens untouched; `.ai/worktree-owner` untouched.
