# S3 verdict — SID song model + format profile (coder's record, completed by the orchestrator)

Branch `agent/sid-song-model-0923a`, off main `3cf01ba1`. Not pushed, not merged.
Plan: `.ai/plan-sid-tracking.md` §6 row S3. Template: `.ai/plan-hvl-editing.md` §8 (doc model first).
**Environment note (honest):** the branch was cut at `3cf01ba1`, which predates main's docs commit
`e1c2eaab` (the only main change during this run — it commits `.ai/plan-sid-tracking.md` itself).
The plan file was therefore NOT present in this worktree while coding; the coder worked from the
orchestrator's task brief and the landed S1/S2 code. No code changed on main, so the branch merges
cleanly; a later reviewer should diff against `e1c2eaab`.

## What landed

| Piece | Where | What it is |
|---|---|---|
| `SidDoc` | `src/audio/tracker/sid-doc/` (`types.ts`, `doc.ts`, `ops.ts`, `sid-file-codec.ts`, `projection.ts`, `index.ts`) | The SID song model, AhxDoc-style: immutable, `markRaw` + top-level frozen, readonly fields, ops return new docs sharing untouched parts. `makeSidDoc` is the single constructor and refuses a doc that breaks a model rule (`sidDocProblem`), so every doc serializes. |
| `moduleFormat: 'sid'` | `packages/tracker-playback/src/types.ts` | Added to the union. |
| `SID_PROFILE` + SID pitch model | `format-profile.ts`, `pitch-model.ts` | `profileForFormat('sid')`; pitch = the GT-range note table (`sidNoteFreqReg`, `createSidPitchModel`). |
| Store | `src/stores/tracker-store.ts` | `sidDoc` state; `adoptSidDoc` (entry point for S5 import / new song), `adoptSidFile` (load), `commitSidDoc` (edit), `showSidDoc` (projection); `serializeSong` embeds `data.sidFile`; `loadSongFile`/`resetToNewSong` clear it; `isSidSong`; SID grid read-only; add/remove track refused. |
| File IO | `src/composables/useTrackerFileIO.ts` | Save refuses a SID song whose doc did not load (true one-liner). Load needs no change: `applySongFile` already calls `songBank.setModuleFormat(store.moduleFormat)`. |
| Instrument routing | `src/audio/tracker/instrument-types.ts` | `'sid'` format: badge `SID`, no editor (`null`) until S4, not a sampler lineage. |
| Rust song file | `rust-wasm/src/sid/song.rs` | `SidSong::parse` / `to_bytes`: the same `ASID` layout as the TS codec. |
| Rust player | `rust-wasm/src/sid/player.rs` | `SidSongPlayer`: plays a `SidSong` on a `Chip` of the song's model, per 50 Hz × multispeed frame (sequencer, commands, wave/pulse/filter/speed tables, vibrato, hard restart). `sid::gt_note_freq_reg` in `mod.rs`. |

### The SidDoc (what it carries)
- Song: `songName`, `author`, `copyright` (≤32 latin-1), **`chipModel: '8580' | '6581'`** (the per-song
  tag S2 deferred; maps to `SidModel::Sid8580`/`Sid6581`), `channels` (3), `speedMultiplier` 1..16
  (frames at 50·n Hz), `tempo` 1..127 (ticks per row), `subsongs` 1..32 (each: one orderlist per
  channel: entries `{pattern, transpose −64..63, repeat 1..16}` + `restart`), `patterns` 1..208
  (1..128 rows of `{note, instrument, command, param}`), `instruments` 0..63.
- Instrument: `attack/decay/sustain/release` 0..15, `waveform` (control byte, gate bit clear),
  `pulseWidth` 0..4095, `filter {enabled, cutoff 0..2047, resonance 0..15, mode LP|BP|HP}`,
  `firstWave`, `gateTimer` 0..63, `hardRestart`, `vibratoDelay`, and pointers into the tables
  (`wavePtr`, `pulsePtr`, `filterPtr`, `speedPtr`).
- Tables: `wave`, `pulse`, `filter`, `speed` — GT's uniform `{left, right}` step rows, ≤255 each.

## Decisions + rationale
1. **Arpeggio table = the wave table's right column.** The brief lists "waveform table, arpeggio
   table" separately; GT keeps them as one table so a waveform step and its note step always advance
   together. A separate arpeggio table would desync from the wave column and would not map 1:1 onto
   GT (S5). Documented on `SidTableRow` and in the player header.
2. **Instrument-level waveform/pulse width/filter AND table pointers.** The brief asks for both;
   the fields are the defaults a note starts with, the tables (when pointed at) move them per frame.
   For a GT import (S5) the base fields are defaults and the tables carry the data; S6's writer must
   fold a non-default base into a table row (noted for S6).
3. **Separate `sidDoc` field, not inside `ahxDoc`** — same reasoning as HVL P1 deviation 1: `ahxDoc`
   gates ~15 AHX edit/publish/save readers (`isAhxEditable`, `publishAhxBytes`, `ahxFile` embedding,
   the write-back watcher). A separate field changes none of them.
4. **SID grid is read-only in S3** (`isReadOnly` → true for `'sid'`). The grid is a projection with
   no write-back; an edit there would silently diverge from the doc (the save authority). S4 opens
   grid edits. Doc edits go through `commitSidDoc` (API only, no UI). No undo step yet: undo/redo
   and history are blocked by `isReadOnly` and S4 introduces SID history with the editor (the AHX
   precedent). `ahx-readonly-audit.test.ts` counts stay 4/7/0/25 (no new line names `isReadOnly`; the
   getter's pinned `return … 'ahx' && this.ahxDoc === null;` line is unchanged, the SID case is an
   early return above it).
5. **Own binary codec (`ASID` v1), not JSON, in `data.sidFile` (base64).** It is the one
   representation both TS and Rust read, so the Rust player consumes exactly what the store saves,
   and byte-exactness is meaningful. Canonical encoding (reserved bits must be clear; the reader
   refuses what the model refuses) makes `serialize(parse(b)) == b` hold for every accepted file,
   not just ones we wrote. **No song-file version bump**: `sidFile` and `'sid'` are additive to v5
   (as HVL's `ahxFile` was in P3); an older build shows the grid and plays nothing.
6. **Pitch model = GT note table semantics.** 93 notes C-0..G#7 (B-7 would need register 67 277 >
   16 bits — GT's range ends at G#7 for the same reason). Registers derived from the datasheet
   formula (A-4 = 440 Hz equal temperament at PAL 985 248 Hz, rounded), not copied from GT (plan
   §8.3). `frequencyFromPeriod` on a note returns the **register-quantized** pitch (A-4 = 440.0291 Hz);
   between notes it is linear in the register (how a SID portamento moves); exactly invertible.
   Period grain 64/semitone, G#7 = 0, `kind: 'linear'`. Pinned identically in TS and Rust
   (278 / 7493 / 56576).
7. **Timing: PList rows at 50 Hz.** Frame = 1/(50·speedMultiplier) s; row = `tempo` frames. The TS
   engine gets `bpm = 125·n`, `initialSpeed = tempo`; for n ≥ 3 (engine BPM caps at 255) 250 BPM
   with a rounded scaled speed — only the TS clock is approximated, the Rust player is exact.
8. **Grid projection of independent orderlists.** A position is cut wherever *any* voice starts a
   pattern; song length = the longest voice's first pass; shorter voices loop from their restart
   (as the player does). Notes are shown as they sound (transposed) and carry the chip's own
   frequency; `positionTranspose` holds each voice's orderlist transpose.
9. **Routing through the playback store**: `tracker-playback-store.loadSong` routes only `'ahx'` to
   the worklet, so a `'sid'` song takes the engine path: `songBank.setModuleFormat('sid')` →
   `engine.loadSong` → `profileForFormat('sid')`. No playback-store change was needed.
10. **Player semantics are INFERRED from GT's documented table/command semantics** (header of
    `player.rs`; GPL code not consulted). S5 pins them against real `.sng` files.

## Test inventory
TS (vitest): **+22 new tests, 1 changed**
- `src/tests/sid-doc.test.ts` (13): doc raw/frozen/not-proxied; new-song shape; 15 model-rule refusals;
  op structural sharing; 11 op refusals leave the doc unchanged; every op lands; **round-trip gate**
  (doc→file→doc equal, file→doc→file byte-exact) on the chain song and on a doc at every codec limit
  (32 subsongs × 254 entries, 208 × 128-row patterns, 63 instruments with every flag, 4 × 255-row
  tables, latin-1 edge chars/whitespace); non-canonical refusals; base64 `.cmod` codec; projection
  (positions, transposes, register frequency, key off, commands, looping short voices); timing map.
- `src/tests/sid-format-chain.test.ts` (9): `profileForFormat('sid')`; note-table pins; pitch model
  (note = register, round-trip, monotone, arpeggio, linear-in-register glide); bank pushes the SID
  model to held instruments; **the chain** (below); fixture byte-exact; edit→save→load; doc-less
  SID save refused with the notice; 3 voices fixed, reset/load clears the doc, native songs carry no
  `sidFile`.
- `src/tests/instrument-types.test.ts` (changed, intended): routing table pins `sid: null`; SID slot
  opens no editor; badge `SID`.
- Helper: `src/tests/helpers/sid-chain-song.ts` (the chain song, built with the doc's ops).

Rust (`cargo test --features native-host`): **+18 new tests**
- `src/sid/tests_s3.rs` (14, unit): note-table pins; file round-trip at limits + refusals; A-4 plays
  its register (Goertzel 440.03 vs 466.16 Hz); rows every `tempo` frames at 50 Hz; multispeed;
  orderlist repeat/transpose/restart; wave table waveform+arpeggio; pulse table; filter table and
  instrument filter; key off / key on / first-frame waveform / hard restart; porta, tone porta;
  instrument vibrato; song's model is the chip's, both models audible and different.
- `tests/sid_song_chain.rs` (4, integration, reads the app-produced fixture): byte-exact both ways
  in Rust + every doc field; frame-by-frame render proof; both models; subsong 1.

### Invocations and counts
- `npm run test:run` — baseline (recorded by the orchestrator on this tip): 3932 passed, 2 failed
  (both `src/tests/artifact-freshness.test.ts`, stale `public/wasm`, out of scope).
  After: **3954 passed, 2 failed** (3956), 1 failed file | 244 passed (245), EXIT 1 — +22 new
  tests, zero new failures; the 2 failures are the same pre-existing artifact-freshness pair
  (`.ai/checks-s3-test.txt`).
- `cd rust-wasm && cargo test --features native-host --no-fail-fast` — baseline this tip
  **352 passed / 1 failed / 1 ignored**, EXIT 101 (`.ai/checks-s3-baseline-cargo-test.txt`; the 1
  failure is `ahx_render_golden::manifest_covers_every_fixture`, pre-existing). After:
  **370 passed / 1 failed / 1 ignored** across 18 targets, EXIT 101 — +18 new tests, zero
  regressions; the single failure is the same pre-existing
  `ahx_render_golden::manifest_covers_every_fixture`. Counts summed from the complete rerun
  `.ai/checks-s3-final-cargo-test-rerun.txt` (the coder's in-flight capture,
  `.ai/checks-s3-final-cargo-test.txt`, is truncated mid-suite and superseded by the rerun).
- **Plain `cargo test` does not build** (as S1 recorded: `tests/engine_node_integration.rs` and
  `tests/envelope_preview.rs` import `audio_engine::native`, which needs `native-host`);
  `--features native-host` is required. S3's own tests need no feature, but share the build.
- Negative controls (`.ai/checks-s3-negative-controls.txt`): flipping the fixture's chip byte turns
  the Rust chain test and the TS fixture test red; breaking the player's arpeggio turns the Rust
  chain + unit test red; editing the app song without regenerating the fixture turns the TS chain
  test red; all green again after restore.

## The end-to-end proof (jt_letgo rule)
1. `sid-format-chain.test.ts` › "save -> load …": `buildSidChainSong()` (a SidDoc made through the
   doc's ops) → real Pinia tracker store `adoptSidDoc` → **real `handleSaveSongFile`** (JSZip `.cmod`;
   only the OS file picker is stubbed to catch the blob) → **real `loadSongFromFile` →
   `loadSongFromBuffer` → `applySongFile`** into a second real store, with a **real
   `TrackerSongBank`**, the **real `useTrackerSongBuilder`** and a **real library `PlaybackEngine`**.
   Asserts: the loaded `sidDoc` equals the saved one; grid/sequence/tempo/slots; `setModuleFormat`
   called with `'sid'` twice (applySongFile + playback load) and the bank's profile is `SID_PROFILE`;
   the built `PlaybackSong.moduleFormat === 'sid'`; `engine.getFormatProfile() === SID_PROFILE`; the
   first step is MIDI 69 at 440.0291 Hz (the chip's register pitch).
2. "the file the chain saves is the Rust fixture": the second store's `data.sidFile` bytes equal the
   first's (save→load→save byte-exact) **and equal `rust-wasm/tests/fixtures/sid/s3-chain.asid`
   byte for byte** (523 bytes). The fixture is this chain's output, written only under
   `UPDATE_SID_CHAIN_FIXTURE=1`; the test fails on any drift (negative control NC3).
3. `rust-wasm/tests/sid_song_chain.rs` includes those bytes: `SidSong::parse` → `to_bytes()` ==
   fixture; `SidSongPlayer::new` builds a **6581** chip from the song's own tag; 192 frames through
   the real S1/S2 `Chip` asserting, per frame: A-4 register 7493 + triangle gate (frame 0); the
   C/E/G arpeggio registers and pulse control (48–53); pulse table widths (48–52, 80, 81);
   A-3 (E-3 + transpose 5) with the filter table's LP/res 12/cutoff sweep (60–63, 125, 130); key-off
   release (96); first-frame 0x09 then vibrato +40/+80/+40/0/−40/−80 (120–136); porta +0x40/frame
   (168–173); hard-restart gate-off (190); every orderlist wrapped at 192; output finite, in range,
   audible, and the solo A-4 dominating 466 Hz by >100× (Goertzel). Plus both models render and
   differ, and subsong 1 plays its own orderlists.

## What S4 / S5 inherit
- **S4**: grid write-back for SID (the projection is not invertible yet: positions cut across shared
  patterns — S4 decides how an edit maps back, e.g. a per-channel pattern view); lift `isReadOnly` for
  SID and add SID undo (snapshots must carry `sidDoc` by reference, like `ahxDoc`); the instrument page
  (`INSTRUMENT_EDITOR_BY_FORMAT.sid` is `null`); **browser audio**: a worklet/wasm-bindgen wrapper
  over `SidSongPlayer` (needs a committed `public/wasm` rebuild — deliberately not done here) and a
  `'sid'` branch in `tracker-playback-store` like `'ahx'`; until then a SID song in the browser loads,
  shows and saves, but the TS engine has no SID instruments, so it is **silent**; the spectrum/visual
  parity hooks (`useTrackerSongHost` still has only the `'ahx'` branch).
- **S5**: map GT `.sng` onto `SidDoc` (`adoptSidDoc` is the store entry point); pin the player's
  INFERRED table/command semantics against the corpus (wave-table `$F0-$FE` commands and funktempo
  are not modelled; hard-restart ADSR is 0/0; exact 50 Hz vs 50.125 Hz); GT repeat/transpose
  orderlist bytes map onto `repeat`/`transpose`.
- **S6**: `SidInstrument` base waveform/pulse/filter have no GT field — a writer folds them into table
  rows or refuses.

## Honest caveats
- **Sample-rate model (plan §1.1)**: the chip is S1/S2's cycle-counted digital core under a
  sample-rate analog path; register writes land on output-sample boundaries (frame starts), not on
  exact CPU cycles. Not cycle-exact.
- **No reference recordings exist** for any SID song played here; the render proof asserts register
  state and spectral sanity derived from the documented semantics, not "sounds like GT/reSID".
- Player semantics are INFERRED from GT's format documentation (no GPL code consulted); S5 is where
  they meet real files.
- The TS engine path for `'sid'` is exercised for format/profile/timing only; audio in the browser is
  S4 (above).
- `rustfmt` is not installed on this toolchain, so the new Rust files are hand-formatted.
