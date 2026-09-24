# S5.9 verdict: SID wave-table gate bit

Branch `agent/sid-gateoff-0924a`, worktree `.ai/worktrees/sid-gateoff`, based on 562cc2e9. Not pushed, not merged.

**Bottom line.** The player now handles the control byte as GoatTracker 2 does. A waveform byte from the wave table or from command 7 is kept whole, gate bit included. The register gets `waveform & mask`, where the mask is 0xFF while the channel's gate is on and 0xFE when it is off. Because of this, a drum program that ends on `$80` or `$40` now releases its note. Before the fix it held noise at the sustain level until the next note. One example: in Stinsen's "Forced Entry", a crash cymbal on voice 2 used to hiss for **61 s**. Across the corpus, 71 of 83 songs change in their first 180 s, and the gate bit is the only register bit that changes. The fix is verified in tests only. **Final ear verification is Morten's**, after a deploy, against his GT2 A/B.

Note on the ear report: "jt_letgo" in the brief is the house *real-production-path rule*. It is not a SID song: `jt_letgo.xm` is an FT2 module. The symptom that matters is Morten's "a lot of the drums … sound like pure white noise" (plan-sid-tracking.md, EAR-REPORT 2026-09-23 22:40).

## 1. GT truth, re-verified (file:line in /tmp/gt2-src)

- `gcommon.h:11`: `CMD_SETWAVE 7`. Our command 7 is GT's CMD_SETWAVE.
- `gcommon.h:57-61`: WAVELASTDELAY 0x0F, WAVESILENT 0xE0, WAVELASTSILENT 0xEF, WAVECMD 0xF0, WAVELASTCMD 0xFE.
- `gplay.c:525`: `if (wave < WAVESILENT) cptr->wave = wave;` stores the whole byte (inside `if (wave > WAVELASTDELAY)`, gplay.c:521).
- `gplay.c:527`: `$E0-$EF` → `cptr->wave = wave & 0xf`, which keeps the gate bit.
- `gplay.c:432-433`: pattern command CMD_SETWAVE → `cptr->wave = cptr->newcmddata`, whole.
- `gplay.c:651-652`: wave-table command CMD_SETWAVE → `cptr->wave = param`, whole.
- `gplay.c:945`: `sidreg[0x4+7*c] = cptr->wave & cptr->gate;`
- The gate is a mask:
  - 0xFE at `gplay.c:129` (new-note keyoff when gatetimer bit $40 is clear), `:148` (releasenote), `:916` (KEYOFF row) and `:926` (gate-off before a new note).
  - 0xFF at `:362` (new note, firstwave < $FE) and `:918` (KEYON row).
  - `:358` (firstwave ≥ $FE) sets the mask to the firstwave value.
- `gplay.c:356-364`: on a new note, firstwave 1..$FD → `wave = firstwave; gate = 0xff`.
- `gplay.c:193`: `wave = 0` at song init.
- Readme (`readme.txt` ~l.599-601): "The actual state of the gatebit will be the gatebit mask ANDed with data from the wavetable. A key on cannot set the gatebit if it was explicitly cleared at the wavetable." Its koto example (~l.811-813), `41 01 / 40 00`, adds "Gatebit is also cleared on the second tick."

### Correction to the brief: the table *can* re-arm the gate, but only while the mask is on

The brief says "table waveform bytes can NEVER re-arm the gate". That holds only after a key off or hard restart (mask 0xFE), because `x & 0xFE` always has bit 0 low. While the channel's mask is 0xFF, the register follows the table's own bit. A table running `$41, $40, $41` writes `$41, $40, $41` to $D404. That is a real 1→0→1 edge on the chip, so the envelope **retriggers**, which is exactly the readme's "gatebit mask ANDed with data from the wavetable". Test `a_gate_off_row_releases_and_a_later_gate_on_row_retriggers_while_the_channel_gate_is_on` pins this. The accurate statement is: **a table byte can re-raise the register's gate bit only if the channel's mask is on, i.e. only after the table itself cleared the bit. After a key off or hard restart, no table byte raises it; only a note, a key on or first-wave $FF does (gplay.c:358, 362, 918).** Test `after_a_key_off_no_table_byte_sets_the_gate_again` pins that half.

## 2. Our player, before → after (`rust-wasm/src/sid/player.rs`)

| Site | Before (562cc2e9) | After |
|---|---|---|
| wave row $10-$DF | `:732 ch.waveform = l & !GATE` | `:753 ch.waveform = l` |
| wave row $E0-$EF | `:733 ch.waveform = l & 0x0E` | `:754 ch.waveform = l & 0x0F` |
| command 7 | `:551 ch.waveform = p & !GATE` | `:564 ch.waveform = p` |
| trigger (instrument) | `:594 ch.waveform = ins.waveform & !GATE` | `:613 ch.waveform = ins.waveform \| GATE` |
| register write | `:875 ch.waveform \| if ch.gate { GATE } else { 0 }` | `:897 ch.waveform & if ch.gate { 0xFF } else { !GATE }` |
| first-frame passthrough | `:872-873` raw `first_wave` | **unchanged** (`:893-894`; S5.6 pin; report 8.8 out of scope) |

The header (`:14-35`, `:44-45`, `:62-67`) now documents the mask semantics.

**Trigger path.** The doc's instrument `waveform` has no gate bit by format (`song.rs:17`, `doc.ts:156`, and the editor refuses to set it, `sid-instrument-edit.ts:46`). Under the AND write it must therefore carry the bit, or every instrument would be silent. `ins.waveform | GATE` produces exactly the register the old OR write produced: `0x01` for an imported GT instrument (whose `waveform` is 0, gt-sng-read.ts:240-242) and `W|1` for a doc-native one. So the gate-on sound is unchanged. **Residual divergence (not fixed, disclosed):** from frame 1 until the wave table writes a waveform, GT holds `firstwave` (gplay.c:361, typically $09) and we hold `W|1`. The two differ only for instruments whose table does not write a waveform on its first executed row. In the corpus that is 21 of 1624 instruments: 13 with no wave table and 8 whose first row is a delay, a `$00` or a table command. There is also one instrument with first-wave `$00`. This belongs with report 8.8 (first-wave handling) as a follow-up.

**TS mirror.** `src/audio/tracker/sid-instrument-visuals.ts` (the S4 instrument-page port of the player) had the same strip/OR logic at `:257, :312-313, :410`. It is ported identically. The parity fixture `src/tests/fixtures/sid-visuals-parity.json` does not change, because the chain song's registers do not change (see §4). *Observed, not touched:* this port's wave-delay step also predates the S5 delay pin (it waits `left` frames and applies no note). The parity fixture cannot see this because the chain song has no delay rows. That is a separate follow-up.

## 3. Register-write semantics (after the fix = GT; the first frame of a note with first-wave ≠ 0 is the raw passthrough in both)

| Source byte | Stored `waveform` | $D404, channel gate ON (mask $FF) | $D404, channel gate OFF (mask $FE) | Before the fix (either gate) |
|---|---|---|---|---|
| table $10-$DF, bit 0 set (e.g. $41, $81, $21) | whole | $41 / $81 / $21, gate high, no edge if already high | $40 / $80 / $20 | `(b & $FE) \| gate` |
| table $10-$DF, bit 0 clear (e.g. $40, $80, $10) | whole | **$40 / $80 / $10: release** | same | `b \| gate`, **held** when on |
| table $E0-$EF, bit 0 set (e.g. $E9) | `b & $0F` = $09 | $09 (test + gate) | $08 | $08 \| gate |
| table $E0-$EF, bit 0 clear (e.g. $E8, $E0) | $08 / $00 | **$08 / $00: release** | same | $08 / $00 \| gate |
| table $00, $01-$0F, $F0-$FE, $FF | unchanged | — | — | — |
| command 7, param P | P | P | P & $FE | `(P & $FE) \| gate` |
| trigger, instrument waveform W (gate-clear) | W \| 1 | W \| 1 | W | same registers as before |

A waveform change that keeps the bit high (`$41 → $21 → $11`) writes only $D404 bits 1-7. The envelope sees no edge and does not retrigger. Test `a_gate_on_waveform_change_from_the_table_does_not_retrigger` shows the level falling monotonically through 7 such changes.

## 4. Tests: red → green

### New: `rust-wasm/tests/sid_gate_off.rs` (6 tests)

The real-song test uses `fixtures/sid/s59-drum-example.asid`. That fixture is Cadaver's `goattracker_drum_example.sng` put through the real `importGtSong` and `serializeSidFile`. `src/tests/sid-gate-off.test.ts` pins it byte for byte and regenerates it with `UPDATE_SID_GATEOFF_FIXTURE=1`. The Rust test parses it with `SidSong::parse` and plays it on `SidSongPlayer`. Red was run on the unfixed player (`.ai/s59-red-rust.txt`):

```
test e0_to_ef_rows_keep_the_low_nibble_gate_bit_included ... FAILED
  left: [9, 65, 9, 9]            right: [9, 65, 8, 8]
test a_gate_off_row_releases_and_a_later_gate_on_row_retriggers_while_the_channel_gate_is_on ... FAILED
  left: [65, 65, 65, 65, 65, 65] right: [65, 65, 64, 64, 65, 65]
test command_7_sets_the_whole_control_byte ... FAILED
  left: [65,65,65,65,65,65,65,65, 129, 129]  right: [...,128, 128]
test a_drum_tables_gate_off_rows_release_the_note_in_the_real_song ... FAILED
  left: [9, 129, 65, 65, 64, 64, 9, 129, 129, 129, 128, 128]
 right: [9, 129, 65, 64, 64, 64, 9, 129, 128, 128, 128, 128]
test a_gate_on_waveform_change_from_the_table_does_not_retrigger ... ok   (guard; true before and after)
test after_a_key_off_no_table_byte_sets_the_gate_again ... ok             (guard; true before and after)
test result: FAILED. 2 passed; 4 failed
```

In the real song, voice 3 before the fix kept `$41` on frame 3 (bass-drum row 03 `$40`) and `$81` on frames 8-9 (hi-hat row 0D `$80`). The gate dropped only at the hard restart. Green is in `.ai/checks-s59-cargo.txt`: all 6 `... ok`, and the test asserts `Stage::Release` on frames 3, 8 and 9.

### New: `src/tests/sid-gate-off.test.ts` (3 tests). Red was run against the unrebuilt wasm and TS (`.ai/s59-red-vitest.txt`)

- *Fixture pin*: green from the start (it is the pin).
- *Instrument-page visuals*: `simulateSidInstrument(drum example, hi-hat)`. Red: `[9, 129, 129, 129, 129]`. Expected `[9, 129, 128, 128, 128]`.
- *SidProcessorCore over the real wasm*: "Forced Entry" goes through the real importer and codec into the worklet render core. Voice 2 is struck at frame 3170 by instrument 16 "Crash-nofilt" (SR $CB, table `4C 71 DF / 4D 80 DF / 4E FF 4D`). The test measures voice 2's tap over frames 3450-3549. Red: `expected 0.24495425820350647 to be less than 0.001` (the hiss). Green: under 1e-3 after `npm run build:wasm` (`.ai/s59-green-vitest.txt`: 3 passed).

### Existing tests whose *song bytes* were re-authored

No assertion changed. Three pre-existing test songs were written under the old INFERRED semantics: wave rows with the gate bit clear, expected to play gated. Under GT truth those rows are gate-offs, so I changed the rows to the bytes a GT author would type. Every assertion is byte-identical. **All three were run green on the unfixed player after the data change** (`/tmp/s59-prefix-cargo.txt`: lib 234 ok, sid_song_chain ok, sid_visuals_parity ok). Since the old player ignored the bit, the data change is invisible to it, which shows the pins were not weakened:

- `rust-wasm/src/sid/tests_s5.rs` `wave_porta_song` (the **S5.6 passthrough pins**): `$10, $20` → `$11, $21`. Frequencies and the final `0x21` are unchanged.
- `rust-wasm/src/sid/tests_s3.rs` `wave_table_is_waveform_and_arpeggio`: `$40, $40, $20` → `$41, $41, $21`.
- `src/tests/helpers/sid-chain-song.ts` (the S3 chain song, "Arp pulse"): `$40 ×3` → `$41 ×3`. `rust-wasm/tests/fixtures/sid/s3-chain.asid` was regenerated with `UPDATE_SID_CHAIN_FIXTURE=1` (same 523 bytes, 3 bytes differ). The visuals parity JSON is unchanged.

I flag these because the brief's STOP rule covers pins. Reviewer: please confirm this reading. Each assertion is intact, and only the test song's bytes moved to GT form.

**Migration note:** a SID song someone authored in the app before S5.9 with gate-clear wave rows (e.g. `$40`) will now release on those rows, as it would in GoatTracker. The app is days old and has no known user songs, but this is a behaviour change for app-authored data.

### Pins held

- S5 tie-note: `tone_portamento_zero_is_gt_tie_note_…`, ok.
- S5 wave delay: `a_delayed_wave_step_waits_then_sets_its_note_the_readme_minor_chord`, ok.
- S5.6 tick-0 phase and wave passthrough: `a_wave_table_note_passes_through_a_tie_…` and `…_speed_glide_…`, ok.
- The first-frame passthrough branch is untouched.
- Corpus pattern-data counts were re-derived with the real importer (`.ai/s59-corpus-counts.txt`): **478 delay rows / 36 files; 4791 `3 00` real-note rows / 56 files** out of 61 GTS5 files. Unchanged.

## 5. Corpus impact

**Static scan** (`.ai/s59-corpus-scan.ts` → `.ai/s59-corpus-scan.txt`, via the real importer). This walks each instrument's wave program from its pointer, following jumps. **75 of 83** songs have an instrument whose program writes a gate-off byte. In **73** of them such an instrument is on a pattern an orderlist plays. **No** played pattern row uses command 7 with a gate-clear parameter. The per-song list with instrument names and table rows is in the scan file. Examples:
- `cadaver/goattracker_drum_example`: Bassdrum 03/04 `$40`, Snaredrum 09/0A `$80`, Hihat 0D `$80`.
- `shinobi/wod`: bassdrum 6F `$80`.
- `stinsen/tribal_tribunal`: kick 06-08 `$10`, toms `$10`.
- `stinsen/tribal18`: only one *unused* instrument carries one, so its playback does not change.

**Playback diff** (`.ai/s59-playback-diff.txt`). Every corpus song was played for 180 s on the player before and after the fix, and the $D404 values of all three voices were compared frame by frame:
- **71 of 83** songs change. 189 031 voice-frames flip the gate bit.
- **0 frames change any other control bit**, and **0 frames gain a gate bit.** The fix only ends notes earlier.
- Noise-with-gate frames drop sharply, which is the white-noise symptom:
  - forced_entry: 6484 → 283
  - sunset_shuffle: 6460 → 1051
  - graffiti_intro: 9467 → 1443
  - two_years_in_gp: 4101 → 757
- Longest removed tails:
  - forced_entry voice 2: 3045 frames (61 s)
  - wod voice 1: 125 frames (2.5 s)
  - drum_example: 2 frames per hi-hat. Its hard restart masks most of the difference.
- The 12 unchanged songs are listed with zeros in the diff file.

## 6. Gates (exit codes are appended in each file)

| Gate | File | Result |
|---|---|---|
| `cd rust-wasm && cargo test --all-targets --features native-host` | `.ai/checks-s59-cargo.txt` | **EXIT 101.** The only failure is the known pre-existing `manifest_covers_every_fixture` (ahx_render_golden: `left: 99 right: 24`). This command stops at the first failing binary, so the file also holds a `--no-fail-fast` run (EXIT 101): **392 passed, 1 failed (the same one), 1 ignored**. It covers all SID binaries, including the 6 new tests. Before the fix, the same run was 388 passed / 5 failed (the 4 red tests + the known one). |
| `npm run test:run` | `.ai/checks-s59-vitest.txt` | **EXIT 0**: 258 files / 4177 tests passed. |
| `npm run lint` | `.ai/checks-s59-lint.txt` | **EXIT 0** |
| `npx vue-tsc --noEmit` | `.ai/checks-s59-vuetsc.txt` | **EXIT 0** |
| `gitleaks detect --no-git --source .` (`/usr/bin/gitleaks`) | `.ai/checks-s59-gitleaks.txt` | **EXIT 0**, "no leaks found" |
| `node scripts/check-artifacts.cjs` | `.ai/checks-s59-artifacts.txt` | **EXIT 0**: `✓ public/worklets and public/wasm match their sources` |

The wasm was rebuilt in this commit with `npm run build:wasm` (SOURCE_HASH sources `4f5d59b31824`). This is a worktree build, so its bytes differ from a main-checkout build; the artifact gate is the authority.

## 7. Scope and follow-ups

Not touched: importer, table data, `waveform.rs`, `envelope.rs`, `chip.rs`, noise LFSR. Open follow-ups:
1. Report 8.8: first-wave $FE/$FF written raw on the trigger frame.
2. The trigger-path residual in §2: GT holds firstwave until the table writes. This affects 21 instruments.
3. The TS visuals port's pre-S5 wave-delay step.

**Ear verification is Morten's.** These tests prove the register semantics match GT2's source. They do not prove that the drums now sound right. That needs a listen after deploy, e.g. Forced Entry around 1:03 (voice 2's crash) or any Cadaver/Stinsen drum track, A/B against GoatTracker 2.
