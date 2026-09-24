# S5.10 verdict: orderlist transpose/repeat semantics + vibrato rate (Streets red-first)

Branch `agent/sid-transpose-0924a`, one commit off `e3750ce3` (the brief's base). No push, no
merge. GoatTracker 2 source at `/tmp/gt2-src/src` was read for facts only; nothing was copied
(see §3 on the frequency table).

## 0. Streets: what was wrong, in one paragraph

The transpose decode was right. The **REPEAT decode was off by one**: GT plays `$Dk` k + 1 times,
we played it k times (and `$D0` 16 times). Streets has 13 repeat markers across its three
subtune-0 channels, so each channel lost a different number of rows: channel 1 lost 128 rows by
the key change, channel 2 lost 80, channel 3 lost 64. From the first repeat on, the three voices
drift apart. Played as GT plays them, all three voices of subtune 0 are **exactly 1824 rows
long** and change key to +3 **on the same row (1568)**. With the old decode they were
1696/1744/1760 rows long, and went to +3 at rows 1440, 1488 and 1504. That is the reported
"everything sounds off, something is not transposed right", sustained over several patterns.
Details are in §2 and `.ai/s510-streets-timeline.txt`. The note-range and vibrato fixes (§3-§5)
are real GT divergences as well, but they are **not** what the Streets report heard: no Streets
row note leaves C-0..G#7 under its transpose.

## 1. Red → green per fix

Red evidence is in `.ai/s510-red-vitest.txt` (5 failed / 36 passed, on the untouched TS) and
`.ai/s510-red-rust.txt` (10 of 10 new Rust tests FAILED on the untouched `player.rs`/`mod.rs`;
every failure is an assertion, not a setup panic; the values are quoted below). Green is the
full gate runs in §6.

| # | Fix | Ours (file:line, after) | GT ground truth | Red → green |
|---|-----|-------------------------|-----------------|-------------|
| 1 | Transpose decode: **no change**, regression pin | `gt-sng-common.ts:193-194` (`v - 0xF0`) | gcommon.h:40-42, gplay.c:971-974 | Pin `sid-transpose-s510.test.ts` "channel 2 entries 55-60": green before and after (by design) |
| 2 | Repeat decode `(v & 15) + 1`, export `$D0 + plays - 1` | `gt-sng-common.ts:22-35` (`gtRepeatPlays`/`gtRepeatByte`), `:196`, `:216`; `gt-sng-write.ts:108` | gplay.c:977-986 (repeat = byte - $D0; replays while it counts down); gdisplay.c:265 (shown R((k+1)&15)); readme §3.1 ("repeat 1-16 times, 16 is R0") | Red: Streets walk mismatch; key-change rows `[1440,1488,1504]` ≠ `[1568,1568,1568]`; old import/export pins. Green: all 41 in the three files |
| 3 | Note index wraps (u8), never clamped | `player.rs:189` `note_index`; `:630` `new_note`; `:639` `trigger` | gplay.c:921 `newnote = note + trans` (u8), :350 `note = newnote - FIRSTNOTE` (u8) | Red: `note_index(93,5)` = 92, not 97; G#7+5 played 56576, not 0; C-0-1 played 278, not 0. Green |
| 3b | Table shape: 96 notes, then zeros, 7-bit index | `mod.rs:131-158` (`GT_TABLE_NOTES`, `gt_note_freq_reg`); TS `pitch-model.ts:726` `sidTableFreqReg` | gplay.c:9-35 (128 entries: 96 real, B-7 = $FFFF, 32 × $00); gplay.c:720 `note &= 0x7f` | Red: `gt_note_freq_reg(95)` = 56576, not 65535. Green |
| 4 | Wave-table note column: GT mod-128 arithmetic | `player.rs:840` `wave_note`; `:818` (table-command rows `$F0-$FE` set no note and end the frame) | gplay.c:714-721 (`note < 0x80 ? note += cptr->note`; `note &= 0x7f`; `freqtbl[note]`; `vibtime = 0`; `lastnote`); gplay.c:529 + 711-712 (cmd rows `goto PULSEEXEC`) | Red: base 50 + $5F played 56576 (clamped to 92), GT gives 743 (17); base 10 + $60 played C-0, GT gives 0. Green |
| 5a | Vibrato: GT's u8 `vibtime` rate and phase, plus fine mode | `player.rs:687` `vibrato` | gplay.c:615-640 and 776-799 | Red (turn 16, speed 5, tempo 40): our first swing was 8 frames, GT's is 9; our half-swings were 16 frames, GT's are 18. Turn 1: ours flipped every frame, GT holds 3 frames. Green, equal to the oracle |
| 5b | Tick-0 skip for vibrato | `player.rs:713` (`tick0`), `:751`, `:755` | goattrk2.c:55 `optimizerealtime = 1`; gplay.c:728 | Covered by the tempo-6/40 oracle sequences (frames 6, 12, 40 hold). Green |
| 5c | A wave step that sets a note ends the frame (no effects) | `player.rs:465` (`if !self.wave_step(c)`) | gplay.c:722 `goto PULSEEXEC` | Covered by the oracle (frame 1 = the wave note). Green |
| 5d | Instrument vibrato = command 0 only; delay 0 never; starts at 1 | `player.rs:755-767` | gplay.c:767-772 (fall-through into CMD_VIBRATO); :351-358 (new note: command 0, cmddata = STBL, vibdelay) | Red: delay 3 gave `[0,0,0,7,0,-7,…]` (old centred swing, turn 2), GT gives `[0,0,0,7,14,7,0,-7,-14,…]`; under `1 00` the old player vibrated. Green |
| 5e | Running command: 5-F leave it, a new note resets it to 0 | `player.rs:578-600` (`run_cmd`/`run_param`), `:630` | gplay.c:397-428 (only 0-4 set `command`), gplay.c:351 | Red: `4 01` then `5 00`: old `[0,-10,0,-10,0,0,…]` (stopped), GT keeps swinging. Green |

The vibrato expectations come from an independent Python transcription of the gplay.c lines
(`.ai/s510-vibrato-oracle.py`), written before the Rust. The Rust tests pin its output. They do
not pin a run of the player.

**Brief claims I corrected against the source** (the brief asked me to re-verify each):

- The steady half-swing for turn value 16 is **18** frames (k + 2), not 17. The first up-swing is
  9 frames (k/2 + 1), as the brief said.
- Wave right column `$81-$FF` is an **absolute note** (`note & 0x7f`), not a delay. Delay rows are
  selected by the LEFT column, `$01-$0F` (gplay.c:522 `wave > WAVELASTDELAY`, 700-708).
- Indices 96-127 of GT's table are **zero**, not "played high". A transpose that wraps below C-0
  lands on 112-127, which is silence. The table is not 93 notes plus extrapolation: it is 96 real
  notes (A-7, A#7, B-7 = $FFFF) and then 32 zeros.
- gsong.c:321 is the **GTS2-4** loader, not GTS5. GTS5 stores speed tables raw. For GTS! (our
  Streets case), gsong.c:687-688 converts command 4 with **MST_NOFINEVIB** explicitly, even though
  `finevibrato` defaults to 1 (goattrk2.c:53). Our GT1 importer (`gt-sng-gt1.ts`, case 4) already
  does NOFINEVIB, so no change was needed. GT1 instruments have no vibrato byte: the GT1 loader
  (gsong.c:370-384) never sets vibdelay/STBL, and our importer's `vibratoDelay: 0, speedPtr: 0`
  matches.
- The brief's player.rs line numbers were stale. On the base, the clamp sites were `note_index`
  :161-166, preview :312, `read_row` :520 and `wave_note` :752-761. `trigger` never clamped by
  itself; it relied on `note_index`. All of them are fixed. The preview clamp is kept: it is UI
  input (C-0..G#7 keys).

## 2. Streets subtune 0, before/after, and what "order 81" is

Every row, all 61/30/23 entries: `.ai/s510-streets-timeline.txt`, from
`.ai/s510-streets-timeline.py`, an independent byte walker. The repeats (GT plays | we played):

- ch1: `$D8 01` 9|8, `$D5 01` 6|5, `$D2 19` 3|2 (twice)
- ch2: `$D2 00` 3|2, `$D2 16` 3|2
- ch3: `$DA 02` 11|10, `$D5 02` 6|5

Entry start rows around the report (old | GT):

```
ch1 e24 p0e +0  1312|1440   e25 p22 +0  1376|1504   e26 p0e +3  1440|1568   e27 p10 +3  1504|1632
ch2 e44 p0d +5  1408|1488   e45 p06 +0  1424|1504   e46 p0d -2  1456|1536   e48 p06 +3  1488|1568
ch3 e17 p0f +0  1376|1440   e18 p11 +0  1440|1504   e19 p0f +3  1504|1568
channel lengths 1696 / 1744 / 1760 (old)  vs  1824 / 1824 / 1824 (GT)
```

Channel 2 entries 55-60 (patterns 0d 06 0d 0d 0d 05, transposes +1 -4 -1 +1 -2 0) decode the same
before and after. Only their start rows move.

**"Order 81"** is the app's grid position, not an orderlist index. The SID grid cuts a position
wherever any channel starts a pattern (`sidGridLayout`, `grid.ts:104`; the bug report's
`order` = `playbackStore.currentSequenceIndex`, `JukeboxPage.vue:396-403`). With the old decode,
Streets had 99 positions. Position 81 is song rows 1456-1471, and there ch1 played entry 26 (p0e
**+3**, row 16), ch2 entry 46 (p0d -2) and ch3 entry 18 (p11 **+0**). So voice 1 was a minor third
above voice 3, and all three came from sections that GT plays 80-128 rows apart. Positions 78-94
(rows 1408-1695) are the stretch where ch1 had already modulated +3 and ch3/ch2 had not. That fits
the follow-up "persists for several patterns around 78-90". With GT's counts the channels align:
the grid has **71** positions, and the key change is position 58 (row 1568) on all three voices.
So order 81 does not exist as the same place after the fix. The same music is at grid positions
52-64.

## 3. The frequency table: derived, not copied (a deliberate deviation from the brief)

The brief said "if 93..127 differ, embed GT's actual table". `.ai/plan-sid-tracking.md` §3 rule 3
(load-bearing, and GPL discipline) says: "source or numeric tables copied from them are NOT
[fine]. Every table in our engine must be derived". I followed the plan. What is GT's is the
**shape**: 96 notes, B-7 clamped to $FFFF, zeros at 96-127, and the 7-bit index. Our values stay
the derived equal temperament (`note_to_freq_reg`). I compared all 128 entries against gplay.c:9-35
(in a scratch script, output not committed): 64 of the 96 notes differ by 1-16 register units.
That is under 0.5 cent everywhere except C-0 (279 vs 278, 6 cents). If Morten wants GT's
bit-exact numbers, that needs a licence decision, not a code change.

## 4. Corpus sweep (83 songs, `src/tests/fixtures/gt-songs`)

Method: `.ai/s510-corpus-sweep.ts`, a throwaway script run with `npx vite-node`. Output:
`.ai/s510-corpus-sweep.txt`. Orderlist markers are counted from the RAW bytes over every subtune
and channel. The note, wave and vibrato counts come from the imported doc, first pass of every
subtune.

- **Transpose markers ($E0-$FE): 48 songs, 1041 markers.**
- **Repeat markers ($D0-$DF): 5 songs, 43 markers.** Every one of those songs changes timeline
  with this fix: Streets 13 (`$D2×4 $D3×5 $D5×2 $D8 $DA`), Investigations 16 (`$D1×4 $D2×4
  $D3×6 $D7×2`), research_facility 5 (`$D1 $D3×4`), warlord 5 (`$D3×3 $D7×2`), dojo 4
  (`$D3 $D5 $D9 $DF`; its `$DF` was 15 plays, now 16).
- Most markers: Streets 81 T + 13 R; metal_warrior_4_investigations 58 + 16; balcony_princess 69
  + 0; midnight_dream 60; pagans_mind 54. Widest transpose range: balcony_princess -12..+12,
  investigations -6..+8, Streets -7..+5, forest_encounter -7..+1.
- Row notes leaving C-0..G#7 under their transpose (the old clamp): **0** in the corpus.
- Wave-table steps where the old and new note arithmetic differ, counted once per (instrument,
  triggered note): **2015 in 54 songs**. 1964 of them are ABSOLUTE notes above G#7 (`$DD-$DF` =
  A-7..B-7, typically drum noise pitches), which the old player clamped to G#7. 62 land on a zero
  entry (silence). 43 are relative steps past G#7, 8 wrap past 127, and 3 go below C-0.
- Command 4 rows: 68 songs, 14 084 row-plays. Turn value ≤ 2 (where the old rate was 2-3× too
  fast): 54 songs, 11 162 row-plays. Fine mode (left ≥ $80, unmodelled before): 4 songs, 158.
- Instruments with vibrato (delay > 0 and a speed row): 55 songs, 383 instruments. All of them
  change: the delay is now counted on tick-N frames only, and there is GT's rate.
- Rows with command 5-F under a running command 4 (the vibrato now continues through them): 23
  songs, 182 row-plays.

## 5. What changed beyond the brief's list (all GT-sourced, all disclosed)

- A **running command** (`run_cmd`/`run_param`) now drives the tick effects, portamentos included.
  So a slide also continues under a later 5-F row, as in GT (gplay.c:397-505). Pinned for vibrato
  only.
- The frame order is now **wave table first, tick effects only if no wave note** (gplay.c:722).
  For portamento and tie-note the audible result is the same as before, because the wave note
  won that frame anyway.
- Wave-table **command rows $F0-$FE** no longer set a note from their parameter byte, and they end
  the frame (gplay.c:529, 711-712). The commands themselves are still not modelled.
- `channel_freq` now includes vibrato, because GT's vibrato moves the frequency itself. A slide
  starts from wherever the vibrato left the frequency.
- The TS mirror `sid-instrument-visuals.ts` was ported to all of the above. Its **wave-delay step
  was aligned to the S5 pin too** (left + 1 frames, note after the wait); it was still pre-S5. The
  parity fixture was regenerated from the Rust (`UPDATE_SID_VISUALS_FIXTURE=1`); 63 lines changed,
  and the TS port reproduces it (7/7).
- Pins changed because they asserted the old semantics. Each change is commented in place:
  `tests_s3.rs` `note_table_pins_match_the_app` (index 200 → 7-bit; `note_index` wraps) and
  `instrument_vibrato_waits_then_swings_around_the_note` (now GT's sequence, verified against the
  oracle); `tests/sid_song_chain.rs` Vib-lead frames 131-141 and the porta frames 168-175 (they
  start from the vibrato's -40 and the vibrato resumes under command 0);
  `sid-sng-import.test.ts` / `sid-sng-export.test.ts` repeat bytes ($D3 → 4 plays, $DF = 16,
  export $D2/$DF/$D1). The helper comment in `sid-chain-song.ts` was updated. The `.asid` bytes
  are unchanged.
- The grid's `sidNoteIndex` clamp is kept. It is display/editing only, and its comment now says
  so.

**Known remaining differences (not this batch's):** portamentos 1-3 still slide on tick 0; GT
skips tick 0 for them too. GT's porta speed ≥ $8000 fine mode is unmodelled. Pitch is still set at
trigger even for an instrument with no wave table (in GT only the wave table sets it). The GT1
loader's `ident[3] < '4'` pulse-speed doubling and its `< '5'` firstwave/gatetimer pass
(gsong.c:817-845) apply to GTS! files. I saw them while reading; they are not checked here.

## 6. Gates (real exit codes in `.ai/checks-s510-*.txt`)

| Gate | Result | File |
|------|--------|------|
| cargo test `--features native-host --no-fail-fast`, baseline (base e3750ce3) | 386 passed / 1 failed / 1 ignored, EXIT=101 (the failure is the known `manifest_covers_every_fixture`, `tests/ahx_render_golden.rs`, AHX) | `checks-s510-cargo-baseline.txt` |
| cargo test, after | **396 passed / 1 failed (the same one) / 1 ignored**, EXIT=101. Delta +10 = the 10 new `tests_s510` tests; 3 changed pins are inside existing tests | `checks-s510-cargo.txt` |
| `npx vitest run` (full) | **258 files, 4179 passed, 0 failed**, EXIT CODE 0 (the known event-stream flake did not show) | `checks-s510-vitest.txt` |
| `npm run lint` | EXIT=0 | `checks-s510-lint.txt` |
| `npx vue-tsc --noEmit` | EXIT CODE 0 | `checks-s510-vuetsc.txt` |
| `gitleaks detect --no-git --source .` (`/usr/bin/gitleaks`) | no leaks found, EXIT CODE 0 | `checks-s510-gitleaks.txt` |
| `npm run build:wasm` + `build:worklets` | EXIT CODE 0 / 0. `public/wasm/audio_processor_bg.wasm` + `SOURCE_HASH.json` rebuilt and committed in the same commit; worklets byte-unchanged | `checks-s510-wasm-build.txt` |
| `node scripts/check-artifacts.cjs` | "public/worklets and public/wasm match their sources", EXIT CODE 0 | `checks-s510-artifacts.txt` |

Red runs: `.ai/s510-red-vitest.txt` (EXIT=1, 5 failed) and `.ai/s510-red-rust.txt` (EXIT=101, 10
failed). The Rust red was run by temporarily restoring the base `player.rs`/`mod.rs` with only
the new test module registered, then putting the new sources back.

## 7. Ear verification: NOT done

**No GoatTracker 2 A/B listening test was run in this batch, and nothing here was listened to.**
Everything above is proven by tests against the GT2 source, not by ear. What a human should check,
on a deploy of this branch:

1. **Streets** (aeuk/metal_warrior_4_streets.sng), the region the report names: now around grid
   position 52-64, song rows 1440-1824. All three voices should change key together at row 1568
   (position 58), and nothing should sound "off" through positions 50-70. Then listen through the
   loop: the channels no longer drift apart on each pass.
2. **Investigations** (cadaver/metal_warrior_4_investigations.sng), the other heavy repeat user
   (16 markers): same check for alignment.
3. **Vibrato rate** on any song with small command-4 values (54 songs; most mch/stinsen songs),
   and instrument vibrato (55 songs): it should sound slower and wider than before, with GT's
   triangle shape.
4. **Drums with absolute high notes** (`$DD-$DF` wave steps, e.g. stinsen/upsandowns,
   jeroenimo): noise hits now sit at A-7..B-7 ($FFFF) instead of being capped at G#7. That is
   brighter and should match GT.

## 8. Merge note

This branch is cut from `e3750ce3`, as the brief says. `main` has since taken S5.9 (`ad2a2bb6`,
the gate-bit fix, and `ac92f788`, an artifact refresh). `git merge-tree --write-tree main HEAD`
(non-destructive, nothing merged) reports **4 conflicts**:

- `rust-wasm/src/sid/player.rs`: textual neighbours. S5.9 rewrote the waveform/control-byte lines
  (header, command 7, `trigger`'s `ins.waveform | GATE`, the wave step's `0x10..=0xDF` /
  `0xE0..=0xEF` arms, `write_registers`' `waveform & mask`). S5.10 rewrote the note/vibrato lines
  right next to them (the same wave-step arms now also produce `noted`; `write_registers` lost
  `vib_offset`). The two are semantically orthogonal. Resolve by taking S5.9's waveform/control
  expressions inside S5.10's structure.
- `src/audio/tracker/sid-instrument-visuals.ts`: the same pair of edits in the TS mirror's
  `waveStep` and control line. Same resolution.
- `public/wasm/audio_processor_bg.wasm` and `public/wasm/SOURCE_HASH.json`: rebuild after
  resolving (`npm run build:wasm && npm run build:worklets`, then `check:artifacts`).

After resolving, regenerate `src/tests/fixtures/sid-visuals-parity.json`
(`UPDATE_SID_VISUALS_FIXTURE=1 cargo test --features native-host --test sid_visuals_parity`),
then re-run cargo and vitest. The `sid_song_chain.rs` frequency pins here do not depend on the
gate bit, but S5.9 regenerated `s3-chain.asid`, so re-check them there. I did not do this merge;
the brief says no merge.
